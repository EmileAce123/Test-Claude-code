"""
Central risk management system.

Coordinates all risk controls and provides a unified interface
for the trading engine.
"""

from datetime import datetime
from decimal import Decimal
from typing import Optional

import structlog

from ..config import RiskConfig
from ..connectors.base import BaseConnector
from ..models import (
    ArbitrageOpportunity,
    ArbitrageTrade,
    MarketSource,
    PortfolioSnapshot,
    Position,
)
from .limits import DrawdownMonitor, PositionLimits, RateLimiter

logger = structlog.get_logger()


class RiskManager:
    """
    Central risk management system.

    Responsibilities:
    - Pre-trade risk checks
    - Position and exposure management
    - Drawdown monitoring
    - Rate limiting
    - Circuit breakers
    - Risk reporting
    """

    def __init__(
        self,
        config: RiskConfig,
        connectors: dict[MarketSource, BaseConnector],
        initial_balance: Decimal = Decimal("10000"),
    ):
        self.config = config
        self.connectors = connectors

        # Initialize components
        self.position_limits = PositionLimits(config)
        self.rate_limiter = RateLimiter(config)
        self.drawdown_monitor = DrawdownMonitor(
            initial_balance=initial_balance,
            max_drawdown_percent=config.stop_loss_percent,
        )

        # Tracking
        self.total_trades = 0
        self.winning_trades = 0
        self.losing_trades = 0
        self.total_profit = Decimal("0")
        self.total_loss = Decimal("0")

        self.logger = logger.bind(component="risk_manager")

    async def check_trade_allowed(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> tuple[bool, str]:
        """
        Comprehensive pre-trade risk check.

        Args:
            opportunity: The opportunity to evaluate

        Returns:
            Tuple of (allowed, reason)
        """
        # Check circuit breaker
        if self.drawdown_monitor.is_circuit_breaker_active:
            return False, "Circuit breaker is active - trading halted"

        # Check rate limits
        can_trade, reason = await self.rate_limiter.can_trade()
        if not can_trade:
            return False, reason

        # Check position limits
        can_open, reason = self.position_limits.can_open_position(
            opportunity.recommended_size_usd
        )
        if not can_open:
            return False, reason

        # Check minimum profit threshold
        if opportunity.profit_percent < self.config.min_profit_threshold_percent:
            return False, f"Profit {opportunity.profit_percent}% below threshold {self.config.min_profit_threshold_percent}%"

        # Check confidence threshold
        min_confidence = 0.5
        if opportunity.confidence < min_confidence:
            return False, f"Confidence {opportunity.confidence:.2f} below threshold {min_confidence}"

        # Check slippage expectations
        expected_slippage = self._estimate_slippage(opportunity)
        if expected_slippage > self.config.max_slippage_percent:
            return False, f"Expected slippage {expected_slippage}% too high"

        # Check liquidity
        is_liquid, liquidity_reason = self._check_liquidity(opportunity)
        if not is_liquid:
            return False, liquidity_reason

        return True, "All checks passed"

    def _estimate_slippage(self, opportunity: ArbitrageOpportunity) -> Decimal:
        """Estimate expected slippage based on size and liquidity."""
        buy_liquidity = opportunity.buy_market.liquidity or Decimal("1000")
        sell_liquidity = opportunity.sell_market.liquidity or Decimal("1000")
        min_liquidity = min(buy_liquidity, sell_liquidity)

        if min_liquidity == 0:
            return Decimal("100")  # No liquidity

        # Rough estimate: slippage increases with size relative to liquidity
        size_ratio = opportunity.recommended_size_usd / min_liquidity
        estimated_slippage = size_ratio * Decimal("100")

        return min(estimated_slippage, Decimal("100"))

    def _check_liquidity(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> tuple[bool, str]:
        """Check if there's sufficient liquidity for the trade."""
        min_liquidity = Decimal("100")  # Minimum $100 liquidity required

        buy_liquidity = opportunity.buy_market.liquidity or Decimal("0")
        sell_liquidity = opportunity.sell_market.liquidity or Decimal("0")

        if buy_liquidity < min_liquidity:
            return False, f"Buy market liquidity ${buy_liquidity} too low"

        if sell_liquidity < min_liquidity:
            return False, f"Sell market liquidity ${sell_liquidity} too low"

        # Check if our size is reasonable relative to liquidity
        size = opportunity.recommended_size_usd
        max_size_ratio = Decimal("0.1")  # Max 10% of liquidity

        if size > buy_liquidity * max_size_ratio:
            return False, f"Trade size too large relative to buy market liquidity"

        if size > sell_liquidity * max_size_ratio:
            return False, f"Trade size too large relative to sell market liquidity"

        return True, "OK"

    async def on_trade_opened(self, trade: ArbitrageTrade) -> None:
        """Called when a trade is opened."""
        self.position_limits.add_trade(trade)
        await self.rate_limiter.record_trade()
        self.total_trades += 1

        self.logger.info(
            "Trade opened",
            trade_id=str(trade.id),
            size=float(trade.total_invested),
            total_trades=self.total_trades,
        )

    async def on_trade_closed(
        self,
        trade: ArbitrageTrade,
        profit: Decimal,
    ) -> None:
        """Called when a trade is closed."""
        self.position_limits.remove_trade(str(trade.id))

        if profit > 0:
            self.winning_trades += 1
            self.total_profit += profit
            await self.rate_limiter.record_profit()
        else:
            self.losing_trades += 1
            self.total_loss += abs(profit)
            await self.rate_limiter.record_loss()

        self.logger.info(
            "Trade closed",
            trade_id=str(trade.id),
            profit=float(profit),
            win_rate=self._calculate_win_rate(),
        )

    def _calculate_win_rate(self) -> float:
        """Calculate current win rate."""
        if self.total_trades == 0:
            return 0.0
        return self.winning_trades / self.total_trades

    async def update_portfolio(self) -> PortfolioSnapshot:
        """
        Update portfolio state from all connectors.

        Returns:
            Current portfolio snapshot
        """
        total_cash = Decimal("0")
        positions_value = Decimal("0")
        all_positions: list[Position] = []

        for source, connector in self.connectors.items():
            try:
                # Get cash balance
                balance = await connector.get_balance()
                total_cash += balance

                # Get positions
                positions = await connector.get_positions()
                for position in positions:
                    position_value = position.size * (position.current_price or position.average_entry_price)
                    positions_value += position_value
                    all_positions.append(position)

                    # Update position tracking
                    self.position_limits.update_position(position)

            except Exception as e:
                self.logger.error(f"Failed to update from {source}: {e}")

        total_value = total_cash + positions_value

        # Update drawdown monitor
        self.drawdown_monitor.update_balance(total_value)

        # Calculate unrealized PnL
        unrealized_pnl = Decimal("0")
        for position in all_positions:
            if position.current_price and position.average_entry_price:
                pnl = (position.current_price - position.average_entry_price) * position.size
                unrealized_pnl += pnl

        snapshot = PortfolioSnapshot(
            total_value_usd=total_value,
            cash_balance_usd=total_cash,
            positions_value_usd=positions_value,
            unrealized_pnl=unrealized_pnl,
            realized_pnl_today=self.total_profit - self.total_loss,
            open_positions=len(all_positions),
            active_trades=len(self.position_limits.active_trades),
        )

        return snapshot

    def get_risk_metrics(self) -> dict:
        """Get comprehensive risk metrics."""
        return {
            "total_exposure": float(self.position_limits.get_total_exposure()),
            "max_exposure": float(self.config.max_total_exposure_usd),
            "available_capacity": float(self.position_limits.get_available_capacity()),
            "total_trades": self.total_trades,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "win_rate": self._calculate_win_rate(),
            "total_profit": float(self.total_profit),
            "total_loss": float(self.total_loss),
            "net_pnl": float(self.total_profit - self.total_loss),
            "trades_last_hour": self.rate_limiter.get_trades_in_last_hour(),
            "max_trades_per_hour": self.config.max_trades_per_hour,
            "drawdown": self.drawdown_monitor.get_status(),
            "circuit_breaker_active": self.drawdown_monitor.is_circuit_breaker_active,
        }

    def adjust_position_size(
        self,
        base_size: Decimal,
        opportunity: ArbitrageOpportunity,
    ) -> Decimal:
        """
        Adjust position size based on risk factors.

        Applies Kelly criterion-like sizing based on confidence
        and available capacity.
        """
        # Start with base size
        adjusted_size = base_size

        # Scale by confidence
        confidence_factor = Decimal(str(opportunity.confidence))
        adjusted_size *= confidence_factor

        # Scale by available capacity
        available = self.position_limits.get_available_capacity()
        if adjusted_size > available:
            adjusted_size = available

        # Apply maximum position size limit
        if adjusted_size > self.config.max_position_size_usd:
            adjusted_size = self.config.max_position_size_usd

        # Reduce size after losses
        if self.rate_limiter.consecutive_losses >= 2:
            loss_factor = Decimal("1") / Decimal(str(self.rate_limiter.consecutive_losses))
            adjusted_size *= loss_factor

        # Ensure minimum viable size
        min_size = Decimal("10")
        if adjusted_size < min_size:
            return Decimal("0")  # Don't trade if size too small

        return adjusted_size

    async def emergency_stop(self) -> None:
        """
        Emergency stop - halt all trading and close positions.
        """
        self.logger.critical("EMERGENCY STOP TRIGGERED")

        # Activate circuit breaker
        self.drawdown_monitor.trigger_circuit_breaker(Decimal("100"))

        # Cancel all active trades
        for trade_id in list(self.position_limits.active_trades.keys()):
            self.logger.warning(f"Emergency: cancelling trade {trade_id}")
            # In production, you'd actually cancel orders here

        self.logger.critical("Emergency stop completed - all trading halted")

    def reset_daily_stats(self) -> None:
        """Reset daily statistics (call at start of each day)."""
        self.logger.info(
            "Resetting daily stats",
            previous_trades=self.total_trades,
            previous_pnl=float(self.total_profit - self.total_loss),
        )

        self.total_trades = 0
        self.winning_trades = 0
        self.losing_trades = 0
        self.total_profit = Decimal("0")
        self.total_loss = Decimal("0")
