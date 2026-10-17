"""Async SQLAlchemy engine, session factory, and schema bootstrap."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy import text

from app.config import settings

def _build_connect_args() -> dict:
    """asyncpg connect args tuned for Supabase.

    - The transaction pooler (port 6543) multiplexes connections and does NOT
      support prepared statements, so we disable asyncpg's statement cache and
      give each prepared statement a unique name to avoid collisions.
    - Supabase requires TLS, so we request SSL.
    """
    args: dict = {}
    if settings.db_requires_ssl:
        # Encrypt the connection (sslmode=require) without failing on the
        # self-signed chain Supabase's pooler presents. This mirrors libpq's
        # default behaviour for cloud Postgres and avoids CERTIFICATE_VERIFY
        # errors on Windows where the CA chain isn't in the local trust store.
        import ssl as _ssl

        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
        args["ssl"] = ctx
    if settings.is_supabase_pooler:
        import uuid

        args["statement_cache_size"] = 0
        args["prepared_statement_name_func"] = lambda: f"__asyncpg_{uuid.uuid4()}__"
    return args


# When using the pooler we also avoid SQLAlchemy's own pooling (the pooler
# already manages connections); NullPool keeps things simple and avoids stale
# server-side state.
_engine_kwargs: dict = {
    "echo": False,
    "pool_pre_ping": True,
    "connect_args": _build_connect_args(),
}
if settings.is_supabase_pooler:
    from sqlalchemy.pool import NullPool

    _engine_kwargs["poolclass"] = NullPool
else:
    _engine_kwargs["pool_size"] = 10
    _engine_kwargs["max_overflow"] = 20

engine = create_async_engine(settings.database_url, **_engine_kwargs)

AsyncSessionLocal = async_sessionmaker(
    bind=engine, expire_on_commit=False, class_=AsyncSession
)


# ---- Schema DDL ----------------------------------------------------------

_SCHEMA_STATEMENTS = [
    "CREATE EXTENSION IF NOT EXISTS vector;",
    # One row per restaurant/tenant so we can scale to multiple outlets.
    """
    CREATE TABLE IF NOT EXISTS restaurants (
        id          SERIAL PRIMARY KEY,
        slug        TEXT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        upi_vpa     TEXT,
        upi_name    TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Backfill columns for pre-existing installs (idempotent).
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_vpa TEXT;",
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_name TEXT;",
    # Parsed menu chunks + embeddings. Dimension is interpolated from settings.
    """
    CREATE TABLE IF NOT EXISTS documents (
        id            SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
        content       TEXT NOT NULL,
        embedding     VECTOR({dim}),
        metadata      JSONB NOT NULL DEFAULT '{{}}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Structured menu items extracted from the PDF.
    """
    CREATE TABLE IF NOT EXISTS menu_items (
        id            SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT,
        category      TEXT,
        price         NUMERIC(10, 2),
        currency      TEXT DEFAULT '$',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Sessions tied to a table number.
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
        table_number  TEXT NOT NULL,
        customer_name TEXT,
        order_type    TEXT NOT NULL DEFAULT 'dine_in',
        cart          JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS customer_name TEXT;",
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'dine_in';",
    # Placed orders — the permanent sales record and kitchen queue.
    """
    CREATE TABLE IF NOT EXISTS orders (
        id             SERIAL PRIMARY KEY,
        restaurant_id  INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
        order_no       TEXT NOT NULL,
        order_type     TEXT NOT NULL DEFAULT 'dine_in',
        table_number   TEXT NOT NULL,
        customer_name  TEXT,
        items          JSONB NOT NULL DEFAULT '[]'::jsonb,
        subtotal       NUMERIC(10, 2) NOT NULL DEFAULT 0,
        tax            NUMERIC(10, 2) NOT NULL DEFAULT 0,
        total          NUMERIC(10, 2) NOT NULL DEFAULT 0,
        currency       TEXT DEFAULT '$',
        status         TEXT NOT NULL DEFAULT 'new',
        payment_status TEXT NOT NULL DEFAULT 'paid_unverified',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Backfill for pre-existing installs (idempotent).
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'dine_in';",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;",
    "CREATE INDEX IF NOT EXISTS orders_restaurant_idx ON orders(restaurant_id);",
    "CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);",
    "CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at);",
    # Similarity index for fast ANN retrieval.
    """
    CREATE INDEX IF NOT EXISTS documents_embedding_idx
    ON documents USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
    """,
    "CREATE INDEX IF NOT EXISTS documents_restaurant_idx ON documents(restaurant_id);",
    "CREATE INDEX IF NOT EXISTS menu_items_restaurant_idx ON menu_items(restaurant_id);",
    "CREATE INDEX IF NOT EXISTS sessions_restaurant_idx ON sessions(restaurant_id);",
]


async def init_db() -> None:
    """Create extension, tables and indexes if they do not exist."""
    async with engine.begin() as conn:
        for stmt in _SCHEMA_STATEMENTS:
            await conn.execute(text(stmt.format(dim=settings.embedding_dim)))


async def dispose_db() -> None:
    await engine.dispose()


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Context-managed session with commit/rollback handling."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding a session."""
    async with session_scope() as session:
        yield session
