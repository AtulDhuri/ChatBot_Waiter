"""Application configuration loaded from environment variables."""
from functools import lru_cache
from typing import List

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".ENV"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # Database (Supabase Postgres). AliasChoices lets a single field accept
    # several env var names so existing .env files keep working.
    database_url: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/waiter",
        validation_alias=AliasChoices("DATABASE_URL", "database_url"),
    )

    # OpenAI / LLM
    openai_api_key: str = Field(default="", validation_alias="OPENAI_API_KEY")
    embedding_model: str = Field(
        default="text-embedding-3-small",
        validation_alias=AliasChoices("EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL"),
    )
    embedding_dim: int = Field(default=1536, validation_alias="EMBEDDING_DIM")
    chat_model: str = Field(
        default="gpt-4o-mini",
        validation_alias=AliasChoices("CHAT_MODEL", "OPENAI_CHAT_MODEL"),
    )

    # App
    app_name: str = "Chatbot Waiter"
    restaurant_name: str = "Demo Bistro"
    currency: str = "$"

    # UPI payment (display QR). Global defaults; per-tenant values in the
    # restaurants table override these. upi_currency is almost always INR.
    upi_vpa: str = Field(default="", validation_alias="UPI_VPA")
    upi_payee_name: str = Field(
        default="", validation_alias="UPI_PAYEE_NAME"
    )
    upi_currency: str = Field(default="INR", validation_alias="UPI_CURRENCY")
    cors_origins: str = Field(
        default="*",
        validation_alias=AliasChoices("CORS_ORIGINS", "ALLOWED_ORIGINS"),
    )
    session_secret: str = Field(
        default="change-me-in-production", validation_alias="SESSION_SECRET"
    )
    # Shared secret that staff pages (kitchen/reports/admin) must present to
    # reach protected endpoints. If blank, protection is DISABLED (demo mode).
    staff_token: str = Field(default="", validation_alias="STAFF_TOKEN")

    # Retrieval / chunking
    top_k: int = Field(
        default=5, validation_alias=AliasChoices("TOP_K", "RETRIEVAL_TOP_K")
    )
    chunk_size: int = Field(default=800, validation_alias="CHUNK_SIZE")
    chunk_overlap: int = Field(default=120, validation_alias="CHUNK_OVERLAP")

    @field_validator("database_url")
    @classmethod
    def _normalize_db_url(cls, v: str) -> str:
        # Supabase/Render/Heroku give postgres:// — normalize to async driver.
        if v.startswith("postgres://"):
            v = v.replace("postgres://", "postgresql+asyncpg://", 1)
        elif v.startswith("postgresql://"):
            v = v.replace("postgresql://", "postgresql+asyncpg://", 1)
        return v

    @property
    def cors_origin_list(self) -> List[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def llm_enabled(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def is_supabase_pooler(self) -> bool:
        """Supabase transaction pooler runs on 6543 and the pooler host.

        It does not support prepared statements, which asyncpg uses by
        default. We detect it so the engine can disable statement caching.
        """
        return "pooler.supabase.com" in self.database_url or ":6543" in self.database_url

    @property
    def db_requires_ssl(self) -> bool:
        return "supabase" in self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
