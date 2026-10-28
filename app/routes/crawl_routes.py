"""/crawl — upload and ingest a restaurant PDF or JSON menu."""
from __future__ import annotations

import os
import re
import tempfile

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.routes.deps import get_db, require_staff
from app.schemas import CrawlResponse, MenuJsonIn
from app.services.ingest import ingest_menu_json, ingest_pdf

router = APIRouter(prefix="/crawl", tags=["crawl"])


def _slugify(value: str) -> str:
    """Turn a free-form restaurant string into a safe slug.

    'Shamiana Mumbai Colaba' -> 'shamiana-mumbai-colaba'. Already-slug values
    pass through unchanged. Falls back to 'demo' if nothing usable remains.
    """
    s = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return s or "demo"


@router.post("", response_model=CrawlResponse)
async def crawl(
    file: UploadFile = File(...),
    restaurant: str = Form(default="demo"),
    name: str = Form(default=""),
    upi_vpa: str = Form(default=""),
    upi_name: str = Form(default=""),
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Parse an uploaded PDF menu into chunks, embeddings and menu items.

    - ``restaurant`` is the unique slug (tenant identity, what the QR encodes).
    - ``name`` is the human display name and may be shared by multiple outlets;
      if omitted it is derived from the slug.
    Re-uploading under the same slug replaces the menu (price updates) and
    refreshes the display name. Optionally stores the tenant's UPI payee.
    """
    # Normalize the slug the same way the JSON route does so a given typed
    # value always maps to one tenant (e.g. 'demo_dombivl' and 'demo-dombivl'
    # collapse to the same 'demo-dombivl'), preventing duplicate restaurants.
    slug = _slugify(restaurant)
    display_name = name.strip() or slug.replace("-", " ").title()
    suffix = os.path.splitext(file.filename or "menu.pdf")[1] or ".pdf"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        result = await ingest_pdf(
            db,
            pdf_path=tmp_path,
            restaurant_slug=slug,
            restaurant_name=display_name,
            source_name=file.filename or "menu.pdf",
        )

        # Persist UPI payee details for this tenant when provided.
        if upi_vpa.strip():
            await repo.set_restaurant_upi(
                db, slug, upi_vpa.strip(), upi_name.strip()
            )

        return CrawlResponse(
            restaurant=slug,
            chunks=result["chunks"],
            menu_items=result["menu_items"],
            error=result["error"],
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


@router.post("/json", response_model=CrawlResponse)
async def crawl_json(
    body: MenuJsonIn,
    db: AsyncSession = Depends(get_db),
    _: None = Depends(require_staff),
):
    """Ingest a structured JSON menu directly — no PDF, no regex extractor.

    Accepts two interchangeable shapes:

    Flat::

        {"menu": [{"category": "...", "name": "...", "description": "...",
                   "weight_gms": 391, "calories_kcal": 385.57,
                   "price_inr": 1200}],
         "restaurant": "demo", "name": "Display Name", "currency": "₹"}

    Nested (category groups its items)::

        {"categories": [{"name": "All Day Breakfast",
                          "items": [{"name": "...", "price": 1200}]}],
         "restaurant": "Shamiana Mumbai Colaba"}

    Per item, price accepts ``price_inr`` or ``price``; weight accepts
    ``weight_gms`` or ``weight``; energy accepts ``calories_kcal`` or
    ``calories``. Extra keys (e.g. ``variants``) are ignored.

    ``restaurant`` may be a slug or a human name — it is slugified for the
    tenant key, and used as the display name when ``name`` is omitted.

    Stores structured rows in ``menu_items`` (ordering/kitchen/billing) and one
    embedded RAG sentence per dish in ``documents`` (chatbot). Re-uploading
    under the same slug replaces the menu. ``weight``/``calories`` are
    preserved in the RAG sentence (menu_items has no columns for them).
    """
    # 'restaurant' may be a slug or a human name; normalize to a slug. The
    # display name prefers an explicit 'name', else the original 'restaurant'
    # string, else a title-cased slug.
    slug = _slugify(body.restaurant)
    display_name = (
        body.name.strip()
        or (body.restaurant.strip() if body.restaurant.strip() else "")
        or slug.replace("-", " ").title()
    )
    items = [it.model_dump() for it in body.menu]
    tables = [t.model_dump() for t in body.tables]

    result = await ingest_menu_json(
        db,
        menu=items,
        restaurant_slug=slug,
        restaurant_name=display_name,
        source_name="menu.json",
        currency=body.currency,
        tables=tables,
    )

    # Always overwrite UPI and payment_mode on every submit so a full
    # re-upload is a true replacement — clearing UPI or changing mode works.
    await repo.set_restaurant_upi(db, slug, body.upi_vpa.strip(), body.upi_name.strip())
    await repo.set_restaurant_payment_mode(db, slug, body.payment_mode)

    return CrawlResponse(
        restaurant=slug,
        chunks=result["chunks"],
        menu_items=result["menu_items"],
        error=result["error"],
    )
