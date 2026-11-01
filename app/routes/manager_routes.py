"""Manager dashboard API.

Read-only order views with filters and CSV export, plus table->zone and dish
availability management. All endpoints are staff-guarded. These are additive:
they never mutate existing order/billing data except the explicit management
actions (set a table's zone, toggle a dish's availability).
"""
from __future__ import annotations

import csv
import io
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.routes.deps import get_db, require_staff, tenant_matches
from app.schemas import (
    ManagerOrder,
    ReceiptProfile,
    ReceiptProfileUpdate,
    SecurityEvent,
    SecurityStatus,
    TableUpsertRequest,
    TableZone,
    MenuAvailabilityUpdate,
)
from app.services import security

router = APIRouter(prefix="/manager", tags=["manager"])


# ---- Admin setup prefill (single round-trip) ----------------------------

@router.get("/setup-data")
async def admin_setup_data(
    restaurant: str = "demo",
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Return UPI, payment mode, tables and menu in one response.

    The admin setup page previously made 4 separate API calls on load,
    each paying a full Supabase round-trip (~600 ms). This endpoint runs
    all queries against the same open connection and returns everything at
    once — reducing page-load latency from ~2.4 s to ~600 ms.

    _resolve_restaurant already fetches the full restaurants row (name,
    upi_vpa, upi_name, payment_mode) so we reuse that result directly
    instead of firing two more queries for the same columns.
    """
    import asyncio

    rest = await _resolve_restaurant(db, restaurant, _principal)
    rid = rest["id"]

    # Only two concurrent queries needed now — restaurant data comes from
    # the row already loaded by _resolve_restaurant above.
    tables_rows, menu_rows = await asyncio.gather(
        repo.list_tables(db, rid),
        repo.get_menu_items(db, rid),
    )

    tables = [
        {"table_number": r["table_number"], "zone": r["zone"]}
        for r in tables_rows
    ]

    items = [
        {
            "id":          r["id"],
            "name":        r["name"],
            "description": r["description"],
            "category":    r["category"] or "General",
            "price":       float(r["price"]) if r["price"] is not None else 0,
            "zone_prices": dict(r.get("zone_prices") or {}),
            "available":   bool(r.get("available", True)),
        }
        for r in menu_rows
    ]

    return {
        "restaurant":      restaurant,
        "restaurant_name": rest.get("name") or restaurant,
        "upi_vpa":         rest.get("upi_vpa")  or "",
        "upi_name":        rest.get("upi_name") or "",
        "payment_mode":    rest.get("payment_mode") or "prepaid",
        "tables":          tables,
        "menu_items":      items,
        "configured":      len(tables) > 0 and len(items) > 0,
    }


def _iso(value) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


async def _resolve_restaurant(db: AsyncSession, slug: str, principal: Dict[str, Any]):
    rest = await repo.get_restaurant_by_slug(db, slug)
    if rest is None:
        raise HTTPException(status_code=404, detail="Unknown restaurant.")
    if not tenant_matches(principal, rest["id"]):
        raise HTTPException(status_code=403, detail="Outlet is outside your tenant.")
    return rest


def _to_manager_order(r: dict) -> ManagerOrder:
    return ManagerOrder(
        id=r["id"],
        order_no=r["order_no"],
        order_type=r.get("order_type", "dine_in"),
        table_number=r["table_number"],
        customer_name=r.get("customer_name"),
        zone=r.get("zone"),
        items=r["items"],
        subtotal=float(r["subtotal"]),
        tax=float(r["tax"]),
        total=float(r["total"]),
        currency=r["currency"] or settings.currency,
        status=r["status"],
        payment_status=r["payment_status"],
        created_at=_iso(r["created_at"]),
    )


@router.get("/orders", response_model=List[ManagerOrder])
async def manager_orders(
    restaurant: str = "demo",
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """All orders for an outlet (newest first) with items, instructions,
    billing and zone. Optional filters: status, date_from, date_to."""
    rest = await _resolve_restaurant(db, restaurant, _principal)
    rows = await repo.list_manager_orders(
        db, rest["id"], status=status, date_from=date_from, date_to=date_to
    )
    return [_to_manager_order(r) for r in rows]


@router.get("/orders.csv")
async def manager_orders_csv(
    restaurant: str = "demo",
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Export the (filtered) order list as CSV, one row per line item so
    instructions are visible per dish."""
    rest = await _resolve_restaurant(db, restaurant, _principal)
    rows = await repo.list_manager_orders(
        db, rest["id"], status=status, date_from=date_from, date_to=date_to
    )

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "Order No", "Created", "Type", "Table", "Zone", "Customer",
            "Status", "Payment", "Item", "Qty", "Unit Price", "Line Total",
            "Instructions", "Order Subtotal", "Order Tax", "Order Total",
            "Currency",
        ]
    )
    for r in rows:
        items = r.get("items") or []
        created = _iso(r["created_at"])
        if not items:
            w.writerow(
                [
                    r["order_no"], created, r.get("order_type", ""),
                    r["table_number"], r.get("zone") or "", r.get("customer_name") or "",
                    r["status"], r["payment_status"], "", "", "", "", "",
                    f'{float(r["subtotal"]):.2f}', f'{float(r["tax"]):.2f}',
                    f'{float(r["total"]):.2f}', r["currency"] or "",
                ]
            )
            continue
        for it in items:
            w.writerow(
                [
                    r["order_no"], created, r.get("order_type", ""),
                    r["table_number"], r.get("zone") or "", r.get("customer_name") or "",
                    r["status"], r["payment_status"],
                    it.get("name", ""), it.get("quantity", ""),
                    it.get("price", ""), it.get("line_total", ""),
                    it.get("instructions", ""),
                    f'{float(r["subtotal"]):.2f}', f'{float(r["tax"]):.2f}',
                    f'{float(r["total"]):.2f}', r["currency"] or "",
                ]
            )

    buf.seek(0)
    fname = f"orders-{restaurant}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ---- Receipt header profile ---------------------------------------------

@router.get("/receipt-profile", response_model=ReceiptProfile)
async def get_receipt_profile(
    restaurant: str = "demo",
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Return the outlet's printed-receipt header fields (shared across
    devices). Missing fields come back as empty strings."""
    rest = await _resolve_restaurant(db, restaurant, _principal)
    profile = await repo.get_receipt_profile(db, rest["id"])
    return ReceiptProfile(**{**ReceiptProfile().model_dump(), **profile})


@router.post("/receipt-profile", response_model=ReceiptProfile)
async def save_receipt_profile(
    body: ReceiptProfileUpdate,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Persist the receipt header fields for an outlet."""
    rest = await _resolve_restaurant(db, body.restaurant, _principal)
    profile = body.model_dump(exclude={"restaurant"})
    saved = await repo.set_receipt_profile(db, rest["id"], profile)
    return ReceiptProfile(**{**ReceiptProfile().model_dump(), **saved})


# ---- Security monitoring -------------------------------------------------

# Raise the alert flag when replay attempts in the window exceed this.
_REPLAY_ALERT_THRESHOLD = 3


@router.get("/security", response_model=SecurityStatus)
async def manager_security(
    restaurant: str = "demo",
    within_minutes: int = 60,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Recent security events + a poll-able anomaly signal for this outlet.

    Staff dashboards poll this to surface replay attempts (a session token used
    from a different device/UA than it was bound to) and alert when activity
    spikes past a threshold.
    """
    rest = await _resolve_restaurant(db, restaurant, _principal)
    recent = await security.count_recent_replays(
        db, rest["id"], within_minutes=within_minutes
    )
    events = await security.list_security_events(db, rest["id"], limit=limit)
    return SecurityStatus(
        recent_replay_attempts=recent,
        window_minutes=within_minutes,
        alert=recent >= _REPLAY_ALERT_THRESHOLD,
        events=[
            SecurityEvent(
                id=e["id"],
                event_type=e["event_type"],
                session_id=e.get("session_id"),
                table_number=e.get("table_number"),
                detail=e.get("detail") or {},
                client_ip=e.get("client_ip"),
                created_at=_iso(e["created_at"]),
            )
            for e in events
        ],
    )


# ---- Table -> zone management -------------------------------------------

@router.get("/tables", response_model=List[TableZone])
async def manager_tables(
    restaurant: str = "demo",
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    rest = await _resolve_restaurant(db, restaurant, _principal)
    rows = await repo.list_tables(db, rest["id"])
    return [
        TableZone(id=r["id"], table_number=r["table_number"], zone=r["zone"])
        for r in rows
    ]


@router.post("/tables", response_model=TableZone)
async def manager_upsert_table(
    body: TableUpsertRequest,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    rest = await _resolve_restaurant(db, body.restaurant, _principal)
    row = await repo.upsert_table(
        db, rest["id"], body.table_number.strip(), body.zone.strip()
    )
    return TableZone(
        id=row["id"], table_number=row["table_number"], zone=row["zone"]
    )


# ---- Dish availability ---------------------------------------------------

@router.patch("/menu/{item_id}")
async def manager_set_availability(
    item_id: int,
    body: MenuAvailabilityUpdate,
    restaurant: str = "demo",
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Live-toggle a dish's sold-out state without re-uploading the menu."""
    rest = await _resolve_restaurant(db, restaurant, _principal)
    updated = await repo.set_menu_item_available(
        db, rest["id"], item_id, body.available
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Menu item not found.")
    return {
        "id": updated["id"],
        "name": updated["name"],
        "available": bool(updated["available"]),
    }
