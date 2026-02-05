"""
Polymarket connector implementation.

Polymarket is a decentralized prediction market on Polygon.
Uses the CLOB (Central Limit Order Book) API for trading.
"""

import asyncio
import hashlib
import hmac
import time
from datetime import datetime
from decimal import Decimal
from typing import Any, AsyncIterator, Optional

import aiohttp
import structlog
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

from ..config import PolymarketConfig
from ..models import Market, MarketSource, Order, OrderStatus, Outcome, Position, Side
from .base import BaseConnector

logger = structlog.get_logger()


class PolymarketConnector(BaseConnector):
    """
    Connector for Polymarket prediction market.

    Implements the CLOB API for order management and
    the Gamma API for market data.
    """

    GAMMA_API_URL = "https://gamma-api.polymarket.com"

    def __init__(self, config: PolymarketConfig):
        super().__init__(MarketSource.POLYMARKET)
        self.config = config
        self._session: Optional[aiohttp.ClientSession] = None
        self._ws: Optional[aiohttp.ClientWebSocketResponse] = None
        self._account: Optional[Account] = None

    async def connect(self) -> None:
        """Establish connection to Polymarket APIs."""
        self._session = aiohttp.ClientSession()

        if self.config.private_key:
            self._account = Account.from_key(self.config.private_key)
            self.logger.info(
                "Connected with trading enabled",
                address=self._account.address,
            )
        else:
            self.logger.info("Connected in read-only mode (no private key)")

        self.is_connected = True

    async def disconnect(self) -> None:
        """Close all connections."""
        if self._ws:
            await self._ws.close()
            self._ws = None

        if self._session:
            await self._session.close()
            self._session = None

        self.is_connected = False
        self.logger.info("Disconnected from Polymarket")

    def _generate_signature(
        self,
        method: str,
        path: str,
        body: str = "",
    ) -> dict[str, str]:
        """Generate API signature headers for authenticated requests."""
        if not self.config.api_key or not self.config.api_secret:
            raise ValueError("API credentials required for authenticated requests")

        timestamp = str(int(time.time()))
        message = f"{timestamp}{method}{path}{body}"

        signature = hmac.new(
            self.config.api_secret.encode(),
            message.encode(),
            hashlib.sha256,
        ).hexdigest()

        return {
            "POLY_API_KEY": self.config.api_key,
            "POLY_SIGNATURE": signature,
            "POLY_TIMESTAMP": timestamp,
            "POLY_PASSPHRASE": self.config.api_passphrase or "",
        }

    async def _request(
        self,
        method: str,
        url: str,
        authenticated: bool = False,
        **kwargs: Any,
    ) -> Any:
        """Make an HTTP request to the API."""
        if not self._session:
            raise RuntimeError("Not connected")

        headers = kwargs.pop("headers", {})

        if authenticated:
            path = url.replace(self.config.api_url, "")
            body = kwargs.get("json", "")
            if body:
                import json
                body = json.dumps(body)
            auth_headers = self._generate_signature(method, path, body)
            headers.update(auth_headers)

        async with self._session.request(
            method,
            url,
            headers=headers,
            **kwargs,
        ) as response:
            if response.status == 429:
                retry_after = int(response.headers.get("Retry-After", 5))
                self.logger.warning(f"Rate limited, waiting {retry_after}s")
                await asyncio.sleep(retry_after)
                return await self._request(method, url, authenticated, **kwargs)

            response.raise_for_status()
            return await response.json()

    async def get_markets(
        self,
        limit: int = 100,
        active_only: bool = True,
        search: Optional[str] = None,
    ) -> list[Market]:
        """Fetch available markets from Polymarket."""
        params = {
            "limit": limit,
            "active": str(active_only).lower(),
        }
        if search:
            params["search"] = search

        data = await self._request(
            "GET",
            f"{self.GAMMA_API_URL}/markets",
            params=params,
        )

        markets = []
        for item in data:
            try:
                market = self._parse_market(item)
                if market:
                    markets.append(market)
            except Exception as e:
                self.logger.warning(f"Failed to parse market: {e}", market_id=item.get("id"))

        return markets

    async def get_market(self, market_id: str) -> Optional[Market]:
        """Fetch a specific market by ID."""
        try:
            data = await self._request(
                "GET",
                f"{self.GAMMA_API_URL}/markets/{market_id}",
            )
            return self._parse_market(data)
        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                return None
            raise

    def _parse_market(self, data: dict[str, Any]) -> Optional[Market]:
        """Parse API response into Market model."""
        if not data:
            return None

        outcomes = []
        tokens = data.get("tokens", [])

        for token in tokens:
            outcome = Outcome(
                id=token.get("token_id", ""),
                name=token.get("outcome", ""),
                price=Decimal(str(token.get("price", 0))),
                volume_24h=Decimal(str(token.get("volume_24h", 0))) if token.get("volume_24h") else None,
            )
            outcomes.append(outcome)

        # Handle case where tokens are embedded differently
        if not outcomes and "outcome_prices" in data:
            prices = data.get("outcome_prices", [])
            names = data.get("outcomes", ["Yes", "No"])
            for i, (price, name) in enumerate(zip(prices, names)):
                outcome = Outcome(
                    id=str(i),
                    name=name,
                    price=Decimal(str(price)),
                )
                outcomes.append(outcome)

        if not outcomes:
            return None

        end_date = None
        if data.get("end_date_iso"):
            try:
                end_date = datetime.fromisoformat(data["end_date_iso"].replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        return Market(
            id=data.get("condition_id", data.get("id", "")),
            source=MarketSource.POLYMARKET,
            title=data.get("question", data.get("title", "")),
            description=data.get("description"),
            outcomes=outcomes,
            end_date=end_date,
            volume_24h=Decimal(str(data.get("volume_24h", 0))) if data.get("volume_24h") else None,
            liquidity=Decimal(str(data.get("liquidity", 0))) if data.get("liquidity") else None,
            url=f"https://polymarket.com/event/{data.get('slug', data.get('id', ''))}",
        )

    async def get_orderbook(
        self,
        market_id: str,
        outcome_id: str,
    ) -> dict[str, list[tuple[Decimal, Decimal]]]:
        """Fetch the orderbook for a market outcome."""
        data = await self._request(
            "GET",
            f"{self.config.api_url}/book",
            params={"token_id": outcome_id},
        )

        bids = [
            (Decimal(str(b["price"])), Decimal(str(b["size"])))
            for b in data.get("bids", [])
        ]
        asks = [
            (Decimal(str(a["price"])), Decimal(str(a["size"])))
            for a in data.get("asks", [])
        ]

        return {"bids": bids, "asks": asks}

    async def place_order(
        self,
        market_id: str,
        outcome_id: str,
        side: Side,
        price: Decimal,
        size: Decimal,
    ) -> Order:
        """Place a new order on Polymarket."""
        if not self._account:
            raise ValueError("Trading requires a private key")

        # Build order payload
        order_payload = {
            "tokenID": outcome_id,
            "price": str(price),
            "size": str(size),
            "side": "BUY" if side == Side.BUY else "SELL",
            "feeRateBps": "0",
            "nonce": str(int(time.time() * 1000)),
            "expiration": "0",  # No expiration
            "taker": "0x0000000000000000000000000000000000000000",
        }

        # Sign the order
        order_hash = self._compute_order_hash(order_payload)
        message = encode_defunct(hexstr=order_hash)
        signed = self._account.sign_message(message)

        order_payload["signature"] = signed.signature.hex()
        order_payload["owner"] = self._account.address

        try:
            response = await self._request(
                "POST",
                f"{self.config.api_url}/order",
                authenticated=True,
                json=order_payload,
            )

            return Order(
                market=Market(
                    id=market_id,
                    source=MarketSource.POLYMARKET,
                    title="",
                    outcomes=[],
                ),
                outcome=Outcome(id=outcome_id, name="", price=price),
                side=side,
                price=price,
                size=size,
                status=OrderStatus.SUBMITTED,
                external_id=response.get("orderID"),
            )

        except Exception as e:
            self.logger.error(f"Order placement failed: {e}")
            return Order(
                market=Market(
                    id=market_id,
                    source=MarketSource.POLYMARKET,
                    title="",
                    outcomes=[],
                ),
                outcome=Outcome(id=outcome_id, name="", price=price),
                side=side,
                price=price,
                size=size,
                status=OrderStatus.FAILED,
                error_message=str(e),
            )

    def _compute_order_hash(self, order: dict[str, Any]) -> str:
        """Compute the EIP-712 hash for order signing."""
        # Simplified hash computation
        # In production, use proper EIP-712 structured data hashing
        order_string = "|".join(str(v) for v in order.values())
        return Web3.keccak(text=order_string).hex()

    async def cancel_order(self, order_id: str) -> bool:
        """Cancel an existing order."""
        try:
            await self._request(
                "DELETE",
                f"{self.config.api_url}/order/{order_id}",
                authenticated=True,
            )
            return True
        except Exception as e:
            self.logger.error(f"Order cancellation failed: {e}")
            return False

    async def get_order(self, order_id: str) -> Optional[Order]:
        """Get order status and details."""
        try:
            data = await self._request(
                "GET",
                f"{self.config.api_url}/order/{order_id}",
                authenticated=True,
            )

            status_map = {
                "LIVE": OrderStatus.SUBMITTED,
                "FILLED": OrderStatus.FILLED,
                "PARTIALLY_FILLED": OrderStatus.PARTIALLY_FILLED,
                "CANCELLED": OrderStatus.CANCELLED,
            }

            return Order(
                market=Market(
                    id=data.get("asset_id", ""),
                    source=MarketSource.POLYMARKET,
                    title="",
                    outcomes=[],
                ),
                outcome=Outcome(
                    id=data.get("token_id", ""),
                    name="",
                    price=Decimal(str(data.get("price", 0))),
                ),
                side=Side.BUY if data.get("side") == "BUY" else Side.SELL,
                price=Decimal(str(data.get("price", 0))),
                size=Decimal(str(data.get("original_size", 0))),
                status=status_map.get(data.get("status", ""), OrderStatus.PENDING),
                external_id=order_id,
                filled_size=Decimal(str(data.get("size_matched", 0))),
            )

        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                return None
            raise

    async def get_positions(self) -> list[Position]:
        """Fetch all open positions."""
        if not self._account:
            return []

        data = await self._request(
            "GET",
            f"{self.config.api_url}/positions",
            authenticated=True,
            params={"user": self._account.address},
        )

        positions = []
        for item in data:
            position = Position(
                market=Market(
                    id=item.get("asset_id", ""),
                    source=MarketSource.POLYMARKET,
                    title=item.get("title", ""),
                    outcomes=[],
                ),
                outcome=Outcome(
                    id=item.get("token_id", ""),
                    name=item.get("outcome", ""),
                    price=Decimal(str(item.get("current_price", 0))),
                ),
                source=MarketSource.POLYMARKET,
                size=Decimal(str(item.get("size", 0))),
                average_entry_price=Decimal(str(item.get("avg_price", 0))),
                current_price=Decimal(str(item.get("current_price", 0))),
            )
            positions.append(position)

        return positions

    async def get_balance(self) -> Decimal:
        """Get available USDC balance."""
        if not self._account:
            return Decimal("0")

        # Query balance from Polygon USDC contract
        # This is a simplified implementation
        data = await self._request(
            "GET",
            f"{self.config.api_url}/balance",
            authenticated=True,
        )

        return Decimal(str(data.get("balance", 0)))

    async def subscribe_to_prices(
        self,
        market_ids: list[str],
    ) -> AsyncIterator[Market]:
        """Subscribe to real-time price updates via WebSocket."""
        if not self._session:
            raise RuntimeError("Not connected")

        async with self._session.ws_connect(self.config.ws_url) as ws:
            self._ws = ws

            # Subscribe to markets
            subscribe_msg = {
                "type": "subscribe",
                "channel": "market",
                "markets": market_ids,
            }
            await ws.send_json(subscribe_msg)
            self.logger.info(f"Subscribed to {len(market_ids)} markets")

            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = msg.json()
                    if data.get("type") == "price_update":
                        market = self._parse_market(data.get("market", {}))
                        if market:
                            yield market

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    self.logger.error(f"WebSocket error: {ws.exception()}")
                    break

    def get_fees(self) -> dict[str, Decimal]:
        """Get Polymarket trading fees."""
        return {
            "maker_fee": Decimal("0"),  # Polymarket has no maker fees
            "taker_fee": Decimal("0.02"),  # 2% taker fee
        }
