"""Order lifecycle: place an order (after payment) and drive it through the
kitchen workflow. Also exposes the kitchen's live list of active orders.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.routes.deps import (
    get_db,
    require_staff,
    resolve_cart,
    resolve_session,
)
from app.schemas import (
    CartItem,
    CloseTableRequest,
    CloseTableResponse,
    Order,
    OrderCreate,
    OrderParseRequest,
    OrderParseResponse,
    OrderPlaced,
    OrderStatusUpdate,
)
from app.services import billing, llm

router = APIRouter(tags=["orders"])


@router.post("/order/parse", response_model=OrderParseResponse)
async def parse_order(
    body: OrderParseRequest, db: AsyncSession = Depends(get_db)
):
    """Interpret a free-text message into cart lines (gated LLM fallback).

    The client calls this only when its own local matcher is unsure, so LLM
    usage stays minimal. Prices are always taken from the stored menu — the
    model only picks dish names and quantities, never prices.
    """
    row = await resolve_session(body.session_id, db)

    # Authoritative name->price map for this tenant.
    lookup = await repo.get_price_lookup(db, row["restaurant_id"])
    if not lookup:
        return OrderParseResponse(items=[], understood=False, llm_used=False)

    menu_names = [v["name"] for v in lookup.values()]
    parsed = await llm.parse_order(body.text, menu_names)

    items: list[CartItem] = []
    for line in parsed:
        canonical = lookup.get(line["name"].strip().lower())
        if not canonical:
            continue
        items.append(
            CartItem(
                name=canonical["name"],
                price=float(canonical["price"]),
                quantity=line["quantity"],
            )
        )

    return OrderParseResponse(
        items=items,
        understood=bool(items),
        llm_used=settings.llm_enabled,
    )


@router.post("/order", response_model=OrderPlaced)
async def place_order(body: OrderCreate, db: AsyncSession = Depends(get_db)):
    """Snapshot the cart into a permanent order and queue it for the kitchen.

    Pay-first flow: the client calls this after payment. The cart is turned
    into immutable line items so later price edits never change past sales.
    """
    row = await resolve_session(body.session_id, db)

    # Re-price against the stored menu; client prices are never trusted.
    cart, _dropped = await resolve_cart(db, row, body.cart)
    if not cart:
        raise HTTPException(status_code=400, detail="Cart is empty.")

    bill = billing.calculate_bill(cart)
    # Use the order type recorded on the session; the client may also pass it,
    # but the session is the source of truth for how the guest started.
    order_type = row.get("order_type") or body.order_type
    customer_name = row.get("customer_name")
    # Dine-in keeps the table number; takeaway has no table (use a dash) but
    # keeps the customer name so the kitchen knows whose order it is.
    table_label = row["table_number"] if order_type == "dine_in" else "-"

    order = await repo.create_order(
        db,
        restaurant_id=row["restaurant_id"],
        table_number=table_label,
        items=bill["line_items"],
        subtotal=bill["subtotal"],
        tax=bill["tax"],
        total=bill["total"],
        currency=bill["currency"],
        payment_status=body.payment_status,
        order_type=order_type,
        customer_name=customer_name,
    )
    # Clear the session cart now that it's been placed.
    await repo.update_cart(db, _sid(body.session_id), [])

    return OrderPlaced(
        id=order["id"],
        order_no=order["order_no"],
        order_type=order["order_type"],
        customer_name=order.get("customer_name"),
        status=order["status"],
        payment_status=order["payment_status"],
        total=bill["total"],
        currency=bill["currency"],
    )


@router.post("/close-table", response_model=CloseTableResponse)
async def close_table(
    body: CloseTableRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Manual override: force-close all active dine-in orders for a table."""
    rest = await repo.get_restaurant_by_slug(db, body.restaurant)
    if rest is None:
        raise HTTPException(status_code=404, detail="Unknown restaurant.")
    n = await repo.close_table(db, rest["id"], body.table_number)
    return CloseTableResponse(table_number=body.table_number, closed=n)


@router.get("/orders", response_model=list[Order])
async def kitchen_orders(
    restaurant: str = "demo",
    active_only: bool = True,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Kitchen display feed: orders for an outlet (active by default)."""
    rest = await repo.get_restaurant_by_slug(db, restaurant)
    if rest is None:
        return []
    statuses = repo.ACTIVE_ORDER_STATUSES if active_only else None
    rows = await repo.list_orders(db, rest["id"], statuses)
    return [_to_order(r) for r in rows]


@router.patch("/order/{order_id}", response_model=Order)
async def update_order(
    order_id: int,
    body: OrderStatusUpdate,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Advance kitchen status and/or update payment verification."""
    existing = await repo.get_order(db, order_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    if body.status:
        await repo.update_order_status(db, order_id, body.status)
    if body.payment_status:
        await repo.update_order_payment(db, order_id, body.payment_status)
    updated = await repo.get_order(db, order_id)
    return _to_order(updated)


def _to_order(r: dict) -> Order:
    return Order(
        id=r["id"],
        order_no=r["order_no"],
        order_type=r.get("order_type", "dine_in"),
        table_number=r["table_number"],
        customer_name=r.get("customer_name"),
        items=r["items"],
        subtotal=float(r["subtotal"]),
        tax=float(r["tax"]),
        total=float(r["total"]),
        currency=r["currency"] or settings.currency,
        status=r["status"],
        payment_status=r["payment_status"],
        created_at=r["created_at"].isoformat()
        if hasattr(r["created_at"], "isoformat")
        else r["created_at"],
    )


def _sid(token: str) -> str:
    return token.rpartition(".")[0]
