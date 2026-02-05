"""
Alert management and notification system.
"""

import asyncio
from datetime import datetime, timedelta
from decimal import Decimal
from enum import Enum
from typing import Optional

import aiohttp
import structlog

from ..config import NotificationConfig
from ..models import ArbitrageOpportunity, ArbitrageTrade

logger = structlog.get_logger()


class AlertLevel(str, Enum):
    """Alert severity levels."""

    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class Alert:
    """Represents an alert notification."""

    def __init__(
        self,
        level: AlertLevel,
        title: str,
        message: str,
        data: Optional[dict] = None,
    ):
        self.level = level
        self.title = title
        self.message = message
        self.data = data or {}
        self.timestamp = datetime.utcnow()

    def format_telegram(self) -> str:
        """Format alert for Telegram."""
        emoji_map = {
            AlertLevel.INFO: "ℹ️",
            AlertLevel.WARNING: "⚠️",
            AlertLevel.ERROR: "❌",
            AlertLevel.CRITICAL: "🚨",
        }
        emoji = emoji_map.get(self.level, "📢")

        text = f"{emoji} *{self.title}*\n\n{self.message}"

        if self.data:
            text += "\n\n*Details:*"
            for key, value in self.data.items():
                text += f"\n• {key}: `{value}`"

        text += f"\n\n_Time: {self.timestamp.strftime('%Y-%m-%d %H:%M:%S UTC')}_"

        return text

    def format_discord(self) -> dict:
        """Format alert for Discord webhook."""
        color_map = {
            AlertLevel.INFO: 3447003,  # Blue
            AlertLevel.WARNING: 16776960,  # Yellow
            AlertLevel.ERROR: 15158332,  # Red
            AlertLevel.CRITICAL: 10038562,  # Dark red
        }

        embed = {
            "title": self.title,
            "description": self.message,
            "color": color_map.get(self.level, 3447003),
            "timestamp": self.timestamp.isoformat(),
            "fields": [
                {"name": key, "value": str(value), "inline": True}
                for key, value in self.data.items()
            ],
        }

        return {"embeds": [embed]}


class AlertManager:
    """
    Manages alerts and notifications.

    Supports:
    - Telegram notifications
    - Discord webhooks
    - Alert throttling (prevent spam)
    - Alert history
    """

    # Minimum interval between similar alerts
    THROTTLE_SECONDS = 60

    def __init__(self, config: NotificationConfig):
        self.config = config
        self._session: Optional[aiohttp.ClientSession] = None
        self._last_alerts: dict[str, datetime] = {}
        self._alert_history: list[Alert] = []
        self.logger = logger.bind(component="alert_manager")

    async def start(self) -> None:
        """Initialize the alert manager."""
        self._session = aiohttp.ClientSession()
        self.logger.info("Alert manager started")

    async def stop(self) -> None:
        """Shutdown the alert manager."""
        if self._session:
            await self._session.close()
            self._session = None
        self.logger.info("Alert manager stopped")

    async def send_alert(
        self,
        level: AlertLevel,
        title: str,
        message: str,
        data: Optional[dict] = None,
        throttle_key: Optional[str] = None,
    ) -> bool:
        """
        Send an alert notification.

        Args:
            level: Alert severity level
            title: Alert title
            message: Alert message body
            data: Additional data to include
            throttle_key: Key for throttling similar alerts

        Returns:
            True if alert was sent, False if throttled
        """
        # Check throttling
        if throttle_key:
            last_time = self._last_alerts.get(throttle_key)
            if last_time:
                elapsed = (datetime.utcnow() - last_time).total_seconds()
                if elapsed < self.THROTTLE_SECONDS:
                    self.logger.debug(f"Alert throttled: {throttle_key}")
                    return False
            self._last_alerts[throttle_key] = datetime.utcnow()

        alert = Alert(level, title, message, data)
        self._alert_history.append(alert)

        # Keep history bounded
        if len(self._alert_history) > 1000:
            self._alert_history = self._alert_history[-500:]

        # Send to all configured channels
        tasks = []

        if self.config.telegram_bot_token and self.config.telegram_chat_id:
            tasks.append(self._send_telegram(alert))

        if self.config.discord_webhook_url:
            tasks.append(self._send_discord(alert))

        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, Exception):
                    self.logger.error(f"Failed to send alert: {result}")

        self.logger.log(
            level.value.upper(),
            f"Alert: {title}",
            message=message,
            data=data,
        )

        return True

    async def _send_telegram(self, alert: Alert) -> None:
        """Send alert via Telegram."""
        if not self._session:
            return

        url = f"https://api.telegram.org/bot{self.config.telegram_bot_token}/sendMessage"
        payload = {
            "chat_id": self.config.telegram_chat_id,
            "text": alert.format_telegram(),
            "parse_mode": "Markdown",
        }

        async with self._session.post(url, json=payload) as response:
            if response.status != 200:
                error = await response.text()
                raise RuntimeError(f"Telegram API error: {error}")

    async def _send_discord(self, alert: Alert) -> None:
        """Send alert via Discord webhook."""
        if not self._session or not self.config.discord_webhook_url:
            return

        async with self._session.post(
            self.config.discord_webhook_url,
            json=alert.format_discord(),
        ) as response:
            if response.status not in (200, 204):
                error = await response.text()
                raise RuntimeError(f"Discord webhook error: {error}")

    # Convenience methods for common alerts

    async def alert_opportunity_found(
        self,
        opportunity: ArbitrageOpportunity,
    ) -> None:
        """Alert when a significant opportunity is found."""
        await self.send_alert(
            level=AlertLevel.INFO,
            title="Arbitrage Opportunity Detected",
            message=f"Found {opportunity.profit_percent:.2f}% profit opportunity",
            data={
                "Buy": f"{opportunity.buy_market.source.value} @ {opportunity.buy_price:.4f}",
                "Sell": f"{opportunity.sell_market.source.value} @ {opportunity.sell_price:.4f}",
                "Expected Profit": f"${opportunity.expected_profit_usd:.2f}",
                "Confidence": f"{opportunity.confidence:.2%}",
            },
            throttle_key=f"opportunity_{opportunity.buy_market.id}",
        )

    async def alert_trade_executed(self, trade: ArbitrageTrade) -> None:
        """Alert when a trade is executed."""
        await self.send_alert(
            level=AlertLevel.INFO,
            title="Trade Executed",
            message=f"Arbitrage trade completed",
            data={
                "Trade ID": str(trade.id)[:8],
                "Status": trade.status,
                "Invested": f"${trade.total_invested:.2f}",
                "Profit": f"${trade.realized_profit:.2f}" if trade.realized_profit else "Pending",
            },
        )

    async def alert_trade_failed(
        self,
        trade: ArbitrageTrade,
        reason: str,
    ) -> None:
        """Alert when a trade fails."""
        await self.send_alert(
            level=AlertLevel.ERROR,
            title="Trade Failed",
            message=f"Trade execution failed: {reason}",
            data={
                "Trade ID": str(trade.id)[:8],
                "Status": trade.status,
            },
            throttle_key="trade_failed",
        )

    async def alert_circuit_breaker(self, drawdown: float) -> None:
        """Alert when circuit breaker is triggered."""
        await self.send_alert(
            level=AlertLevel.CRITICAL,
            title="Circuit Breaker Activated",
            message="Trading has been halted due to excessive drawdown",
            data={
                "Current Drawdown": f"{drawdown:.2f}%",
            },
        )

    async def alert_connector_error(
        self,
        source: str,
        error: str,
    ) -> None:
        """Alert when a connector has errors."""
        await self.send_alert(
            level=AlertLevel.WARNING,
            title="Connector Error",
            message=f"Error with {source} connector",
            data={
                "Source": source,
                "Error": error[:200],
            },
            throttle_key=f"connector_error_{source}",
        )

    async def alert_low_balance(
        self,
        source: str,
        balance: Decimal,
        minimum: Decimal,
    ) -> None:
        """Alert when balance is low."""
        await self.send_alert(
            level=AlertLevel.WARNING,
            title="Low Balance Warning",
            message=f"Balance on {source} is below minimum",
            data={
                "Source": source,
                "Current Balance": f"${balance:.2f}",
                "Minimum Required": f"${minimum:.2f}",
            },
            throttle_key=f"low_balance_{source}",
        )

    async def alert_daily_summary(
        self,
        trades: int,
        profit: Decimal,
        win_rate: float,
    ) -> None:
        """Send daily summary alert."""
        status = "Profitable" if profit > 0 else "Loss"
        level = AlertLevel.INFO if profit >= 0 else AlertLevel.WARNING

        await self.send_alert(
            level=level,
            title=f"Daily Summary - {status}",
            message="End of day trading summary",
            data={
                "Total Trades": trades,
                "Net P&L": f"${profit:.2f}",
                "Win Rate": f"{win_rate:.1%}",
            },
        )

    def get_recent_alerts(
        self,
        hours: int = 24,
        level: Optional[AlertLevel] = None,
    ) -> list[Alert]:
        """Get recent alerts."""
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        alerts = [a for a in self._alert_history if a.timestamp >= cutoff]

        if level:
            alerts = [a for a in alerts if a.level == level]

        return alerts
