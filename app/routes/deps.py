"""Shared route dependencies: resolving and validating sessions."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from typing import List, Optional, Tuple

from fastapi import Header, Query

from app.config import settings
from app.db import repository as repo
from app.db.database import get_session
from app.services import pricing, sessions as sess


async def require_staff(
    x_staff_token: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None),
) -> None:
    """Guard staff-only endpoints.

    Accepts the token from the 'X-Staff-Token' header or a '?token=' query
    param (the latter lets static pages pass it easily). If STAFF_TOKEN is
    unset, protection is disabled so the demo still runs out of the box.
    """
    expected = settings.staff_token
    if not expected:
        return  # protection disabled (demo mode)
    provided = x_staff_token or token
    if not provided or provided != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Staff authentication required.",
        )


async def resolve_cart(
    db: AsyncSession, row: Dict[str, Any], client_cart
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Pick the cart (client override or stored) and re-price it from the DB.

    Returns (repriced_cart, dropped_item_names). Prices always come from the
    stored menu, never from the client, so a tampered cart can't underpay.
    """
    if client_cart is not None:
        cart = [
            c.model_dump() if hasattr(c, "model_dump") else dict(c)
            for c in client_cart
        ]
    else:
        cart = row["cart"] or []
    lookup = await repo.get_price_lookup(db, row["restaurant_id"])
    return pricing.reprice_cart(cart, lookup)


async def resolve_session(
    token: str, db: AsyncSession
) -> Dict[str, Any]:
    """Validate a signed token and load its DB row, or raise 401/404."""
    session_id = sess.verify(token)
    if session_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing session token.",
        )
    row = await repo.get_session_row(db, session_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found. Please re-enter your table number.",
        )
    return row


async def get_db() -> AsyncSession:  # thin re-export for clarity in routers
    async for s in get_session():
        yield s
