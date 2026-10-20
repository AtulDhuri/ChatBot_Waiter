"""/pay — build a UPI display-payment deep link for the session's bill total.

This returns a UPI URI (and amount) the frontend renders as a QR. It is a
display payment: there is no gateway and no confirmation callback.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.routes.deps import get_db, require_staff, resolve_cart, resolve_session
from app.schemas import PayRequest, PayResponse, UpiInfo, UpiUpdate
from app.services import billing, payments

router = APIRouter(prefix="/pay", tags=["pay"])


@router.get("/upi", response_model=UpiInfo)
async def get_upi(restaurant: str = "demo", db: AsyncSession = Depends(get_db)):
    """Return the UPI payee configured for a restaurant (admin convenience)."""
    rest = await repo.get_restaurant_by_slug(db, restaurant)
    vpa = (rest.get("upi_vpa") if rest else None) or settings.upi_vpa or None
    name = (rest.get("upi_name") if rest else None) or settings.upi_payee_name or None
    return UpiInfo(
        restaurant=restaurant,
        upi_vpa=vpa,
        upi_name=name,
        configured=payments.is_valid_vpa(vpa),
    )


@router.post("/upi", response_model=UpiInfo)
async def set_upi(
    body: UpiUpdate,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Set/update a restaurant's UPI payee without re-uploading the menu."""
    if not payments.is_valid_vpa(body.upi_vpa):
        raise HTTPException(
            status_code=400,
            detail="Invalid UPI ID. Expected format: name@bank",
        )
    # Ensure the restaurant row exists so a UPI can be set before a menu upload.
    await repo.get_or_create_restaurant(
        db, body.restaurant, body.restaurant.replace("-", " ").title()
    )
    await repo.set_restaurant_upi(db, body.restaurant, body.upi_vpa, body.upi_name)
    return UpiInfo(
        restaurant=body.restaurant,
        upi_vpa=body.upi_vpa,
        upi_name=body.upi_name or None,
        configured=True,
    )


@router.post("", response_model=PayResponse)
async def pay(
    body: PayRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    row = await resolve_session(body.session_id, db, request)

    # Re-price against the stored menu; client prices are never trusted.
    cart, dropped = await resolve_cart(db, row, body.cart)
    if not cart:
        raise HTTPException(status_code=400, detail="Cart is empty.")

    bill = billing.calculate_bill(cart)
    amount = bill["total"]

    restaurant = await repo.get_restaurant_by_id(db, row["restaurant_id"])

    # Per-tenant VPA wins; fall back to the global env default.
    vpa = (restaurant.get("upi_vpa") if restaurant else None) or settings.upi_vpa
    payee_name = (
        (restaurant.get("upi_name") if restaurant else None)
        or settings.upi_payee_name
        or (restaurant["name"] if restaurant else settings.restaurant_name)
    )

    configured = payments.is_valid_vpa(vpa)
    # Build a human note that fits the order type.
    if (row.get("order_type") or "dine_in") == "takeaway":
        who = row.get("customer_name") or "Takeaway"
        note = f"{who} (Takeaway) - {payee_name}"
    else:
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
        dropped=dropped,
    )
