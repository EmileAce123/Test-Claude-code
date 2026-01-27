"""
Kalshi connector implementation.

Kalshi is a CFTC-regulated prediction market for US users.
"""

import asyncio
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

import aiohttp
import structlog

from ..config import KalshiConfig
from ..models import Market, MarketSource, Order, OrderStatus, Outcome, Position, Side
from .base import BaseConnector

logger = structlog.get_logger()


class KalshiConnector(BaseConnector):
    """
    Connector for Kalshi prediction market.

    Kalshi is a regulated exchange in the US, offering event contracts
    on various topics including politics, economics, and weather.
    """

    def __init__(self, config: KalshiConfig):
        super().__init__(MarketSource.KALSHI)
        self.config = config
        self._session: Optional[aiohttp.ClientSession] = None
        self._token: Optional[str] = None
        self._member_id: Optional[str] = None

    async def connect(self) -> None:
        """Establish connection and authenticate with Kalshi."""
        self._session = aiohttp.ClientSession()

        if self.config.email and self.config.password:
            await self._authenticate()
            self.logger.info("Connected with trading enabled", member_id=self._member_id)
        else:
            self.logger.info("Connected in read-only mode")

        self.is_connected = True

    async def _authenticate(self) -> None:
        """Authenticate with Kalshi API."""
        async with self._session.post(
            f"{self.config.api_url}/login",
            json={
                "email": self.config.email,
                "password": self.config.password,
            },
        ) as response:
            response.raise_for_status()
            data = await response.json()
            self._token = data.get("token")
            self._member_id = data.get("member_id")

    async def disconnect(self) -> None:
        """Close connection."""
        if self._session:
            if self._token:
                try:
                    await self._request("POST", "/logout")
                except Exception:
                    pass
            await self._session.close()
            self._session = None

        self._token = None
        self._member_id = None
        self.is_connected = False
        self.logger.info("Disconnected from Kalshi")

    async def _request(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> Any:
        """Make an authenticated request to Kalshi API."""
        if not self._session:
            raise RuntimeError("Not connected")

        headers = kwargs.pop("headers", {})
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        url = f"{self.config.api_url}{path}"

        async with self._session.request(
            method,
            url,
            headers=headers,
            **kwargs,
        ) as response:
            if response.status == 401 and self._token:
                # Token expired, re-authenticate
                await self._authenticate()
                headers["Authorization"] = f"Bearer {self._token}"
                async with self._session.request(
                    method,
                    url,
                    headers=headers,
                    **kwargs,
                ) as retry_response:
                    retry_response.raise_for_status()
                    return await retry_response.json()

            if response.status == 429:
                retry_after = int(response.headers.get("Retry-After", 5))
                self.logger.warning(f"Rate limited, waiting {retry_after}s")
                await asyncio.sleep(retry_after)
                return await self._request(method, path, **kwargs)

            response.raise_for_status()
            return await response.json()

    async def get_markets(
        self,
        limit: int = 100,
        active_only: bool = True,
        search: Optional[str] = None,
    ) -> list[Market]:
        """Fetch available markets from Kalshi."""
        params = {
            "limit": limit,
            "status": "open" if active_only else None,
        }
        if search:
            params["series_ticker"] = search

        # Remove None values
        params = {k: v for k, v in params.items() if v is not None}

        data = await self._request("GET", "/markets", params=params)

        markets = []
        for item in data.get("markets", []):
            try:
                market = self._parse_market(item)
                if market:
                    markets.append(market)
            except Exception as e:
                self.logger.warning(f"Failed to parse market: {e}")

        return markets

    async def get_market(self, market_id: str) -> Optional[Market]:
        """Fetch a specific market by ticker."""
        try:
            data = await self._request("GET", f"/markets/{market_id}")
            return self._parse_market(data.get("market"))
        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                return None
            raise

    def _parse_market(self, data: dict[str, Any]) -> Optional[Market]:
        """Parse Kalshi API response into Market model."""
        if not data:
            return None

        # Kalshi markets are binary (Yes/No)
        yes_price = Decimal(str(data.get("yes_ask", data.get("last_price", 50)))) / 100
        no_price = Decimal("1") - yes_price

        outcomes = [
            Outcome(
                id=f"{data.get('ticker')}_yes",
                name="Yes",
                price=yes_price,
                volume_24h=Decimal(str(data.get("volume_24h", 0))) if data.get("volume_24h") else None,
            ),
            Outcome(
                id=f"{data.get('ticker')}_no",
                name="No",
                price=no_price,
            ),
        ]

        end_date = None
        if data.get("close_time"):
            try:
                end_date = datetime.fromisoformat(data["close_time"].replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        return Market(
            id=data.get("ticker", ""),
            source=MarketSource.KALSHI,
            title=data.get("title", data.get("subtitle", "")),
            description=data.get("rules_primary"),
            outcomes=outcomes,
            end_date=end_date,
            volume_24h=Decimal(str(data.get("volume_24h", 0))) if data.get("volume_24h") else None,
            liquidity=Decimal(str(data.get("open_interest", 0))) if data.get("open_interest") else None,
            url=f"https://kalshi.com/markets/{data.get('ticker', '')}",
        )

    async def get_orderbook(
        self,
        market_id: str,
        outcome_id: str,
    ) -> dict[str, list[tuple[Decimal, Decimal]]]:
        """Fetch the orderbook for a market."""
        data = await self._request("GET", f"/markets/{market_id}/orderbook")

        orderbook = data.get("orderbook", {})

        # Kalshi prices are in cents (1-99)
        bids = [
            (Decimal(str(b[0])) / 100, Decimal(str(b[1])))
            for b in orderbook.get("yes", [])
            if outcome_id.endswith("_yes")
        ]
        asks = [
            (Decimal(str(a[0])) / 100, Decimal(str(a[1])))
            for a in orderbook.get("no", [])
            if outcome_id.endswith("_yes")
        ]

        # Flip for "No" outcome
        if outcome_id.endswith("_no"):
            bids, asks = asks, bids
            bids = [(Decimal("1") - p, s) for p, s in bids]
            asks = [(Decimal("1") - p, s) for p, s in asks]

        return {"bids": bids, "asks": asks}

    async def place_order(
        self,
        market_id: str,
        outcome_id: str,
        side: Side,
        price: Decimal,
        size: Decimal,
    ) -> Order:
        """Place a new order on Kalshi."""
        if not self._token:
            raise ValueError("Trading requires authentication")

        # Kalshi uses cents for price
        price_cents = int(price * 100)

        # Determine if buying Yes or No
        is_yes = outcome_id.endswith("_yes")

        order_payload = {
            "ticker": market_id,
            "action": "buy" if side == Side.BUY else "sell",
            "side": "yes" if is_yes else "no",
            "type": "limit",
            "count": int(size),
            "yes_price" if is_yes else "no_price": price_cents,
        }

        try:
            response = await self._request(
                "POST",
                "/portfolio/orders",
                json=order_payload,
            )

            order_data = response.get("order", {})

            return Order(
                market=Market(
                    id=market_id,
                    source=MarketSource.KALSHI,
                    title="",
                    outcomes=[],
                ),
                outcome=Outcome(id=outcome_id, name="Yes" if is_yes else "No", price=price),
                side=side,
                price=price,
                size=size,
                status=OrderStatus.SUBMITTED,
                external_id=order_data.get("order_id"),
            )

        except Exception as e:
            self.logger.error(f"Order placement failed: {e}")
            return Order(
                market=Market(
                    id=market_id,
                    source=MarketSource.KALSHI,
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

    async def cancel_order(self, order_id: str) -> bool:
        """Cancel an existing order."""
        try:
            await self._request("DELETE", f"/portfolio/orders/{order_id}")
            return True
        except Exception as e:
            self.logger.error(f"Order cancellation failed: {e}")
            return False

    async def get_order(self, order_id: str) -> Optional[Order]:
        """Get order status and details."""
        try:
            data = await self._request("GET", f"/portfolio/orders/{order_id}")
            order_data = data.get("order", {})

            status_map = {
                "resting": OrderStatus.SUBMITTED,
                "executed": OrderStatus.FILLED,
                "canceled": OrderStatus.CANCELLED,
                "pending": OrderStatus.PENDING,
            }

            is_yes = order_data.get("side") == "yes"

            return Order(
                market=Market(
                    id=order_data.get("ticker", ""),
                    source=MarketSource.KALSHI,
                    title="",
                    outcomes=[],
                ),
                outcome=Outcome(
                    id=f"{order_data.get('ticker')}_{order_data.get('side', 'yes')}",
                    name="Yes" if is_yes else "No",
                    price=Decimal(str(order_data.get("yes_price", 0))) / 100,
                ),
                side=Side.BUY if order_data.get("action") == "buy" else Side.SELL,
                price=Decimal(str(order_data.get("yes_price", 0))) / 100,
                size=Decimal(str(order_data.get("count", 0))),
                status=status_map.get(order_data.get("status", ""), OrderStatus.PENDING),
                external_id=order_id,
                filled_size=Decimal(str(order_data.get("count_filled", 0))),
            )

        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                return None
            raise

    async def get_positions(self) -> list[Position]:
        """Fetch all open positions."""
        if not self._token:
            return []

        data = await self._request("GET", "/portfolio/positions")

        positions = []
        for item in data.get("market_positions", []):
            # Create position for Yes side if held
            if item.get("position", 0) > 0:
                position = Position(
                    market=Market(
                        id=item.get("ticker", ""),
                        source=MarketSource.KALSHI,
                        title=item.get("market_title", ""),
                        outcomes=[],
                    ),
                    outcome=Outcome(
                        id=f"{item.get('ticker')}_yes",
                        name="Yes",
                        price=Decimal(str(item.get("market_price", 50))) / 100,
                    ),
                    source=MarketSource.KALSHI,
                    size=Decimal(str(abs(item.get("position", 0)))),
                    average_entry_price=Decimal(str(item.get("average_price", 50))) / 100,
                    current_price=Decimal(str(item.get("market_price", 50))) / 100,
                )
                positions.append(position)
            elif item.get("position", 0) < 0:
                # Short position = holding No
                position = Position(
                    market=Market(
                        id=item.get("ticker", ""),
                        source=MarketSource.KALSHI,
                        title=item.get("market_title", ""),
                        outcomes=[],
                    ),
                    outcome=Outcome(
                        id=f"{item.get('ticker')}_no",
                        name="No",
                        price=Decimal("1") - Decimal(str(item.get("market_price", 50))) / 100,
                    ),
                    source=MarketSource.KALSHI,
                    size=Decimal(str(abs(item.get("position", 0)))),
                    average_entry_price=Decimal("1") - Decimal(str(item.get("average_price", 50))) / 100,
                    current_price=Decimal("1") - Decimal(str(item.get("market_price", 50))) / 100,
                )
                positions.append(position)

        return positions

    async def get_balance(self) -> Decimal:
        """Get available balance."""
        if not self._token:
            return Decimal("0")

        data = await self._request("GET", "/portfolio/balance")
        # Kalshi balance is in cents
        return Decimal(str(data.get("balance", 0))) / 100

    def get_fees(self) -> dict[str, Decimal]:
        """Get Kalshi trading fees."""
        return {
            "maker_fee": Decimal("0"),
            "taker_fee": Decimal("0.01"),  # $0.01 per contract or 1%
        }
