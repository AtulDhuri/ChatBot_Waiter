"""Security event recording and monitoring helpers.

Replay attempts and other suspicious events are persisted to the
``security_events`` table so staff tooling can surface and alert on them. The
recorder is best-effort: a logging/audit failure must never break the request
that triggered it, so writes here swallow their own errors.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("waiter.security")

EVENT_REPLAY_ATTEMPT = "replay_attempt"


async def record_security_event(
    session: AsyncSession,
    event_type: str,
    *,
    restaurant_id: Optional[int] = None,
    session_id: Optional[str] = None,
    table_number: Optional[str] = None,
    detail: Optional[Dict[str, Any]] = None,
    client_ip: Optional[str] = None,
) -> None:
    """Persist a security event. Best-effort; never raises to the caller."""
    try:
        await session.execute(
            text(
                """
                INSERT INTO security_events
                    (event_type, restaurant_id, session_id, table_number,
                     detail, client_ip)
                VALUES
                    (:etype, :rid, :sid, :tn, CAST(:detail AS JSONB), :ip)
                """
            ),
            {
                "etype": event_type,
                "rid": restaurant_id,
                "sid": session_id,
                "tn": table_number,
                "detail": json.dumps(detail or {}),
                "ip": client_ip,
            },
        )
    except Exception as exc:  # pragma: no cover - audit must not break flow
        logger.error("Failed to record security event %s: %s", event_type, exc)


async def record_replay_attempt(
    session: AsyncSession,
    *,
    session_id: str,
    restaurant_id: Optional[int],
    table_number: Optional[str],
    mismatch_fields: List[str],
    client_ip: Optional[str],
) -> None:
    """Record that a session token was used from a different device/UA."""
    await record_security_event(
        session,
        EVENT_REPLAY_ATTEMPT,
        restaurant_id=restaurant_id,
        session_id=session_id,
        table_number=table_number,
        detail={"mismatch_fields": mismatch_fields},
        client_ip=client_ip,
    )


async def list_security_events(
    session: AsyncSession,
    restaurant_id: int,
    *,
    event_type: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """Recent security events for an outlet, newest first (staff monitoring)."""
    params: Dict[str, Any] = {"rid": restaurant_id, "lim": max(1, min(limit, 500))}
    where = "restaurant_id = :rid"
    if event_type:
        where += " AND event_type = :etype"
        params["etype"] = event_type
    rows = (
        await session.execute(
            text(
                f"""
                SELECT id, event_type, session_id, table_number, detail,
                       client_ip, created_at
                FROM security_events
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT :lim
                """
            ),
            params,
        )
    ).mappings().all()
    return [dict(r) for r in rows]


async def count_recent_replays(
    session: AsyncSession, restaurant_id: int, within_minutes: int = 60
) -> int:
    """How many replay attempts an outlet has seen recently.

    Staff tooling can poll this and raise an alert when it crosses a threshold.
    """
    row = (
        await session.execute(
            text(
                """
                SELECT count(*) AS n
                FROM security_events
                WHERE restaurant_id = :rid
                  AND event_type = :etype
                  AND created_at >= now() - make_interval(mins => :mins)
                """
            ),
            {
                "rid": restaurant_id,
                "etype": EVENT_REPLAY_ATTEMPT,
                "mins": within_minutes,
            },
        )
    ).mappings().first()
    return int(row["n"]) if row else 0
