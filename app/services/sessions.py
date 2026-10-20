"""Signed session tokens tying a browser to a table number.

The session id is a random token; we also issue an HMAC signature so the
server can detect tampering before hitting the database. Cart state lives in
Postgres (per session row) so it survives widget reloads.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

from app.config import settings


def new_session_id() -> str:
    return secrets.token_urlsafe(24)


def hash_ua(user_agent: str | None) -> str:
    """Stable, privacy-preserving fingerprint of a User-Agent string.

    We store only the hash, never the raw UA. An empty/missing UA hashes to a
    fixed value so "no UA" is still comparable across requests.
    """
    return hashlib.sha256((user_agent or "").strip().encode()).hexdigest()


def new_qr_token() -> str:
    """A short, opaque, URL-safe token for a table QR sticker.

    ~128 bits of entropy — not guessable or enumerable, so the token reveals
    nothing about the tenant and can't be walked to discover other tables.
    """
    return secrets.token_urlsafe(16)


def sign(session_id: str) -> str:
    mac = hmac.new(
        settings.session_secret.encode(), session_id.encode(), hashlib.sha256
    ).hexdigest()
    return f"{session_id}.{mac}"


def constant_time_eq(a: str, b: str) -> bool:
    """Timing-safe string comparison for secrets (e.g. the staff token)."""
    return hmac.compare_digest((a or "").encode(), (b or "").encode())


def verify(token: str) -> str | None:
    """Return the session id if the token's signature is valid, else None."""
    if not token or "." not in token:
        return None
    session_id, _, mac = token.rpartition(".")
    expected = hmac.new(
        settings.session_secret.encode(), session_id.encode(), hashlib.sha256
    ).hexdigest()
    if hmac.compare_digest(mac, expected):
        return session_id
    return None
