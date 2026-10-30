"""Data-access layer. All raw SQL lives here so services stay DB-agnostic."""
from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

def _as_date(value: Optional[str]) -> Optional[date]:
    """Coerce a 'YYYY-MM-DD' string (or date/datetime) to a datetime.date.

    asyncpg binds Python values by type, not by SQL cast, so a date filter
    must be passed a real date object — a bare string raises a DataError
    ('str' object has no attribute 'toordinal'). Returns None for falsy input
    so callers can skip the filter.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value).strip())


# ---- Restaurants ---------------------------------------------------------

async def get_or_create_restaurant(
    session: AsyncSession, slug: str, name: str, update_name: bool = False
) -> int:
    """Return the restaurant id for ``slug``, creating it if needed.

    The slug is the stable tenant identity (unique). ``name`` is the display
    name and may be shared across outlets. Pass ``update_name=True`` to refresh
    the display name of an existing restaurant (e.g. on menu re-upload).
    """
    # Atomic upsert on the UNIQUE(slug) constraint. This avoids a
    # SELECT-then-INSERT race where two concurrent uploads could both create a
    # row for the same slug (and guarantees exactly one tenant per slug).
    # ON CONFLICT updates the name only when update_name is requested;
    # otherwise it's a no-op update that still returns the existing id.
    row = (
        await session.execute(
            text(
                """
                INSERT INTO restaurants (slug, name)
                VALUES (:slug, :name)
                ON CONFLICT (slug) DO UPDATE
                    SET name = CASE
                        WHEN :update_name THEN EXCLUDED.name
                        ELSE restaurants.name
                    END
                RETURNING id
                """
            ),
            {"slug": slug, "name": name, "update_name": bool(update_name and name)},
        )
    ).first()
    return row[0]


async def get_restaurant_by_slug(
    session: AsyncSession, slug: str
) -> Optional[Dict[str, Any]]:
    row = (
        await session.execute(
            text(
                "SELECT id, slug, name, upi_vpa, upi_name, payment_mode "
                "FROM restaurants WHERE slug = :slug"
            ),
            {"slug": slug},
        )
    ).mappings().first()
    return dict(row) if row else None


async def get_restaurant_by_id(
    session: AsyncSession, restaurant_id: int
) -> Optional[Dict[str, Any]]:
    row = (
        await session.execute(
            text(
                "SELECT id, slug, name, upi_vpa, upi_name, payment_mode "
                "FROM restaurants WHERE id = :rid"
            ),
            {"rid": restaurant_id},
        )
    ).mappings().first()
    return dict(row) if row else None


async def set_restaurant_payment_mode(
    session: AsyncSession, slug: str, payment_mode: str
) -> None:
    if payment_mode not in ("prepaid", "postpaid"):
        raise ValueError("Unsupported payment mode")
    await session.execute(
        text("UPDATE restaurants SET payment_mode = :mode WHERE slug = :slug"),
        {"mode": payment_mode, "slug": slug},
    )


async def set_restaurant_upi(
    session: AsyncSession, slug: str, upi_vpa: str, upi_name: str
) -> None:
    await session.execute(
        text(
            "UPDATE restaurants SET upi_vpa = :vpa, upi_name = :name "
            "WHERE slug = :slug"
        ),
        {"vpa": upi_vpa, "name": upi_name, "slug": slug},
    )


async def get_receipt_profile(
    session: AsyncSession, restaurant_id: int
) -> Dict[str, Any]:
    """Return the restaurant's printed-receipt header fields as a dict.

    Always returns a dict (empty when nothing has been configured yet) so
    callers can treat every field as optional.
    """
    row = (
        await session.execute(
            text("SELECT receipt_profile FROM restaurants WHERE id = :rid"),
            {"rid": restaurant_id},
        )
    ).mappings().first()
    if not row:
        return {}
    profile = row.get("receipt_profile")
    return dict(profile) if isinstance(profile, dict) else {}


async def set_receipt_profile(
    session: AsyncSession, restaurant_id: int, profile: Dict[str, Any]
) -> Dict[str, Any]:
    """Persist the receipt header fields (overwrites the whole blob)."""
    await session.execute(
        text(
            "UPDATE restaurants SET receipt_profile = CAST(:profile AS JSONB) "
            "WHERE id = :rid"
        ),
        {"rid": restaurant_id, "profile": json.dumps(profile or {})},
    )
    return profile or {}


# ---- Documents (vector store) -------------------------------------------

async def clear_documents(session: AsyncSession, restaurant_id: int) -> None:
    await session.execute(
        text("DELETE FROM documents WHERE restaurant_id = :rid"),
        {"rid": restaurant_id},
    )


async def insert_documents(
    session: AsyncSession,
    restaurant_id: int,
    chunks: List[str],
    embeddings: List[List[float]],
    metadatas: List[Dict[str, Any]],
) -> int:
    inserted = 0
    for content, embedding, meta in zip(chunks, embeddings, metadatas):
        await session.execute(
            text(
                "INSERT INTO documents (restaurant_id, content, embedding, metadata) "
                "VALUES (:rid, :content, :embedding, CAST(:metadata AS JSONB))"
            ),
            {
                "rid": restaurant_id,
                "content": content,
                # pgvector accepts the string form '[1,2,3]'.
                "embedding": "[" + ",".join(str(x) for x in embedding) + "]",
                "metadata": json.dumps(meta),
            },
        )
        inserted += 1
    return inserted


async def similarity_search(
    session: AsyncSession,
    restaurant_id: int,
    query_embedding: List[float],
    top_k: int,
) -> List[Dict[str, Any]]:
    """Cosine-distance nearest neighbours. Lower distance = more similar."""
    vector_literal = "[" + ",".join(str(x) for x in query_embedding) + "]"
    rows = (
        await session.execute(
            text(
                """
                SELECT content, metadata,
                       1 - (embedding <=> CAST(:qvec AS vector)) AS score
                FROM documents
                WHERE restaurant_id = :rid
                ORDER BY embedding <=> CAST(:qvec AS vector)
                LIMIT :k
                """
            ),
            {"qvec": vector_literal, "rid": restaurant_id, "k": top_k},
        )
    ).mappings().all()
    return [dict(r) for r in rows]


# ---- Menu items ----------------------------------------------------------

async def clear_menu_items(session: AsyncSession, restaurant_id: int) -> None:
    await session.execute(
        text("DELETE FROM menu_items WHERE restaurant_id = :rid"),
        {"rid": restaurant_id},
    )


async def insert_menu_items(
    session: AsyncSession, restaurant_id: int, items: List[Dict[str, Any]]
) -> int:
    for it in items:
        zone_prices = it.get("zone_prices") or {}
        available = it.get("available")
        await session.execute(
            text(
                """
                INSERT INTO menu_items
                    (restaurant_id, name, description, category, price,
                     currency, zone_prices, available)
                VALUES (:rid, :name, :description, :category, :price,
                        :currency, CAST(:zone_prices AS JSONB), :available)
                """
            ),
            {
                "rid": restaurant_id,
                "name": it.get("name"),
                "description": it.get("description"),
                "category": it.get("category"),
                "price": it.get("price"),
                "currency": it.get("currency", "$"),
                "zone_prices": json.dumps(zone_prices),
                # Default to available unless explicitly set False.
                "available": False if available is False else True,
            },
        )
    return len(items)


async def get_menu_items(
    session: AsyncSession, restaurant_id: int
) -> List[Dict[str, Any]]:
    rows = (
        await session.execute(
            text(
                """
                SELECT id, name, description, category, price, currency,
                       zone_prices, available
                FROM menu_items
                WHERE restaurant_id = :rid
                ORDER BY category NULLS LAST, name
                """
            ),
            {"rid": restaurant_id},
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def set_menu_item_available(
    session: AsyncSession, restaurant_id: int, item_id: int, available: bool
) -> Optional[Dict[str, Any]]:
    """Toggle a single dish's availability. Returns the updated row or None."""
    row = (
        await session.execute(
            text(
                """
                UPDATE menu_items SET available = :avail
                WHERE id = :id AND restaurant_id = :rid
                RETURNING id, name, available
                """
            ),
            {"avail": available, "id": item_id, "rid": restaurant_id},
        )
    ).mappings().first()
    return dict(row) if row else None


async def get_price_lookup(
    session: AsyncSession, restaurant_id: int
) -> Dict[str, Dict[str, Any]]:
    """Return {lowercased_name: {name, price}} for authoritative re-pricing.

    The server never trusts client-sent prices; it maps each cart line to the
    canonical menu item by (case-insensitive) name and uses the stored price.
    """
    rows = await get_menu_items(session, restaurant_id)
    lookup: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        if r["name"]:
            # zone_prices is a JSONB map {zone: price}; coerce values to float.
            zp_raw = r.get("zone_prices") or {}
            zone_prices = {
                str(k): float(v)
                for k, v in zp_raw.items()
                if v is not None
            }
            lookup[r["name"].strip().lower()] = {
                "name": r["name"],
                "price": float(r["price"]) if r["price"] is not None else 0.0,
                "zone_prices": zone_prices,
                "available": bool(r.get("available", True)),
            }
    return lookup


# ---- Sessions / carts ----------------------------------------------------

async def create_session(
    session: AsyncSession,
    session_id: str,
    restaurant_id: int,
    table_number: str,
    customer_name: Optional[str] = None,
    order_type: str = "dine_in",
    zone: Optional[str] = None,
    device_id: Optional[str] = None,
    ua_hash: Optional[str] = None,
    ttl_seconds: int = 7200,
) -> None:
    """Create (or refresh) a session row.

    ``device_id`` lets us recognize the same browser on a later rescan and,
    together with ``ua_hash``, pins the session to one client so a replayed
    token from a different device/UA is rejected. ``ttl_seconds`` sets the
    initial inactivity window (``expires_at`` is kept sliding by
    :func:`touch_session` on each authenticated call).
    """
    await session.execute(
        text(
            """
            INSERT INTO sessions
                (id, restaurant_id, table_number, customer_name, order_type,
                 zone, device_id, ua_hash, cart, last_seen_at, expires_at)
            VALUES (
                :id, :rid, :table, :cname, :otype, :zone, :device, :ua,
                '[]'::jsonb,
                now(), now() + make_interval(secs => :ttl)
            )
            ON CONFLICT (id) DO UPDATE
                SET table_number = EXCLUDED.table_number,
                    customer_name = EXCLUDED.customer_name,
                    order_type = EXCLUDED.order_type,
                    zone = EXCLUDED.zone,
                    device_id = EXCLUDED.device_id,
                    ua_hash = EXCLUDED.ua_hash,
                    last_seen_at = now(),
                    expires_at = now() + make_interval(secs => :ttl),
                    updated_at = now()
            """
        ),
        {
            "id": session_id,
            "rid": restaurant_id,
            "table": table_number,
            "cname": customer_name,
            "otype": order_type,
            "zone": zone,
            "device": device_id,
            "ua": ua_hash,
            "ttl": ttl_seconds,
        },
    )


async def get_session_row(
    session: AsyncSession, session_id: str
) -> Optional[Dict[str, Any]]:
    row = (
        await session.execute(
            text(
                "SELECT id, restaurant_id, table_number, customer_name, "
                "order_type, zone, cart, device_id, ua_hash, "
                "last_seen_at, expires_at, "
                "(expires_at IS NOT NULL AND expires_at <= now()) AS is_expired "
                "FROM sessions WHERE id = :id"
            ),
            {"id": session_id},
        )
    ).mappings().first()
    return dict(row) if row else None


async def touch_session(
    session: AsyncSession, session_id: str, ttl_seconds: int = 7200
) -> None:
    """Slide a session's inactivity expiry forward on activity."""
    await session.execute(
        text(
            "UPDATE sessions "
            "SET last_seen_at = now(), "
            "    expires_at = now() + make_interval(secs => :ttl), "
            "    updated_at = now() "
            "WHERE id = :id"
        ),
        {"id": session_id, "ttl": ttl_seconds},
    )


async def end_session(session: AsyncSession, session_id: str) -> None:
    """Immediately expire a session (hard cutoff now).

    Called once all of a session's orders are served so the same device/table
    cannot continue it, and a new guest scanning the same QR gets a fresh
    session that can never see the previous guest's orders.
    """
    if not session_id:
        return
    await session.execute(
        text(
            "UPDATE sessions "
            "SET expires_at = now(), last_seen_at = now(), "
            "    cart = '[]'::jsonb, updated_at = now() "
            "WHERE id = :id"
        ),
        {"id": session_id},
    )


async def find_live_device_session(
    session: AsyncSession,
    restaurant_id: int,
    table_number: str,
    device_id: str,
    ua_hash: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Return the most recent non-expired session for this device at this
    table, or None. Used to continue a cart when the same browser rescans.

    When ``ua_hash`` is supplied we also require the stored UA fingerprint to
    match, so a different browser (even sharing a stolen device_id) cannot
    silently continue — it gets a fresh session instead.
    """
    if not device_id:
        return None
    params: Dict[str, Any] = {
        "rid": restaurant_id,
        "tn": table_number,
        "device": device_id,
    }
    ua_clause = ""
    if ua_hash is not None:
        ua_clause = " AND ua_hash = :ua"
        params["ua"] = ua_hash
    row = (
        await session.execute(
            text(
                "SELECT id, restaurant_id, table_number, customer_name, "
                "order_type, zone, cart, device_id, ua_hash, last_seen_at, "
                "expires_at "
                "FROM sessions "
                "WHERE restaurant_id = :rid AND table_number = :tn "
                "  AND device_id = :device"
                + ua_clause +
                "  AND (expires_at IS NULL OR expires_at > now()) "
                "ORDER BY last_seen_at DESC "
                "LIMIT 1"
            ),
            params,
        )
    ).mappings().first()
    return dict(row) if row else None


# ---- QR tokens (opaque table identity) ----------------------------------

async def get_or_create_qr_token(
    session: AsyncSession,
    restaurant_id: int,
    table_number: str,
    token: str,
) -> str:
    """Return the opaque token for (tenant, table), creating it if absent.

    One durable token per physical table sticker. If the table already has a
    token we return the existing one (so re-generating a QR is idempotent and
    doesn't invalidate stickers already printed). ``token`` is the candidate
    used only when inserting a new row.
    """
    row = (
        await session.execute(
            text(
                """
                INSERT INTO qr_tokens (token, restaurant_id, table_number)
                VALUES (:token, :rid, :tn)
                ON CONFLICT (restaurant_id, table_number) DO UPDATE
                    SET active = true
                RETURNING token
                """
            ),
            {"token": token, "rid": restaurant_id, "tn": table_number},
        )
    ).first()
    return row[0]


async def resolve_qr_token(
    session: AsyncSession, token: str
) -> Optional[Dict[str, Any]]:
    """Resolve an opaque token to its tenant + table (server-side only).

    Returns a dict with restaurant_id, slug, name, table_number when the token
    exists and is active; otherwise None. The slug/id are for internal routing
    and must never be returned to the customer.
    """
    if not token:
        return None
    row = (
        await session.execute(
            text(
                "SELECT q.restaurant_id, q.table_number, r.slug, r.name, "
                "r.payment_mode "
                "FROM qr_tokens q "
                "JOIN restaurants r ON r.id = q.restaurant_id "
                "WHERE q.token = :token AND q.active = true"
            ),
            {"token": token},
        )
    ).mappings().first()
    return dict(row) if row else None


async def revoke_qr_token(
    session: AsyncSession, restaurant_id: int, table_number: str
) -> None:
    await session.execute(
        text(
            "UPDATE qr_tokens SET active = false "
            "WHERE restaurant_id = :rid AND table_number = :tn"
        ),
        {"rid": restaurant_id, "tn": table_number},
    )


# ---- Tables & zones ------------------------------------------------------

async def get_table_zone(
    session: AsyncSession, restaurant_id: int, table_number: str
) -> Optional[str]:
    """Return the zone for a given table, or None if the table isn't mapped.

    A None result means "use base pricing" — unregistered tables behave
    exactly like the pre-zone system.
    """
    row = (
        await session.execute(
            text(
                "SELECT zone FROM restaurant_tables "
                "WHERE restaurant_id = :rid AND table_number = :tn"
            ),
            {"rid": restaurant_id, "tn": table_number},
        )
    ).first()
    return row[0] if row else None


async def list_tables(
    session: AsyncSession, restaurant_id: int
) -> List[Dict[str, Any]]:
    rows = (
        await session.execute(
            text(
                "SELECT id, table_number, zone FROM restaurant_tables "
                "WHERE restaurant_id = :rid ORDER BY table_number"
            ),
            {"rid": restaurant_id},
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def upsert_table(
    session: AsyncSession, restaurant_id: int, table_number: str, zone: str
) -> Dict[str, Any]:
    """Create or update a table -> zone mapping."""
    row = (
        await session.execute(
            text(
                """
                INSERT INTO restaurant_tables (restaurant_id, table_number, zone)
                VALUES (:rid, :tn, :zone)
                ON CONFLICT (restaurant_id, table_number) DO UPDATE
                    SET zone = EXCLUDED.zone, updated_at = now()
                RETURNING id, table_number, zone
                """
            ),
            {"rid": restaurant_id, "tn": table_number, "zone": zone},
        )
    ).mappings().first()
    return dict(row)


async def replace_tables(
    session: AsyncSession, restaurant_id: int, tables: List[Dict[str, Any]]
) -> int:
    """Bulk-replace the table map (used by JSON menu ingestion).

    Deletes ALL existing tables for the restaurant first, then inserts the
    new set. This makes it idempotent: deleted tables don't linger, renamed
    tables don't leave stale rows.
    """
    await session.execute(
        text("DELETE FROM restaurant_tables WHERE restaurant_id = :rid"),
        {"rid": restaurant_id},
    )
    count = 0
    for t in tables:
        tn = (t.get("table_number") or "").strip()
        zone = (t.get("zone") or "Non-AC").strip() or "Non-AC"
        if not tn:
            continue
        await upsert_table(session, restaurant_id, tn, zone)
        count += 1
    return count


async def update_cart(
    session: AsyncSession, session_id: str, cart: List[Dict[str, Any]]
) -> None:
    await session.execute(
        text(
            "UPDATE sessions SET cart = CAST(:cart AS JSONB), updated_at = now() "
            "WHERE id = :id"
        ),
        {"id": session_id, "cart": json.dumps(cart)},
    )


# ---- Orders --------------------------------------------------------------

# Active (kitchen-relevant) statuses vs terminal ones.
ACTIVE_ORDER_STATUSES = ("new", "preparing", "ready")
ALL_ORDER_STATUSES = ("new", "preparing", "ready", "served", "cancelled")


async def _next_order_no(session: AsyncSession, restaurant_id: int) -> str:
    """Short per-outlet daily sequence like 'A17'.

    Counts today's orders for the outlet and increments. The letter prefix is
    derived from the day so numbers reset and stay short each day.
    """
    row = (
        await session.execute(
            text(
                "SELECT count(*) FROM orders "
                "WHERE restaurant_id = :rid "
                "AND created_at::date = (now() AT TIME ZONE 'utc')::date"
            ),
            {"rid": restaurant_id},
        )
    ).first()
    seq = (row[0] if row else 0) + 1
    # Day-of-year modulo 26 gives a rotating letter prefix (cosmetic).
    import datetime as _dt

    letter = chr(ord("A") + (_dt.datetime.utcnow().timetuple().tm_yday % 26))
    return f"{letter}{seq}"


async def create_order(
    session: AsyncSession,
    restaurant_id: int,
    table_number: str,
    items: List[Dict[str, Any]],
    subtotal: float,
    tax: float,
    total: float,
    currency: str,
    payment_status: str = "paid_unverified",
    order_type: str = "dine_in",
    customer_name: Optional[str] = None,
    zone: Optional[str] = None,
    session_id: Optional[str] = None,
    device_id: Optional[str] = None,
) -> Dict[str, Any]:
    order_no = await _next_order_no(session, restaurant_id)
    row = (
        await session.execute(
            text(
                """
                INSERT INTO orders
                    (restaurant_id, order_no, order_type, table_number,
                     customer_name, zone, session_id, device_id, items,
                     subtotal, tax, total, currency, status, payment_status)
                VALUES
                    (:rid, :no, :otype, :table, :cname, :zone, :sid, :did,
                     CAST(:items AS JSONB),
                     :subtotal, :tax, :total, :currency, 'new', :pay)
                RETURNING id, order_no, order_type, customer_name, zone, status,
                          payment_status, created_at
                """
            ),
            {
                "rid": restaurant_id,
                "no": order_no,
                "otype": order_type,
                "table": table_number,
                "cname": customer_name,
                "zone": zone,
                "sid": session_id,
                "did": device_id,
                "items": json.dumps(items),
                "subtotal": subtotal,
                "tax": tax,
                "total": total,
                "currency": currency,
                "pay": payment_status,
            },
        )
    ).mappings().first()
    return dict(row)


async def close_table(
    session: AsyncSession, restaurant_id: int, table_number: str
) -> int:
    """Force-serve all active orders for a dine-in table (manual override).

    Returns the number of orders closed. Lets staff reset a table so a new
    customer can order fresh.
    """
    result = await session.execute(
        text(
            """
            UPDATE orders SET status = 'served', updated_at = now()
            WHERE restaurant_id = :rid
              AND table_number = :table
              AND order_type = 'dine_in'
              AND status IN ('new', 'preparing', 'ready')
            """
        ),
        {"rid": restaurant_id, "table": table_number},
    )
    return result.rowcount or 0


async def list_orders(
    session: AsyncSession,
    restaurant_id: int,
    statuses: Optional[tuple] = None,
) -> List[Dict[str, Any]]:
    params: Dict[str, Any] = {"rid": restaurant_id}
    where = "restaurant_id = :rid"
    if statuses:
        # Build an IN clause with bound params.
        keys = []
        for i, s in enumerate(statuses):
            k = f"s{i}"
            params[k] = s
            keys.append(f":{k}")
        where += f" AND status IN ({', '.join(keys)})"
    rows = (
        await session.execute(
            text(
                f"""
                SELECT id, order_no, order_type, table_number, customer_name,
                       zone, items, subtotal, tax, total, currency, status,
                       payment_status, created_at
                FROM orders
                WHERE {where}
                ORDER BY created_at ASC
                """
            ),
            params,
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def list_manager_orders(
    session: AsyncSession,
    restaurant_id: int,
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """All orders for the manager dashboard, newest first, with optional
    status and date-range (inclusive, 'YYYY-MM-DD' UTC) filters."""
    params: Dict[str, Any] = {"rid": restaurant_id}
    where = "restaurant_id = :rid"
    if status:
        where += " AND status = :status"
        params["status"] = status
    # asyncpg binds by Python type, so pass real date objects (not strings):
    # a str here raises DataError ("'str' object has no attribute 'toordinal'").
    dfrom = _as_date(date_from)
    dto = _as_date(date_to)
    if dfrom is not None:
        where += " AND created_at::date >= :dfrom"
        params["dfrom"] = dfrom
    if dto is not None:
        where += " AND created_at::date <= :dto"
        params["dto"] = dto
    rows = (
        await session.execute(
            text(
                f"""
                SELECT id, order_no, order_type, table_number, customer_name,
                       zone, items, subtotal, tax, total, currency, status,
                       payment_status, created_at
                FROM orders
                WHERE {where}
                ORDER BY created_at DESC
                """
            ),
            params,
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def get_order(
    session: AsyncSession, order_id: int
) -> Optional[Dict[str, Any]]:
    row = (
        await session.execute(
            text(
                "SELECT id, restaurant_id, order_no, order_type, table_number, "
                "customer_name, zone, session_id, device_id, items, subtotal, "
                "tax, total, currency, status, payment_status, created_at "
                "FROM orders WHERE id = :id"
            ),
            {"id": order_id},
        )
    ).mappings().first()
    return dict(row) if row else None


async def update_order_status(
    session: AsyncSession, order_id: int, status: str
) -> None:
    await session.execute(
        text(
            "UPDATE orders SET status = :status, updated_at = now() "
            "WHERE id = :id"
        ),
        {"id": order_id, "status": status},
    )


async def update_order_payment(
    session: AsyncSession, order_id: int, payment_status: str
) -> None:
    await session.execute(
        text(
            "UPDATE orders SET payment_status = :pay, updated_at = now() "
            "WHERE id = :id"
        ),
        {"id": order_id, "pay": payment_status},
    )


# ---- Session-scoped order views (customer-facing isolation) --------------

async def list_session_orders(
    session: AsyncSession, session_id: str
) -> List[Dict[str, Any]]:
    """Return ONLY the orders placed in the given session, oldest first.

    This is what the customer's device sees: never other customers' orders,
    even at the same physical table. Each order is an independent transaction
    with its own status.
    """
    if not session_id:
        return []
    rows = (
        await session.execute(
            text(
                """
                SELECT id, order_no, order_type, table_number, customer_name,
                       zone, items, subtotal, tax, total, currency, status,
                       payment_status, created_at
                FROM orders
                WHERE session_id = :sid
                ORDER BY created_at ASC
                """
            ),
            {"sid": session_id},
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def close_session_orders(
    session: AsyncSession, session_id: str
) -> int:
    """Mark served, paid orders closed at settlement time."""
    result = await session.execute(
        text(
            "UPDATE orders SET closed_at = now(), updated_at = now() "
            "WHERE session_id = :sid AND status = 'served' "
            "AND payment_status = 'verified' AND closed_at IS NULL"
        ),
        {"sid": session_id},
    )
    return result.rowcount or 0


async def session_orders_all_served_and_paid(
    session: AsyncSession, session_id: str
) -> bool:
    """True when every order is terminal and its payment is verified.

    Cancelled orders do not require payment. This keeps the customer's order
    history visible until the table is both served and paid.
    """
    if not session_id:
        return False
    row = (
        await session.execute(
            text(
                "SELECT count(*) AS total, "
                "       count(*) FILTER (WHERE status IN ('served', 'cancelled') "
                "         AND (status = 'cancelled' OR payment_status = 'verified')) AS closed "
                "FROM orders WHERE session_id = :sid"
            ),
            {"sid": session_id},
        )
    ).mappings().first()
    return bool(row and row["total"] and row["total"] == row["closed"])


async def mark_session_paid(
    session: AsyncSession, session_id: str
) -> int:
    """Mark all non-cancelled orders in a postpaid session paid."""
    result = await session.execute(
        text(
            "UPDATE orders SET payment_status = 'verified', updated_at = now() "
            "WHERE session_id = :sid AND status <> 'cancelled' "
            "AND payment_status <> 'verified'"
        ),
        {"sid": session_id},
    )
    return result.rowcount or 0


async def session_orders_all_served(
    session: AsyncSession, session_id: str
) -> bool:
    """True when the session has at least one order and every one of its
    orders is in a terminal state (served or cancelled).

    Used to end a session so a new customer at the same table starts clean.
    """
    if not session_id:
        return False
    row = (
        await session.execute(
            text(
                """
                SELECT count(*) AS total,
                       count(*) FILTER (
                           WHERE status NOT IN ('served', 'cancelled')
                       ) AS open_count
                FROM orders
                WHERE session_id = :sid
                """
            ),
            {"sid": session_id},
        )
    ).mappings().first()
    if not row or (row["total"] or 0) == 0:
        return False
    return (row["open_count"] or 0) == 0


async def sales_report(
    session: AsyncSession,
    restaurant_id: int,
    date_from: Optional[str],
    date_to: Optional[str],
) -> Dict[str, Any]:
    """Aggregate sales for an outlet over an optional date range (inclusive).

    Excludes cancelled orders from revenue. Dates are 'YYYY-MM-DD' (UTC).
    """
    params: Dict[str, Any] = {"rid": restaurant_id}
    where = "restaurant_id = :rid AND status <> 'cancelled'"
    # Bind real date objects; see list_manager_orders for why strings fail.
    dfrom = _as_date(date_from)
    dto = _as_date(date_to)
    if dfrom is not None:
        where += " AND created_at::date >= :dfrom"
        params["dfrom"] = dfrom
    if dto is not None:
        where += " AND created_at::date <= :dto"
        params["dto"] = dto

    totals = (
        await session.execute(
            text(
                f"""
                SELECT count(*) AS order_count,
                       COALESCE(sum(subtotal), 0) AS subtotal,
                       COALESCE(sum(tax), 0) AS tax,
                       COALESCE(sum(total), 0) AS total
                FROM orders WHERE {where}
                """
            ),
            params,
        )
    ).mappings().first()

    # Per-status counts.
    status_rows = (
        await session.execute(
            text(
                f"SELECT status, count(*) AS n FROM orders WHERE {where} "
                f"GROUP BY status"
            ),
            params,
        )
    ).mappings().all()

    # Top items: unnest the items JSONB array.
    item_rows = (
        await session.execute(
            text(
                f"""
                SELECT it->>'name' AS name,
                       sum((it->>'quantity')::int) AS qty,
                       sum((it->>'line_total')::numeric) AS revenue
                FROM orders, jsonb_array_elements(items) AS it
                WHERE {where}
                GROUP BY it->>'name'
                ORDER BY qty DESC
                LIMIT 20
                """
            ),
            params,
        )
    ).mappings().all()

    return {
        "order_count": int(totals["order_count"]),
        "subtotal": float(totals["subtotal"]),
        "tax": float(totals["tax"]),
        "total": float(totals["total"]),
        "by_status": {r["status"]: int(r["n"]) for r in status_rows},
        "top_items": [
            {
                "name": r["name"],
                "quantity": int(r["qty"]),
                "revenue": float(r["revenue"]),
            }
            for r in item_rows
        ],
    }


async def analytics_dashboard(
    session: AsyncSession,
    restaurant: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
) -> Dict[str, Any]:
    """Return merchant analytics aggregates for one outlet or all outlets.

    Revenue is intentionally limited to served orders, while order volume and
    status counts include every non-cancelled order in the selected range.
    Dates are inclusive UTC calendar dates, matching the existing reports API.
    """
    params: Dict[str, Any] = {}
    where = "1=1"
    if restaurant and restaurant != "all":
        where += " AND r.slug = :restaurant"
        params["restaurant"] = restaurant
    dfrom = _as_date(date_from)
    dto = _as_date(date_to)
    if dfrom is not None:
        where += " AND o.created_at::date >= :dfrom"
        params["dfrom"] = dfrom
    if dto is not None:
        where += " AND o.created_at::date <= :dto"
        params["dto"] = dto

    totals = (await session.execute(text(f"""
        SELECT count(*) FILTER (WHERE o.status <> 'cancelled') AS orders,
               count(*) FILTER (WHERE o.status = 'served') AS completed_orders,
               count(*) FILTER (WHERE o.status <> 'cancelled' AND o.order_type = 'dine_in') AS dine_in_orders,
               count(*) FILTER (WHERE o.status <> 'cancelled' AND o.order_type = 'takeaway') AS takeaway_orders,
               count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
               COALESCE(sum(o.total) FILTER (WHERE o.status = 'served'), 0) AS revenue,
               COALESCE(sum(o.tax) FILTER (WHERE o.status = 'served'), 0) AS tax
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
        WHERE {where}
    """), params)).mappings().first()

    status_rows = (await session.execute(text(f"""
        SELECT o.status, count(*) AS n
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
        WHERE {where}
        GROUP BY o.status
    """), params)).mappings().all()

    trend_rows = (await session.execute(text(f"""
        SELECT o.created_at::date AS day,
               count(*) FILTER (WHERE o.status <> 'cancelled') AS orders,
               COALESCE(sum(o.total) FILTER (WHERE o.status = 'served'), 0) AS revenue
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
        WHERE {where}
        GROUP BY o.created_at::date ORDER BY day
    """), params)).mappings().all()

    item_rows = (await session.execute(text(f"""
        SELECT it->>'name' AS name,
               sum((it->>'quantity')::int) AS qty,
               sum((it->>'line_total')::numeric) AS revenue
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id,
             jsonb_array_elements(o.items) AS it
        WHERE {where} AND o.status = 'served'
        GROUP BY it->>'name' ORDER BY qty DESC LIMIT 10
    """), params)).mappings().all()

    summary_rows = (await session.execute(text(f"""
        SELECT o.created_at::date AS day,
               count(*) FILTER (WHERE o.status <> 'cancelled') AS orders,
               COALESCE(sum(o.total) FILTER (WHERE o.status = 'served'), 0) AS revenue,
               count(*) FILTER (WHERE o.status = 'served') AS completed_orders
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
        WHERE {where}
        GROUP BY o.created_at::date ORDER BY day DESC
    """), params)).mappings().all()

    params["outlet_all"] = restaurant == "all"
    params["outlet_slug"] = restaurant or ""
    outlet_rows = (await session.execute(text(f"""
        SELECT r.slug, r.name,
               COALESCE(sum(o.total) FILTER (WHERE o.status = 'served'), 0) AS revenue,
               count(o.id) FILTER (WHERE o.status <> 'cancelled') AS orders
        FROM restaurants r LEFT JOIN orders o ON o.restaurant_id = r.id
          AND ({' AND '.join(where.split(' AND ')[1:]) if ' AND ' in where else '1=1'})
        GROUP BY r.id, r.slug, r.name
        HAVING (:outlet_all OR r.slug = :outlet_slug)
        ORDER BY revenue DESC, r.name
    """), params)).mappings().all()

    table_where = "1=1"
    table_params: Dict[str, Any] = {}
    if restaurant and restaurant != "all":
        table_where += " AND r.slug = :table_restaurant"
        table_params["table_restaurant"] = restaurant
    active = (await session.execute(text(f"""
        SELECT count(DISTINCT o.table_number) AS n
        FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
        WHERE {table_where} AND o.order_type = 'dine_in'
          AND o.status IN ('new','preparing','ready')
          AND o.table_number <> '-'
    """), table_params)).scalar() or 0

    return {
        "currency": settings.currency if 'settings' in globals() else "$",
        "total_revenue": float(totals["revenue"] or 0),
        "total_orders": int(totals["orders"] or 0),
        "completed_orders": int(totals["completed_orders"] or 0),
        "dine_in_orders": int(totals["dine_in_orders"] or 0),
        "takeaway_orders": int(totals["takeaway_orders"] or 0),
        "cancelled_orders": int(totals["cancelled"] or 0),
        "tax": float(totals["tax"] or 0),
        "active_tables": int(active),
        "total_staff": settings.staff_count,
        "by_status": {r["status"]: int(r["n"]) for r in status_rows},
        "trend": [{"date": str(r["day"]), "orders": int(r["orders"] or 0), "revenue": float(r["revenue"] or 0)} for r in trend_rows],
        "top_items": [{"name": r["name"], "quantity": int(r["qty"] or 0), "revenue": float(r["revenue"] or 0)} for r in item_rows],
        "summary": [{"date": str(r["day"]), "orders": int(r["orders"] or 0), "revenue": float(r["revenue"] or 0), "aov": float(r["revenue"] or 0) / int(r["completed_orders"] or 1) if r["completed_orders"] else 0} for r in summary_rows],
        "outlets": [{"slug": r["slug"], "name": r["name"], "revenue": float(r["revenue"] or 0), "orders": int(r["orders"] or 0)} for r in outlet_rows],
    }


async def list_restaurants(session: AsyncSession) -> List[Dict[str, Any]]:
    rows = (await session.execute(text("SELECT slug, name FROM restaurants ORDER BY name, slug"))).mappings().all()
    return [dict(r) for r in rows]
