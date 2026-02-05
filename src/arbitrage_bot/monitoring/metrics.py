"""
Prometheus metrics collection and export.
"""

from decimal import Decimal
from typing import Optional

import structlog
from prometheus_client import Counter, Gauge, Histogram, Info, start_http_server

from ..models import ArbitrageOpportunity, ArbitrageTrade, PortfolioSnapshot

logger = structlog.get_logger()


class MetricsCollector:
    """
    Collects and exports Prometheus metrics for the arbitrage bot.

    Metrics include:
    - Trade counts and outcomes
    - Portfolio value and exposure
    - Opportunity detection rates
    - Latency measurements
    - Error rates
    """

    def __init__(self, port: int = 9090):
        self.port = port
        self._initialized = False
        self.logger = logger.bind(component="metrics")

        # Trade metrics
        self.trades_total = Counter(
            "arbitrage_trades_total",
            "Total number of trades executed",
            ["source_buy", "source_sell", "status"],
        )

        self.trade_profit = Histogram(
            "arbitrage_trade_profit_usd",
            "Trade profit distribution in USD",
            buckets=[-100, -50, -10, -1, 0, 1, 10, 50, 100, 500],
        )

        self.trade_latency = Histogram(
            "arbitrage_trade_latency_seconds",
            "Trade execution latency",
            ["leg"],
            buckets=[0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        )

        # Portfolio metrics
        self.portfolio_value = Gauge(
            "arbitrage_portfolio_value_usd",
            "Current portfolio value in USD",
        )

        self.portfolio_cash = Gauge(
            "arbitrage_portfolio_cash_usd",
            "Cash balance in USD",
        )

        self.portfolio_positions = Gauge(
            "arbitrage_portfolio_positions_value_usd",
            "Total value of open positions in USD",
        )

        self.portfolio_exposure = Gauge(
            "arbitrage_portfolio_exposure_usd",
            "Current total exposure in USD",
        )

        self.unrealized_pnl = Gauge(
            "arbitrage_unrealized_pnl_usd",
            "Unrealized profit/loss in USD",
        )

        self.realized_pnl = Gauge(
            "arbitrage_realized_pnl_usd",
            "Realized profit/loss today in USD",
        )

        # Opportunity metrics
        self.opportunities_detected = Counter(
            "arbitrage_opportunities_detected_total",
            "Total opportunities detected",
            ["source_a", "source_b"],
        )

        self.opportunities_executed = Counter(
            "arbitrage_opportunities_executed_total",
            "Total opportunities executed",
        )

        self.opportunities_rejected = Counter(
            "arbitrage_opportunities_rejected_total",
            "Total opportunities rejected",
            ["reason"],
        )

        self.current_spread = Gauge(
            "arbitrage_current_spread_percent",
            "Current best arbitrage spread",
            ["market_pair"],
        )

        # Risk metrics
        self.drawdown_percent = Gauge(
            "arbitrage_drawdown_percent",
            "Current drawdown from peak",
        )

        self.circuit_breaker_active = Gauge(
            "arbitrage_circuit_breaker_active",
            "Whether circuit breaker is active (1) or not (0)",
        )

        self.rate_limit_remaining = Gauge(
            "arbitrage_rate_limit_remaining",
            "Remaining trades allowed this hour",
        )

        # Connector metrics
        self.connector_status = Gauge(
            "arbitrage_connector_status",
            "Connector status (1=connected, 0=disconnected)",
            ["source"],
        )

        self.connector_latency = Histogram(
            "arbitrage_connector_latency_seconds",
            "API request latency by connector",
            ["source", "operation"],
            buckets=[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
        )

        self.connector_errors = Counter(
            "arbitrage_connector_errors_total",
            "Total connector errors",
            ["source", "error_type"],
        )

        # System info
        self.bot_info = Info(
            "arbitrage_bot",
            "Arbitrage bot information",
        )

    def start_server(self) -> None:
        """Start the Prometheus metrics HTTP server."""
        if not self._initialized:
            try:
                start_http_server(self.port)
                self._initialized = True
                self.logger.info(f"Metrics server started on port {self.port}")
            except Exception as e:
                self.logger.error(f"Failed to start metrics server: {e}")

    def set_bot_info(self, version: str, environment: str) -> None:
        """Set bot information labels."""
        self.bot_info.info({
            "version": version,
            "environment": environment,
        })

    def record_trade(
        self,
        trade: ArbitrageTrade,
        profit: Optional[Decimal] = None,
    ) -> None:
        """Record a completed trade."""
        source_buy = trade.opportunity.buy_market.source.value
        source_sell = trade.opportunity.sell_market.source.value

        self.trades_total.labels(
            source_buy=source_buy,
            source_sell=source_sell,
            status=trade.status,
        ).inc()

        if profit is not None:
            self.trade_profit.observe(float(profit))

    def record_trade_latency(self, leg: str, latency_seconds: float) -> None:
        """Record trade execution latency."""
        self.trade_latency.labels(leg=leg).observe(latency_seconds)

    def update_portfolio(self, snapshot: PortfolioSnapshot) -> None:
        """Update portfolio metrics from snapshot."""
        self.portfolio_value.set(float(snapshot.total_value_usd))
        self.portfolio_cash.set(float(snapshot.cash_balance_usd))
        self.portfolio_positions.set(float(snapshot.positions_value_usd))
        self.unrealized_pnl.set(float(snapshot.unrealized_pnl))
        self.realized_pnl.set(float(snapshot.realized_pnl_today))

    def update_exposure(self, exposure_usd: Decimal) -> None:
        """Update current exposure."""
        self.portfolio_exposure.set(float(exposure_usd))

    def record_opportunity(
        self,
        opportunity: ArbitrageOpportunity,
        executed: bool = False,
        rejected_reason: Optional[str] = None,
    ) -> None:
        """Record an opportunity detection."""
        source_a = opportunity.buy_market.source.value
        source_b = opportunity.sell_market.source.value

        self.opportunities_detected.labels(
            source_a=source_a,
            source_b=source_b,
        ).inc()

        if executed:
            self.opportunities_executed.inc()
        elif rejected_reason:
            self.opportunities_rejected.labels(reason=rejected_reason).inc()

        # Update current spread
        market_pair = f"{source_a}_{source_b}"
        self.current_spread.labels(market_pair=market_pair).set(
            float(opportunity.profit_percent)
        )

    def update_risk_metrics(
        self,
        drawdown: float,
        circuit_breaker: bool,
        rate_limit_remaining: int,
    ) -> None:
        """Update risk-related metrics."""
        self.drawdown_percent.set(drawdown)
        self.circuit_breaker_active.set(1 if circuit_breaker else 0)
        self.rate_limit_remaining.set(rate_limit_remaining)

    def update_connector_status(self, source: str, connected: bool) -> None:
        """Update connector status."""
        self.connector_status.labels(source=source).set(1 if connected else 0)

    def record_connector_latency(
        self,
        source: str,
        operation: str,
        latency_seconds: float,
    ) -> None:
        """Record connector API latency."""
        self.connector_latency.labels(
            source=source,
            operation=operation,
        ).observe(latency_seconds)

    def record_connector_error(self, source: str, error_type: str) -> None:
        """Record a connector error."""
        self.connector_errors.labels(
            source=source,
            error_type=error_type,
        ).inc()
