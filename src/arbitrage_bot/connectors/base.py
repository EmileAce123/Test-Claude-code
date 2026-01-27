"""
Base connector class defining the interface for all market connectors.
"""

from abc import ABC, abstractmethod
from decimal import Decimal
from typing import AsyncIterator, Optional

import structlog

from ..models import Market, MarketSource, Order, Outcome, Position, Side

logger = structlog.get_logger()


class BaseConnector(ABC):
    """
    Abstract base class for prediction market connectors.

    All market-specific connectors must implement this interface to ensure
    consistent behavior across different platforms.
    """

    def __init__(self, source: MarketSource):
        self.source = source
        self.is_connected = False
        self._session = None
        self.logger = logger.bind(connector=source.value)

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to the market API."""
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        """Close connection to the market API."""
        pass

    @abstractmethod
    async def get_markets(
        self,
        limit: int = 100,
        active_only: bool = True,
        search: Optional[str] = None,
    ) -> list[Market]:
        """
        Fetch available markets.

        Args:
            limit: Maximum number of markets to return
            active_only: Only return active/open markets
            search: Optional search query to filter markets

        Returns:
            List of Market objects
        """
        pass

    @abstractmethod
    async def get_market(self, market_id: str) -> Optional[Market]:
        """
        Fetch a specific market by ID.

        Args:
            market_id: The market identifier

        Returns:
            Market object or None if not found
        """
        pass

    @abstractmethod
    async def get_orderbook(
        self,
        market_id: str,
        outcome_id: str,
    ) -> dict[str, list[tuple[Decimal, Decimal]]]:
        """
        Fetch the orderbook for a market outcome.

        Args:
            market_id: The market identifier
            outcome_id: The outcome identifier

        Returns:
            Dict with 'bids' and 'asks' as lists of (price, size) tuples
        """
        pass

    @abstractmethod
    async def place_order(
        self,
        market_id: str,
        outcome_id: str,
        side: Side,
        price: Decimal,
        size: Decimal,
    ) -> Order:
        """
        Place a new order.

        Args:
            market_id: The market identifier
            outcome_id: The outcome identifier
            side: BUY or SELL
            price: Order price (0-1)
            size: Order size in dollars/shares

        Returns:
            Order object with status
        """
        pass

    @abstractmethod
    async def cancel_order(self, order_id: str) -> bool:
        """
        Cancel an existing order.

        Args:
            order_id: The order identifier

        Returns:
            True if cancelled successfully
        """
        pass

    @abstractmethod
    async def get_order(self, order_id: str) -> Optional[Order]:
        """
        Get order status and details.

        Args:
            order_id: The order identifier

        Returns:
            Order object or None if not found
        """
        pass

    @abstractmethod
    async def get_positions(self) -> list[Position]:
        """
        Fetch all open positions.

        Returns:
            List of Position objects
        """
        pass

    @abstractmethod
    async def get_balance(self) -> Decimal:
        """
        Get available balance for trading.

        Returns:
            Available balance in USD
        """
        pass

    async def subscribe_to_prices(
        self,
        market_ids: list[str],
    ) -> AsyncIterator[Market]:
        """
        Subscribe to real-time price updates.

        Args:
            market_ids: List of market IDs to subscribe to

        Yields:
            Market objects with updated prices
        """
        raise NotImplementedError("Real-time subscriptions not supported")

    async def health_check(self) -> bool:
        """
        Check if the connection is healthy.

        Returns:
            True if connection is healthy
        """
        return self.is_connected

    def supports_trading(self) -> bool:
        """
        Check if this connector supports trading (vs read-only).

        Returns:
            True if trading is supported
        """
        return True

    def get_fees(self) -> dict[str, Decimal]:
        """
        Get trading fees for this market.

        Returns:
            Dict with 'maker_fee' and 'taker_fee' as decimals
        """
        return {
            "maker_fee": Decimal("0"),
            "taker_fee": Decimal("0"),
        }
