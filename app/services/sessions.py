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


def sign(session_id: str) -> str:
    mac = hmac.new(
        settings.session_secret.encode(), session_id.encode(), hashlib.sha256
    ).hexdigest()
    return f"{session_id}.{mac}"


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
