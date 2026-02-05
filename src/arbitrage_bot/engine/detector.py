"""
Arbitrage opportunity detection engine.

Analyzes matched market pairs to find profitable arbitrage opportunities.
"""

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

import structlog

from ..config import RiskConfig
from ..connectors.base import BaseConnector
from ..models import (
    ArbitrageOpportunity,
    Market,
    MarketPair,
    MarketSource,
    Outcome,
)

logger = structlog.get_logger()


class ArbitrageDetector:
    """
    Detects arbitrage opportunities between matched prediction markets.

    Supports multiple arbitrage strategies:
    1. Cross-platform arbitrage: Same event, different prices
    2. Inter-outcome arbitrage: Prices don't sum to 1 within a market
    3. Temporal arbitrage: Price discrepancies over time
    """

    def __init__(
        self,
        connectors: dict[MarketSource, BaseConnector],
        risk_config: RiskConfig,
    ):
        self.connectors = connectors
        self.risk_config = risk_config
        self.logger = logger.bind(component="arbitrage_detector")

    async def scan_pair(
        self,
        pair: MarketPair,
    ) -> list[ArbitrageOpportunity]:
        """
        Scan a market pair for arbitrage opportunities.

        Args:
            pair: The matched market pair to analyze

        Returns:
            List of detected arbitrage opportunities
        """
        opportunities = []

        # Refresh market data
        market_a = await self._refresh_market(pair.market_a)
        market_b = await self._refresh_market(pair.market_b)

        if not market_a or not market_b:
            return opportunities

        # Check cross-platform arbitrage
        cross_platform_opps = self._detect_cross_platform_arbitrage(
            market_a, market_b, pair
        )
        opportunities.extend(cross_platform_opps)

        # Check inter-outcome arbitrage for each market
        for market in [market_a, market_b]:
            inter_outcome_opps = self._detect_inter_outcome_arbitrage(market)
            opportunities.extend(inter_outcome_opps)

        # Filter by minimum profit threshold
        min_profit = self.risk_config.min_profit_threshold_percent
        opportunities = [
            opp for opp in opportunities
            if opp.profit_percent >= min_profit
        ]

        if opportunities:
            self.logger.info(
                f"Found {len(opportunities)} arbitrage opportunities",
                pair_id=str(pair.id),
            )

        return opportunities

    async def _refresh_market(self, market: Market) -> Optional[Market]:
        """Refresh market data from the connector."""
        connector = self.connectors.get(market.source)
        if not connector:
            self.logger.warning(f"No connector for {market.source}")
            return None

        try:
            return await connector.get_market(market.id)
        except Exception as e:
            self.logger.error(f"Failed to refresh market: {e}", market_id=market.id)
            return None

    def _detect_cross_platform_arbitrage(
        self,
        market_a: Market,
        market_b: Market,
        pair: MarketPair,
    ) -> list[ArbitrageOpportunity]:
        """
        Detect arbitrage between the same event on different platforms.

        The basic strategy:
        - If "Yes" on Platform A is cheaper than "No" on Platform B (inverted)
        - Buy Yes on A, Buy No on B (which is selling Yes effectively)
        - Guaranteed profit if prices diverge enough
        """
        opportunities = []

        if not market_a.is_binary or not market_b.is_binary:
            # For now, only handle binary markets
            return opportunities

        price_yes_a = market_a.get_yes_price()
        price_yes_b = market_b.get_yes_price()
        price_no_a = market_a.get_no_price()
        price_no_b = market_b.get_no_price()

        if not all([price_yes_a, price_yes_b, price_no_a, price_no_b]):
            return opportunities

        # Get fees for both platforms
        fees_a = self._get_connector_fees(market_a.source)
        fees_b = self._get_connector_fees(market_b.source)

        # Strategy 1: Buy Yes on A, Buy No on B
        # Profit if: price_yes_a + price_no_b < 1 (after fees)
        cost_1 = price_yes_a * (1 + fees_a) + price_no_b * (1 + fees_b)
        if cost_1 < Decimal("1"):
            spread = Decimal("1") - cost_1
            profit_pct = (spread / cost_1) * 100

            opp = self._create_opportunity(
                pair=pair,
                buy_market=market_a,
                sell_market=market_b,
                buy_outcome=self._find_outcome(market_a, "yes"),
                sell_outcome=self._find_outcome(market_b, "no"),
                buy_price=price_yes_a,
                sell_price=price_no_b,
                spread=spread,
                profit_percent=profit_pct,
            )
            if opp:
                opportunities.append(opp)

        # Strategy 2: Buy No on A, Buy Yes on B
        cost_2 = price_no_a * (1 + fees_a) + price_yes_b * (1 + fees_b)
        if cost_2 < Decimal("1"):
            spread = Decimal("1") - cost_2
            profit_pct = (spread / cost_2) * 100

            opp = self._create_opportunity(
                pair=pair,
                buy_market=market_a,
                sell_market=market_b,
                buy_outcome=self._find_outcome(market_a, "no"),
                sell_outcome=self._find_outcome(market_b, "yes"),
                buy_price=price_no_a,
                sell_price=price_yes_b,
                spread=spread,
                profit_percent=profit_pct,
            )
            if opp:
                opportunities.append(opp)

        return opportunities

    def _detect_inter_outcome_arbitrage(
        self,
        market: Market,
    ) -> list[ArbitrageOpportunity]:
        """
        Detect arbitrage within a single market where outcome prices
        don't properly sum to 1.

        For binary markets: Yes + No should = 1
        For multi-outcome: Sum of all outcomes should = 1
        """
        opportunities = []

        total_price = sum(outcome.price for outcome in market.outcomes)

        # Check if prices sum to more or less than 1
        fees = self._get_connector_fees(market.source)
        threshold = Decimal("0.02")  # 2% threshold

        if total_price > Decimal("1") + threshold:
            # Overpriced: Could sell all outcomes
            spread = total_price - Decimal("1")
            profit_pct = (spread / Decimal("1")) * 100

            self.logger.debug(
                f"Inter-outcome arbitrage (overpriced): {market.title[:50]}",
                total_price=float(total_price),
                spread=float(spread),
            )
            # Note: This requires the ability to sell/short all outcomes
            # which may not be available on all platforms

        elif total_price < Decimal("1") - threshold:
            # Underpriced: Buy all outcomes for guaranteed profit
            spread = Decimal("1") - total_price
            cost_with_fees = total_price * (1 + fees * len(market.outcomes))

            if cost_with_fees < Decimal("1"):
                profit_pct = ((Decimal("1") - cost_with_fees) / cost_with_fees) * 100

                # Create opportunity for buying all outcomes
                # This is simplified - in practice, need separate orders
                opp = ArbitrageOpportunity(
                    market_pair=MarketPair(
                        market_a=market,
                        market_b=market,  # Same market for inter-outcome
                        similarity_score=1.0,
                    ),
                    buy_market=market,
                    sell_market=market,
                    buy_outcome=market.outcomes[0],  # Placeholder
                    sell_outcome=market.outcomes[1] if len(market.outcomes) > 1 else market.outcomes[0],
                    buy_price=total_price,
                    sell_price=Decimal("1"),
                    spread=spread,
                    profit_percent=profit_pct,
                    recommended_size_usd=self._calculate_recommended_size(
                        spread, profit_pct
                    ),
                    expected_profit_usd=spread * self._calculate_recommended_size(
                        spread, profit_pct
                    ),
                    confidence=0.9,  # High confidence for mathematical arbitrage
                    expires_at=datetime.utcnow() + timedelta(minutes=5),
                )
                opportunities.append(opp)

        return opportunities

    def _get_connector_fees(self, source: MarketSource) -> Decimal:
        """Get trading fees for a market source."""
        connector = self.connectors.get(source)
        if connector:
            fees = connector.get_fees()
            return fees.get("taker_fee", Decimal("0"))
        return Decimal("0")

    def _find_outcome(self, market: Market, name: str) -> Optional[Outcome]:
        """Find an outcome by name in a market."""
        name_lower = name.lower()
        for outcome in market.outcomes:
            if outcome.name.lower() in (name_lower, "true", "1") and name_lower == "yes":
                return outcome
            if outcome.name.lower() in (name_lower, "false", "0") and name_lower == "no":
                return outcome
            if outcome.name.lower() == name_lower:
                return outcome
        return market.outcomes[0] if market.outcomes else None

    def _create_opportunity(
        self,
        pair: MarketPair,
        buy_market: Market,
        sell_market: Market,
        buy_outcome: Optional[Outcome],
        sell_outcome: Optional[Outcome],
        buy_price: Decimal,
        sell_price: Decimal,
        spread: Decimal,
        profit_percent: Decimal,
    ) -> Optional[ArbitrageOpportunity]:
        """Create an ArbitrageOpportunity object."""
        if not buy_outcome or not sell_outcome:
            return None

        recommended_size = self._calculate_recommended_size(spread, profit_percent)
        expected_profit = spread * recommended_size

        # Calculate confidence based on various factors
        confidence = self._calculate_confidence(
            pair, buy_market, sell_market, spread, profit_percent
        )

        return ArbitrageOpportunity(
            market_pair=pair,
            buy_market=buy_market,
            sell_market=sell_market,
            buy_outcome=buy_outcome,
            sell_outcome=sell_outcome,
            buy_price=buy_price,
            sell_price=sell_price,
            spread=spread,
            profit_percent=profit_percent,
            recommended_size_usd=recommended_size,
            expected_profit_usd=expected_profit,
            confidence=confidence,
            expires_at=datetime.utcnow() + timedelta(minutes=5),
        )

    def _calculate_recommended_size(
        self,
        spread: Decimal,
        profit_percent: Decimal,
    ) -> Decimal:
        """
        Calculate recommended position size based on spread and risk limits.
        """
        max_size = self.risk_config.max_position_size_usd

        # Scale down for smaller spreads (less confident)
        if profit_percent < Decimal("5"):
            return max_size * Decimal("0.25")
        elif profit_percent < Decimal("10"):
            return max_size * Decimal("0.5")
        elif profit_percent < Decimal("20"):
            return max_size * Decimal("0.75")

        return max_size

    def _calculate_confidence(
        self,
        pair: MarketPair,
        buy_market: Market,
        sell_market: Market,
        spread: Decimal,
        profit_percent: Decimal,
    ) -> float:
        """
        Calculate confidence score for an opportunity.

        Factors:
        - Market pair similarity
        - Spread size
        - Market liquidity
        - Time to resolution
        """
        confidence = 0.5  # Base confidence

        # Higher similarity = higher confidence
        confidence += pair.similarity_score * 0.2

        # Larger spread = lower confidence (might be due to different events)
        if profit_percent > Decimal("50"):
            confidence -= 0.2  # Suspicious - might not be same event
        elif profit_percent > Decimal("20"):
            confidence -= 0.1

        # Better liquidity = higher confidence
        liquidity_a = buy_market.liquidity or Decimal("0")
        liquidity_b = sell_market.liquidity or Decimal("0")
        min_liquidity = min(liquidity_a, liquidity_b)

        if min_liquidity > Decimal("100000"):
            confidence += 0.15
        elif min_liquidity > Decimal("10000"):
            confidence += 0.1
        elif min_liquidity > Decimal("1000"):
            confidence += 0.05

        return min(max(confidence, 0.0), 1.0)

    async def scan_all_pairs(
        self,
        pairs: list[MarketPair],
    ) -> list[ArbitrageOpportunity]:
        """
        Scan all market pairs for arbitrage opportunities.

        Args:
            pairs: List of market pairs to scan

        Returns:
            All detected opportunities, sorted by expected profit
        """
        all_opportunities = []

        for pair in pairs:
            try:
                opportunities = await self.scan_pair(pair)
                all_opportunities.extend(opportunities)
            except Exception as e:
                self.logger.error(
                    f"Error scanning pair: {e}",
                    pair_id=str(pair.id),
                )

        # Sort by expected profit descending
        all_opportunities.sort(
            key=lambda x: x.expected_profit_usd,
            reverse=True,
        )

        return all_opportunities

    def validate_opportunity(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> tuple[bool, str]:
        """
        Validate that an opportunity is still viable.

        Returns:
            Tuple of (is_valid, reason)
        """
        # Check expiration
        if opportunity.expires_at and datetime.utcnow() > opportunity.expires_at:
            return False, "Opportunity expired"

        # Check minimum profit
        if opportunity.profit_percent < self.risk_config.min_profit_threshold_percent:
            return False, "Profit below threshold"

        # Check position size limits
        if opportunity.recommended_size_usd > self.risk_config.max_position_size_usd:
            return False, "Size exceeds maximum position"

        # Check confidence
        if opportunity.confidence < 0.5:
            return False, "Confidence too low"

        return True, "Valid"
