"""Order lifecycle: place an order (after payment) and drive it through the
kitchen workflow. Also exposes the kitchen's live list of active orders.

Item-level lifecycle:
  - Every menu item inside an order is its own order_items row with a status
    (pending -> accepted -> preparing -> ready -> served, or cancelled).
  - Chefs update individual item statuses from the KOT screen via PATCH.
  - Overall order status is auto-derived from item statuses (never manual).
  - Customers may cancel individual items while pending/accepted.
"""

from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import Field, BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.routes.deps import (
    get_db,
    require_staff,
    tenant_matches,
    resolve_cart,
    resolve_session,
)
from app.schemas import (
    CartItem,
    CloseTableRequest,
    CloseTableResponse,
    ItemCancelRequest,
    ItemQuantityRequest,
    ItemStatusUpdate,
    MyOrder,
    MyOrdersResponse,
    Order,
    OrderCreate,
    OrderItem,
    OrderParseRequest,
    OrderParseResponse,
    OrderPlaced,
    OrderStatusUpdate,
    OrderWithItems,
)
from app.services import billing, llm, sessions as sess
from app.services.auth import audit
from app.services.payment_modes import is_postpaid


# Map internal kitchen statuses to the customer-facing label set
# (Placed -> Preparing -> Ready -> Served). Payment is tracked separately and never
# appears as a kitchen-progress status.
_CUSTOMER_STATUS = {
    "new": "Placed",
    "preparing": "Preparing",
    "ready": "Ready",
    "partially_served": "Partially Served",
    "served": "Served",
    "cancelled": "Cancelled",
}


def _customer_status(internal: str) -> str:
    return _CUSTOMER_STATUS.get(internal, "Placed")


async def _fetch_order(db: AsyncSession, order_id: int) -> dict:
    order = await repo.get_order(db, order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found.")
    return order


def _require_tenant(principal: Dict[str, Any], restaurant_id: int) -> None:
    if not tenant_matches(principal, restaurant_id):
        raise HTTPException(status_code=403, detail="Order is outside your tenant.")


router = APIRouter(tags=["orders"])


@router.post("/order/parse", response_model=OrderParseResponse)
async def parse_order(
    body: OrderParseRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Interpret a free-text message into cart lines (gated LLM fallback)."""
    row = await resolve_session(body.session_id, db, request)

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
    Each line item also becomes an order_items row starting at ``pending``.
    """
    row = await resolve_session(body.session_id, db, request)

    cart, _dropped = await resolve_cart(db, row, body.cart)
    if not cart:
        raise HTTPException(status_code=400, detail="Cart is empty.")

    bill = billing.calculate_bill(cart)
    restaurant = await repo.get_restaurant_by_id(db, row["restaurant_id"])
    postpaid = is_postpaid((restaurant or {}).get("payment_mode"))
    payment_status = "unpaid" if postpaid else body.payment_status
    order_type = row.get("order_type") or body.order_type
    customer_name = row.get("customer_name")
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
        payment_status=payment_status,
        order_type=order_type,
        customer_name=customer_name,
        zone=row.get("zone"),
        session_id=row["id"],
        device_id=row.get("device_id"),
    )
    await repo.update_cart(db, _sid(body.session_id), [])

    order_items_payload = [
        {
            "id": it["id"],
            "name": it["name"],
            "quantity": it["quantity"],
            "price": float(it["price"]),
            "line_total": float(it["line_total"]),
            "status": it["status"],
            "instructions": it.get("instructions") or "",
        }
        for it in (order.get("order_items") or [])
    ]

    return OrderPlaced(
        id=order["id"],
        order_no=order["order_no"],
        order_type=order["order_type"],
        customer_name=order.get("customer_name"),
        status=order["status"],
        payment_status=order["payment_status"],
        total=bill["total"],
        currency=bill["currency"],
        items=bill["line_items"],
        order_items=order_items_payload,
    )


@router.get("/my-orders", response_model=MyOrdersResponse)
async def my_orders(
    session_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Customer-facing: the orders placed in THIS session only.

    Includes per-item order_items so the customer tracker can show item-level
    status and allow pending/accepted item cancellation.
    """
    try:
        row = await resolve_session(session_id, db, request)
    except HTTPException as e:
        if e.status_code != 440:
            raise
        inner = sess.verify(session_id)
        row = await repo.get_session_row(db, inner) if inner else None
        if row is None:
            raise

    orders = await repo.list_session_orders(db, row["id"])
    all_terminal = await repo.session_orders_all_served_and_paid(db, row["id"])
    restaurant = await repo.get_restaurant_by_id(db, row["restaurant_id"])
    if all_terminal:
        await repo.close_session_orders(db, row["id"])
        await repo.end_session(db, row["id"])

    enriched: List[MyOrder] = []
    for o in orders:
        order_items = None
        try:
            full = await repo.get_order(db, o["id"])
            order_items = full.get("order_items") if full else None
        except Exception:
            order_items = None
        internal_status = (
            repo._compute_order_status([it["status"] for it in order_items])
            if order_items
            else o["status"]
        )
        enriched.append(
            MyOrder(
                order_no=o["order_no"],
                order_type=o.get("order_type", "dine_in"),
                status=_customer_status(internal_status),
                items=o["items"],
                total=float(o["total"]),
                currency=o["currency"] or settings.currency,
                created_at=o["created_at"].isoformat()
                if hasattr(o["created_at"], "isoformat")
                else o["created_at"],
                order_items=order_items,
            )
        )

    return MyOrdersResponse(
        orders=enriched,
        session_ended=all_terminal,
        payment_mode=((restaurant or {}).get("payment_mode") or "prepaid"),
        amount_due=sum(
            float(o["total"])
            for o in orders
            if o.get("status") != "cancelled" and o.get("payment_status") != "verified"
        ),
    )


@router.post("/close-table", response_model=CloseTableResponse)
async def close_table(
    body: CloseTableRequest,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Manual override: force-close all active dine-in orders for a table."""
    rest = await repo.get_restaurant_by_slug(db, body.restaurant)
    if rest is None:
        raise HTTPException(status_code=404, detail="Unknown restaurant.")
    if not tenant_matches(_principal, rest["id"]):
        raise HTTPException(status_code=403, detail="Outlet is outside your tenant.")
    n = await repo.close_table(db, rest["id"], body.table_number)
    return CloseTableResponse(table_number=body.table_number, closed=n)


@router.get("/orders", response_model=list[OrderWithItems])
async def kitchen_orders(
    restaurant: str = "demo",
    active_only: bool = True,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Kitchen display feed: orders for an outlet (active by default)."""
    if _principal.get("role") == "kitchen":
        rest = await repo.get_restaurant_by_id(db, _principal["outletId"])
    else:
        rest = await repo.get_restaurant_by_slug(db, restaurant)
    if rest is None:
        return []
    if not tenant_matches(_principal, rest["id"]):
        raise HTTPException(status_code=403, detail="Outlet is outside your tenant.")
    statuses = repo.ACTIVE_ORDER_STATUSES if active_only else None
    rows = await repo.list_orders(db, rest["id"], statuses)
    return [_to_order_with_items(r) for r in rows]


@router.get("/order/{order_id}", response_model=OrderWithItems)
async def get_order_detail(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Full order with per-item rows, history and cancellations (staff)."""
    order = await _fetch_order(db, order_id)
    _require_tenant(_principal, order["restaurant_id"])
    return _to_order_with_items(order)


@router.get("/order/{order_id}/items", response_model=List[Any])
async def list_order_items(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """All line items for an order (staff)."""
    order = await _fetch_order(db, order_id)
    _require_tenant(_principal, order["restaurant_id"])
    return await repo.get_order_items(db, order_id)


@router.patch("/order/{order_id}", response_model=OrderWithItems)
async def update_order(
    order_id: int,
    body: OrderStatusUpdate,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Item-level order update.

    Supported actions (staff/kitchen):
      - ``payment_status``: verify/unverify the order's payment (manager only).
      - order-level ``status`` is no longer accepted directly: overall status is
        auto-derived from item statuses. If supplied it is ignored.

    Per-item actions are exposed through dedicated endpoints:
      PATCH /order/{order_id}/items/{item_id}
      POST  /order/{order_id}/items/{item_id}/cancel
      POST  /order/{order_id}/items/{item_id}/quantity
    """
    existing = await _fetch_order(db, order_id)
    _require_tenant(_principal, existing["restaurant_id"])
    if _principal.get("role") == "kitchen" and body.payment_status is not None:
        raise HTTPException(status_code=403, detail="Kitchen users cannot update payment status.")

    changed = False
    if body.payment_status:
        await repo.update_order_payment(db, order_id, body.payment_status)
        changed = True

    # Order-level status is auto-derived from items; do not allow manual override.
    # A table/session remains visible until every order is terminal and paid.
    sid = existing.get("session_id")
    if sid:
        rest = await repo.get_restaurant_by_id(db, existing["restaurant_id"])
        can_close = await repo.session_orders_all_served_and_paid(db, sid)
        if can_close:
            await repo.close_session_orders(db, sid)
            await repo.end_session(db, sid)

    updated = await repo.get_order(db, order_id)
    return _to_order_with_items(updated)


@router.post("/order/{order_id}/cancel", response_model=OrderWithItems)
async def cancel_order_endpoint(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Cancel every non-terminal item in an order (order-level cancel cascade)."""
    order = await _fetch_order(db, order_id)
    _require_tenant(_principal, order["restaurant_id"])
    count = await repo.cancel_all_order_items(
        db, order_id,
        cancelled_by=_principal.get("userId"),
        cancelled_by_role=_principal.get("role"),
        reason="order cancelled",
    )
    if count == 0 and all(
        it["status"] in repo.TERMINAL_ITEM_STATUSES
        for it in (order.get("order_items") or [])
    ):
        raise HTTPException(status_code=409, detail="All items already terminal.")
    updated = await repo.get_order(db, order_id)
    return _to_order_with_items(updated)


# ── Per-item endpoints ─────────────────────────────────────────────────────


@router.patch(
    "/order/{order_id}/items/{item_id}", response_model=OrderItem
)
async def set_item_status(
    order_id: int,
    item_id: int,
    body: ItemStatusUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Chef/manager moves a single item to a new status. Order status is
    auto-recomputed from all item statuses."""
    item = await _fetch_order(db, order_id)
    _require_tenant(_principal, item["restaurant_id"])

    target = next((it for it in (item.get("order_items") or []) if it["id"] == item_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    if target["status"] in repo.TERMINAL_ITEM_STATUSES:
        raise HTTPException(
            status_code=409,
            detail=f"Item already {target['status']} and cannot be changed.",
        )

    role = _principal.get("role")
    updated = await repo.update_item_status(
        db, item_id, body.status,
        changed_by=_principal.get("userId"),
        changed_by_role=role,
        reason=body.reason,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Order item not found.")

    # Notify waiters when an item becomes ready.
    if body.status == repo.ITEM_READY:
        try:
            await _notify_item_ready(db, order_id, item_id, _principal)
        except Exception:
            # Notifications must never block a status change.
            pass

    return _to_order_item(updated)


@router.post(
    "/order/{order_id}/items/{item_id}/cancel", response_model=OrderItem
)
async def cancel_order_item(
    order_id: int,
    item_id: int,
    body: ItemCancelRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Customer or staff cancels a single item (only while pending/accepted).

    Refund eligibility is derived from the restaurant's refund policy and the
    order's payment mode.
    """
    item = await _fetch_order(db, order_id)
    _require_tenant(_principal, item["restaurant_id"])

    target = next((it for it in (item.get("order_items") or []) if it["id"] == item_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    if target["status"] not in (repo.ITEM_PENDING, repo.ITEM_ACCEPTED):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot cancel '{target['name']}': it is already "
                f"{target['status']}. Cancellation is only allowed while an "
                "item is pending or accepted."
            ),
        )

    policy = await repo.get_refund_policy(db, item["restaurant_id"])
    payment_mode = (await repo.get_restaurant_by_id(db, item["restaurant_id"]) or {}).get(
        "payment_mode", "prepaid"
    )
    postpaid = is_postpaid(payment_mode)
    refund_required = bool(policy.get("prepaid_full_refund")) and not postpaid
    refund_amount = float(target["line_total"]) if refund_required else 0.0
    refund_policy = policy.get("mode", "proportional")

    updated = await repo.cancel_item(
        db, item_id,
        cancelled_by=_principal.get("userId"),
        cancelled_by_role=_principal.get("role"),
        reason=body.reason or "customer cancelled",
        refund_required=refund_required,
        refund_amount=refund_amount,
        refund_policy=refund_policy,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    return _to_order_item(updated)


class _CustomerItemCancel(BaseModel):
    session_id: str
    reason: Optional[str] = Field(default=None, max_length=200)


@router.post("/my-order/items/{item_id}/cancel", response_model=OrderItem)
async def customer_cancel_order_item(
    item_id: int,
    body: _CustomerItemCancel,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Customer cancels a single item from their own session (pending/accepted only)."""
    row = await resolve_session(body.session_id, db, request)
    item = await repo.get_order_item(db, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    order = await repo.get_order(db, item["order_id"])
    if order is None or order.get("session_id") != row["id"]:
        raise HTTPException(status_code=403, detail="Order item is not in your session.")
    if item["status"] not in (repo.ITEM_PENDING, repo.ITEM_ACCEPTED):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot cancel '{item['name']}': it is already {item['status']}. "
                "Cancellation is only allowed while an item is pending or accepted."
            ),
        )
    updated = await repo.cancel_item(
        db, item_id,
        cancelled_by=None, cancelled_by_role='customer',
        reason=body.reason or "customer cancelled",
        refund_required=False,
        refund_amount=0.0,
        refund_policy='proportional',
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    return _to_order_item(updated)


@router.post(
    "/order/{order_id}/items/{item_id}/quantity", response_model=OrderItem
)
async def reduce_order_item_quantity(
    order_id: int,
    item_id: int,
    body: ItemQuantityRequest,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Reduce an item's quantity. Reaching zero auto-cancels the item."""
    item = await _fetch_order(db, order_id)
    _require_tenant(_principal, item["restaurant_id"])

    target = next((it for it in (item.get("order_items") or []) if it["id"] == item_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    if target["status"] not in (repo.ITEM_PENDING, repo.ITEM_ACCEPTED):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot change quantity of '{target['name']}': it is already "
                f"{target['status']}."
            ),
        )

    updated = await repo.reduce_item_quantity(
        db, item_id, body.quantity,
        changed_by=_principal.get("userId"),
        changed_by_role=_principal.get("role"),
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Order item not found.")
    return _to_order_item(updated)


@router.get(
    "/order/{order_id}/items/{item_id}/history", response_model=List[Any]
)
async def item_history(
    order_id: int,
    item_id: int,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Full audit trail for one item (status changes, timestamps, actor)."""
    order = await _fetch_order(db, order_id)
    _require_tenant(_principal, order["restaurant_id"])
    return await repo.get_item_status_history(db, item_id)


@router.get(
    "/order/{order_id}/cancellations", response_model=List[Any]
)
async def order_cancellations(
    order_id: int,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Cancellation + refund records for an order."""
    order = await _fetch_order(db, order_id)
    _require_tenant(_principal, order["restaurant_id"])
    return await repo.get_item_cancellations(db, order_id)


# ── Kitchen item queue (all active items across orders) ────────────────────

@router.get("/kitchen/items", response_model=List[Dict[str, Any]])
async def kitchen_items(
    restaurant: str = "demo",
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """All active (prep-relevant) order items across the outlet, for the KOT."""
    if _principal.get("role") == "kitchen":
        rest = await repo.get_restaurant_by_id(db, _principal["outletId"])
    else:
        rest = await repo.get_restaurant_by_slug(db, restaurant)
    if rest is None:
        return []
    if not tenant_matches(_principal, rest["id"]):
        raise HTTPException(status_code=403, detail="Outlet is outside your tenant.")
    return await repo.get_order_items_by_status(
        db, rest["id"], repo.KITCHEN_ACTIVE_ITEM_STATUSES
    )


async def _notify_item_ready(
    db: AsyncSession, order_id: int, item_id: int, principal: Dict[str, Any]
) -> None:
    """Record an item-ready notification event (waiter alert)."""
    await audit(
        db,
        "ITEM_READY",
        user_id=principal.get("userId"),
        tenant_id=principal.get("tenantId"),
        detail={
            "order_id": order_id,
            "order_item_id": item_id,
            "action": "item_ready_notify_waiter",
        },
    )


# ── Helpers ────────────────────────────────────────────────────────────────


def _to_order_with_items(r: dict) -> OrderWithItems:
    return OrderWithItems(
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
        status=(
            repo._compute_order_status(
                [it["status"] for it in (r.get("order_items") or [])]
            )
            if r.get("order_items")
            else r["status"]
        ),
        payment_status=r["payment_status"],
        created_at=r["created_at"].isoformat()
        if hasattr(r["created_at"], "isoformat")
        else r["created_at"],
        order_items=[
            {
                "id": it["id"],
                "order_id": it["order_id"],
                "restaurant_id": it["restaurant_id"],
                "menu_item_id": it.get("menu_item_id"),
                "name": it["name"],
                "price": float(it["price"]),
                "quantity": it["quantity"],
                "line_total": float(it["line_total"]),
                "instructions": it.get("instructions") or "",
                "status": it["status"],
                "previous_status": it.get("previous_status"),
                "cancelled_at": it.get("cancelled_at").isoformat()
                if it.get("cancelled_at") and hasattr(it["cancelled_at"], "isoformat")
                else it.get("cancelled_at"),
                "cancelled_by": it.get("cancelled_by"),
                "cancel_reason": it.get("cancel_reason"),
                "created_at": it["created_at"].isoformat()
                if hasattr(it["created_at"], "isoformat")
                else it["created_at"],
                "updated_at": it["updated_at"].isoformat()
                if hasattr(it["updated_at"], "isoformat")
                else it["updated_at"],
            }
            for it in (r.get("order_items") or [])
        ],
    )


def _to_order_item(r: dict) -> OrderItem:
    return OrderItem(
        id=r["id"],
        order_id=r["order_id"],
        restaurant_id=r["restaurant_id"],
        menu_item_id=r.get("menu_item_id"),
        name=r["name"],
        price=float(r["price"]),
        quantity=r["quantity"],
        line_total=float(r["line_total"]),
        instructions=r.get("instructions") or "",
        status=r["status"],
        previous_status=r.get("previous_status"),
        cancelled_at=r.get("cancelled_at").isoformat()
        if r.get("cancelled_at") and hasattr(r["cancelled_at"], "isoformat")
        else r.get("cancelled_at"),
        cancelled_by=r.get("cancelled_by"),
        cancel_reason=r.get("cancel_reason"),
        created_at=r["created_at"].isoformat()
        if hasattr(r["created_at"], "isoformat")
        else r["created_at"],
        updated_at=r["updated_at"].isoformat()
        if hasattr(r["updated_at"], "isoformat")
        else r["updated_at"],
    )


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
