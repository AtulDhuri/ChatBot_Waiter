"""/menu — return the structured menu (items grouped by category)."""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.routes.deps import get_db, tenant_matches
from app.services.auth import decode_token, token_from_request
from app.schemas import MenuItem, MenuResponse
from app.services import pricing, sessions as sess

router = APIRouter(prefix="/menu", tags=["menu"])


async def _zone_for_session(db: AsyncSession, session_id: Optional[str]) -> Optional[str]:
    """Resolve the pricing zone for a (signed) session token, or None.

    Invalid/missing tokens simply yield None (base pricing) so the menu still
    loads for anonymous callers and staff tools.
    """
    if not session_id:
        return None
    inner = sess.verify(session_id)
    if inner is None:
        return None
    row = await repo.get_session_row(db, inner)
    return row.get("zone") if row else None


@router.get("", response_model=MenuResponse)
async def get_menu(
    restaurant: Optional[str] = None,
    session_id: Optional[str] = None,
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    response_obj: Response = None,
):
    rest = None
    session_row = None

    # Prefer the session: it ties the menu to the table's tenant without ever
    # exposing the slug to the customer.
    if session_id:
        inner = sess.verify(session_id)
        if inner is not None:
            session_row = await repo.get_session_row(db, inner)
        if session_row is not None and not session_row.get("is_expired"):
            rest = await repo.get_restaurant_by_id(db, session_row["restaurant_id"])

    # Fall back to an explicit slug (staff/admin/legacy callers).
    if rest is None and restaurant:
        rest = await repo.get_restaurant_by_slug(db, restaurant)

    if rest is None:
        raise HTTPException(status_code=404, detail="No menu loaded for this restaurant.")
    admin_token = token_from_request(request) if request else None
    if admin_token and not session_id:
        principal = decode_token(admin_token)
        if not tenant_matches(principal, rest["id"]):
            raise HTTPException(status_code=403, detail="Outlet is outside your tenant.")

    # Zone: reuse the already-loaded session row when we have it, else resolve
    # from the token (slug path with a session_id), else base pricing.
    if session_row is not None and not session_row.get("is_expired"):
        zone = session_row.get("zone")
    else:
        zone = await _zone_for_session(db, session_id)

    rows = await repo.get_menu_items(db, rest["id"])
    items = []
    for r in rows:
        zone_prices = {
            str(k): float(v)
            for k, v in (r.get("zone_prices") or {}).items()
            if v is not None
        }
        base = float(r["price"]) if r["price"] is not None else None
        # Zone-effective display price (falls back to base when no override).
        if base is None:
            display_price = None
        else:
            display_price = pricing.resolve_zone_price(
                {"price": base, "zone_prices": zone_prices}, zone
            )
        items.append(
            MenuItem(
                id=r["id"],
                name=r["name"],
                description=r["description"],
                category=r["category"],
                price=display_price,
                currency=r["currency"] or "$",
                available=bool(r.get("available", True)),
                zone_prices=zone_prices,
            )
        )

    categories = defaultdict(list)
    for item in items:
        categories[item.category or "General"].append(item)

    menu_response = MenuResponse(
        restaurant=rest["slug"],
        restaurant_name=rest.get("name") or rest["slug"],
        categories=dict(categories),
        items=items,
    )

    # --- ETag + Cache-Control -------------------------------------------
    # Build a lightweight fingerprint from item ids and availability flags.
    # This lets browsers/CDNs send If-None-Match and get a 304 with no body
    # when nothing has changed — essentially free on cache hits.
    if response_obj is not None:
        is_public = not session_id and not (request and token_from_request(request))

        fingerprint_data = json.dumps(
            [[r["id"], bool(r.get("available", True))] for r in rows],
            separators=(",", ":"),
        )
        etag = '"' + hashlib.md5(fingerprint_data.encode()).hexdigest()[:16] + '"'
        response_obj.headers["ETag"] = etag

        if is_public:
            response_obj.headers["Cache-Control"] = (
                "public, max-age=60, stale-while-revalidate=300"
            )
        else:
            response_obj.headers["Cache-Control"] = "private, max-age=30"

        # Honour conditional requests — return 304 when the client already
        # has the current version (no body, no DB cost for serialisation).
        if request and request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})

    return menu_response
