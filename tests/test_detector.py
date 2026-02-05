"""Tests for the arbitrage detector."""

from datetime import datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock

import pytest

from arbitrage_bot.config import RiskConfig
from arbitrage_bot.engine.detector import ArbitrageDetector
from arbitrage_bot.models import Market, MarketPair, MarketSource, Outcome


@pytest.fixture
def risk_config():
    return RiskConfig(
        max_position_size_usd=Decimal("1000"),
        max_total_exposure_usd=Decimal("5000"),
        min_profit_threshold_percent=Decimal("2.0"),
        max_slippage_percent=Decimal("1.0"),
    )


@pytest.fixture
def mock_connectors():
    poly_connector = MagicMock()
    poly_connector.get_market = AsyncMock()
    poly_connector.get_fees = MagicMock(return_value={
        "maker_fee": Decimal("0"),
        "taker_fee": Decimal("0.02"),
    })

    kalshi_connector = MagicMock()
    kalshi_connector.get_market = AsyncMock()
    kalshi_connector.get_fees = MagicMock(return_value={
        "maker_fee": Decimal("0"),
        "taker_fee": Decimal("0.01"),
    })

    return {
        MarketSource.POLYMARKET: poly_connector,
        MarketSource.KALSHI: kalshi_connector,
    }


@pytest.fixture
def detector(mock_connectors, risk_config):
    return ArbitrageDetector(
        connectors=mock_connectors,
        risk_config=risk_config,
    )


@pytest.fixture
def market_with_arbitrage():
    """Market pair with clear arbitrage opportunity."""
    market_a = Market(
        id="market_a",
        source=MarketSource.POLYMARKET,
        title="Test Market A",
        outcomes=[
            Outcome(id="yes_a", name="Yes", price=Decimal("0.45")),
            Outcome(id="no_a", name="No", price=Decimal("0.55")),
        ],
        liquidity=Decimal("10000"),
    )

    market_b = Market(
        id="market_b",
        source=MarketSource.KALSHI,
        title="Test Market B",
        outcomes=[
            Outcome(id="yes_b", name="Yes", price=Decimal("0.52")),
            Outcome(id="no_b", name="No", price=Decimal("0.48")),
        ],
        liquidity=Decimal("10000"),
    )

    return MarketPair(
        market_a=market_a,
        market_b=market_b,
        similarity_score=0.9,
    )


@pytest.fixture
def market_no_arbitrage():
    """Market pair with no arbitrage opportunity."""
    market_a = Market(
        id="market_a",
        source=MarketSource.POLYMARKET,
        title="Test Market A",
        outcomes=[
            Outcome(id="yes_a", name="Yes", price=Decimal("0.50")),
            Outcome(id="no_a", name="No", price=Decimal("0.50")),
        ],
        liquidity=Decimal("10000"),
    )

    market_b = Market(
        id="market_b",
        source=MarketSource.KALSHI,
        title="Test Market B",
        outcomes=[
            Outcome(id="yes_b", name="Yes", price=Decimal("0.50")),
            Outcome(id="no_b", name="No", price=Decimal("0.50")),
        ],
        liquidity=Decimal("10000"),
    )

    return MarketPair(
        market_a=market_a,
        market_b=market_b,
        similarity_score=0.9,
    )


class TestArbitrageDetector:
    def test_find_outcome(self, detector, market_with_arbitrage):
        market = market_with_arbitrage.market_a
        yes_outcome = detector._find_outcome(market, "yes")
        no_outcome = detector._find_outcome(market, "no")

        assert yes_outcome is not None
        assert yes_outcome.name == "Yes"
        assert no_outcome is not None
        assert no_outcome.name == "No"

    def test_detect_cross_platform_arbitrage_with_opportunity(
        self, detector, market_with_arbitrage
    ):
        market_a = market_with_arbitrage.market_a
        market_b = market_with_arbitrage.market_b

        opportunities = detector._detect_cross_platform_arbitrage(
            market_a, market_b, market_with_arbitrage
        )

        # Yes on A (0.45) + No on B (0.48) = 0.93 < 1.0 -> Profit!
        assert len(opportunities) > 0
        assert any(opp.profit_percent > Decimal("0") for opp in opportunities)

    def test_detect_cross_platform_arbitrage_no_opportunity(
        self, detector, market_no_arbitrage
    ):
        market_a = market_no_arbitrage.market_a
        market_b = market_no_arbitrage.market_b

        opportunities = detector._detect_cross_platform_arbitrage(
            market_a, market_b, market_no_arbitrage
        )

        # 0.50 + 0.50 = 1.0 -> No profit
        profitable_opps = [
            opp for opp in opportunities
            if opp.profit_percent > Decimal("2")  # Min threshold
        ]
        assert len(profitable_opps) == 0

    def test_detect_inter_outcome_arbitrage_underpriced(self, detector):
        market = Market(
            id="underpriced",
            source=MarketSource.POLYMARKET,
            title="Underpriced Market",
            outcomes=[
                Outcome(id="yes", name="Yes", price=Decimal("0.40")),
                Outcome(id="no", name="No", price=Decimal("0.50")),
            ],  # Sum = 0.90, should be 1.0
            liquidity=Decimal("10000"),
        )

        opportunities = detector._detect_inter_outcome_arbitrage(market)

        # Total = 0.90 < 1.0 -> Buy all for guaranteed profit
        assert len(opportunities) > 0

    def test_detect_inter_outcome_arbitrage_normal(self, detector):
        market = Market(
            id="normal",
            source=MarketSource.POLYMARKET,
            title="Normal Market",
            outcomes=[
                Outcome(id="yes", name="Yes", price=Decimal("0.50")),
                Outcome(id="no", name="No", price=Decimal("0.50")),
            ],  # Sum = 1.0, normal
            liquidity=Decimal("10000"),
        )

        opportunities = detector._detect_inter_outcome_arbitrage(market)

        # Total = 1.0 -> No arbitrage
        assert len(opportunities) == 0

    def test_calculate_recommended_size(self, detector):
        # Small profit -> Small size
        small_size = detector._calculate_recommended_size(
            spread=Decimal("0.03"),
            profit_percent=Decimal("3"),
        )

        # Large profit -> Larger size
        large_size = detector._calculate_recommended_size(
            spread=Decimal("0.15"),
            profit_percent=Decimal("15"),
        )

        assert large_size > small_size

    def test_calculate_confidence(self, detector, market_with_arbitrage):
        confidence = detector._calculate_confidence(
            pair=market_with_arbitrage,
            buy_market=market_with_arbitrage.market_a,
            sell_market=market_with_arbitrage.market_b,
            spread=Decimal("0.03"),
            profit_percent=Decimal("3"),
        )

        assert 0 <= confidence <= 1

    def test_validate_opportunity(self, detector, market_with_arbitrage):
        from arbitrage_bot.models import ArbitrageOpportunity

        opportunity = ArbitrageOpportunity(
            market_pair=market_with_arbitrage,
            buy_market=market_with_arbitrage.market_a,
            sell_market=market_with_arbitrage.market_b,
            buy_outcome=market_with_arbitrage.market_a.outcomes[0],
            sell_outcome=market_with_arbitrage.market_b.outcomes[1],
            buy_price=Decimal("0.45"),
            sell_price=Decimal("0.48"),
            spread=Decimal("0.07"),
            profit_percent=Decimal("7"),
            recommended_size_usd=Decimal("500"),
            expected_profit_usd=Decimal("35"),
            confidence=0.8,
        )

        is_valid, reason = detector.validate_opportunity(opportunity)
        assert is_valid
        assert reason == "Valid"

    def test_validate_opportunity_low_profit(self, detector, market_with_arbitrage):
        from arbitrage_bot.models import ArbitrageOpportunity

        opportunity = ArbitrageOpportunity(
            market_pair=market_with_arbitrage,
            buy_market=market_with_arbitrage.market_a,
            sell_market=market_with_arbitrage.market_b,
            buy_outcome=market_with_arbitrage.market_a.outcomes[0],
            sell_outcome=market_with_arbitrage.market_b.outcomes[1],
            buy_price=Decimal("0.49"),
            sell_price=Decimal("0.50"),
            spread=Decimal("0.01"),
            profit_percent=Decimal("1"),  # Below 2% threshold
            recommended_size_usd=Decimal("500"),
            expected_profit_usd=Decimal("5"),
            confidence=0.8,
        )

        is_valid, reason = detector.validate_opportunity(opportunity)
        assert not is_valid
        assert "below threshold" in reason.lower()
