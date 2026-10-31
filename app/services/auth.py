"""JWT authentication, password hashing, and audit helpers for merchant users."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Optional

from fastapi import HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from app.config import settings


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str) -> str:
    if len(password) < 10:
        raise ValueError("Password must be at least 10 characters.")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"pbkdf2_sha256$310000${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, rounds, salt, expected = encoded.split("$", 3)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), _unb64(salt), int(rounds))
        return algo == "pbkdf2_sha256" and hmac.compare_digest(_b64(actual), expected)
    except (ValueError, TypeError):
        return False


def issue_token(*, user_id: int, tenant_id: int, outlet_id: int, role: str, subscription_status: str, restaurant_slug: str = "") -> str:
    now = int(time.time())
    payload = {"userId": user_id, "tenantId": tenant_id, "outletId": outlet_id, "restaurantSlug": restaurant_slug, "role": role,
               "subscriptionStatus": subscription_status, "exp": now + settings.auth_token_ttl_seconds}
    header = {"alg": "HS256", "typ": "JWT"}
    encoded = f"{_b64(json.dumps(header, separators=(',', ':')).encode())}.{_b64(json.dumps(payload, separators=(',', ':')).encode())}"
    signature = hmac.new(settings.auth_jwt_secret.encode(), encoded.encode(), hashlib.sha256).digest()
    return f"{encoded}.{_b64(signature)}"


def create_reset_token() -> tuple[str, str]:
    raw = secrets.token_urlsafe(32)
    return raw, hashlib.sha256(raw.encode()).hexdigest()

def issue_realtime_token(*, user_id: int, tenant_id: int, outlet_id: int, role: str, ttl_seconds: int = 300) -> str:
    """Issue a short-lived JWT understood by Supabase Realtime RLS."""
    now = int(time.time())
    payload = {"sub": str(user_id), "role": "authenticated", "user_id": user_id,
               "tenant_id": tenant_id, "outlet_id": outlet_id, "app_role": role,
               "iat": now, "exp": now + ttl_seconds}
    header = {"alg": "HS256", "typ": "JWT"}
    encoded = f"{_b64(json.dumps(header, separators=(',', ':')).encode())}.{_b64(json.dumps(payload, separators=(',', ':')).encode())}"
    signature = hmac.new(settings.supabase_jwt_secret.encode(), encoded.encode(), hashlib.sha256).digest()
    return f"{encoded}.{_b64(signature)}"


def decode_token(token: str) -> dict[str, Any]:
    try:
        head, body, signature = token.split(".", 2)
        expected = hmac.new(settings.auth_jwt_secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(_unb64(signature), expected):
            raise ValueError
        payload = json.loads(_unb64(body))
        if int(payload["exp"]) <= int(time.time()):
            raise HTTPException(status_code=401, detail="Token expired.")
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid authentication token.") from exc


def token_from_request(request: Request) -> Optional[str]:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.cookies.get(settings.auth_cookie_name)


async def audit(db: AsyncSession, event_type: str, *, user_id: Optional[int] = None, tenant_id: Optional[int] = None, detail: Optional[dict] = None, request: Optional[Request] = None) -> None:
    await db.execute(text("INSERT INTO audit_logs (event_type, user_id, tenant_id, detail, client_ip) VALUES (:event, :uid, :tid, CAST(:detail AS JSONB), :ip)"), {
        "event": event_type, "uid": user_id, "tid": tenant_id, "detail": json.dumps(detail or {}),
        "ip": request.client.host if request and request.client else None,
    })
