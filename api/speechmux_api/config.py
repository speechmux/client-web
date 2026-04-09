"""Configuration settings loaded from environment variables."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings.

    Attributes:
        core_ws_url: WebSocket URL of the SpeechMux Core server.
        core_api_key: API key injected into upstream session start messages.
            Empty string means Core auth is disabled.
        access_token: Bearer token required from browser clients.
            Empty string disables client authentication.
        max_sessions_per_user: Maximum concurrent WebSocket sessions per
            authenticated user. Enforced by the proxy.
        cors_origins: Comma-separated list of allowed CORS origins.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    core_ws_url: str = "ws://localhost:8091/ws/stream"  # overridden by run-web via .env
    core_api_key: str = ""
    access_token: str = ""
    max_sessions_per_user: int = 2
    cors_origins: str = "http://localhost:3020"  # overridden by run-web via .env

    @property
    def cors_origins_list(self) -> list[str]:
        """Return CORS origins as a list."""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()
