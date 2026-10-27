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
        payment_mode TEXT NOT NULL DEFAULT 'prepaid',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Backfill columns for pre-existing installs (idempotent).
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_vpa TEXT;",
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS upi_name TEXT;",
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'prepaid';",
    "ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_payment_mode_check;",
    "ALTER TABLE restaurants ADD CONSTRAINT restaurants_payment_mode_check CHECK (payment_mode IN ('prepaid', 'postpaid'));",
    # Printed-receipt header fields (name override, subtitle, address, FSSAI,
    # phone, GSTIN, footer). Stored as a JSONB blob so staff can edit the shop's
    # legal/receipt details from the manager dashboard without a schema change
    # per field. Defaults to an empty object; the receipt simply omits any blank.
    "ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS receipt_profile JSONB NOT NULL DEFAULT '{}'::jsonb;",
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
    # NOTE: ``price`` is the base price (Non-AC / default zone). Per-zone
    # overrides live in ``zone_prices`` (JSONB map {zone: price}); zones not
    # listed there fall back to ``price``. ``available`` toggles sold-out.
    """
    CREATE TABLE IF NOT EXISTS menu_items (
        id            SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT,
        category      TEXT,
        price         NUMERIC(10, 2),
        currency      TEXT DEFAULT '$',
        zone_prices   JSONB NOT NULL DEFAULT '{}'::jsonb,
        available     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Backfill the zone/availability columns for pre-existing installs. Both
    # default to no-op values so existing menus bill and show exactly as before.
    "ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS zone_prices JSONB NOT NULL DEFAULT '{}'::jsonb;",
    "ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT true;",
    # Predefined tables, each mapped to a pricing zone. Customers never pick a
    # zone; the table they sit at decides it. A table that is not registered
    # here defaults to the base price (zone resolves to NULL -> no override).
    """
    CREATE TABLE IF NOT EXISTS restaurant_tables (
        id            SERIAL PRIMARY KEY,
        restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
        table_number  TEXT NOT NULL,
        zone          TEXT NOT NULL DEFAULT 'Non-AC',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (restaurant_id, table_number)
    );
    """,
    "CREATE INDEX IF NOT EXISTS restaurant_tables_rid_idx ON restaurant_tables(restaurant_id);",
    # Opaque QR tokens. Each physical table sticker encodes one durable, random
    # token that maps to a (tenant, table). The customer only ever sees this
    # token; the slug/tenant_id never leaves the server. `active` lets staff
    # revoke a sticker (e.g. reprint) without deleting history.
    """
    CREATE TABLE IF NOT EXISTS qr_tokens (
        token         TEXT PRIMARY KEY,
        restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
        table_number  TEXT NOT NULL,
        active        BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (restaurant_id, table_number)
    );
    """,
    "CREATE INDEX IF NOT EXISTS qr_tokens_rid_idx ON qr_tokens(restaurant_id);",
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
    # Zone resolved from the table at session start (NULL = base price).
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS zone TEXT;",
    # Short-lived session lifecycle: `device_id` recognizes the same browser on
    # rescan (so we can continue its cart), `last_seen_at` drives sliding
    # inactivity expiry, and `expires_at` is the hard cutoff enforced on every
    # authenticated call. Backfill expires_at for pre-existing rows generously.
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id TEXT;",
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();",
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;",
    # SHA-256 of the User-Agent that first minted the session. Together with
    # device_id this pins the token to one browser/device so a captured token
    # replayed from a different client is detected and rejected. Nullable so
    # pre-existing sessions (minted before pinning) stay usable.
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ua_hash TEXT;",
    "CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions(restaurant_id, table_number, device_id);",
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
    # Zone frozen onto the order at placement so past bills never change if a
    # table's zone is later reassigned.
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS zone TEXT;",
    # Each order is bound to the session (and device) that placed it. This is
    # what lets a customer see ONLY their own session's orders, keeps every
    # scan/order a separate transaction (never merged by table), and lets us
    # end a session once all of its orders are served. Nullable so pre-existing
    # orders (placed before this column existed) stay valid.
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id TEXT;",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS device_id TEXT;",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;",
    "CREATE INDEX IF NOT EXISTS orders_session_idx ON orders(session_id);",
    "CREATE INDEX IF NOT EXISTS orders_closed_idx ON orders(closed_at);",
    "CREATE INDEX IF NOT EXISTS orders_restaurant_idx ON orders(restaurant_id);",
    "CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);",
    "CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at);",
    # Security audit trail. Replay attempts (a token used from a different
    # device/UA than it was bound to) are recorded here so staff monitoring can
    # surface and alert on suspicious activity per outlet.
    """
    CREATE TABLE IF NOT EXISTS security_events (
        id             SERIAL PRIMARY KEY,
        event_type     TEXT NOT NULL,
        restaurant_id  INTEGER,
        session_id     TEXT,
        table_number   TEXT,
        detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
        client_ip      TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS security_events_type_idx ON security_events(event_type);",
    "CREATE INDEX IF NOT EXISTS security_events_rid_idx ON security_events(restaurant_id);",
    "CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events(created_at);",
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
    """Create extension, tables and indexes if they do not exist.

    Only statements that contain the ``{dim}`` placeholder are run through
    ``str.format``; the rest are executed verbatim. This is important because
    some DDL contains literal braces (e.g. ``'{}'::jsonb`` defaults) that
    ``str.format`` would otherwise try to interpret as replacement fields.
    """
    async with engine.begin() as conn:
        for stmt in _SCHEMA_STATEMENTS:
            sql = (
                stmt.format(dim=settings.embedding_dim)
                if "{dim}" in stmt
                else stmt
            )
            await conn.execute(text(sql))


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
