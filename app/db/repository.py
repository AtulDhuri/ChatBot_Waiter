"""Data-access layer. All raw SQL lives here so services stay DB-agnostic."""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


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
                "SELECT id, slug, name, upi_vpa, upi_name "
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
                "SELECT id, slug, name, upi_vpa, upi_name "
                "FROM restaurants WHERE id = :rid"
            ),
            {"rid": restaurant_id},
        )
    ).mappings().first()
    return dict(row) if row else None


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
        await session.execute(
            text(
                """
                INSERT INTO menu_items
                    (restaurant_id, name, description, category, price, currency)
                VALUES (:rid, :name, :description, :category, :price, :currency)
                """
            ),
            {
                "rid": restaurant_id,
                "name": it.get("name"),
                "description": it.get("description"),
                "category": it.get("category"),
                "price": it.get("price"),
                "currency": it.get("currency", "$"),
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
                SELECT id, name, description, category, price, currency
                FROM menu_items
                WHERE restaurant_id = :rid
                ORDER BY category NULLS LAST, name
                """
            ),
            {"rid": restaurant_id},
        )
    ).mappings().all()
    return [dict(r) for r in rows]


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
            lookup[r["name"].strip().lower()] = {
                "name": r["name"],
                "price": float(r["price"]) if r["price"] is not None else 0.0,
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
) -> None:
    await session.execute(
        text(
            """
            INSERT INTO sessions
                (id, restaurant_id, table_number, customer_name, order_type, cart)
            VALUES (:id, :rid, :table, :cname, :otype, '[]'::jsonb)
            ON CONFLICT (id) DO UPDATE
                SET table_number = EXCLUDED.table_number,
                    customer_name = EXCLUDED.customer_name,
                    order_type = EXCLUDED.order_type,
                    updated_at = now()
            """
        ),
        {
            "id": session_id,
            "rid": restaurant_id,
            "table": table_number,
            "cname": customer_name,
            "otype": order_type,
        },
    )


async def get_session_row(
    session: AsyncSession, session_id: str
) -> Optional[Dict[str, Any]]:
    row = (
        await session.execute(
            text(
                "SELECT id, restaurant_id, table_number, customer_name, "
                "order_type, cart FROM sessions WHERE id = :id"
            ),
            {"id": session_id},
        )
    ).mappings().first()
    return dict(row) if row else None


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
) -> Dict[str, Any]:
    order_no = await _next_order_no(session, restaurant_id)
    row = (
        await session.execute(
            text(
                """
                INSERT INTO orders
                    (restaurant_id, order_no, order_type, table_number,
                     customer_name, items,
                     subtotal, tax, total, currency, status, payment_status)
                VALUES
                    (:rid, :no, :otype, :table, :cname, CAST(:items AS JSONB),
                     :subtotal, :tax, :total, :currency, 'new', :pay)
                RETURNING id, order_no, order_type, customer_name, status,
                          payment_status, created_at
                """
            ),
            {
                "rid": restaurant_id,
                "no": order_no,
                "otype": order_type,
                "table": table_number,
                "cname": customer_name,
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
                       items, subtotal, tax, total, currency, status,
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


async def get_order(
    session: AsyncSession, order_id: int
) -> Optional[Dict[str, Any]]:
    row = (
        await session.execute(
            text(
                "SELECT id, restaurant_id, order_no, order_type, table_number, "
                "customer_name, items, subtotal, tax, total, currency, status, "
                "payment_status, created_at FROM orders WHERE id = :id"
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
    if date_from:
        where += " AND created_at::date >= :dfrom"
        params["dfrom"] = date_from
    if date_to:
        where += " AND created_at::date <= :dto"
        params["dto"] = date_to

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
