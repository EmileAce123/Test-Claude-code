"""Tests for the market matcher."""

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from arbitrage_bot.engine.matcher import MarketMatcher
from arbitrage_bot.models import Market, MarketSource, Outcome


@pytest.fixture
def matcher():
    return MarketMatcher(similarity_threshold=0.6)


@pytest.fixture
def polymarket_market():
    return Market(
        id="poly_btc_100k",
        source=MarketSource.POLYMARKET,
        title="Will Bitcoin exceed $100,000 by end of 2024?",
        description="Bitcoin price prediction",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.45")),
            Outcome(id="no", name="No", price=Decimal("0.55")),
        ],
        end_date=datetime(2024, 12, 31),
        volume_24h=Decimal("50000"),
        liquidity=Decimal("100000"),
    )


@pytest.fixture
def kalshi_market():
    return Market(
        id="kalshi_btc_100k",
        source=MarketSource.KALSHI,
        title="BTC price above $100,000 on December 31, 2024",
        description="Bitcoin price contract",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.50")),
            Outcome(id="no", name="No", price=Decimal("0.50")),
        ],
        end_date=datetime(2024, 12, 31),
        volume_24h=Decimal("30000"),
        liquidity=Decimal("80000"),
    )


@pytest.fixture
def unrelated_market():
    return Market(
        id="unrelated",
        source=MarketSource.MANIFOLD,
        title="Will it rain tomorrow in Tokyo?",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.30")),
            Outcome(id="no", name="No", price=Decimal("0.70")),
        ],
        end_date=datetime(2024, 6, 15),
    )


class TestMarketMatcher:
    def test_normalize_text(self, matcher):
        text = "Will BITCOIN exceed $100,000?"
        normalized = matcher._normalize_text(text)

        assert "bitcoin" in normalized.lower()
        assert "100000" in normalized or "100" in normalized

    def test_text_similarity_identical(self, matcher):
        text = "Will Bitcoin reach $100k?"
        similarity = matcher._text_similarity(text, text)
        assert similarity == 1.0

    def test_text_similarity_similar(self, matcher):
        text_a = "Will Bitcoin exceed $100,000?"
        text_b = "Bitcoin price above $100,000"
        similarity = matcher._text_similarity(text_a, text_b)
        assert similarity > 0.5

    def test_text_similarity_different(self, matcher):
        text_a = "Will Bitcoin reach $100k?"
        text_b = "Will it rain tomorrow?"
        similarity = matcher._text_similarity(text_a, text_b)
        assert similarity < 0.3

    def test_outcome_similarity_binary(self, matcher, polymarket_market, kalshi_market):
        similarity = matcher._outcome_similarity(polymarket_market, kalshi_market)
        assert similarity == 1.0  # Both binary

    def test_date_similarity_same_date(self, matcher):
        date = datetime(2024, 12, 31)
        similarity = matcher._date_similarity(date, date)
        assert similarity == 1.0

    def test_date_similarity_close_dates(self, matcher):
        date_a = datetime(2024, 12, 31)
        date_b = datetime(2024, 12, 25)
        similarity = matcher._date_similarity(date_a, date_b)
        assert similarity > 0.8

    def test_date_similarity_far_dates(self, matcher):
        date_a = datetime(2024, 12, 31)
        date_b = datetime(2024, 6, 1)
        similarity = matcher._date_similarity(date_a, date_b)
        assert similarity < 0.5

    def test_calculate_similarity_matching_markets(
        self, matcher, polymarket_market, kalshi_market
    ):
        similarity = matcher.calculate_similarity(polymarket_market, kalshi_market)
        assert similarity > 0.6  # Should match

    def test_calculate_similarity_different_markets(
        self, matcher, polymarket_market, unrelated_market
    ):
        similarity = matcher.calculate_similarity(polymarket_market, unrelated_market)
        assert similarity < 0.5  # Should not match

    def test_find_matches(self, matcher, polymarket_market, kalshi_market, unrelated_market):
        markets_a = [polymarket_market]
        markets_b = [kalshi_market, unrelated_market]

        pairs = matcher.find_matches(markets_a, markets_b)

        assert len(pairs) == 1
        assert pairs[0].market_a.id == polymarket_market.id
        assert pairs[0].market_b.id == kalshi_market.id

    def test_extract_entities(self, matcher):
        text = "Will Trump win the 2024 election?"
        entities = matcher.extract_entities(text)

        assert "2024" in entities["dates"]
        assert "Trump" in entities["persons"]
        assert "Election" in entities["events"]
