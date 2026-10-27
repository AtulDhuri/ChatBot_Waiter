"""Postpaid table-bill and settlement endpoints.

Kitchen status and payment closure are intentionally separate: an order may be
served while the tab remains open until staff verifies the final bill payment.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.routes.deps import get_db, require_staff, resolve_session
from app.schemas import (
    PayResponse,
    PostpaidBillRequest,
    PostpaidBillResponse,
    PostpaidSettleRequest,
)
from app.config import settings
from app.services import payments
from app.services import sessions as sess
from app.services.payment_modes import is_postpaid

router = APIRouter(prefix="/postpaid", tags=["postpaid"])


@router.post("/bill", response_model=PostpaidBillResponse)
async def get_postpaid_bill(
    body: PostpaidBillRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    row = await resolve_session(body.session_id, db, request)
    rest = await repo.get_restaurant_by_id(db, row["restaurant_id"])
    if not is_postpaid((rest or {}).get("payment_mode")):
        raise HTTPException(status_code=409, detail="This restaurant uses prepaid checkout.")

    orders = await repo.list_session_orders(db, row["id"])
    active = [o for o in orders if o.get("status") != "cancelled"]
    if not active:
        raise HTTPException(status_code=400, detail="There are no orders to bill.")

    line_items = []
    subtotal = 0.0
    tax = 0.0
    total = 0.0
    for order in active:
        line_items.extend(order.get("items") or [])
        subtotal += float(order.get("subtotal") or 0)
        tax += float(order.get("tax") or 0)
        total += float(order.get("total") or 0)

    payment_status = "paid" if all(
        o.get("payment_status") == "verified" for o in active
    ) else "unpaid"
    return PostpaidBillResponse(
        table_number=row["table_number"],
        line_items=line_items,
        subtotal=subtotal,
        tax=tax,
        total=total,
        currency=active[0].get("currency") or "₹",
        tax_rate=(tax / subtotal if subtotal else 0.0),
        payment_status=payment_status,
    )


@router.post("/pay", response_model=PayResponse)
async def pay_postpaid_bill(
    body: PostpaidBillRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Build the same display-only UPI QR as prepaid, using the open tab total."""
    row = await resolve_session(body.session_id, db, request)
    rest = await repo.get_restaurant_by_id(db, row["restaurant_id"])
    if not is_postpaid((rest or {}).get("payment_mode")):
        raise HTTPException(status_code=409, detail="This restaurant uses prepaid checkout.")

    orders = await repo.list_session_orders(db, row["id"])
    active = [o for o in orders if o.get("status") != "cancelled"]
    if not active:
        raise HTTPException(status_code=400, detail="There are no orders to pay.")

    amount = round(sum(float(o.get("total") or 0) for o in active), 2)
    vpa = (rest.get("upi_vpa") if rest else None) or settings.upi_vpa
    payee_name = (
        (rest.get("upi_name") if rest else None)
        or settings.upi_payee_name
        or (rest.get("name") if rest else settings.restaurant_name)
    )
    configured = payments.is_valid_vpa(vpa)
    note = f"Table {row['table_number']} - {payee_name}"
    upi_uri = (
        payments.build_upi_uri(
            payee_vpa=vpa,
            payee_name=payee_name,
            amount=amount,
            note=note,
            currency=settings.upi_currency,
        )
        if configured
        else ""
    )
    return PayResponse(
        table_number=row["table_number"],
        payee_name=payee_name,
        amount=amount,
        currency=settings.upi_currency,
        upi_uri=upi_uri,
        configured=configured,
        dropped=[],
    )


@router.post("/settle")
async def settle_postpaid(
    body: PostpaidSettleRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Verify payment for a postpaid session and close it when served."""
    session_id = sess.verify(body.session_id)
    if session_id is None:
        raise HTTPException(status_code=401, detail="Invalid session token.")
    row = await repo.get_session_row(db, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    rest = await repo.get_restaurant_by_slug(db, body.restaurant)
    if rest is None or rest["id"] != row["restaurant_id"]:
        raise HTTPException(status_code=403, detail="Session does not belong to this restaurant.")
    if not is_postpaid(rest.get("payment_mode")):
        raise HTTPException(status_code=409, detail="This restaurant uses prepaid checkout.")

    changed = await repo.mark_session_paid(db, session_id)
    closed = await repo.session_orders_all_served_and_paid(db, session_id)
    if closed:
        await repo.close_session_orders(db, session_id)
        await repo.end_session(db, session_id)
    return {
        "session_id": body.session_id,
        "payment_method": body.payment_method,
        "orders_marked_paid": changed,
        "closed": closed,
    }
