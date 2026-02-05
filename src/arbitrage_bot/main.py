"""
Main entry point for the Prediction Market Arbitrage Bot.

This bot detects and executes arbitrage opportunities across
prediction markets like Polymarket, Kalshi, and Manifold.
"""

import asyncio
import signal
import sys
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional

import structlog

from .config import Settings, get_settings
from .connectors import KalshiConnector, ManifoldConnector, PolymarketConnector
from .connectors.base import BaseConnector
from .engine import ArbitrageDetector, MarketMatcher, TradeExecutor
from .engine.matcher import CrossMarketIndex
from .models import ArbitrageOpportunity, ArbitrageTrade, MarketSource, PortfolioSnapshot
from .monitoring import AlertManager, DashboardServer, MetricsCollector
from .risk import RiskManager

# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.dev.ConsoleRenderer(colors=True),
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


class ArbitrageBot:
    """
    Main arbitrage bot orchestrator.

    Coordinates all components:
    - Market connectors
    - Market matching
    - Opportunity detection
    - Trade execution
    - Risk management
    - Monitoring and alerts
    """

    # Scan interval in seconds
    SCAN_INTERVAL = 10

    # Market refresh interval
    MARKET_REFRESH_INTERVAL = 60

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.logger = logger.bind(component="arbitrage_bot")

        # State
        self._running = False
        self._paused = False
        self._last_market_refresh = datetime.min
        self._opportunities: list[ArbitrageOpportunity] = []
        self._recent_trades: list[ArbitrageTrade] = []

        # Components (initialized in start())
        self.connectors: dict[MarketSource, BaseConnector] = {}
        self.market_matcher: Optional[MarketMatcher] = None
        self.market_index: Optional[CrossMarketIndex] = None
        self.detector: Optional[ArbitrageDetector] = None
        self.executor: Optional[TradeExecutor] = None
        self.risk_manager: Optional[RiskManager] = None
        self.metrics: Optional[MetricsCollector] = None
        self.alerts: Optional[AlertManager] = None
        self.dashboard: Optional[DashboardServer] = None

    async def start(self) -> None:
        """Initialize and start the bot."""
        self.logger.info(
            "Starting Arbitrage Bot",
            environment=self.settings.bot_env.value,
            dry_run=self.settings.is_dry_run,
        )

        # Initialize connectors
        await self._init_connectors()

        # Initialize market matching
        self.market_matcher = MarketMatcher(similarity_threshold=0.7)
        self.market_index = CrossMarketIndex(self.market_matcher)

        # Initialize detection and execution engines
        self.detector = ArbitrageDetector(
            connectors=self.connectors,
            risk_config=self.settings.risk,
        )

        self.executor = TradeExecutor(
            connectors=self.connectors,
            risk_config=self.settings.risk,
            dry_run=self.settings.is_dry_run,
        )

        # Initialize risk management
        initial_balance = await self._get_total_balance()
        self.risk_manager = RiskManager(
            config=self.settings.risk,
            connectors=self.connectors,
            initial_balance=initial_balance,
        )

        # Initialize monitoring
        self.metrics = MetricsCollector(port=self.settings.prometheus_port)
        self.metrics.start_server()
        self.metrics.set_bot_info(
            version="1.0.0",
            environment=self.settings.bot_env.value,
        )

        # Initialize alerts
        self.alerts = AlertManager(self.settings.notifications)
        await self.alerts.start()

        # Initialize dashboard
        self.dashboard = DashboardServer(
            port=self.settings.health_check_port,
            get_status_callback=self._get_status,
            get_opportunities_callback=lambda: self._opportunities,
            get_trades_callback=lambda: self._recent_trades,
            control_callback=self._handle_control,
        )
        await self.dashboard.start()

        # Register signal handlers
        for sig in (signal.SIGINT, signal.SIGTERM):
            asyncio.get_event_loop().add_signal_handler(
                sig, lambda: asyncio.create_task(self.stop())
            )

        self._running = True
        self.logger.info("Bot started successfully")

        # Send startup alert
        await self.alerts.send_alert(
            level=self.alerts.AlertLevel.INFO,
            title="Bot Started",
            message=f"Arbitrage bot started in {self.settings.bot_env.value} mode",
            data={"Dry Run": str(self.settings.is_dry_run)},
        )

    async def _init_connectors(self) -> None:
        """Initialize market connectors."""
        # Polymarket
        polymarket = PolymarketConnector(self.settings.polymarket)
        await polymarket.connect()
        self.connectors[MarketSource.POLYMARKET] = polymarket

        # Kalshi
        kalshi = KalshiConnector(self.settings.kalshi)
        await kalshi.connect()
        self.connectors[MarketSource.KALSHI] = kalshi

        # Manifold
        manifold = ManifoldConnector(self.settings.manifold)
        await manifold.connect()
        self.connectors[MarketSource.MANIFOLD] = manifold

        self.logger.info(f"Initialized {len(self.connectors)} connectors")

        # Update connector status metrics
        if self.metrics:
            for source, connector in self.connectors.items():
                self.metrics.update_connector_status(
                    source.value, connector.is_connected
                )

    async def _get_total_balance(self) -> Decimal:
        """Get total balance across all connectors."""
        total = Decimal("0")
        for connector in self.connectors.values():
            try:
                balance = await connector.get_balance()
                total += balance
            except Exception as e:
                self.logger.warning(f"Failed to get balance: {e}")
        return total

    async def stop(self) -> None:
        """Stop the bot gracefully."""
        if not self._running:
            return

        self.logger.info("Stopping bot...")
        self._running = False

        # Send shutdown alert
        if self.alerts:
            await self.alerts.send_alert(
                level=self.alerts.AlertLevel.INFO,
                title="Bot Stopping",
                message="Arbitrage bot is shutting down",
            )
            await self.alerts.stop()

        # Stop dashboard
        if self.dashboard:
            await self.dashboard.stop()

        # Disconnect connectors
        for source, connector in self.connectors.items():
            try:
                await connector.disconnect()
                self.logger.info(f"Disconnected {source.value}")
            except Exception as e:
                self.logger.error(f"Error disconnecting {source.value}: {e}")

        self.logger.info("Bot stopped")

    async def run(self) -> None:
        """Main bot loop."""
        await self.start()

        try:
            while self._running:
                if self._paused:
                    await asyncio.sleep(1)
                    continue

                try:
                    await self._scan_cycle()
                except Exception as e:
                    self.logger.error(f"Error in scan cycle: {e}")
                    if self.alerts:
                        await self.alerts.send_alert(
                            level=self.alerts.AlertLevel.ERROR,
                            title="Scan Cycle Error",
                            message=str(e),
                            throttle_key="scan_error",
                        )

                await asyncio.sleep(self.SCAN_INTERVAL)

        except Exception as e:
            self.logger.critical(f"Fatal error: {e}")
            raise
        finally:
            await self.stop()

    async def _scan_cycle(self) -> None:
        """Single scan cycle: refresh markets, detect opportunities, execute."""
        # Refresh markets periodically
        now = datetime.utcnow()
        if (now - self._last_market_refresh).total_seconds() > self.MARKET_REFRESH_INTERVAL:
            await self._refresh_markets()
            self._last_market_refresh = now

        # Update portfolio and risk metrics
        if self.risk_manager:
            snapshot = await self.risk_manager.update_portfolio()
            if self.metrics:
                self.metrics.update_portfolio(snapshot)
                self.metrics.update_exposure(
                    self.risk_manager.position_limits.get_total_exposure()
                )
                risk_metrics = self.risk_manager.get_risk_metrics()
                self.metrics.update_risk_metrics(
                    drawdown=risk_metrics["drawdown"]["current_drawdown_percent"],
                    circuit_breaker=risk_metrics["circuit_breaker_active"],
                    rate_limit_remaining=risk_metrics["max_trades_per_hour"] - risk_metrics["trades_last_hour"],
                )

        # Detect opportunities
        if self.detector and self.market_index:
            pairs = self.market_index.get_pairs_by_similarity(min_similarity=0.7)
            opportunities = await self.detector.scan_all_pairs(pairs)

            self._opportunities = opportunities

            # Process opportunities
            for opportunity in opportunities:
                await self._process_opportunity(opportunity)

    async def _refresh_markets(self) -> None:
        """Refresh market data from all connectors."""
        self.logger.debug("Refreshing markets...")

        for source, connector in self.connectors.items():
            try:
                markets = await connector.get_markets(limit=200, active_only=True)
                if self.market_index:
                    self.market_index.add_markets(markets)
                self.logger.debug(f"Loaded {len(markets)} markets from {source.value}")
            except Exception as e:
                self.logger.error(f"Failed to refresh {source.value}: {e}")
                if self.metrics:
                    self.metrics.record_connector_error(source.value, type(e).__name__)

        # Rebuild market pairs
        if self.market_index:
            pairs = self.market_index.rebuild_pairs()
            self.logger.info(f"Found {len(pairs)} market pairs")

    async def _process_opportunity(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> None:
        """Process a detected arbitrage opportunity."""
        self.logger.info(
            "Processing opportunity",
            profit_percent=float(opportunity.profit_percent),
            confidence=opportunity.confidence,
            buy_market=opportunity.buy_market.source.value,
            sell_market=opportunity.sell_market.source.value,
        )

        # Record opportunity
        if self.metrics:
            self.metrics.record_opportunity(opportunity)

        # Check if we should execute
        if not self.risk_manager:
            return

        allowed, reason = await self.risk_manager.check_trade_allowed(opportunity)

        if not allowed:
            self.logger.info(f"Trade not allowed: {reason}")
            if self.metrics:
                self.metrics.record_opportunity(
                    opportunity, executed=False, rejected_reason=reason
                )
            return

        # Adjust position size based on risk
        adjusted_size = self.risk_manager.adjust_position_size(
            opportunity.recommended_size_usd,
            opportunity,
        )

        if adjusted_size <= 0:
            self.logger.info("Adjusted size is zero, skipping")
            return

        opportunity.recommended_size_usd = adjusted_size

        # Alert significant opportunities
        if opportunity.profit_percent >= Decimal("5") and self.alerts:
            await self.alerts.alert_opportunity_found(opportunity)

        # Execute trade
        if self.executor:
            result = await self.executor.execute(opportunity)

            if result.success and result.trade:
                await self.risk_manager.on_trade_opened(result.trade)
                self._recent_trades.append(result.trade)

                # Keep only recent trades
                if len(self._recent_trades) > 100:
                    self._recent_trades = self._recent_trades[-50:]

                if self.metrics:
                    self.metrics.record_opportunity(opportunity, executed=True)
                    self.metrics.record_trade(result.trade, result.trade.realized_profit)

                if self.alerts:
                    await self.alerts.alert_trade_executed(result.trade)

                # Handle trade completion
                if result.trade.realized_profit is not None:
                    await self.risk_manager.on_trade_closed(
                        result.trade, result.trade.realized_profit
                    )

            elif self.alerts and result.error:
                await self.alerts.send_alert(
                    level=self.alerts.AlertLevel.WARNING,
                    title="Trade Execution Failed",
                    message=result.error,
                    throttle_key="trade_failed",
                )

    def _get_status(self) -> dict:
        """Get current bot status for dashboard."""
        portfolio = None
        risk_metrics = {}

        if self.risk_manager:
            risk_metrics = self.risk_manager.get_risk_metrics()

        return {
            "running": self._running,
            "paused": self._paused,
            "dry_run": self.settings.is_dry_run,
            "environment": self.settings.bot_env.value,
            "connectors": {
                source.value: connector.is_connected
                for source, connector in self.connectors.items()
            },
            "opportunities_count": len(self._opportunities),
            "recent_trades_count": len(self._recent_trades),
            "risk_metrics": risk_metrics,
            "last_market_refresh": self._last_market_refresh.isoformat(),
        }

    def _handle_control(self, action: str) -> bool:
        """Handle control commands from dashboard."""
        if action == "pause":
            self._paused = True
            self.logger.info("Bot paused")
            return True
        elif action == "resume":
            self._paused = False
            self.logger.info("Bot resumed")
            return True
        elif action == "stop":
            if self.risk_manager:
                asyncio.create_task(self.risk_manager.emergency_stop())
            self._paused = True
            self.logger.critical("Emergency stop triggered")
            return True
        return False


def main() -> None:
    """Main entry point."""
    bot = ArbitrageBot()

    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logger.critical(f"Fatal error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
