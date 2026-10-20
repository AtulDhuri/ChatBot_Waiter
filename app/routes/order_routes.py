"""Order lifecycle: place an order (after payment) and drive it through the
kitchen workflow. Also exposes the kitchen's live list of active orders.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
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
    MyOrder,
    MyOrdersResponse,
    Order,
    OrderCreate,
    OrderParseRequest,
    OrderParseResponse,
    OrderPlaced,
    OrderStatusUpdate,
)
from app.services import billing, llm, sessions as sess


# Map internal kitchen statuses to the customer-facing label set
# (Paid -> Preparing -> Served). The customer never sees internal workflow
# states like "new"/"ready"; those collapse into the three visible stages.
_CUSTOMER_STATUS = {
    "new": "Paid",
    "preparing": "Preparing",
    "ready": "Preparing",
    "served": "Served",
    "cancelled": "Cancelled",
}


def _customer_status(internal: str) -> str:
    return _CUSTOMER_STATUS.get(internal, "Paid")

router = APIRouter(tags=["orders"])


@router.post("/order/parse", response_model=OrderParseResponse)
async def parse_order(
    body: OrderParseRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Interpret a free-text message into cart lines (gated LLM fallback).

    The client calls this only when its own local matcher is unsure, so LLM
    usage stays minimal. Prices are always taken from the stored menu — the
    model only picks dish names and quantities, never prices.
    """
    row = await resolve_session(body.session_id, db, request)

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
async def place_order(
    body: OrderCreate, request: Request, db: AsyncSession = Depends(get_db)
):
    """Snapshot the cart into a permanent order and queue it for the kitchen.

    Pay-first flow: the client calls this after payment. The cart is turned
    into immutable line items so later price edits never change past sales.
    """
    row = await resolve_session(body.session_id, db, request)

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
        # Freeze the zone used for pricing onto the order.
        zone=row.get("zone"),
        # Bind the order to its session + device. This keeps each order an
        # independent transaction and lets the customer see only their own.
        session_id=row["id"],
        device_id=row.get("device_id"),
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


@router.get("/my-orders", response_model=MyOrdersResponse)
async def my_orders(
    session_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Customer-facing: the orders placed in THIS session only.

    The caller is identified solely by their signed session token (the opaque
    ``session_id`` they already hold). We resolve it, then return only the
    orders bound to that session — never another device's orders at the same
    table. Statuses are the customer-safe labels Paid / Preparing / Served.
    No tenant_id, slug, or internal order id is ever returned.

    Side effect: once every order in the session is served/cancelled, the
    session is ended so the same table cannot keep showing these orders to a
    new guest. ``session_ended`` tells the widget to stop polling.
    """
    # Resolve the session. A subtlety: when the kitchen serves the LAST order
    # of a session, the PATCH handler ends that session immediately (so a new
    # guest at the table starts clean). If the customer's status poll then runs
    # against the now-ended session, a strict resolve would 440 and the widget
    # would freeze on the previous label ("Preparing") — the guest would never
    # see the final "Served". So for this read-only, customer-facing status
    # view we tolerate a just-ended/expired session: we still validate the
    # signed token and load the row, then return the final statuses with
    # session_ended=true (which tells the widget to show them once and stop).
    try:
        row = await resolve_session(session_id, db, request)
    except HTTPException as e:
        if e.status_code != 440:
            raise  # forged token / unknown / device mismatch: still reject
        inner = sess.verify(session_id)
        row = await repo.get_session_row(db, inner) if inner else None
        if row is None:
            raise

    orders = await repo.list_session_orders(db, row["id"])
    all_served = await repo.session_orders_all_served(db, row["id"])
    if all_served:
        # Terminate the session so a new customer at the same table starts
        # clean and can never see these orders. (Idempotent if already ended.)
        await repo.end_session(db, row["id"])

    return MyOrdersResponse(
        orders=[
            MyOrder(
                order_no=o["order_no"],
                order_type=o.get("order_type", "dine_in"),
                status=_customer_status(o["status"]),
                items=o["items"],
                total=float(o["total"]),
                currency=o["currency"] or settings.currency,
                created_at=o["created_at"].isoformat()
                if hasattr(o["created_at"], "isoformat")
                else o["created_at"],
            )
            for o in orders
        ],
        session_ended=all_served,
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

    # When this order reaches a terminal state, check whether its session is
    # now fully served/cancelled and, if so, end the session. This ensures a
    # new customer at the same table cannot inherit the previous session's
    # orders. Orders placed before session binding existed have no session_id
    # and are simply skipped.
    if body.status in ("served", "cancelled"):
        sid = existing.get("session_id") if existing else None
        if sid and await repo.session_orders_all_served(db, sid):
            await repo.end_session(db, sid)

    updated = await repo.get_order(db, order_id)
    return _to_order(updated)


def _to_order(r: dict) -> Order:
    return Order(
        id=r["id"],
        order_no=r["order_no"],
        order_type=r.get("order_type", "dine_in"),
        table_number=r["table_number"],
        customer_name=r.get("customer_name"),
        zone=r.get("zone"),
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
