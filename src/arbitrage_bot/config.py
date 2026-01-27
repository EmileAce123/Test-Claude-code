"""
Configuration management for the arbitrage bot.
Uses pydantic-settings for type-safe configuration with environment variables.
"""

from decimal import Decimal
from enum import Enum
from functools import lru_cache
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Environment(str, Enum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class PolymarketConfig(BaseSettings):
    """Polymarket API configuration."""

    model_config = SettingsConfigDict(env_prefix="POLYMARKET_")

    api_url: str = "https://clob.polymarket.com"
    ws_url: str = "wss://ws-subscriptions-clob.polymarket.com/ws"
    private_key: Optional[str] = None
    api_key: Optional[str] = None
    api_secret: Optional[str] = None
    api_passphrase: Optional[str] = None


class KalshiConfig(BaseSettings):
    """Kalshi API configuration."""

    model_config = SettingsConfigDict(env_prefix="KALSHI_")

    api_url: str = "https://trading-api.kalshi.com/trade-api/v2"
    email: Optional[str] = None
    password: Optional[str] = None


class ManifoldConfig(BaseSettings):
    """Manifold Markets API configuration."""

    model_config = SettingsConfigDict(env_prefix="MANIFOLD_")

    api_url: str = "https://api.manifold.markets/v0"
    api_key: Optional[str] = None


class RiskConfig(BaseSettings):
    """Risk management configuration."""

    model_config = SettingsConfigDict(env_prefix="")

    max_position_size_usd: Decimal = Field(default=Decimal("1000"))
    max_total_exposure_usd: Decimal = Field(default=Decimal("5000"))
    min_profit_threshold_percent: Decimal = Field(default=Decimal("2.0"))
    max_slippage_percent: Decimal = Field(default=Decimal("1.0"))
    stop_loss_percent: Decimal = Field(default=Decimal("5.0"))
    max_trades_per_hour: int = Field(default=20)
    cooldown_after_loss_seconds: int = Field(default=300)

    @field_validator(
        "max_position_size_usd",
        "max_total_exposure_usd",
        "min_profit_threshold_percent",
        "max_slippage_percent",
        "stop_loss_percent",
        mode="before",
    )
    @classmethod
    def convert_to_decimal(cls, v: str | float | Decimal) -> Decimal:
        return Decimal(str(v))


class NotificationConfig(BaseSettings):
    """Notification settings."""

    model_config = SettingsConfigDict(env_prefix="")

    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    discord_webhook_url: Optional[str] = None


class Settings(BaseSettings):
    """Main application settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # General
    bot_env: Environment = Environment.DEVELOPMENT
    log_level: str = "INFO"
    dry_run: bool = True

    # Database
    database_url: str = "sqlite+aiosqlite:///./arbitrage_bot.db"

    # Monitoring
    prometheus_port: int = 9090
    health_check_port: int = 8080

    # Sub-configurations
    polymarket: PolymarketConfig = Field(default_factory=PolymarketConfig)
    kalshi: KalshiConfig = Field(default_factory=KalshiConfig)
    manifold: ManifoldConfig = Field(default_factory=ManifoldConfig)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    notifications: NotificationConfig = Field(default_factory=NotificationConfig)

    @property
    def is_production(self) -> bool:
        return self.bot_env == Environment.PRODUCTION

    @property
    def is_dry_run(self) -> bool:
        return self.dry_run or self.bot_env == Environment.DEVELOPMENT


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
