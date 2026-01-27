"""
Simple HTTP dashboard for monitoring the bot.
"""

import asyncio
import json
from datetime import datetime
from decimal import Decimal
from typing import Any, Callable, Optional

from aiohttp import web
import structlog

logger = structlog.get_logger()


class DecimalEncoder(json.JSONEncoder):
    """JSON encoder that handles Decimal types."""

    def default(self, obj: Any) -> Any:
        if isinstance(obj, Decimal):
            return float(obj)
        if isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)


class DashboardServer:
    """
    Simple HTTP server for monitoring and health checks.

    Endpoints:
    - GET /health: Health check
    - GET /status: Current bot status
    - GET /metrics: Current metrics (JSON)
    - GET /opportunities: Current opportunities
    - GET /trades: Recent trades
    - POST /control/pause: Pause trading
    - POST /control/resume: Resume trading
    - POST /control/stop: Emergency stop
    """

    def __init__(
        self,
        port: int = 8080,
        get_status_callback: Optional[Callable[[], dict]] = None,
        get_opportunities_callback: Optional[Callable[[], list]] = None,
        get_trades_callback: Optional[Callable[[], list]] = None,
        control_callback: Optional[Callable[[str], bool]] = None,
    ):
        self.port = port
        self.get_status = get_status_callback or (lambda: {})
        self.get_opportunities = get_opportunities_callback or (lambda: [])
        self.get_trades = get_trades_callback or (lambda: [])
        self.control = control_callback or (lambda x: False)

        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self._is_paused = False
        self.logger = logger.bind(component="dashboard")

    async def start(self) -> None:
        """Start the dashboard server."""
        self._app = web.Application()
        self._setup_routes()

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()

        self._site = web.TCPSite(self._runner, "0.0.0.0", self.port)
        await self._site.start()

        self.logger.info(f"Dashboard server started on port {self.port}")

    async def stop(self) -> None:
        """Stop the dashboard server."""
        if self._site:
            await self._site.stop()
        if self._runner:
            await self._runner.cleanup()
        self.logger.info("Dashboard server stopped")

    def _setup_routes(self) -> None:
        """Configure routes."""
        if not self._app:
            return

        self._app.router.add_get("/", self._handle_root)
        self._app.router.add_get("/health", self._handle_health)
        self._app.router.add_get("/status", self._handle_status)
        self._app.router.add_get("/metrics", self._handle_metrics)
        self._app.router.add_get("/opportunities", self._handle_opportunities)
        self._app.router.add_get("/trades", self._handle_trades)
        self._app.router.add_post("/control/pause", self._handle_pause)
        self._app.router.add_post("/control/resume", self._handle_resume)
        self._app.router.add_post("/control/stop", self._handle_stop)

    async def _handle_root(self, request: web.Request) -> web.Response:
        """Root endpoint - returns simple dashboard HTML."""
        html = """
        <!DOCTYPE html>
        <html>
        <head>
            <title>Arbitrage Bot Dashboard</title>
            <style>
                body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; }
                .card { background: #16213e; padding: 15px; margin: 10px 0; border-radius: 8px; }
                .metric { display: inline-block; margin: 10px 20px 10px 0; }
                .metric-value { font-size: 24px; font-weight: bold; color: #00ff88; }
                .metric-label { font-size: 12px; color: #888; }
                .negative { color: #ff4444; }
                .warning { color: #ffaa00; }
                h1 { color: #00ff88; }
                h2 { color: #4da6ff; margin-top: 20px; }
                table { width: 100%; border-collapse: collapse; }
                th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; }
                th { color: #888; }
                button { background: #4da6ff; border: none; padding: 10px 20px;
                         border-radius: 4px; cursor: pointer; margin: 5px; }
                button.danger { background: #ff4444; }
                button.warning { background: #ffaa00; color: #000; }
            </style>
            <script>
                async function fetchData() {
                    const status = await (await fetch('/status')).json();
                    const opportunities = await (await fetch('/opportunities')).json();
                    const trades = await (await fetch('/trades')).json();

                    document.getElementById('portfolio-value').textContent =
                        '$' + status.portfolio?.total_value_usd?.toFixed(2) || '0.00';
                    document.getElementById('pnl').textContent =
                        '$' + (status.risk_metrics?.net_pnl?.toFixed(2) || '0.00');
                    document.getElementById('exposure').textContent =
                        '$' + (status.risk_metrics?.total_exposure?.toFixed(2) || '0.00');
                    document.getElementById('win-rate').textContent =
                        ((status.risk_metrics?.win_rate || 0) * 100).toFixed(1) + '%';
                    document.getElementById('trades-count').textContent =
                        status.risk_metrics?.total_trades || 0;

                    // Update opportunities table
                    let oppHtml = '';
                    (opportunities || []).slice(0, 10).forEach(opp => {
                        oppHtml += '<tr>' +
                            '<td>' + (opp.buy_market?.title || '').substring(0, 40) + '</td>' +
                            '<td>' + opp.profit_percent?.toFixed(2) + '%</td>' +
                            '<td>$' + opp.expected_profit_usd?.toFixed(2) + '</td>' +
                            '<td>' + (opp.confidence * 100).toFixed(0) + '%</td>' +
                            '</tr>';
                    });
                    document.getElementById('opportunities-body').innerHTML = oppHtml ||
                        '<tr><td colspan="4">No opportunities</td></tr>';

                    // Update trades table
                    let tradesHtml = '';
                    (trades || []).slice(0, 10).forEach(trade => {
                        const profit = trade.realized_profit || 0;
                        const profitClass = profit >= 0 ? '' : 'negative';
                        tradesHtml += '<tr>' +
                            '<td>' + trade.id?.substring(0, 8) + '</td>' +
                            '<td>' + trade.status + '</td>' +
                            '<td>$' + trade.total_invested?.toFixed(2) + '</td>' +
                            '<td class="' + profitClass + '">$' + profit.toFixed(2) + '</td>' +
                            '</tr>';
                    });
                    document.getElementById('trades-body').innerHTML = tradesHtml ||
                        '<tr><td colspan="4">No trades</td></tr>';
                }

                async function control(action) {
                    await fetch('/control/' + action, { method: 'POST' });
                    fetchData();
                }

                setInterval(fetchData, 5000);
                fetchData();
            </script>
        </head>
        <body>
            <h1>🤖 Arbitrage Bot Dashboard</h1>

            <div class="card">
                <div class="metric">
                    <div class="metric-value" id="portfolio-value">$0.00</div>
                    <div class="metric-label">Portfolio Value</div>
                </div>
                <div class="metric">
                    <div class="metric-value" id="pnl">$0.00</div>
                    <div class="metric-label">Net P&L</div>
                </div>
                <div class="metric">
                    <div class="metric-value" id="exposure">$0.00</div>
                    <div class="metric-label">Exposure</div>
                </div>
                <div class="metric">
                    <div class="metric-value" id="win-rate">0%</div>
                    <div class="metric-label">Win Rate</div>
                </div>
                <div class="metric">
                    <div class="metric-value" id="trades-count">0</div>
                    <div class="metric-label">Trades Today</div>
                </div>
            </div>

            <div class="card">
                <button onclick="control('pause')" class="warning">⏸️ Pause</button>
                <button onclick="control('resume')">▶️ Resume</button>
                <button onclick="control('stop')" class="danger">🛑 Emergency Stop</button>
            </div>

            <h2>📊 Active Opportunities</h2>
            <div class="card">
                <table>
                    <thead>
                        <tr><th>Market</th><th>Spread</th><th>Expected Profit</th><th>Confidence</th></tr>
                    </thead>
                    <tbody id="opportunities-body">
                        <tr><td colspan="4">Loading...</td></tr>
                    </tbody>
                </table>
            </div>

            <h2>📈 Recent Trades</h2>
            <div class="card">
                <table>
                    <thead>
                        <tr><th>ID</th><th>Status</th><th>Invested</th><th>Profit</th></tr>
                    </thead>
                    <tbody id="trades-body">
                        <tr><td colspan="4">Loading...</td></tr>
                    </tbody>
                </table>
            </div>
        </body>
        </html>
        """
        return web.Response(text=html, content_type="text/html")

    async def _handle_health(self, request: web.Request) -> web.Response:
        """Health check endpoint."""
        return web.json_response({
            "status": "healthy" if not self._is_paused else "paused",
            "timestamp": datetime.utcnow().isoformat(),
        })

    async def _handle_status(self, request: web.Request) -> web.Response:
        """Get current bot status."""
        status = self.get_status()
        return web.Response(
            text=json.dumps(status, cls=DecimalEncoder),
            content_type="application/json",
        )

    async def _handle_metrics(self, request: web.Request) -> web.Response:
        """Get current metrics in JSON format."""
        status = self.get_status()
        return web.Response(
            text=json.dumps(status.get("risk_metrics", {}), cls=DecimalEncoder),
            content_type="application/json",
        )

    async def _handle_opportunities(self, request: web.Request) -> web.Response:
        """Get current opportunities."""
        opportunities = self.get_opportunities()

        # Convert to JSON-serializable format
        result = []
        for opp in opportunities:
            if hasattr(opp, "model_dump"):
                result.append(opp.model_dump())
            elif hasattr(opp, "dict"):
                result.append(opp.dict())
            else:
                result.append(opp)

        return web.Response(
            text=json.dumps(result, cls=DecimalEncoder),
            content_type="application/json",
        )

    async def _handle_trades(self, request: web.Request) -> web.Response:
        """Get recent trades."""
        trades = self.get_trades()

        result = []
        for trade in trades:
            if hasattr(trade, "model_dump"):
                result.append(trade.model_dump())
            elif hasattr(trade, "dict"):
                result.append(trade.dict())
            else:
                result.append(trade)

        return web.Response(
            text=json.dumps(result, cls=DecimalEncoder),
            content_type="application/json",
        )

    async def _handle_pause(self, request: web.Request) -> web.Response:
        """Pause trading."""
        self._is_paused = True
        self.control("pause")
        self.logger.info("Trading paused via dashboard")
        return web.json_response({"status": "paused"})

    async def _handle_resume(self, request: web.Request) -> web.Response:
        """Resume trading."""
        self._is_paused = False
        self.control("resume")
        self.logger.info("Trading resumed via dashboard")
        return web.json_response({"status": "running"})

    async def _handle_stop(self, request: web.Request) -> web.Response:
        """Emergency stop."""
        self._is_paused = True
        self.control("stop")
        self.logger.critical("Emergency stop triggered via dashboard")
        return web.json_response({"status": "stopped"})
