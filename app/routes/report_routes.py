"""Sales reports per outlet: JSON summary and CSV export."""
from __future__ import annotations

import csv
import io
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.routes.deps import get_db, require_staff, tenant_matches
from app.schemas import ReportResponse

router = APIRouter(prefix="/reports", tags=["reports"])


async def _gather(db, restaurant, date_from, date_to, principal):
    rest = await repo.get_restaurant_by_slug(db, restaurant)
    if rest is None:
        raise HTTPException(status_code=404, detail="Unknown restaurant.")
    if not tenant_matches(principal, rest["id"]):
        raise HTTPException(status_code=403, detail="Outlet is outside your tenant.")
    data = await repo.sales_report(db, rest["id"], date_from, date_to)
    return rest, data


@router.get("", response_model=ReportResponse)
async def report(
    restaurant: str = "demo",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    _, data = await _gather(db, restaurant, date_from, date_to, _principal)
    return ReportResponse(
        restaurant=restaurant,
        date_from=date_from,
        date_to=date_to,
        currency=settings.currency,
        **data,
    )


@router.get("/csv")
async def report_csv(
    restaurant: str = "demo",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    _, data = await _gather(db, restaurant, date_from, date_to, _principal)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Report", restaurant])
    w.writerow(["From", date_from or "", "To", date_to or ""])
    w.writerow([])
    w.writerow(["Orders", data["order_count"]])
    w.writerow(["Subtotal", f"{data['subtotal']:.2f}"])
    w.writerow(["Tax", f"{data['tax']:.2f}"])
    w.writerow(["Total", f"{data['total']:.2f}"])
    w.writerow([])
    w.writerow(["Top items", "Qty", "Revenue"])
    for it in data["top_items"]:
        w.writerow([it["name"], it["quantity"], f"{it['revenue']:.2f}"])

    buf.seek(0)
    fname = f"sales-{restaurant}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/dashboard")
async def analytics_dashboard(
    restaurant: str = "demo",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """Merchant analytics payload for the DineOS dashboard."""
    if restaurant == "all":
        raise HTTPException(
            status_code=403,
            detail="Merchant analytics must be scoped to one outlet.",
        )
    rest = await repo.get_restaurant_by_slug(db, restaurant)
    if rest is None:
        raise HTTPException(status_code=404, detail="Unknown restaurant.")
    if not tenant_matches(_principal, rest["id"]):
        raise HTTPException(status_code=403, detail="Outlet is outside your tenant.")
    return await repo.analytics_dashboard(db, restaurant, date_from, date_to)


@router.get("/outlets")
async def report_outlets(
    db: AsyncSession = Depends(get_db),
    _principal: Dict[str, Any] = Depends(require_staff),
):
    """List outlets available to the staff dashboard."""
    outlet = await repo.get_restaurant_by_id(db, _principal["outletId"])
    return {"outlets": ([{"slug": outlet["slug"], "name": outlet["name"]}] if outlet else [])}
