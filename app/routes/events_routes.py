"""Server-Sent Events: realtime pings for staff screens and customer widgets.

The browser connects only to this backend. Each message says *that* something
changed (table + change type), never *what*; clients re-fetch through the
normal authenticated API. No Supabase URL, key or token is ever sent.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator, Dict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.db import repository as repo
from app.db.database import session_scope
from app.routes.deps import require_staff
from app.services import sessions as sess
from app.services.realtime_hub import Matcher, hub

router = APIRouter(prefix="/events", tags=["events"])

PING_S = 15
# Streams are closed periodically; EventSource reconnects automatically and
# the reconnect re-runs authentication (picks up revoked staff / ended sessions).
MAX_STREAM_S = 15 * 60

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",      # disable proxy buffering (nginx/Render)
    "Connection": "keep-alive",
}


def _sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def _stream(request: Request, match: Matcher) -> AsyncIterator[str]:
    sub = hub.subscribe(match)
    started = time.monotonic()
    try:
        yield "retry: 3000\n\n"
        yield _sse("live", {"live": hub.live})
        while time.monotonic() - started < MAX_STREAM_S:
            if await request.is_disconnected():
                break
            try:
                ev = await asyncio.wait_for(sub.queue.get(), timeout=PING_S)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            if ev["kind"] == "live":
                yield _sse("live", {"live": ev["live"]})
            else:
                yield _sse("change", {"table": ev["table"], "type": ev["type"]})
    finally:
        hub.unsubscribe(sub)


@router.get("/board")
async def staff_events(request: Request):
    """Kitchen / manager screens: changes to this outlet's orders and items."""
    async with session_scope() as db:
        principal = await require_staff(request, db)
    if principal.get("role") not in {"admin", "manager", "kitchen"}:
        raise HTTPException(status_code=403, detail="Staff access required.")
    outlet = int(principal["outletId"])

    def match(table: str, record: Dict[str, Any]) -> bool:
        return table in ("orders", "order_items") and _int(record.get("restaurant_id")) == outlet

    return StreamingResponse(_stream(request, match), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.get("/session")
async def session_events(request: Request, session_id: str, device: str = ""):
    """Customer widget: changes to THIS session's orders and the menu.

    EventSource cannot send custom headers, so the device id comes as a query
    parameter and is checked against the session's bound device, the same
    pinning rule the JSON API enforces through X-Device-Id.
    """
    inner = sess.verify(session_id)
    if not inner:
        raise HTTPException(status_code=401, detail="Invalid session token.")
    async with session_scope() as db:
        row = await repo.get_session_row(db, inner)
    if row is None or row.get("is_expired"):
        raise HTTPException(status_code=404, detail="Session not found or expired.")
    bound_device = row.get("device_id")
    bound_ua = row.get("ua_hash")
    if bound_device and device.strip()[:128] != bound_device:
        raise HTTPException(status_code=403, detail="Session is bound to another device.")
    if bound_ua and sess.hash_ua(request.headers.get("user-agent")) != bound_ua:
        raise HTTPException(status_code=403, detail="Session is bound to another device.")

    sid = str(row["id"])
    rid = _int(row["restaurant_id"])

    def match(table: str, record: Dict[str, Any]) -> bool:
        if table == "orders":
            return str(record.get("session_id") or "") == sid
        if table == "menu_items":
            return _int(record.get("restaurant_id")) == rid
        return False

    return StreamingResponse(_stream(request, match), media_type="text/event-stream", headers=_SSE_HEADERS)


def _int(v: Any) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return -1
