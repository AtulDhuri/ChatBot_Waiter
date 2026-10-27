"""/qr — opaque table-token resolution and (staff) token minting.

The customer only ever holds an opaque token encoded in their table's QR
sticker (``?r=<token>``). This module resolves that token to a tenant + table
*server-side* and mints a short-lived, device-bound session. The tenant slug
and id never cross the wire to the customer — the response carries only safe
display fields (restaurant display name, table number, cart).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.routes.deps import get_db, require_staff
from app.schemas import (
    QrResolveRequest,
    QrSession,
    QrTokenRequest,
    QrTokenResponse,
)
from app.services import sessions as sess

router = APIRouter(prefix="/qr", tags=["qr"])

# Sessions live this long between interactions before they expire (sliding).
# Driven by config so production can run a short window to limit replay risk.
SESSION_TTL_SECONDS = settings.session_ttl_seconds

# Cap on device_id length / charset is enforced by the schema; we only need to
# treat an empty string as "no device".


def _clean_device_id(value: str) -> str:
    return (value or "").strip()[:128]


@router.post("/resolve", response_model=QrSession)
async def resolve_qr(
    body: QrResolveRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Resolve an opaque QR token to a customer-safe session.

    Flow:
      1. Look up the token -> (tenant, table). Unknown/revoked -> 404 (we do
         not distinguish "never existed" from "revoked" so nothing leaks).
      2. If this device+UA already has a live session at this table, continue
         it (keeps the cart). Otherwise mint a fresh one.
      3. Bind the session to this device_id + UA fingerprint so a replayed
         token from a different client is later rejected.
      4. Return only safe fields. Never the slug or tenant id.
    """
    mapping = await repo.resolve_qr_token(db, body.token.strip())
    if mapping is None:
        # Uniform error: don't reveal whether the tenant/table exists.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This code isn't valid. Please scan the QR on your table again.",
        )

    restaurant_id = mapping["restaurant_id"]
    table_number = mapping["table_number"]
    device_id = _clean_device_id(body.device_id)
    ua_hash = sess.hash_ua(request.headers.get("user-agent"))

    # Zone (and therefore pricing) is decided by the physical table, resolved
    # server-side from the tenant+table — never chosen by the customer.
    zone = await repo.get_table_zone(db, restaurant_id, table_number)

    # Same-device+UA rescan: continue the existing live session so the cart
    # survives a reload or re-scan without the guest losing their order. A
    # different UA (even reusing the device_id) will not match and gets a
    # fresh session instead.
    existing = (
        await repo.find_live_device_session(
            db, restaurant_id, table_number, device_id, ua_hash=ua_hash
        )
        if device_id
        else None
    )

    if existing is not None:
        # Slide the expiry forward and reuse the signed token for this id.
        await repo.touch_session(db, existing["id"], SESSION_TTL_SECONDS)
        token = sess.sign(existing["id"])
        return QrSession(
            session_id=token,
            table_number=table_number,
            restaurant_name=mapping["name"],
            order_type=existing.get("order_type") or "dine_in",
            zone=zone,
            cart=existing.get("cart") or [],
            continued=True,
            payment_mode=mapping.get("payment_mode") or "prepaid",
        )

    # Fresh session bound to this device.
    session_id = sess.new_session_id()
    await repo.create_session(
        db,
        session_id,
        restaurant_id,
        table_number=table_number,
        customer_name=None,
        order_type="dine_in",
        zone=zone,
        device_id=device_id or None,
        ua_hash=ua_hash,
        ttl_seconds=SESSION_TTL_SECONDS,
    )
    token = sess.sign(session_id)
    return QrSession(
        session_id=token,
        table_number=table_number,
        restaurant_name=mapping["name"],
        order_type="dine_in",
        zone=zone,
        cart=[],
        continued=False,
        payment_mode=mapping.get("payment_mode") or "prepaid",
    )


@router.post("/token", response_model=QrTokenResponse)
async def mint_token(
    body: QrTokenRequest,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Staff-only: get (or create) the durable opaque token for a table.

    Idempotent — re-generating a table's QR returns the same token so stickers
    already printed keep working.
    """
    rest = await repo.get_restaurant_by_slug(db, body.restaurant)
    if rest is None:
        raise HTTPException(status_code=404, detail="Unknown restaurant.")
    table_number = body.table_number.strip()
    if not table_number:
        raise HTTPException(status_code=422, detail="Table number is required.")

    token = await repo.get_or_create_qr_token(
        db, rest["id"], table_number, sess.new_qr_token()
    )
    return QrTokenResponse(token=token, table_number=table_number)
