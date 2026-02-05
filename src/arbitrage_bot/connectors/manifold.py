"""
Manifold Markets connector implementation.

Manifold Markets is a play-money prediction market with an open API.
While not using real money, it can be useful for price discovery and validation.
"""

import asyncio
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

import aiohttp
import structlog

from ..config import ManifoldConfig
from ..models import Market, MarketSource, Order, OrderStatus, Outcome, Position, Side
from .base import BaseConnector

logger = structlog.get_logger()


class ManifoldConnector(BaseConnector):
    """
    Connector for Manifold Markets prediction market.

    Manifold uses play money (Mana) but provides valuable market data
    and can be used for strategy validation.
    """

    def __init__(self, config: ManifoldConfig):
        super().__init__(MarketSource.MANIFOLD)
        self.config = config
        self._session: Optional[aiohttp.ClientSession] = None
        self._user_id: Optional[str] = None

    async def connect(self) -> None:
        """Establish connection to Manifold API."""
        self._session = aiohttp.ClientSession()

        if self.config.api_key:
            # Verify API key by fetching user info
            try:
                user_data = await self._request("GET", "/me")
                self._user_id = user_data.get("id")
                self.logger.info("Connected with API key", user_id=self._user_id)
            except Exception as e:
                self.logger.warning(f"API key verification failed: {e}")
        else:
            self.logger.info("Connected in read-only mode")

        self.is_connected = True

    async def disconnect(self) -> None:
        """Close connection."""
        if self._session:
            await self._session.close()
            self._session = None

        self._user_id = None
        self.is_connected = False
        self.logger.info("Disconnected from Manifold")

    async def _request(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> Any:
        """Make a request to Manifold API."""
        if not self._session:
            raise RuntimeError("Not connected")

        headers = kwargs.pop("headers", {})
        if self.config.api_key:
            headers["Authorization"] = f"Key {self.config.api_key}"

        url = f"{self.config.api_url}{path}"

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
                return await self._request(method, path, **kwargs)

            response.raise_for_status()

            if response.content_type == "application/json":
                return await response.json()
            return {}

    async def get_markets(
        self,
        limit: int = 100,
        active_only: bool = True,
        search: Optional[str] = None,
    ) -> list[Market]:
        """Fetch available markets from Manifold."""
        params = {"limit": limit}

        if search:
            # Use search endpoint
            data = await self._request(
                "GET",
                "/search-markets",
                params={"term": search, "limit": limit},
            )
        else:
            data = await self._request("GET", "/markets", params=params)

        markets = []
        for item in data if isinstance(data, list) else [data]:
            try:
                # Filter by active status
                if active_only and item.get("isResolved", False):
                    continue

                market = self._parse_market(item)
                if market:
                    markets.append(market)
            except Exception as e:
                self.logger.warning(f"Failed to parse market: {e}")

        return markets

    async def get_market(self, market_id: str) -> Optional[Market]:
        """Fetch a specific market by ID or slug."""
        try:
            # Try by ID first
            data = await self._request("GET", f"/market/{market_id}")
            return self._parse_market(data)
        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                # Try by slug
                try:
                    data = await self._request("GET", f"/slug/{market_id}")
                    return self._parse_market(data)
                except aiohttp.ClientResponseError:
                    return None
            raise

    def _parse_market(self, data: dict[str, Any]) -> Optional[Market]:
        """Parse Manifold API response into Market model."""
        if not data:
            return None

        outcomes = []
        market_type = data.get("outcomeType", "BINARY")

        if market_type == "BINARY":
            # Binary market
            prob = Decimal(str(data.get("probability", 0.5)))
            outcomes = [
                Outcome(
                    id=f"{data.get('id')}_yes",
                    name="Yes",
                    price=prob,
                    volume_24h=Decimal(str(data.get("volume24Hours", 0))) if data.get("volume24Hours") else None,
                ),
                Outcome(
                    id=f"{data.get('id')}_no",
                    name="No",
                    price=Decimal("1") - prob,
                ),
            ]
        elif market_type == "MULTIPLE_CHOICE":
            # Multiple choice market
            answers = data.get("answers", [])
            for answer in answers:
                outcome = Outcome(
                    id=answer.get("id", ""),
                    name=answer.get("text", ""),
                    price=Decimal(str(answer.get("probability", 0))),
                )
                outcomes.append(outcome)
        else:
            # Other types (numeric, etc.) - skip for now
            return None

        if not outcomes:
            return None

        end_date = None
        close_time = data.get("closeTime")
        if close_time:
            try:
                # Manifold uses milliseconds
                end_date = datetime.fromtimestamp(close_time / 1000)
            except (ValueError, TypeError, OSError):
                pass

        return Market(
            id=data.get("id", ""),
            source=MarketSource.MANIFOLD,
            title=data.get("question", ""),
            description=data.get("description"),
            outcomes=outcomes,
            end_date=end_date,
            volume_24h=Decimal(str(data.get("volume24Hours", 0))) if data.get("volume24Hours") else None,
            liquidity=Decimal(str(data.get("totalLiquidity", 0))) if data.get("totalLiquidity") else None,
            url=f"https://manifold.markets/{data.get('creatorUsername', '')}/{data.get('slug', '')}",
        )

    async def get_orderbook(
        self,
        market_id: str,
        outcome_id: str,
    ) -> dict[str, list[tuple[Decimal, Decimal]]]:
        """
        Manifold uses an AMM, not an orderbook.
        Return simulated orderbook based on AMM curve.
        """
        market = await self.get_market(market_id)
        if not market:
            return {"bids": [], "asks": []}

        # Find the outcome
        current_price = Decimal("0.5")
        for outcome in market.outcomes:
            if outcome.id == outcome_id:
                current_price = outcome.price
                break

        # Simulate orderbook from AMM
        # In reality, you'd calculate from the CPMM or DPM curves
        bids = [(current_price - Decimal("0.01") * i, Decimal("100")) for i in range(1, 6)]
        asks = [(current_price + Decimal("0.01") * i, Decimal("100")) for i in range(1, 6)]

        return {"bids": bids, "asks": asks}

    async def place_order(
        self,
        market_id: str,
        outcome_id: str,
        side: Side,
        price: Decimal,
        size: Decimal,
    ) -> Order:
        """Place a bet on Manifold (uses Mana, not real money)."""
        if not self.config.api_key:
            raise ValueError("Trading requires an API key")

        # Manifold uses a simple bet endpoint
        is_yes = outcome_id.endswith("_yes")

        bet_payload = {
            "amount": float(size),
            "contractId": market_id,
            "outcome": "YES" if (is_yes and side == Side.BUY) or (not is_yes and side == Side.SELL) else "NO",
        }

        # Add limit price if specified
        if price != Decimal("0"):
            bet_payload["limitProb"] = float(price)

        try:
            response = await self._request(
                "POST",
                "/bet",
                json=bet_payload,
            )

            return Order(
                market=Market(
                    id=market_id,
                    source=MarketSource.MANIFOLD,
                    title="",
                    outcomes=[],
                ),
                outcome=Outcome(id=outcome_id, name="Yes" if is_yes else "No", price=price),
                side=side,
                price=price,
                size=size,
                status=OrderStatus.FILLED,  # Manifold bets fill immediately
                external_id=response.get("betId"),
                filled_size=Decimal(str(response.get("amount", size))),
                filled_price=Decimal(str(response.get("probAfter", price))),
            )

        except Exception as e:
            self.logger.error(f"Bet placement failed: {e}")
            return Order(
                market=Market(
                    id=market_id,
                    source=MarketSource.MANIFOLD,
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
        """
        Cancel a limit order on Manifold.
        Note: Market orders fill immediately and cannot be cancelled.
        """
        try:
            await self._request(
                "POST",
                f"/bet/cancel/{order_id}",
            )
            return True
        except Exception as e:
            self.logger.error(f"Order cancellation failed: {e}")
            return False

    async def get_order(self, order_id: str) -> Optional[Order]:
        """Get bet details."""
        try:
            data = await self._request("GET", f"/bet/{order_id}")

            return Order(
                market=Market(
                    id=data.get("contractId", ""),
                    source=MarketSource.MANIFOLD,
                    title="",
                    outcomes=[],
                ),
                outcome=Outcome(
                    id=f"{data.get('contractId')}_{data.get('outcome', 'yes').lower()}",
                    name=data.get("outcome", "Yes"),
                    price=Decimal(str(data.get("probBefore", 0.5))),
                ),
                side=Side.BUY,  # All bets are technically buys
                price=Decimal(str(data.get("probBefore", 0.5))),
                size=Decimal(str(data.get("amount", 0))),
                status=OrderStatus.FILLED,
                external_id=order_id,
                filled_size=Decimal(str(data.get("amount", 0))),
                filled_price=Decimal(str(data.get("probAfter", 0.5))),
            )

        except aiohttp.ClientResponseError as e:
            if e.status == 404:
                return None
            raise

    async def get_positions(self) -> list[Position]:
        """Fetch all positions for the authenticated user."""
        if not self._user_id:
            return []

        # Get user's bets
        data = await self._request(
            "GET",
            f"/bets",
            params={"userId": self._user_id},
        )

        # Aggregate bets into positions
        positions_map: dict[str, Position] = {}

        for bet in data if isinstance(data, list) else []:
            contract_id = bet.get("contractId", "")
            outcome = bet.get("outcome", "YES")
            position_key = f"{contract_id}_{outcome.lower()}"

            if position_key not in positions_map:
                positions_map[position_key] = Position(
                    market=Market(
                        id=contract_id,
                        source=MarketSource.MANIFOLD,
                        title="",
                        outcomes=[],
                    ),
                    outcome=Outcome(
                        id=position_key,
                        name=outcome,
                        price=Decimal(str(bet.get("probAfter", 0.5))),
                    ),
                    source=MarketSource.MANIFOLD,
                    size=Decimal("0"),
                    average_entry_price=Decimal("0"),
                )

            # Add to position
            amount = Decimal(str(bet.get("shares", 0)))
            positions_map[position_key].size += amount

        return list(positions_map.values())

    async def get_balance(self) -> Decimal:
        """Get Mana balance (play money)."""
        if not self.config.api_key:
            return Decimal("0")

        data = await self._request("GET", "/me")
        return Decimal(str(data.get("balance", 0)))

    def get_fees(self) -> dict[str, Decimal]:
        """Manifold has no trading fees."""
        return {
            "maker_fee": Decimal("0"),
            "taker_fee": Decimal("0"),
        }

    def supports_trading(self) -> bool:
        """Manifold supports trading but uses play money."""
        return self.config.api_key is not None
