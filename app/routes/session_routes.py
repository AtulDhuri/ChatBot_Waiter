"""Session lifecycle: create a session bound to a table number."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.routes.deps import get_db, resolve_session
from app.schemas import SessionCreate, SessionInfo
from app.services import sessions as sess

router = APIRouter(prefix="/session", tags=["session"])


@router.post("", response_model=SessionInfo)
async def create_session(body: SessionCreate, db: AsyncSession = Depends(get_db)):
    # Do not overwrite an existing outlet's display name just by starting a
    # session; the admin owns the name via menu upload.
    restaurant_id = await repo.get_or_create_restaurant(
        db, body.restaurant, body.restaurant.replace("-", " ").title()
    )
    rest = await repo.get_restaurant_by_id(db, restaurant_id)

    # Validate the identifier for the chosen order type.
    table_number = body.table_number.strip()
    customer_name = body.customer_name.strip()
    if body.order_type == "dine_in" and not table_number:
        raise HTTPException(status_code=422, detail="Table number is required.")
    if body.order_type == "takeaway" and not customer_name:
        raise HTTPException(status_code=422, detail="Customer name is required.")

    session_id = sess.new_session_id()
    await repo.create_session(
        db,
        session_id,
        restaurant_id,
        table_number=table_number or "-",
        customer_name=customer_name or None,
        order_type=body.order_type,
    )
    token = sess.sign(session_id)
    return SessionInfo(
        session_id=token,
        table_number=table_number or "-",
        customer_name=customer_name,
        order_type=body.order_type,
        restaurant=body.restaurant,
        restaurant_name=(rest["name"] if rest else body.restaurant),
        cart=[],
    )


@router.get("/{token}", response_model=SessionInfo)
async def get_session_info(token: str, db: AsyncSession = Depends(get_db)):
    row = await resolve_session(token, db)
    rest = await repo.get_restaurant_by_id(db, row["restaurant_id"])
    return SessionInfo(
        session_id=token,
        table_number=row["table_number"],
        customer_name=row.get("customer_name") or "",
        order_type=row.get("order_type") or "dine_in",
        restaurant=(rest["slug"] if rest else "demo"),
        restaurant_name=(rest["name"] if rest else "demo"),
        cart=row["cart"],
    )
