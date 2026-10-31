"""Session lifecycle: create a session bound to a table number."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.routes.deps import get_db, resolve_session
from app.schemas import SessionCreate, SessionInfo
from app.services import sessions as sess

router = APIRouter(prefix="/session", tags=["session"])


@router.post("", response_model=SessionInfo)
async def create_session(
    body: SessionCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    # Customer sessions may use an existing outlet slug, but they must never
    # provision a new tenant by calling this endpoint.
    rest = await repo.get_restaurant_by_slug(db, body.restaurant.strip().lower())
    if rest is None:
        raise HTTPException(status_code=404, detail="Unknown restaurant. Scan a valid restaurant QR code.")
    restaurant_id = rest["id"]

    # Validate the identifier for the chosen order type.
    table_number = body.table_number.strip()
    customer_name = body.customer_name.strip()
    if body.order_type == "dine_in" and not table_number:
        raise HTTPException(status_code=422, detail="Table number is required.")
    if body.order_type == "takeaway" and not customer_name:
        raise HTTPException(status_code=422, detail="Customer name is required.")

    # Resolve the pricing zone from the table (dine-in only). The customer
    # never chooses a zone; an unregistered table resolves to None = base price.
    zone = None
    if body.order_type == "dine_in" and table_number:
        zone = await repo.get_table_zone(db, restaurant_id, table_number)

    session_id = sess.new_session_id()
    device_id = (request.headers.get("x-device-id") or "").strip()[:128] or None
    ua_hash = sess.hash_ua(request.headers.get("user-agent"))
    await repo.create_session(
        db,
        session_id,
        restaurant_id,
        table_number=table_number or "-",
        customer_name=customer_name or None,
        order_type=body.order_type,
        zone=zone,
        device_id=device_id,
        ua_hash=ua_hash,
    )
    token = sess.sign(session_id)
    return SessionInfo(
        session_id=token,
        table_number=table_number or "-",
        customer_name=customer_name,
        order_type=body.order_type,
        restaurant=body.restaurant,
        restaurant_name=(rest["name"] if rest else body.restaurant),
        zone=zone,
        cart=[],
        payment_mode=(rest.get("payment_mode") if rest else "prepaid") or "prepaid",
    )


@router.get("/{token}", response_model=SessionInfo)
async def get_session_info(
    token: str, request: Request, db: AsyncSession = Depends(get_db)
):
    row = await resolve_session(token, db, request)
    rest = await repo.get_restaurant_by_id(db, row["restaurant_id"])
    # Customer-safe: return the display name only. The slug (backend tenant
    # identity) is deliberately omitted so a token holder cannot learn it.
    return SessionInfo(
        session_id=token,
        table_number=row["table_number"],
        customer_name=row.get("customer_name") or "",
        order_type=row.get("order_type") or "dine_in",
        restaurant=None,
        restaurant_name=(rest["name"] if rest else ""),
        zone=row.get("zone"),
        cart=row["cart"],
        payment_mode=(rest.get("payment_mode") if rest else "prepaid") or "prepaid",
    )
