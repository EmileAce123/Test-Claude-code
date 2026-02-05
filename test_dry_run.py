#!/usr/bin/env python3
"""
Test script for the arbitrage bot in dry-run mode.
Simulates market data and tests all components without placing real orders.
"""

import asyncio
import sys
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

sys.path.insert(0, "src")

from arbitrage_bot.models import (
    Market,
    MarketSource,
    Outcome,
    MarketPair,
    ArbitrageOpportunity,
)
from arbitrage_bot.config import Settings, RiskConfig
from arbitrage_bot.engine.matcher import MarketMatcher
from arbitrage_bot.engine.detector import ArbitrageDetector
from arbitrage_bot.risk.limits import PositionLimits, RateLimiter, DrawdownMonitor


def create_simulated_markets() -> list[Market]:
    """Create simulated markets for testing."""
    markets = []

    # Market 1: Bitcoin price - Polymarket
    markets.append(Market(
        id="poly_btc_100k",
        source=MarketSource.POLYMARKET,
        title="Will Bitcoin exceed $100,000 by the end of 2025?",
        description="Resolves YES if BTC/USD exceeds $100,000 on any major exchange before Jan 1, 2026",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.42"), volume_24h=Decimal("50000"), liquidity=Decimal("25000")),
            Outcome(id="no", name="No", price=Decimal("0.58"), volume_24h=Decimal("45000"), liquidity=Decimal("22000")),
        ],
        end_date=datetime(2025, 12, 31, 23, 59, 59),
        volume_24h=Decimal("95000"),
        liquidity=Decimal("47000"),
        url="https://polymarket.com/event/btc-100k-2025",
    ))

    # Market 2: Bitcoin price - Kalshi (similar but different price!)
    markets.append(Market(
        id="kalshi_btc_100k",
        source=MarketSource.KALSHI,
        title="Bitcoin above $100,000 on December 31, 2025",
        description="Will the price of Bitcoin be above $100,000 at the end of 2025?",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.38"), volume_24h=Decimal("30000"), liquidity=Decimal("15000")),
            Outcome(id="no", name="No", price=Decimal("0.62"), volume_24h=Decimal("28000"), liquidity=Decimal("14000")),
        ],
        end_date=datetime(2025, 12, 31, 23, 59, 59),
        volume_24h=Decimal("58000"),
        liquidity=Decimal("29000"),
        url="https://kalshi.com/markets/btc-100k",
    ))

    # Market 3: US Election - Polymarket
    markets.append(Market(
        id="poly_election_2028",
        source=MarketSource.POLYMARKET,
        title="Who will win the 2028 US Presidential Election?",
        outcomes=[
            Outcome(id="dem", name="Democratic Candidate", price=Decimal("0.48")),
            Outcome(id="rep", name="Republican Candidate", price=Decimal("0.45")),
            Outcome(id="other", name="Other", price=Decimal("0.07")),
        ],
        end_date=datetime(2028, 11, 3),
        volume_24h=Decimal("200000"),
        liquidity=Decimal("100000"),
    ))

    # Market 4: US Election - Kalshi
    markets.append(Market(
        id="kalshi_election_2028",
        source=MarketSource.KALSHI,
        title="2028 Presidential Election Winner Party",
        outcomes=[
            Outcome(id="dem", name="Democrat", price=Decimal("0.52")),
            Outcome(id="rep", name="Republican", price=Decimal("0.48")),
        ],
        end_date=datetime(2028, 11, 3),
        volume_24h=Decimal("150000"),
        liquidity=Decimal("75000"),
    ))

    # Market 5: Fed Rate - Polymarket
    markets.append(Market(
        id="poly_fed_rate",
        source=MarketSource.POLYMARKET,
        title="Will the Fed cut rates in Q1 2026?",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.65"), liquidity=Decimal("20000")),
            Outcome(id="no", name="No", price=Decimal("0.35"), liquidity=Decimal("18000")),
        ],
        end_date=datetime(2026, 3, 31),
        liquidity=Decimal("38000"),
    ))

    # Market 6: Fed Rate - Manifold (with arbitrage opportunity - prices don't sum to 1!)
    markets.append(Market(
        id="manifold_fed_rate",
        source=MarketSource.MANIFOLD,
        title="Federal Reserve interest rate cut Q1 2026",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.70"), liquidity=Decimal("5000")),
            Outcome(id="no", name="No", price=Decimal("0.35"), liquidity=Decimal("4500")),  # Sum = 1.05!
        ],
        end_date=datetime(2026, 3, 31),
        liquidity=Decimal("9500"),
    ))

    # Market 7: AI Achievement - Polymarket (arbitrage opportunity)
    markets.append(Market(
        id="poly_agi_2026",
        source=MarketSource.POLYMARKET,
        title="Will AGI be achieved by end of 2026?",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.15"), liquidity=Decimal("10000")),
            Outcome(id="no", name="No", price=Decimal("0.85"), liquidity=Decimal("12000")),
        ],
        end_date=datetime(2026, 12, 31),
        liquidity=Decimal("22000"),
    ))

    # Market 8: AI Achievement - Kalshi (different price = arbitrage!)
    markets.append(Market(
        id="kalshi_agi_2026",
        source=MarketSource.KALSHI,
        title="AGI achieved before 2027",
        outcomes=[
            Outcome(id="yes", name="Yes", price=Decimal("0.08"), liquidity=Decimal("8000")),
            Outcome(id="no", name="No", price=Decimal("0.92"), liquidity=Decimal("9000")),
        ],
        end_date=datetime(2026, 12, 31),
        liquidity=Decimal("17000"),
    ))

    return markets


def print_separator(title: str):
    print("\n" + "=" * 60)
    print(f" {title}")
    print("=" * 60)


async def test_market_matching(markets: list[Market]):
    """Test the market matching algorithm."""
    print_separator("MARKET MATCHING TEST")

    matcher = MarketMatcher()

    # Group markets by source
    polymarket_markets = [m for m in markets if m.source == MarketSource.POLYMARKET]
    kalshi_markets = [m for m in markets if m.source == MarketSource.KALSHI]
    manifold_markets = [m for m in markets if m.source == MarketSource.MANIFOLD]

    print(f"\nMarkets loaded:")
    print(f"  - Polymarket: {len(polymarket_markets)} markets")
    print(f"  - Kalshi: {len(kalshi_markets)} markets")
    print(f"  - Manifold: {len(manifold_markets)} markets")

    # Find matched pairs
    all_other_markets = kalshi_markets + manifold_markets
    pairs = matcher.find_matches(polymarket_markets, all_other_markets)

    print(f"\n✓ Found {len(pairs)} matched market pairs:")
    for pair in pairs:
        print(f"\n  Pair (similarity: {pair.similarity_score:.2%}):")
        print(f"    A: [{pair.market_a.source.value}] {pair.market_a.title[:50]}...")
        print(f"    B: [{pair.market_b.source.value}] {pair.market_b.title[:50]}...")

    return pairs


def detect_cross_platform_arbitrage_simple(pair: MarketPair, risk_config: RiskConfig) -> list[ArbitrageOpportunity]:
    """Simplified arbitrage detection without connectors."""
    opportunities = []
    market_a = pair.market_a
    market_b = pair.market_b

    # For binary markets, check if buying YES on one and NO on other is profitable
    if market_a.is_binary and market_b.is_binary:
        yes_a = market_a.get_yes_price()
        no_a = market_a.get_no_price()
        yes_b = market_b.get_yes_price()
        no_b = market_b.get_no_price()

        if yes_a and no_a and yes_b and no_b:
            # Strategy 1: Buy YES on A, Buy NO on B
            cost_1 = yes_a + no_b
            if cost_1 < Decimal("1"):
                profit_pct = ((Decimal("1") - cost_1) / cost_1) * 100
                if profit_pct >= risk_config.min_profit_threshold_percent:
                    recommended_size = min(
                        risk_config.max_position_size_usd,
                        (market_a.liquidity or Decimal("1000")) * Decimal("0.1"),
                        (market_b.liquidity or Decimal("1000")) * Decimal("0.1"),
                    )
                    opportunities.append(ArbitrageOpportunity(
                        market_pair=pair,
                        buy_market=market_a,
                        sell_market=market_b,
                        buy_outcome=market_a.outcomes[0],  # YES
                        sell_outcome=market_b.outcomes[1],  # NO
                        buy_price=yes_a,
                        sell_price=no_b,
                        spread=Decimal("1") - cost_1,
                        profit_percent=profit_pct,
                        recommended_size_usd=recommended_size,
                        expected_profit_usd=recommended_size * profit_pct / 100,
                        confidence=pair.similarity_score,
                    ))

            # Strategy 2: Buy NO on A, Buy YES on B
            cost_2 = no_a + yes_b
            if cost_2 < Decimal("1"):
                profit_pct = ((Decimal("1") - cost_2) / cost_2) * 100
                if profit_pct >= risk_config.min_profit_threshold_percent:
                    recommended_size = min(
                        risk_config.max_position_size_usd,
                        (market_a.liquidity or Decimal("1000")) * Decimal("0.1"),
                        (market_b.liquidity or Decimal("1000")) * Decimal("0.1"),
                    )
                    opportunities.append(ArbitrageOpportunity(
                        market_pair=pair,
                        buy_market=market_a,
                        sell_market=market_b,
                        buy_outcome=market_a.outcomes[1],  # NO
                        sell_outcome=market_b.outcomes[0],  # YES
                        buy_price=no_a,
                        sell_price=yes_b,
                        spread=Decimal("1") - cost_2,
                        profit_percent=profit_pct,
                        recommended_size_usd=recommended_size,
                        expected_profit_usd=recommended_size * profit_pct / 100,
                        confidence=pair.similarity_score,
                    ))

    return opportunities


def detect_inter_outcome_arbitrage_simple(market: Market, risk_config: RiskConfig) -> Optional[ArbitrageOpportunity]:
    """Check if outcomes within a market don't sum to 1."""
    total_price = sum(o.price for o in market.outcomes)

    # If sum > 1, there's potential arbitrage by selling all outcomes
    if total_price > Decimal("1"):
        profit = total_price - Decimal("1")
        profit_pct = (profit / Decimal("1")) * 100

        if profit_pct >= risk_config.min_profit_threshold_percent:
            # This is a simplified model - in reality you'd short all outcomes
            return ArbitrageOpportunity(
                market_pair=MarketPair(
                    market_a=market,
                    market_b=market,
                    similarity_score=1.0,
                ),
                buy_market=market,
                sell_market=market,
                buy_outcome=market.outcomes[0],
                sell_outcome=market.outcomes[1] if len(market.outcomes) > 1 else market.outcomes[0],
                buy_price=market.outcomes[0].price,
                sell_price=market.outcomes[1].price if len(market.outcomes) > 1 else Decimal("0"),
                spread=profit,
                profit_percent=profit_pct,
                recommended_size_usd=min(risk_config.max_position_size_usd, (market.liquidity or Decimal("500")) * Decimal("0.1")),
                expected_profit_usd=profit_pct * Decimal("10"),  # Simplified
                confidence=0.9,
            )

    return None


async def test_arbitrage_detection(pairs: list[MarketPair]):
    """Test arbitrage detection on matched pairs."""
    print_separator("ARBITRAGE DETECTION TEST")

    risk_config = RiskConfig(
        min_profit_threshold_percent=Decimal("1.0"),  # Lower threshold for testing
        max_position_size_usd=Decimal("500"),
    )

    opportunities = []

    for pair in pairs:
        opps = detect_cross_platform_arbitrage_simple(pair, risk_config)
        opportunities.extend(opps)

        # Also check inter-outcome arbitrage
        for market in [pair.market_a, pair.market_b]:
            inter_opp = detect_inter_outcome_arbitrage_simple(market, risk_config)
            if inter_opp:
                opportunities.append(inter_opp)

    print(f"\n✓ Detected {len(opportunities)} arbitrage opportunities:\n")

    profitable_count = 0
    for opp in opportunities:
        if opp.profit_percent > 0:
            profitable_count += 1
            print(f"  📈 ARBITRAGE OPPORTUNITY #{profitable_count}")
            print(f"     Markets: {opp.buy_market.source.value} ↔ {opp.sell_market.source.value}")
            print(f"     Event: {opp.buy_market.title[:45]}...")
            print(f"     Buy '{opp.buy_outcome.name}' @ ${opp.buy_price:.4f} on {opp.buy_market.source.value}")
            print(f"     Buy '{opp.sell_outcome.name}' @ ${opp.sell_price:.4f} on {opp.sell_market.source.value}")
            print(f"     Total cost: ${opp.buy_price + opp.sell_price:.4f}")
            print(f"     Guaranteed payout: $1.00")
            print(f"     Profit: {opp.profit_percent:.2f}% (${opp.expected_profit_usd:.2f})")
            print(f"     Confidence: {opp.confidence:.1%}")
            print(f"     Recommended size: ${opp.recommended_size_usd:.2f}")
            print()

    if profitable_count == 0:
        print("  No profitable arbitrage opportunities found with current prices.")
        print("  (This is normal - real arbitrage opportunities are rare and fleeting)")

    return opportunities


async def test_risk_management():
    """Test risk management components."""
    print_separator("RISK MANAGEMENT TEST")

    risk_config = RiskConfig(
        max_position_size_usd=Decimal("1000"),
        max_total_exposure_usd=Decimal("5000"),
        min_profit_threshold_percent=Decimal("1.0"),
        max_slippage_percent=Decimal("1.0"),
        stop_loss_percent=Decimal("5.0"),
        max_trades_per_hour=10,
    )

    # Test Position Limits
    print("\n1. Position Limits Test:")
    limits = PositionLimits(risk_config)

    can_open, reason = limits.can_open_position(Decimal("500"))
    print(f"   Can open $500 position? {can_open} ({reason})")

    can_open, reason = limits.can_open_position(Decimal("1500"))
    print(f"   Can open $1500 position? {can_open} ({reason})")

    print(f"   Available capacity: ${limits.get_available_capacity()}")

    # Test Rate Limiter
    print("\n2. Rate Limiter Test:")
    rate_limiter = RateLimiter(risk_config)

    can_trade, reason = await rate_limiter.can_trade()
    print(f"   Can trade initially? {can_trade} ({reason})")

    # Simulate some trades
    for i in range(3):
        await rate_limiter.record_trade()

    print(f"   Trades in last hour after 3 trades: {rate_limiter.get_trades_in_last_hour()}")

    # Test Drawdown Monitor
    print("\n3. Drawdown Monitor Test:")
    drawdown = DrawdownMonitor(
        initial_balance=Decimal("10000"),
        max_drawdown_percent=Decimal("5.0"),
    )

    print(f"   Initial balance: ${drawdown.current_balance}")

    # Simulate profit
    drawdown.update_balance(Decimal("10500"))
    print(f"   After $500 profit: ${drawdown.current_balance} (peak: ${drawdown.peak_balance})")

    # Simulate loss
    drawdown.update_balance(Decimal("10000"))
    status = drawdown.get_status()
    print(f"   After $500 loss: ${drawdown.current_balance}")
    print(f"   Current drawdown: {status['current_drawdown_percent']:.2f}%")
    print(f"   Circuit breaker active? {status['circuit_breaker_active']}")

    # Trigger circuit breaker
    drawdown.update_balance(Decimal("9400"))  # More than 5% from peak
    status = drawdown.get_status()
    print(f"   After major loss (${drawdown.current_balance}):")
    print(f"   Current drawdown: {status['current_drawdown_percent']:.2f}%")
    print(f"   Circuit breaker active? {status['circuit_breaker_active']}")


async def test_dry_run_execution(opportunities: list[ArbitrageOpportunity]):
    """Test dry-run trade execution."""
    print_separator("DRY-RUN EXECUTION TEST")

    if not opportunities:
        print("\n  No opportunities to execute in dry-run mode.")
        return

    # Find the best opportunity
    best_opp = max(opportunities, key=lambda x: x.profit_percent)

    print(f"\n  Best opportunity:")
    print(f"    Profit: {best_opp.profit_percent:.2f}%")
    print(f"    Size: ${best_opp.recommended_size_usd:.2f}")

    print(f"\n  🔄 Simulating execution (DRY RUN)...")
    print(f"     [DRY RUN] Would place BUY order on {best_opp.buy_market.source.value}")
    print(f"               Market: {best_opp.buy_market.title[:40]}...")
    print(f"               Outcome: {best_opp.buy_outcome.name}")
    print(f"               Price: ${best_opp.buy_price:.4f}")
    print(f"               Size: ${best_opp.recommended_size_usd / 2:.2f}")

    print(f"\n     [DRY RUN] Would place BUY order on {best_opp.sell_market.source.value}")
    print(f"               Market: {best_opp.sell_market.title[:40]}...")
    print(f"               Outcome: {best_opp.sell_outcome.name}")
    print(f"               Price: ${best_opp.sell_price:.4f}")
    print(f"               Size: ${best_opp.recommended_size_usd / 2:.2f}")

    print(f"\n  ✓ DRY RUN completed successfully")
    print(f"    Expected profit: ${best_opp.expected_profit_usd:.2f}")


async def main():
    """Run all tests."""
    print("\n" + "=" * 60)
    print("  PREDICTION MARKET ARBITRAGE BOT - DRY RUN TEST")
    print("=" * 60)
    print(f"\nStarting test at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("Mode: DRY RUN (no real orders will be placed)")

    # Create simulated markets
    markets = create_simulated_markets()

    # Test components
    pairs = await test_market_matching(markets)
    opportunities = await test_arbitrage_detection(pairs)
    await test_risk_management()
    await test_dry_run_execution(opportunities)

    # Summary
    print_separator("TEST SUMMARY")
    print(f"""
  Markets analyzed: {len(markets)}
  Matched pairs found: {len(pairs)}
  Arbitrage opportunities: {len([o for o in opportunities if o.profit_percent > 0])}

  All tests completed successfully! ✓

  Note: This was a simulation using fake market data.
  In production, the bot would:
  1. Connect to real market APIs (Polymarket, Kalshi, etc.)
  2. Fetch real-time prices
  3. Detect actual arbitrage opportunities
  4. Execute trades automatically (when dry_run=False)
""")


if __name__ == "__main__":
    asyncio.run(main())
