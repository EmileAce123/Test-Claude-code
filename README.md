# Prediction Market Arbitrage Bot

A sophisticated bot for detecting and executing arbitrage opportunities across prediction markets like Polymarket, Kalshi, and Manifold Markets.

## Features

- **Multi-Platform Support**: Connect to multiple prediction markets simultaneously
  - Polymarket (blockchain-based, USDC)
  - Kalshi (CFTC-regulated, USD)
  - Manifold Markets (play money, useful for price discovery)

- **Intelligent Market Matching**: Automatically identifies equivalent markets across platforms using:
  - Text similarity analysis
  - Temporal proximity matching
  - Outcome structure comparison

- **Arbitrage Detection**: Multiple arbitrage strategies:
  - Cross-platform arbitrage (same event, different prices)
  - Inter-outcome arbitrage (prices don't sum to 1)
  - Real-time price monitoring

- **Automatic Execution**:
  - Simultaneous order placement on multiple platforms
  - Slippage protection
  - Order monitoring and management
  - Retry logic with exponential backoff

- **Risk Management**:
  - Position size limits
  - Total exposure limits
  - Drawdown monitoring with circuit breakers
  - Rate limiting (trades per hour)
  - Cooldown periods after losses
  - Kelly criterion-based position sizing

- **Monitoring & Alerts**:
  - Prometheus metrics export
  - Web dashboard with real-time stats
  - Telegram notifications
  - Discord webhook alerts

## Architecture

```
src/arbitrage_bot/
├── __init__.py
├── main.py              # Main entry point
├── config.py            # Configuration management
├── models.py            # Data models
├── connectors/          # Market API connectors
│   ├── base.py          # Abstract base connector
│   ├── polymarket.py    # Polymarket CLOB API
│   ├── kalshi.py        # Kalshi trading API
│   └── manifold.py      # Manifold Markets API
├── engine/              # Core trading engine
│   ├── matcher.py       # Market matching algorithm
│   ├── detector.py      # Arbitrage detection
│   └── executor.py      # Trade execution
├── risk/                # Risk management
│   ├── manager.py       # Central risk manager
│   └── limits.py        # Position/rate limits
└── monitoring/          # Monitoring system
    ├── metrics.py       # Prometheus metrics
    ├── alerts.py        # Alert notifications
    └── dashboard.py     # Web dashboard
```

## Installation

### Prerequisites

- Python 3.11+
- pip or poetry

### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd prediction-market-arbitrage-bot
```

2. Create a virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # Linux/Mac
# or
venv\Scripts\activate     # Windows
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Configure environment:
```bash
cp .env.example .env
# Edit .env with your API credentials
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```env
# General
BOT_ENV=development      # development, staging, production
DRY_RUN=true            # Set to false for live trading

# Polymarket (requires wallet)
POLYMARKET_PRIVATE_KEY=your_private_key
POLYMARKET_API_KEY=your_api_key
POLYMARKET_API_SECRET=your_secret
POLYMARKET_API_PASSPHRASE=your_passphrase

# Kalshi (US residents only)
KALSHI_EMAIL=your_email
KALSHI_PASSWORD=your_password

# Risk Management
MAX_POSITION_SIZE_USD=1000
MAX_TOTAL_EXPOSURE_USD=5000
MIN_PROFIT_THRESHOLD_PERCENT=2.0
MAX_SLIPPAGE_PERCENT=1.0
STOP_LOSS_PERCENT=5.0

# Notifications (optional)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### Risk Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `MAX_POSITION_SIZE_USD` | Maximum size per trade | $1,000 |
| `MAX_TOTAL_EXPOSURE_USD` | Maximum total exposure | $5,000 |
| `MIN_PROFIT_THRESHOLD_PERCENT` | Minimum profit to execute | 2% |
| `MAX_SLIPPAGE_PERCENT` | Maximum allowed slippage | 1% |
| `STOP_LOSS_PERCENT` | Circuit breaker trigger | 5% |
| `MAX_TRADES_PER_HOUR` | Rate limit | 20 |
| `COOLDOWN_AFTER_LOSS_SECONDS` | Pause after loss | 300s |

## Usage

### Running the Bot

```bash
# Development mode (dry run)
python -m arbitrage_bot.main

# Or using the CLI
arbitrage-bot
```

### Monitoring

- **Dashboard**: http://localhost:8080
- **Metrics**: http://localhost:9090/metrics (Prometheus format)
- **Health check**: http://localhost:8080/health

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard |
| `/health` | GET | Health check |
| `/status` | GET | Current bot status |
| `/metrics` | GET | Risk metrics (JSON) |
| `/opportunities` | GET | Active opportunities |
| `/trades` | GET | Recent trades |
| `/control/pause` | POST | Pause trading |
| `/control/resume` | POST | Resume trading |
| `/control/stop` | POST | Emergency stop |

## How It Works

### 1. Market Discovery

The bot fetches active markets from all configured platforms and builds an index of available markets.

### 2. Market Matching

Using text similarity and temporal analysis, the bot identifies equivalent markets across platforms:

```python
# Example: These would be matched
Polymarket: "Will Bitcoin exceed $100k by end of 2024?"
Kalshi: "BTC price above $100,000 on Dec 31, 2024"
```

### 3. Arbitrage Detection

For matched market pairs, the bot calculates potential profit:

```
Platform A: Yes @ $0.45, No @ $0.55
Platform B: Yes @ $0.50, No @ $0.52

Strategy: Buy Yes on A ($0.45) + Buy No on B ($0.52) = $0.97
Guaranteed payout: $1.00
Profit: $0.03 (3.09%)
```

### 4. Risk Assessment

Before execution, the bot checks:
- Position size limits
- Total exposure
- Rate limits
- Slippage estimates
- Liquidity requirements
- Circuit breaker status

### 5. Execution

If all checks pass, the bot:
1. Places orders simultaneously on both platforms
2. Monitors order fills
3. Handles partial fills and retries
4. Records results and updates risk metrics

## Testing

```bash
# Run tests
pytest

# With coverage
pytest --cov=src/arbitrage_bot

# Specific test file
pytest tests/test_detector.py -v
```

## Development

### Code Quality

```bash
# Format code
black src/

# Lint
ruff src/

# Type checking
mypy src/
```

### Adding a New Connector

1. Create a new file in `src/arbitrage_bot/connectors/`
2. Inherit from `BaseConnector`
3. Implement all abstract methods
4. Add to `connectors/__init__.py`
5. Update `main.py` to initialize the connector

## Risks and Disclaimers

**IMPORTANT**: This software is for educational purposes. Trading in prediction markets involves significant risks:

- **Regulatory Risk**: Prediction markets may not be legal in your jurisdiction
- **Platform Risk**: Platforms may freeze funds or change rules
- **Execution Risk**: Orders may not fill at expected prices
- **Matching Risk**: Markets that appear similar may resolve differently
- **Technical Risk**: Software bugs, network issues, API changes

**Never trade with money you cannot afford to lose.**

## License

MIT License - See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

## Support

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
