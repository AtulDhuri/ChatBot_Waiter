"""Application configuration loaded from environment variables."""
from functools import lru_cache
from typing import List

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Secrets that must never be used in production. A SESSION_SECRET that is one
# of these (or too short) is treated as "not set".
_WEAK_SECRETS = {
    "",
    "change-me-in-production",
    "changeme",
    "secret",
    "dev",
    "test",
}
_MIN_SECRET_LEN = 16


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
    app_name: str = "DineOS"
    restaurant_name: str = "Demo Bistro"
    staff_count: int = Field(default=0, ge=0, validation_alias="STAFF_COUNT")
    currency: str = "$"

    # Deployment environment. "production" turns on fail-fast security checks:
    # a weak/default SESSION_SECRET or a blank/weak STAFF_TOKEN will refuse to
    # boot. Any value other than production/prod is treated as dev/demo and
    # keeps the permissive out-of-the-box behaviour.
    app_env: str = Field(
        default="development",
        validation_alias=AliasChoices("APP_ENV", "ENV", "ENVIRONMENT"),
    )

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
    # reach protected endpoints. If blank, protection is DISABLED (demo mode)
    # — but ONLY outside production; in production a strong value is required.
    staff_token: str = Field(default="", validation_alias="STAFF_TOKEN")

    # Sliding inactivity window for customer sessions. Kept short in production
    # to shrink the replay window for a captured token. Overridable via env.
    session_ttl_seconds: int = Field(
        default=30 * 60, validation_alias="SESSION_TTL_SECONDS"
    )

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
    def is_production(self) -> bool:
        return self.app_env.strip().lower() in ("production", "prod")

    @staticmethod
    def _is_weak_secret(value: str) -> bool:
        v = (value or "").strip()
        return v.lower() in _WEAK_SECRETS or len(v) < _MIN_SECRET_LEN

    @model_validator(mode="after")
    def _enforce_production_secrets(self) -> "Settings":
        """Fail fast when deployed to production without strong secrets.

        In production:
          - SESSION_SECRET must be set to a strong, non-default value so
            session-token signatures cannot be forged.
          - STAFF_TOKEN must be a strong, non-empty value so staff endpoints
            are never left unauthenticated.
        Outside production these are warnings only, preserving the zero-config
        demo experience.
        """
        if not self.is_production:
            return self
        problems: List[str] = []
        if self._is_weak_secret(self.session_secret):
            problems.append(
                "SESSION_SECRET is unset, default, or too short "
                f"(need >= {_MIN_SECRET_LEN} chars)"
            )
        if self._is_weak_secret(self.staff_token):
            problems.append(
                "STAFF_TOKEN is unset, weak, or too short "
                f"(need >= {_MIN_SECRET_LEN} chars)"
            )
        if problems:
            raise ValueError(
                "Refusing to start in production (APP_ENV="
                f"{self.app_env!r}) due to insecure configuration: "
                + "; ".join(problems)
                + ". Set strong values and restart."
            )
        return self

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
