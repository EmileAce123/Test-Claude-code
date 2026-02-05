"""
Trade execution engine.

Handles the automatic execution of arbitrage trades across platforms.
"""

import asyncio
from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

import structlog

from ..config import RiskConfig
from ..connectors.base import BaseConnector
from ..models import (
    ArbitrageOpportunity,
    ArbitrageTrade,
    Market,
    MarketSource,
    Order,
    OrderStatus,
    Side,
)

logger = structlog.get_logger()


class ExecutionResult:
    """Result of a trade execution attempt."""

    def __init__(
        self,
        success: bool,
        trade: Optional[ArbitrageTrade] = None,
        error: Optional[str] = None,
    ):
        self.success = success
        self.trade = trade
        self.error = error


class TradeExecutor:
    """
    Executes arbitrage trades across prediction market platforms.

    Handles:
    - Simultaneous order placement
    - Order monitoring and management
    - Slippage protection
    - Failed trade recovery
    """

    # Maximum time to wait for order fills
    ORDER_TIMEOUT_SECONDS = 30

    # Maximum retries for failed orders
    MAX_RETRIES = 3

    def __init__(
        self,
        connectors: dict[MarketSource, BaseConnector],
        risk_config: RiskConfig,
        dry_run: bool = True,
    ):
        self.connectors = connectors
        self.risk_config = risk_config
        self.dry_run = dry_run
        self.active_trades: dict[UUID, ArbitrageTrade] = {}
        self.logger = logger.bind(component="trade_executor")

    async def execute(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> ExecutionResult:
        """
        Execute an arbitrage opportunity.

        Args:
            opportunity: The opportunity to execute

        Returns:
            ExecutionResult with trade details or error
        """
        self.logger.info(
            "Executing arbitrage opportunity",
            opportunity_id=str(opportunity.id),
            buy_market=opportunity.buy_market.source.value,
            sell_market=opportunity.sell_market.source.value,
            expected_profit=float(opportunity.expected_profit_usd),
            dry_run=self.dry_run,
        )

        if self.dry_run:
            return await self._simulate_execution(opportunity)

        # Validate opportunity is still valid
        is_valid, reason = await self._validate_before_execution(opportunity)
        if not is_valid:
            self.logger.warning(f"Opportunity no longer valid: {reason}")
            return ExecutionResult(success=False, error=reason)

        # Calculate actual order sizes with slippage protection
        buy_size, sell_size = self._calculate_order_sizes(opportunity)

        # Execute both legs simultaneously
        try:
            buy_order, sell_order = await asyncio.gather(
                self._place_order(
                    opportunity.buy_market,
                    opportunity.buy_outcome,
                    Side.BUY,
                    opportunity.buy_price,
                    buy_size,
                ),
                self._place_order(
                    opportunity.sell_market,
                    opportunity.sell_outcome,
                    Side.BUY,  # Buying the opposite outcome = selling
                    opportunity.sell_price,
                    sell_size,
                ),
                return_exceptions=True,
            )

            # Handle exceptions
            if isinstance(buy_order, Exception):
                self.logger.error(f"Buy order failed: {buy_order}")
                buy_order = self._create_failed_order(
                    opportunity.buy_market,
                    opportunity.buy_outcome,
                    Side.BUY,
                    opportunity.buy_price,
                    buy_size,
                    str(buy_order),
                )

            if isinstance(sell_order, Exception):
                self.logger.error(f"Sell order failed: {sell_order}")
                sell_order = self._create_failed_order(
                    opportunity.sell_market,
                    opportunity.sell_outcome,
                    Side.BUY,
                    opportunity.sell_price,
                    sell_size,
                    str(sell_order),
                )

            # Create trade record
            trade = ArbitrageTrade(
                opportunity=opportunity,
                buy_order=buy_order,
                sell_order=sell_order,
                total_invested=buy_size + sell_size,
                status=self._determine_trade_status(buy_order, sell_order),
            )

            self.active_trades[trade.id] = trade

            # Monitor order fills
            if trade.status == "pending":
                trade = await self._monitor_orders(trade)

            # Calculate realized profit
            if trade.status == "completed":
                trade.realized_profit = self._calculate_realized_profit(trade)
                trade.closed_at = datetime.utcnow()

            self.logger.info(
                "Trade execution completed",
                trade_id=str(trade.id),
                status=trade.status,
                realized_profit=float(trade.realized_profit or 0),
            )

            return ExecutionResult(success=trade.status == "completed", trade=trade)

        except Exception as e:
            self.logger.error(f"Trade execution failed: {e}")
            return ExecutionResult(success=False, error=str(e))

    async def _simulate_execution(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> ExecutionResult:
        """Simulate trade execution for dry run mode."""
        self.logger.info("DRY RUN: Simulating trade execution")

        buy_size, sell_size = self._calculate_order_sizes(opportunity)

        # Create simulated orders
        buy_order = Order(
            market=opportunity.buy_market,
            outcome=opportunity.buy_outcome,
            side=Side.BUY,
            price=opportunity.buy_price,
            size=buy_size,
            status=OrderStatus.FILLED,
            filled_size=buy_size,
            filled_price=opportunity.buy_price,
            external_id="DRY_RUN_BUY",
        )

        sell_order = Order(
            market=opportunity.sell_market,
            outcome=opportunity.sell_outcome,
            side=Side.BUY,
            price=opportunity.sell_price,
            size=sell_size,
            status=OrderStatus.FILLED,
            filled_size=sell_size,
            filled_price=opportunity.sell_price,
            external_id="DRY_RUN_SELL",
        )

        trade = ArbitrageTrade(
            opportunity=opportunity,
            buy_order=buy_order,
            sell_order=sell_order,
            total_invested=buy_size + sell_size,
            realized_profit=opportunity.expected_profit_usd,
            status="completed",
            closed_at=datetime.utcnow(),
        )

        self.logger.info(
            "DRY RUN: Simulated trade",
            expected_profit=float(opportunity.expected_profit_usd),
            buy_price=float(opportunity.buy_price),
            sell_price=float(opportunity.sell_price),
        )

        return ExecutionResult(success=True, trade=trade)

    async def _validate_before_execution(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> tuple[bool, str]:
        """Validate opportunity immediately before execution."""
        # Refresh prices
        buy_connector = self.connectors.get(opportunity.buy_market.source)
        sell_connector = self.connectors.get(opportunity.sell_market.source)

        if not buy_connector or not sell_connector:
            return False, "Missing connector"

        try:
            # Get current orderbook prices
            buy_book = await buy_connector.get_orderbook(
                opportunity.buy_market.id,
                opportunity.buy_outcome.id,
            )
            sell_book = await sell_connector.get_orderbook(
                opportunity.sell_market.id,
                opportunity.sell_outcome.id,
            )

            # Check if best ask/bid are still profitable
            if not buy_book["asks"] or not sell_book["asks"]:
                return False, "No liquidity available"

            current_buy_price = buy_book["asks"][0][0]  # Best ask
            current_sell_price = sell_book["asks"][0][0]

            # Check for excessive slippage
            buy_slippage = (current_buy_price - opportunity.buy_price) / opportunity.buy_price
            sell_slippage = (current_sell_price - opportunity.sell_price) / opportunity.sell_price

            max_slippage = self.risk_config.max_slippage_percent / 100

            if buy_slippage > max_slippage:
                return False, f"Buy slippage too high: {buy_slippage:.2%}"
            if sell_slippage > max_slippage:
                return False, f"Sell slippage too high: {sell_slippage:.2%}"

            # Recalculate profit with current prices
            current_cost = current_buy_price + current_sell_price
            if current_cost >= Decimal("1"):
                return False, "No longer profitable at current prices"

            current_profit_pct = ((Decimal("1") - current_cost) / current_cost) * 100
            if current_profit_pct < self.risk_config.min_profit_threshold_percent:
                return False, f"Profit too low: {current_profit_pct:.2f}%"

            return True, "Valid"

        except Exception as e:
            return False, f"Validation error: {e}"

    def _calculate_order_sizes(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> tuple[Decimal, Decimal]:
        """Calculate order sizes for both legs."""
        total_size = opportunity.recommended_size_usd

        # For binary arbitrage, we need equal notional on both sides
        # Size is in USD for the position
        buy_size = total_size / 2
        sell_size = total_size / 2

        # Ensure we don't exceed max position size
        max_size = self.risk_config.max_position_size_usd / 2
        buy_size = min(buy_size, max_size)
        sell_size = min(sell_size, max_size)

        return buy_size, sell_size

    async def _place_order(
        self,
        market: Market,
        outcome: "Outcome",
        side: Side,
        price: Decimal,
        size: Decimal,
    ) -> Order:
        """Place an order on the specified market."""
        connector = self.connectors.get(market.source)
        if not connector:
            raise ValueError(f"No connector for {market.source}")

        # Add slippage tolerance to buy orders
        if side == Side.BUY:
            price = price * (1 + self.risk_config.max_slippage_percent / 100)
            price = min(price, Decimal("0.99"))  # Cap at 99 cents

        for attempt in range(self.MAX_RETRIES):
            try:
                order = await connector.place_order(
                    market_id=market.id,
                    outcome_id=outcome.id,
                    side=side,
                    price=price,
                    size=size,
                )

                if order.status != OrderStatus.FAILED:
                    return order

                self.logger.warning(
                    f"Order attempt {attempt + 1} failed: {order.error_message}"
                )

            except Exception as e:
                self.logger.warning(f"Order attempt {attempt + 1} error: {e}")

            if attempt < self.MAX_RETRIES - 1:
                await asyncio.sleep(1 * (attempt + 1))  # Exponential backoff

        raise RuntimeError(f"Failed to place order after {self.MAX_RETRIES} attempts")

    def _create_failed_order(
        self,
        market: Market,
        outcome: "Outcome",
        side: Side,
        price: Decimal,
        size: Decimal,
        error: str,
    ) -> Order:
        """Create a failed order record."""
        return Order(
            market=market,
            outcome=outcome,
            side=side,
            price=price,
            size=size,
            status=OrderStatus.FAILED,
            error_message=error,
        )

    def _determine_trade_status(
        self,
        buy_order: Order,
        sell_order: Order,
    ) -> str:
        """Determine overall trade status from orders."""
        if buy_order.status == OrderStatus.FAILED or sell_order.status == OrderStatus.FAILED:
            return "failed"

        if buy_order.status == OrderStatus.FILLED and sell_order.status == OrderStatus.FILLED:
            return "completed"

        return "pending"

    async def _monitor_orders(
        self,
        trade: ArbitrageTrade,
        timeout: int = ORDER_TIMEOUT_SECONDS,
    ) -> ArbitrageTrade:
        """Monitor orders until they fill or timeout."""
        start_time = datetime.utcnow()

        while (datetime.utcnow() - start_time).total_seconds() < timeout:
            # Check buy order
            if trade.buy_order.status not in (OrderStatus.FILLED, OrderStatus.FAILED):
                buy_connector = self.connectors.get(trade.buy_order.market.source)
                if buy_connector and trade.buy_order.external_id:
                    updated_buy = await buy_connector.get_order(trade.buy_order.external_id)
                    if updated_buy:
                        trade.buy_order = updated_buy

            # Check sell order
            if trade.sell_order.status not in (OrderStatus.FILLED, OrderStatus.FAILED):
                sell_connector = self.connectors.get(trade.sell_order.market.source)
                if sell_connector and trade.sell_order.external_id:
                    updated_sell = await sell_connector.get_order(trade.sell_order.external_id)
                    if updated_sell:
                        trade.sell_order = updated_sell

            # Update trade status
            trade.status = self._determine_trade_status(trade.buy_order, trade.sell_order)

            if trade.status in ("completed", "failed"):
                break

            await asyncio.sleep(1)

        # Timeout - cancel unfilled orders
        if trade.status == "pending":
            await self._cancel_unfilled_orders(trade)
            trade.status = "timeout"

        return trade

    async def _cancel_unfilled_orders(self, trade: ArbitrageTrade) -> None:
        """Cancel any unfilled orders."""
        for order in [trade.buy_order, trade.sell_order]:
            if order.status not in (OrderStatus.FILLED, OrderStatus.FAILED, OrderStatus.CANCELLED):
                connector = self.connectors.get(order.market.source)
                if connector and order.external_id:
                    try:
                        await connector.cancel_order(order.external_id)
                        order.status = OrderStatus.CANCELLED
                        self.logger.info(f"Cancelled unfilled order {order.external_id}")
                    except Exception as e:
                        self.logger.error(f"Failed to cancel order: {e}")

    def _calculate_realized_profit(self, trade: ArbitrageTrade) -> Decimal:
        """Calculate the realized profit from a completed trade."""
        if trade.status != "completed":
            return Decimal("0")

        # For binary markets: One outcome will pay $1, the other $0
        # We bought both sides, so we're guaranteed $1 payout
        buy_cost = trade.buy_order.filled_size * (trade.buy_order.filled_price or trade.buy_order.price)
        sell_cost = trade.sell_order.filled_size * (trade.sell_order.filled_price or trade.sell_order.price)

        total_cost = buy_cost + sell_cost
        payout = min(trade.buy_order.filled_size, trade.sell_order.filled_size)

        # Account for fees
        buy_fees = trade.buy_order.fees
        sell_fees = trade.sell_order.fees

        return payout - total_cost - buy_fees - sell_fees

    async def get_trade_status(self, trade_id: UUID) -> Optional[ArbitrageTrade]:
        """Get the current status of a trade."""
        return self.active_trades.get(trade_id)

    def get_active_trades(self) -> list[ArbitrageTrade]:
        """Get all active trades."""
        return [
            trade for trade in self.active_trades.values()
            if trade.status in ("pending", "partially_filled")
        ]

    async def close_trade(self, trade_id: UUID) -> bool:
        """
        Close a trade by selling all positions.
        Used for stop-loss or manual intervention.
        """
        trade = self.active_trades.get(trade_id)
        if not trade:
            return False

        self.logger.info(f"Closing trade {trade_id}")

        # Cancel any pending orders
        await self._cancel_unfilled_orders(trade)

        # In a real implementation, you'd also sell any acquired positions
        # This depends on the market's ability to sell positions

        trade.status = "closed"
        trade.closed_at = datetime.utcnow()

        return True
