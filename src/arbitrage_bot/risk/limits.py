"""
Position and rate limiting components.
"""

import asyncio
from collections import deque
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

import structlog

from ..config import RiskConfig
from ..models import ArbitrageTrade, MarketSource, Position

logger = structlog.get_logger()


class PositionLimits:
    """
    Manages position size and exposure limits.

    Tracks:
    - Total exposure across all markets
    - Per-market exposure
    - Per-platform exposure
    - Individual position sizes
    """

    def __init__(self, config: RiskConfig):
        self.config = config
        self.positions: dict[str, Position] = {}
        self.active_trades: dict[str, ArbitrageTrade] = {}
        self.logger = logger.bind(component="position_limits")

    def get_total_exposure(self) -> Decimal:
        """Calculate total exposure across all positions."""
        total = Decimal("0")

        for position in self.positions.values():
            total += position.size * position.average_entry_price

        for trade in self.active_trades.values():
            if trade.status in ("pending", "partially_filled"):
                total += trade.total_invested

        return total

    def get_exposure_by_source(self, source: MarketSource) -> Decimal:
        """Calculate exposure for a specific platform."""
        total = Decimal("0")

        for position in self.positions.values():
            if position.source == source:
                total += position.size * position.average_entry_price

        return total

    def can_open_position(
        self,
        size_usd: Decimal,
        source: Optional[MarketSource] = None,
    ) -> tuple[bool, str]:
        """
        Check if a new position can be opened.

        Args:
            size_usd: Size of the new position in USD
            source: Optional platform source for platform-specific limits

        Returns:
            Tuple of (can_open, reason)
        """
        # Check individual position size
        if size_usd > self.config.max_position_size_usd:
            return False, f"Position size ${size_usd} exceeds max ${self.config.max_position_size_usd}"

        # Check total exposure
        current_exposure = self.get_total_exposure()
        new_exposure = current_exposure + size_usd

        if new_exposure > self.config.max_total_exposure_usd:
            return False, f"Total exposure ${new_exposure} would exceed max ${self.config.max_total_exposure_usd}"

        # Platform-specific checks could go here
        # For example, limiting exposure to any single platform

        return True, "OK"

    def add_position(self, position: Position) -> None:
        """Add a new position to tracking."""
        key = f"{position.market.id}_{position.outcome.id}"
        self.positions[key] = position
        self.logger.info(
            "Position added",
            market=position.market.title[:50],
            size=float(position.size),
        )

    def update_position(self, position: Position) -> None:
        """Update an existing position."""
        key = f"{position.market.id}_{position.outcome.id}"
        if key in self.positions:
            self.positions[key] = position

    def remove_position(self, market_id: str, outcome_id: str) -> None:
        """Remove a position from tracking."""
        key = f"{market_id}_{outcome_id}"
        if key in self.positions:
            del self.positions[key]
            self.logger.info("Position removed", market_id=market_id)

    def add_trade(self, trade: ArbitrageTrade) -> None:
        """Add an active trade to tracking."""
        self.active_trades[str(trade.id)] = trade

    def update_trade(self, trade: ArbitrageTrade) -> None:
        """Update a tracked trade."""
        self.active_trades[str(trade.id)] = trade

    def remove_trade(self, trade_id: str) -> None:
        """Remove a trade from tracking."""
        if trade_id in self.active_trades:
            del self.active_trades[trade_id]

    def get_available_capacity(self) -> Decimal:
        """Get available capacity for new positions."""
        current_exposure = self.get_total_exposure()
        return max(Decimal("0"), self.config.max_total_exposure_usd - current_exposure)


class RateLimiter:
    """
    Rate limiting for trade execution.

    Prevents:
    - Too many trades per time period
    - Rapid-fire trading after losses
    - API rate limit violations
    """

    def __init__(self, config: RiskConfig):
        self.config = config
        self.trade_timestamps: deque[datetime] = deque()
        self.last_loss_time: Optional[datetime] = None
        self.consecutive_losses = 0
        self._lock = asyncio.Lock()
        self.logger = logger.bind(component="rate_limiter")

    async def can_trade(self) -> tuple[bool, str]:
        """
        Check if a new trade is allowed.

        Returns:
            Tuple of (can_trade, reason)
        """
        async with self._lock:
            now = datetime.utcnow()

            # Check cooldown after loss
            if self.last_loss_time:
                cooldown_end = self.last_loss_time + timedelta(
                    seconds=self.config.cooldown_after_loss_seconds
                )
                if now < cooldown_end:
                    remaining = (cooldown_end - now).total_seconds()
                    return False, f"In cooldown period, {remaining:.0f}s remaining"

            # Clean old timestamps (older than 1 hour)
            cutoff = now - timedelta(hours=1)
            while self.trade_timestamps and self.trade_timestamps[0] < cutoff:
                self.trade_timestamps.popleft()

            # Check trades per hour
            if len(self.trade_timestamps) >= self.config.max_trades_per_hour:
                return False, f"Max trades per hour ({self.config.max_trades_per_hour}) reached"

            # Check consecutive losses - progressive cooldown
            if self.consecutive_losses >= 3:
                cooldown_multiplier = min(self.consecutive_losses - 2, 5)
                extended_cooldown = self.config.cooldown_after_loss_seconds * cooldown_multiplier

                if self.last_loss_time:
                    extended_end = self.last_loss_time + timedelta(seconds=extended_cooldown)
                    if now < extended_end:
                        remaining = (extended_end - now).total_seconds()
                        return False, f"Extended cooldown after {self.consecutive_losses} losses, {remaining:.0f}s remaining"

            return True, "OK"

    async def record_trade(self) -> None:
        """Record a trade execution."""
        async with self._lock:
            self.trade_timestamps.append(datetime.utcnow())

    async def record_loss(self) -> None:
        """Record a losing trade."""
        async with self._lock:
            self.last_loss_time = datetime.utcnow()
            self.consecutive_losses += 1
            self.logger.warning(
                f"Loss recorded, consecutive losses: {self.consecutive_losses}"
            )

    async def record_profit(self) -> None:
        """Record a profitable trade."""
        async with self._lock:
            self.consecutive_losses = 0
            self.logger.info("Profit recorded, loss streak reset")

    def get_trades_in_last_hour(self) -> int:
        """Get count of trades in the last hour."""
        cutoff = datetime.utcnow() - timedelta(hours=1)
        return sum(1 for t in self.trade_timestamps if t >= cutoff)

    async def wait_for_availability(self, timeout: float = 300) -> bool:
        """
        Wait until trading is available.

        Args:
            timeout: Maximum time to wait in seconds

        Returns:
            True if trading became available, False if timeout
        """
        start = datetime.utcnow()
        while (datetime.utcnow() - start).total_seconds() < timeout:
            can_trade, _ = await self.can_trade()
            if can_trade:
                return True
            await asyncio.sleep(5)
        return False


class DrawdownMonitor:
    """
    Monitors drawdown and triggers circuit breakers.
    """

    def __init__(
        self,
        initial_balance: Decimal,
        max_drawdown_percent: Decimal = Decimal("10"),
    ):
        self.initial_balance = initial_balance
        self.peak_balance = initial_balance
        self.current_balance = initial_balance
        self.max_drawdown_percent = max_drawdown_percent
        self.is_circuit_breaker_active = False
        self.logger = logger.bind(component="drawdown_monitor")

    def update_balance(self, new_balance: Decimal) -> None:
        """Update current balance and check drawdown."""
        self.current_balance = new_balance

        # Update peak
        if new_balance > self.peak_balance:
            self.peak_balance = new_balance

        # Calculate drawdown
        drawdown = self._calculate_drawdown()

        if drawdown >= self.max_drawdown_percent:
            self.trigger_circuit_breaker(drawdown)

    def _calculate_drawdown(self) -> Decimal:
        """Calculate current drawdown from peak."""
        if self.peak_balance == 0:
            return Decimal("0")

        drawdown = ((self.peak_balance - self.current_balance) / self.peak_balance) * 100
        return drawdown

    def trigger_circuit_breaker(self, drawdown: Decimal) -> None:
        """Activate circuit breaker to stop trading."""
        if not self.is_circuit_breaker_active:
            self.is_circuit_breaker_active = True
            self.logger.critical(
                "CIRCUIT BREAKER ACTIVATED",
                drawdown=float(drawdown),
                peak_balance=float(self.peak_balance),
                current_balance=float(self.current_balance),
            )

    def reset_circuit_breaker(self) -> None:
        """Manually reset the circuit breaker."""
        self.is_circuit_breaker_active = False
        self.logger.info("Circuit breaker reset")

    def get_status(self) -> dict:
        """Get current drawdown monitoring status."""
        return {
            "initial_balance": float(self.initial_balance),
            "peak_balance": float(self.peak_balance),
            "current_balance": float(self.current_balance),
            "current_drawdown_percent": float(self._calculate_drawdown()),
            "max_drawdown_percent": float(self.max_drawdown_percent),
            "circuit_breaker_active": self.is_circuit_breaker_active,
        }
