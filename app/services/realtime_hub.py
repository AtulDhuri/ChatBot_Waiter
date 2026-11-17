"""Server-side Supabase Realtime relay.

Browsers never talk to Supabase. This process holds ONE Supabase Realtime
websocket (authenticated with a server-signed ``service_role`` JWT that never
leaves the server), receives ``postgres_changes`` for the kitchen-relevant
tables, and fans out content-free "something changed" pings to subscribers
(Server-Sent Events, see ``app/routes/events_routes.py``).

Pings carry only the table name and change type, never row data, keys or
tokens. Clients re-fetch through the normal authenticated API.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Set

from app.config import settings

logger = logging.getLogger("waiter.realtime")

TABLES = ("orders", "order_items", "menu_items")
TOPIC = "realtime:dineos-server-hub"
HEARTBEAT_S = 25
TOKEN_TTL_S = 3600
TOKEN_REFRESH_S = 3000          # push a fresh JWT well before expiry
RECONNECT_MAX_S = 60
QUEUE_MAX = 100

# match(table, record) -> bool
Matcher = Callable[[str, Dict[str, Any]], bool]


@dataclass(eq=False)
class Subscriber:
    match: Matcher
    queue: "asyncio.Queue[Dict[str, Any]]" = field(
        default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX)
    )

    def push(self, event: Dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            # Slow consumer: one pending ping already means "refetch", so
            # dropping extras loses nothing.
            pass


def _b64(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _service_token() -> str:
    now = int(time.time())
    payload = {"role": "service_role", "iss": "dineos-server", "iat": now, "exp": now + TOKEN_TTL_S}
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(settings.supabase_jwt_secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(sig)}"


def is_configured() -> bool:
    return bool(
        settings.resolved_supabase_url
        and settings.supabase_anon_key
        and settings.supabase_jwt_secret
    )


class RealtimeHub:
    def __init__(self) -> None:
        self._subs: Set[Subscriber] = set()
        self._task: Optional[asyncio.Task] = None
        self.live = False

    # ---- subscriber management -------------------------------------------
    def subscribe(self, match: Matcher) -> Subscriber:
        sub = Subscriber(match=match)
        self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subs.discard(sub)

    def _set_live(self, live: bool) -> None:
        if live == self.live:
            return
        self.live = live
        # Tell every client to switch between push and fallback polling; on
        # (re)connect they also refetch to cover anything missed meanwhile.
        for sub in list(self._subs):
            sub.push({"kind": "live", "live": live})

    def _publish(self, table: str, change: str, record: Dict[str, Any]) -> None:
        for sub in list(self._subs):
            try:
                if sub.match(table, record):
                    sub.push({"kind": "change", "table": table, "type": change})
            except Exception:  # a bad matcher must never break the relay
                logger.exception("realtime matcher failed")

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        if self._task is None and is_configured():
            self._task = asyncio.create_task(self._run(), name="supabase-realtime-hub")
        elif not is_configured():
            logger.warning("Supabase Realtime not configured; clients will poll.")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self._set_live(False)

    async def _run(self) -> None:
        import websockets

        url = (
            settings.resolved_supabase_url.replace("https://", "wss://")
            + f"/realtime/v1/websocket?apikey={settings.supabase_anon_key}&vsn=1.0.0"
        )
        delay = 1
        while True:
            try:
                async with websockets.connect(url, ping_interval=None, open_timeout=15) as ws:
                    await self._session(ws)
                    delay = 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Supabase Realtime connection lost: %s", exc)
            self._set_live(False)
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX_S)

    async def _session(self, ws) -> None:
        ref = 0

        def next_ref() -> str:
            nonlocal ref
            ref += 1
            return str(ref)

        await ws.send(json.dumps({
            "topic": TOPIC, "event": "phx_join", "ref": next_ref(),
            "payload": {
                "config": {
                    "broadcast": {"self": False}, "presence": {"key": ""},
                    "postgres_changes": [
                        {"event": "*", "schema": "public", "table": t} for t in TABLES
                    ],
                },
                "access_token": _service_token(),
            },
        }))

        async def keepalive() -> None:
            last_token = time.monotonic()
            while True:
                await asyncio.sleep(HEARTBEAT_S)
                await ws.send(json.dumps({"topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": next_ref()}))
                if time.monotonic() - last_token > TOKEN_REFRESH_S:
                    await ws.send(json.dumps({
                        "topic": TOPIC, "event": "access_token", "ref": next_ref(),
                        "payload": {"access_token": _service_token()},
                    }))
                    last_token = time.monotonic()

        ka = asyncio.create_task(keepalive())
        try:
            async for raw in ws:
                msg = json.loads(raw)
                event, payload = msg.get("event"), msg.get("payload") or {}
                if msg.get("topic") != TOPIC:
                    continue
                if event == "system":
                    if payload.get("status") == "ok":
                        logger.info("Supabase Realtime hub subscribed.")
                        self._set_live(True)
                    else:
                        logger.warning("Supabase Realtime system error: %s", payload.get("message"))
                        raise RuntimeError("subscription failed")
                elif event == "phx_reply" and payload.get("status") == "error":
                    raise RuntimeError(f"join rejected: {payload.get('response')}")
                elif event in ("phx_error", "phx_close"):
                    raise RuntimeError(event)
                elif event == "postgres_changes":
                    data = payload.get("data") or {}
                    record = data.get("record") or data.get("old_record") or {}
                    self._publish(data.get("table", ""), data.get("type", ""), record)
        finally:
            ka.cancel()


hub = RealtimeHub()
