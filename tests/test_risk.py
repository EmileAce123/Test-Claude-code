"""Tests for risk management."""

from decimal import Decimal

import pytest

from arbitrage_bot.config import RiskConfig
from arbitrage_bot.risk.limits import DrawdownMonitor, PositionLimits, RateLimiter


@pytest.fixture
def risk_config():
    return RiskConfig(
        max_position_size_usd=Decimal("1000"),
        max_total_exposure_usd=Decimal("5000"),
        min_profit_threshold_percent=Decimal("2.0"),
        max_slippage_percent=Decimal("1.0"),
        stop_loss_percent=Decimal("5.0"),
        max_trades_per_hour=20,
        cooldown_after_loss_seconds=300,
    )


class TestPositionLimits:
    def test_can_open_position_within_limits(self, risk_config):
        limits = PositionLimits(risk_config)

        can_open, reason = limits.can_open_position(Decimal("500"))
        assert can_open
        assert reason == "OK"

    def test_can_open_position_exceeds_max_size(self, risk_config):
        limits = PositionLimits(risk_config)

        can_open, reason = limits.can_open_position(Decimal("1500"))  # Over $1000 max
        assert not can_open
        assert "exceeds max" in reason.lower()

    def test_can_open_position_exceeds_total_exposure(self, risk_config):
        limits = PositionLimits(risk_config)

        # Add existing exposure
        from arbitrage_bot.models import Market, MarketSource, Outcome, Position

        position = Position(
            market=Market(
                id="test",
                source=MarketSource.POLYMARKET,
                title="Test",
                outcomes=[],
            ),
            outcome=Outcome(id="yes", name="Yes", price=Decimal("0.5")),
            source=MarketSource.POLYMARKET,
            size=Decimal("4500"),
            average_entry_price=Decimal("1"),
        )
        limits.add_position(position)

        # Try to open new position that would exceed total
        can_open, reason = limits.can_open_position(Decimal("1000"))
        assert not can_open
        assert "total exposure" in reason.lower()

    def test_get_available_capacity(self, risk_config):
        limits = PositionLimits(risk_config)
        capacity = limits.get_available_capacity()
        assert capacity == Decimal("5000")


class TestRateLimiter:
    @pytest.mark.asyncio
    async def test_can_trade_initial(self, risk_config):
        limiter = RateLimiter(risk_config)

        can_trade, reason = await limiter.can_trade()
        assert can_trade
        assert reason == "OK"

    @pytest.mark.asyncio
    async def test_record_trade(self, risk_config):
        limiter = RateLimiter(risk_config)

        await limiter.record_trade()
        assert limiter.get_trades_in_last_hour() == 1

    @pytest.mark.asyncio
    async def test_rate_limit_exceeded(self, risk_config):
        config = RiskConfig(
            max_trades_per_hour=2,
            cooldown_after_loss_seconds=0,
        )
        limiter = RateLimiter(config)

        # Make 2 trades (the limit)
        await limiter.record_trade()
        await limiter.record_trade()

        # Third should be blocked
        can_trade, reason = await limiter.can_trade()
        assert not can_trade
        assert "max trades" in reason.lower()

    @pytest.mark.asyncio
    async def test_consecutive_losses_tracking(self, risk_config):
        limiter = RateLimiter(risk_config)

        await limiter.record_loss()
        assert limiter.consecutive_losses == 1

        await limiter.record_loss()
        assert limiter.consecutive_losses == 2

        await limiter.record_profit()
        assert limiter.consecutive_losses == 0


class TestDrawdownMonitor:
    def test_initial_state(self):
        monitor = DrawdownMonitor(
            initial_balance=Decimal("10000"),
            max_drawdown_percent=Decimal("10"),
        )

        assert monitor.current_balance == Decimal("10000")
        assert monitor.peak_balance == Decimal("10000")
        assert not monitor.is_circuit_breaker_active

    def test_update_balance_increase(self):
        monitor = DrawdownMonitor(
            initial_balance=Decimal("10000"),
            max_drawdown_percent=Decimal("10"),
        )

        monitor.update_balance(Decimal("11000"))

        assert monitor.current_balance == Decimal("11000")
        assert monitor.peak_balance == Decimal("11000")

    def test_update_balance_decrease(self):
        monitor = DrawdownMonitor(
            initial_balance=Decimal("10000"),
            max_drawdown_percent=Decimal("10"),
        )

        monitor.update_balance(Decimal("9500"))

        assert monitor.current_balance == Decimal("9500")
        assert monitor.peak_balance == Decimal("10000")

    def test_circuit_breaker_trigger(self):
        monitor = DrawdownMonitor(
            initial_balance=Decimal("10000"),
            max_drawdown_percent=Decimal("10"),
        )

        # 10% drawdown should trigger
        monitor.update_balance(Decimal("9000"))

        assert monitor.is_circuit_breaker_active

    def test_circuit_breaker_not_triggered(self):
        monitor = DrawdownMonitor(
            initial_balance=Decimal("10000"),
            max_drawdown_percent=Decimal("10"),
        )

        # 5% drawdown should not trigger
        monitor.update_balance(Decimal("9500"))

        assert not monitor.is_circuit_breaker_active

    def test_get_status(self):
        monitor = DrawdownMonitor(
            initial_balance=Decimal("10000"),
            max_drawdown_percent=Decimal("10"),
        )
        monitor.update_balance(Decimal("9500"))

        status = monitor.get_status()

        assert status["initial_balance"] == 10000
        assert status["current_balance"] == 9500
        assert status["peak_balance"] == 10000
        assert status["current_drawdown_percent"] == 5.0
        assert not status["circuit_breaker_active"]

    def test_reset_circuit_breaker(self):
        monitor = DrawdownMonitor(
            initial_balance=Decimal("10000"),
            max_drawdown_percent=Decimal("10"),
        )

        monitor.trigger_circuit_breaker(Decimal("15"))
        assert monitor.is_circuit_breaker_active

        monitor.reset_circuit_breaker()
        assert not monitor.is_circuit_breaker_active
