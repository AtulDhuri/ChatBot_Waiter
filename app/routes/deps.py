"""Shared route dependencies: resolving and validating sessions."""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.db.database import get_session
from app.services import pricing, sessions as sess
from app.services import security

logger = logging.getLogger("waiter.security")

# ---------------------------------------------------------------------------
# DB session helper — defined early so require_staff (below) can reference it
# ---------------------------------------------------------------------------

async def get_db() -> AsyncSession:
    async for s in get_session():
        yield s


# ---------------------------------------------------------------------------
# Short-lived in-process auth cache
# ---------------------------------------------------------------------------
# Each authenticated API call previously opened a *second* DB connection just
# to re-validate the JWT's user row.  For a Supabase-hosted DB using NullPool
# that means two full TLS handshakes + round-trips before any real work.
#
# We cache the validated user record keyed on the JWT signature (the last
# segment of the token, which is an HMAC of the payload — unique per token
# issuance).  TTL is 30 s: short enough to pick up role/status changes quickly,
# long enough that rapid successive button clicks share a single DB validation.
#
# The cache is per-process and not shared across workers, which is fine: a
# revoked account is blocked at most 30 s per worker, matching the security
# posture of any short-TTL token scheme.

_AUTH_CACHE: dict[str, tuple[float, dict]] = {}   # sig -> (expires_at, user_row)
_AUTH_CACHE_TTL = 30          # seconds
_AUTH_CACHE_MAX = 2000        # entries; prevents unbounded growth


def _cache_key(token: str) -> str:
    """Use the last JWT segment (HMAC signature) as the cache key."""
    return token.rsplit(".", 1)[-1]


def _cache_get(token: str) -> Optional[dict]:
    key = _cache_key(token)
    entry = _AUTH_CACHE.get(key)
    if entry and entry[0] > time.monotonic():
        return entry[1]
    _AUTH_CACHE.pop(key, None)
    return None


def _cache_set(token: str, user_row: dict) -> None:
    if len(_AUTH_CACHE) >= _AUTH_CACHE_MAX:
        # Evict ~10 % of the oldest entries to stay bounded.
        cutoff = time.monotonic()
        expired = [k for k, (exp, _) in _AUTH_CACHE.items() if exp <= cutoff]
        for k in expired[:max(1, _AUTH_CACHE_MAX // 10)]:
            _AUTH_CACHE.pop(k, None)
        if len(_AUTH_CACHE) >= _AUTH_CACHE_MAX:
            # Still full — drop arbitrary entries to make room.
            for k in list(_AUTH_CACHE)[:_AUTH_CACHE_MAX // 10]:
                _AUTH_CACHE.pop(k, None)
    _AUTH_CACHE[_cache_key(token)] = (time.monotonic() + _AUTH_CACHE_TTL, user_row)


def invalidate_auth_cache(token: str) -> None:
    """Remove a specific token from the cache (call on logout/role change)."""
    _AUTH_CACHE.pop(_cache_key(token), None)


# ---------------------------------------------------------------------------
# Staff authentication dependency
# ---------------------------------------------------------------------------

# Single SQL that joins only users + restaurants (tenants/outlets tables are
# not needed here — tenant_id == outlet_id == restaurant.id in this schema).
_AUTH_QUERY = text("""
    SELECT u.active, u.status, u.role, u.tenant_id, u.outlet_id,
           r.subscription_status, r.slug AS restaurant_slug
    FROM   users u
    JOIN   restaurants r ON r.id = u.outlet_id
    WHERE  u.id = :uid
""")


async def require_staff(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Authenticate an admin/staff request.

    Uses the request's already-open DB session (injected by FastAPI's
    dependency graph) so NO second connection is opened.  Both this dependency
    and the route handler that calls it depend on the same ``get_db``
    function, so FastAPI deduplicates them and shares one session per request.
    Validated user rows are cached in-process for 30 s to absorb rapid
    successive calls.
    """
    from app.services.auth import decode_token, token_from_request

    token = token_from_request(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required.")

    payload = decode_token(token)   # verifies HMAC + expiry (pure CPU, no DB)

    # --- cache hit: skip the DB round-trip entirely ---
    cached = _cache_get(token)
    if cached is None:
        try:
            user = (
                await db.execute(_AUTH_QUERY, {"uid": payload.get("userId")})
            ).mappings().first()
        except Exception:
            # Fallback: retry without the tenants/outlets join (legacy schema).
            user = (
                await db.execute(
                    text("""SELECT u.active, u.status, u.role, u.tenant_id,
                                   u.outlet_id, r.subscription_status,
                                   r.slug AS restaurant_slug
                            FROM   users u
                            JOIN   restaurants r ON r.id = u.outlet_id
                            WHERE  u.id = :uid"""),
                    {"uid": payload.get("userId")},
                )
            ).mappings().first()

        if not user or not user["active"] or user.get("status", "ACTIVE") != "ACTIVE":
            raise HTTPException(status_code=401, detail="Account is disabled.")
        if (
            int(user["tenant_id"]) != int(payload.get("tenantId", -1))
            or int(user["outlet_id"]) != int(payload.get("outletId", -1))
        ):
            raise HTTPException(
                status_code=403, detail="Authentication tenant mismatch."
            )
        cached = dict(user)
        _cache_set(token, cached)

    # Merge cached DB fields into the decoded JWT payload.
    payload["role"] = cached["role"]
    payload["restaurantSlug"] = cached.get("restaurant_slug")
    payload["subscriptionStatus"] = (
        cached.get("subscription_status")
        or payload.get("subscriptionStatus")
    )

    if payload.get("subscriptionStatus") in {"EXPIRED", "SUSPENDED"}:
        raise HTTPException(
            status_code=402,
            detail="Subscription Expired. Please renew your plan.",
        )

    # Path-based role enforcement.
    role = payload["role"]
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
        raise HTTPException(
            status_code=403,
            detail="Staff management requires administrator access.",
        )
    if path == "/close-table" and role not in {"admin", "manager"}:
        raise HTTPException(
            status_code=403, detail="Table closing requires manager access."
        )
    if path.startswith("/postpaid") and request.method == "POST" and role not in {
        "admin",
        "manager",
    }:
        raise HTTPException(
            status_code=403, detail="Postpaid settlement requires manager access."
        )
    if path.startswith("/pay") and request.method == "POST" and role not in {
        "admin",
        "manager",
    }:
        raise HTTPException(status_code=403, detail="Manager access required.")

    return payload


def tenant_matches(principal: Dict[str, Any], outlet_id: int) -> bool:
    return int(principal.get("outletId", -1)) == int(outlet_id) and int(
        principal.get("tenantId", -1)
    ) == int(outlet_id)


async def require_role(
    principal: Dict[str, Any], roles: set[str]
) -> Dict[str, Any]:
    if principal.get("role") not in roles:
        raise HTTPException(status_code=403, detail="Insufficient permissions.")
    return principal


async def resolve_cart(
    db: AsyncSession, row: Dict[str, Any], client_cart
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Pick the cart (client override or stored) and re-price it from the DB."""
    if client_cart is not None:
        cart = [
            c.model_dump() if hasattr(c, "model_dump") else dict(c)
            for c in client_cart
        ]
    else:
        cart = row["cart"] or []
    lookup = await repo.get_price_lookup(db, row["restaurant_id"])
    zone = row.get("zone")
    return pricing.reprice_cart(cart, lookup, zone=zone)


SESSION_TTL_SECONDS = settings.session_ttl_seconds


async def resolve_session(
    token: str,
    db: AsyncSession,
    request: Optional[Request] = None,
) -> Dict[str, Any]:
    """Validate a signed token, pin it to device+UA, enforce expiry, load row."""
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
        raise HTTPException(
            status_code=440,
            detail="Your session expired. Please scan your table's QR code again.",
        )

    if request is not None:
        caller_device = (request.headers.get("x-device-id") or "").strip()[:128]
        caller_ua_hash = sess.hash_ua(request.headers.get("user-agent"))
        bound_device = row.get("device_id")
        bound_ua = row.get("ua_hash")

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

    await repo.touch_session(db, session_id, SESSION_TTL_SECONDS)
    return row


def _mask(value: Optional[str]) -> str:
    if not value:
        return "-"
    return value[:6] + "…" if len(value) > 6 else value
