"""Shared route dependencies: resolving and validating sessions."""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from typing import List, Optional, Tuple

from fastapi import Header, Query

from app.config import settings
from app.db import repository as repo
from app.db.database import get_session
from app.services import pricing, sessions as sess
from app.services import security

logger = logging.getLogger("waiter.security")


async def require_staff(request: Request) -> Dict[str, Any]:
    """Authenticate an admin request from the HttpOnly JWT cookie or Bearer header.

    The outlet and tenant claims are authoritative. Query-string slugs are only
    display/routing inputs and must never grant access.
    """
    from app.services.auth import decode_token, token_from_request
    token = token_from_request(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required.")
    payload = decode_token(token)
    # Re-check the user and outlet on every protected request so disabling an
    # account or changing its role invalidates already-issued JWTs promptly.
    from sqlalchemy import text
    from app.db.database import AsyncSessionLocal
    async with AsyncSessionLocal() as auth_db:
        try:
            user = (await auth_db.execute(text("""SELECT u.active,u.status,u.role,u.tenant_id,u.outlet_id,
                r.subscription_status, r.slug AS restaurant_slug, u.tenant_id AS outlet_tenant_id
                FROM users u JOIN restaurants r ON r.id=u.outlet_id
                JOIN tenants t ON t.id=u.tenant_id
                JOIN outlets o ON o.id=u.outlet_id AND o.tenant_id=u.tenant_id
                WHERE u.id=:id"""), {"id": payload.get("userId")})).mappings().first()
        except Exception:
            user = (await auth_db.execute(text("""SELECT u.active,u.status,u.role,u.tenant_id,u.outlet_id,
                r.subscription_status, r.slug AS restaurant_slug, u.tenant_id AS outlet_tenant_id
                FROM users u JOIN restaurants r ON r.id=u.outlet_id
                WHERE u.id=:id"""), {"id": payload.get("userId")})).mappings().first()
    if not user or not user["active"] or user.get("status", "ACTIVE") != "ACTIVE":
        raise HTTPException(status_code=401, detail="Account is disabled.")
    if int(user["tenant_id"]) != int(payload.get("tenantId", -1)) or int(user["outlet_id"]) != int(payload.get("outletId", -1)):
        raise HTTPException(status_code=403, detail="Authentication tenant mismatch.")
    payload["role"] = user["role"]
    payload["restaurantSlug"] = user.get("restaurant_slug")
    payload["subscriptionStatus"] = user.get("subscription_status") or payload.get("subscriptionStatus")
    if payload.get("subscriptionStatus") in {"EXPIRED", "SUSPENDED"}:
        raise HTTPException(status_code=402, detail="Subscription Expired. Please renew your plan.")
    role = payload.get("role")
    path = request.url.path
    if path.startswith("/reports") and role not in {"admin", "manager"}:
        raise HTTPException(status_code=403, detail="Reports require manager access.")
    if path.startswith("/manager") and role not in {"admin", "manager"}:
        raise HTTPException(status_code=403, detail="Manager access required.")
    if path.startswith("/crawl") and role != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required.")
    if path == "/qr/token" and role not in {"admin", "manager"}:
        raise HTTPException(status_code=403, detail="Manager access required.")
    if path.startswith("/order") and role not in {"admin", "manager", "kitchen"}:
        raise HTTPException(status_code=403, detail="Kitchen access required.")
    if path.startswith("/staff") and role != "admin":
        raise HTTPException(status_code=403, detail="Staff management requires administrator access.")
    if path == "/close-table" and role not in {"admin", "manager"}:
        raise HTTPException(status_code=403, detail="Table closing requires manager access.")
    if path.startswith("/order/") and role == "kitchen":
        # Kitchen users may update kitchen status, but never payment state.
        pass
    if path.startswith("/postpaid") and request.method == "POST" and role not in {"admin", "manager"}:
        raise HTTPException(status_code=403, detail="Postpaid settlement requires manager access.")
    if path.startswith("/pay") and request.method == "POST" and role not in {"admin", "manager"}:
        raise HTTPException(status_code=403, detail="Manager access required.")
    return payload


def tenant_matches(principal: Dict[str, Any], outlet_id: int) -> bool:
    return int(principal.get("outletId", -1)) == int(outlet_id) and int(principal.get("tenantId", -1)) == int(outlet_id)

async def require_role(principal: Dict[str, Any], roles: set[str]) -> Dict[str, Any]:
    if principal.get("role") not in roles:
        raise HTTPException(status_code=403, detail="Insufficient permissions.")
    return principal


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
    # The session's zone (resolved from the table at session start) selects
    # per-zone prices. None -> base price, identical to pre-zone behaviour.
    zone = row.get("zone")
    return pricing.reprice_cart(cart, lookup, zone=zone)


# Keep in sync with qr_routes.SESSION_TTL_SECONDS: every authenticated call
# slides the session's expiry forward by this much. Driven by config so a
# short production window shrinks the replay window for a captured token.
SESSION_TTL_SECONDS = settings.session_ttl_seconds


async def resolve_session(
    token: str,
    db: AsyncSession,
    request: Optional[Request] = None,
) -> Dict[str, Any]:
    """Validate a signed token, pin it to device+UA, enforce expiry, load row.

    Raises:
      - 401 for a tampered/forged token.
      - 404 for an unknown session.
      - 440 (login timeout) for an expired one.
      - 403 when the caller's device_id or User-Agent does not match the
        values the session was bound to (a likely replay from a stolen token).

    When ``request`` is provided we read the ``X-Device-Id`` header and the
    ``User-Agent`` and compare them to the session's stored ``device_id`` and
    ``ua_hash``. A mismatch is logged and recorded as a security event so staff
    monitoring can alert on it, then the request is rejected. On success the
    sliding inactivity window is pushed forward.
    """
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
            detail="Session not found. Please scan your table's QR code again.",
        )
    if row.get("is_expired"):
        # Expired by inactivity. The widget treats this as "start fresh".
        raise HTTPException(
            status_code=440,  # Login Timeout
            detail="Your session expired. Please scan your table's QR code again.",
        )

    # ---- Device + UA pinning (replay defense) ---------------------------
    if request is not None:
        caller_device = (request.headers.get("x-device-id") or "").strip()[:128]
        caller_ua_hash = sess.hash_ua(request.headers.get("user-agent"))
        bound_device = row.get("device_id")
        bound_ua = row.get("ua_hash")

        # Only enforce against values that were actually bound. Sessions minted
        # before pinning (no stored device/ua) are not retroactively rejected,
        # but any session that WAS bound must match on every request.
        mismatch_fields: List[str] = []
        if bound_device and caller_device != bound_device:
            mismatch_fields.append("device_id")
        if bound_ua and caller_ua_hash != bound_ua:
            mismatch_fields.append("user_agent")

        if mismatch_fields:
            client_ip = request.client.host if request.client else None
            logger.warning(
                "Session pinning mismatch (possible replay): session=%s "
                "fields=%s ip=%s bound_device=%s caller_device=%s",
                session_id,
                ",".join(mismatch_fields),
                client_ip,
                _mask(bound_device),
                _mask(caller_device),
            )
            await security.record_replay_attempt(
                db,
                session_id=session_id,
                restaurant_id=row.get("restaurant_id"),
                table_number=row.get("table_number"),
                mismatch_fields=mismatch_fields,
                client_ip=client_ip,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This session can't be used from here. Please scan "
                "your table's QR code again.",
            )

    # Sliding expiry: this request counts as activity.
    await repo.touch_session(db, session_id, SESSION_TTL_SECONDS)
    return row


def _mask(value: Optional[str]) -> str:
    """Mask an identifier for logs: keep a short prefix only."""
    if not value:
        return "-"
    return value[:6] + "…" if len(value) > 6 else value


async def get_db() -> AsyncSession:  # thin re-export for clarity in routers
    async for s in get_session():
        yield s
