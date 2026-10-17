"""/menu — return the structured menu (items grouped by category)."""
from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.routes.deps import get_db
from app.schemas import MenuItem, MenuResponse

router = APIRouter(prefix="/menu", tags=["menu"])


@router.get("", response_model=MenuResponse)
async def get_menu(restaurant: str = "demo", db: AsyncSession = Depends(get_db)):
    rest = await repo.get_restaurant_by_slug(db, restaurant)
    if rest is None:
        raise HTTPException(status_code=404, detail="No menu loaded for this restaurant.")

    rows = await repo.get_menu_items(db, rest["id"])
    items = [
        MenuItem(
            id=r["id"],
            name=r["name"],
            description=r["description"],
            category=r["category"],
            price=float(r["price"]) if r["price"] is not None else None,
            currency=r["currency"] or "$",
        )
        for r in rows
    ]

    categories = defaultdict(list)
    for item in items:
        categories[item.category or "General"].append(item)

    return MenuResponse(
        restaurant=restaurant, categories=dict(categories), items=items
    )
