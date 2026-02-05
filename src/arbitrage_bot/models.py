"""
Data models for the arbitrage bot.
Defines the core entities used throughout the application.
"""

from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


class MarketSource(str, Enum):
    """Supported prediction market sources."""

    POLYMARKET = "polymarket"
    KALSHI = "kalshi"
    MANIFOLD = "manifold"
    PREDICTIT = "predictit"
    METACULUS = "metaculus"


class Side(str, Enum):
    """Order side."""

    BUY = "buy"
    SELL = "sell"


class OrderStatus(str, Enum):
    """Order execution status."""

    PENDING = "pending"
    SUBMITTED = "submitted"
    FILLED = "filled"
    PARTIALLY_FILLED = "partially_filled"
    CANCELLED = "cancelled"
    FAILED = "failed"


class Outcome(BaseModel):
    """Represents a possible outcome in a prediction market."""

    id: str
    name: str
    price: Decimal = Field(ge=0, le=1)
    volume_24h: Optional[Decimal] = None
    liquidity: Optional[Decimal] = None


class Market(BaseModel):
    """Represents a prediction market."""

    id: str
    source: MarketSource
    title: str
    description: Optional[str] = None
    outcomes: list[Outcome]
    end_date: Optional[datetime] = None
    volume_24h: Optional[Decimal] = None
    liquidity: Optional[Decimal] = None
    url: Optional[str] = None
    last_updated: datetime = Field(default_factory=datetime.utcnow)

    @property
    def is_binary(self) -> bool:
        """Check if this is a binary (yes/no) market."""
        return len(self.outcomes) == 2

    def get_yes_price(self) -> Optional[Decimal]:
        """Get the 'Yes' outcome price for binary markets."""
        if not self.is_binary:
            return None
        for outcome in self.outcomes:
            if outcome.name.lower() in ("yes", "true", "1"):
                return outcome.price
        return self.outcomes[0].price

    def get_no_price(self) -> Optional[Decimal]:
        """Get the 'No' outcome price for binary markets."""
        if not self.is_binary:
            return None
        for outcome in self.outcomes:
            if outcome.name.lower() in ("no", "false", "0"):
                return outcome.price
        return self.outcomes[1].price


class MarketPair(BaseModel):
    """A pair of related markets from different sources."""

    id: UUID = Field(default_factory=uuid4)
    market_a: Market
    market_b: Market
    similarity_score: float = Field(ge=0, le=1)
    matched_at: datetime = Field(default_factory=datetime.utcnow)


class ArbitrageOpportunity(BaseModel):
    """Represents a detected arbitrage opportunity."""

    id: UUID = Field(default_factory=uuid4)
    market_pair: MarketPair
    buy_market: Market
    sell_market: Market
    buy_outcome: Outcome
    sell_outcome: Outcome
    buy_price: Decimal
    sell_price: Decimal
    spread: Decimal
    profit_percent: Decimal
    recommended_size_usd: Decimal
    expected_profit_usd: Decimal
    confidence: float = Field(ge=0, le=1)
    detected_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: Optional[datetime] = None
    is_valid: bool = True

    @property
    def is_profitable(self) -> bool:
        """Check if the opportunity is still profitable after fees."""
        return self.profit_percent > Decimal("0")


class Order(BaseModel):
    """Represents a trade order."""

    id: UUID = Field(default_factory=uuid4)
    market: Market
    outcome: Outcome
    side: Side
    price: Decimal
    size: Decimal
    status: OrderStatus = OrderStatus.PENDING
    external_id: Optional[str] = None
    filled_size: Decimal = Decimal("0")
    filled_price: Optional[Decimal] = None
    fees: Decimal = Decimal("0")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    error_message: Optional[str] = None


class ArbitrageTrade(BaseModel):
    """Represents an executed arbitrage trade (pair of orders)."""

    id: UUID = Field(default_factory=uuid4)
    opportunity: ArbitrageOpportunity
    buy_order: Order
    sell_order: Order
    total_invested: Decimal
    realized_profit: Optional[Decimal] = None
    status: str = "pending"
    executed_at: datetime = Field(default_factory=datetime.utcnow)
    closed_at: Optional[datetime] = None


class Position(BaseModel):
    """Represents a current position in a market."""

    id: UUID = Field(default_factory=uuid4)
    market: Market
    outcome: Outcome
    source: MarketSource
    size: Decimal
    average_entry_price: Decimal
    current_price: Optional[Decimal] = None
    unrealized_pnl: Optional[Decimal] = None
    opened_at: datetime = Field(default_factory=datetime.utcnow)


class PortfolioSnapshot(BaseModel):
    """Snapshot of the portfolio at a point in time."""

    timestamp: datetime = Field(default_factory=datetime.utcnow)
    total_value_usd: Decimal
    cash_balance_usd: Decimal
    positions_value_usd: Decimal
    unrealized_pnl: Decimal
    realized_pnl_today: Decimal
    open_positions: int
    active_trades: int
