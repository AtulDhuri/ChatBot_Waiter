"""Ingestion pipeline: PDF -> text -> chunks -> embeddings -> pgvector + menu.

Also supports structured JSON ingestion (see ``ingest_menu_json``), which skips
PDF parsing and the regex extractor entirely: the caller supplies clean item
rows, so menu_items are stored verbatim and one RAG sentence per dish is
embedded for the chatbot.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import repository as repo
from app.services import llm
from app.services.menu_extractor import extract_menu_items
from app.services.parser import chunk_text, parse_pdf_to_markdown

logger = logging.getLogger(__name__)


def _fmt_num(value: Any) -> str:
    """Render a number without a trailing '.0' (391.0 -> '391', 385.57 kept)."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _item_to_sentence(item: Dict[str, Any], currency: str) -> str:
    """Render one structured item as a readable RAG sentence.

    Format: ``Category: Name – Description (W gms | C kcal) – <cur>Price``
    Missing fields are omitted gracefully so partial rows still read cleanly.
    """
    name = (item.get("name") or "").strip()
    parts: List[str] = []
    category = (item.get("category") or "").strip()
    if category:
        parts.append(f"{category}:")
    parts.append(name)

    desc = (item.get("description") or "").strip()
    sentence = " ".join(parts)
    if desc:
        sentence += f" – {desc}"

    weight = item.get("weight_gms")
    calories = item.get("calories_kcal")
    nutrition = []
    if weight is not None:
        nutrition.append(f"{_fmt_num(weight)} gms")
    if calories is not None:
        nutrition.append(f"{_fmt_num(calories)} kcal")
    if nutrition:
        sentence += f" ({' | '.join(nutrition)})"

    price = item.get("price_inr", item.get("price"))
    if price is not None:
        sentence += f" – {currency}{_fmt_num(price)}"
    return sentence


async def ingest_menu_json(
    session: AsyncSession,
    menu: List[Dict[str, Any]],
    restaurant_slug: str,
    restaurant_name: str,
    source_name: str = "menu.json",
    currency: str | None = None,
    update_name: bool = True,
    tables: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    """Ingest a structured menu (list of item dicts) into DB + RAG store.

    Each item may carry: category, name, description, weight_gms,
    calories_kcal, price_inr (or price), an optional ``zone_prices`` map
    ({zone: price}) and an ``available`` flag. This bypasses PDF parsing and
    the heuristic extractor, so data lands exactly as supplied. One embedded
    RAG sentence per dish keeps the chatbot functional.

    ``tables`` is an optional list of {table_number, zone} mappings replacing
    the restaurant's table->zone map.

    Idempotent per slug: existing documents, menu items and (if provided)
    table mappings are replaced.
    """
    cur = currency or settings.currency
    restaurant_id = await repo.get_or_create_restaurant(
        session, restaurant_slug, restaurant_name, update_name=update_name
    )

    # Keep only rows with a usable name.
    clean = [it for it in menu if (it.get("name") or "").strip()]
    if not clean:
        return {
            "restaurant_id": restaurant_id,
            "chunks": 0,
            "menu_items": 0,
            "error": "No valid menu items found in the JSON.",
        }

    # Build RAG sentences and embed them (resilient: degrades on API failure).
    sentences = [_item_to_sentence(it, cur) for it in clean]
    embeddings = await llm.embed_texts(sentences)
    warning = None
    if llm.embeddings_degraded:
        warning = (
            "Menu saved, but the OpenAI embedding service was unreachable so "
            "offline fallback embeddings were used. Chatbot answer quality "
            "will be reduced until you re-upload with a working connection."
        )
    metadatas = [
        {
            "source": source_name,
            "chunk_index": i,
            "restaurant": restaurant_slug,
            "name": clean[i].get("name"),
            "category": clean[i].get("category"),
        }
        for i in range(len(clean))
    ]

    await repo.clear_documents(session, restaurant_id)
    inserted = await repo.insert_documents(
        session, restaurant_id, sentences, embeddings, metadatas
    )

    # Structured rows for ordering/kitchen/billing. weight/calories aren't
    # columns in menu_items, so they live only in the RAG sentence above.
    menu_items = [
        {
            "name": it.get("name"),
            "description": it.get("description"),
            "category": it.get("category"),
            "price": it.get("price_inr", it.get("price")),
            "currency": cur,
            # Per-zone price overrides {zone: price}; empty = base price only.
            "zone_prices": it.get("zone_prices") or {},
            # Defaults to True unless the item explicitly sets available=False.
            "available": it.get("available"),
        }
        for it in clean
    ]
    await repo.clear_menu_items(session, restaurant_id)
    await repo.insert_menu_items(session, restaurant_id, menu_items)

    # Optional table -> zone map shipped alongside the menu. Replacing the map
    # keeps re-uploads idempotent, matching how menu_items are replaced.
    if tables:
        await repo.replace_tables(session, restaurant_id, tables)

    logger.info(
        "Ingested JSON %s: %d chunks, %d menu items",
        restaurant_slug,
        inserted,
        len(menu_items),
    )
    return {
        "restaurant_id": restaurant_id,
        "chunks": inserted,
        "menu_items": len(menu_items),
        "error": warning,
    }


async def ingest_pdf(
    session: AsyncSession,
    pdf_path: str,
    restaurant_slug: str,
    restaurant_name: str,
    source_name: str,
    update_name: bool = True,
) -> Dict[str, Any]:
    """Parse a PDF menu and store chunks, embeddings and menu items.

    Replaces any existing data for the restaurant so re-uploading a menu is
    idempotent — this is how a restaurant updates prices: edit the PDF and
    re-upload under the same slug. The display name is refreshed too.
    """
    restaurant_id = await repo.get_or_create_restaurant(
        session, restaurant_slug, restaurant_name, update_name=update_name
    )

    text = parse_pdf_to_markdown(pdf_path)
    if not text.strip():
        return {
            "restaurant_id": restaurant_id,
            "chunks": 0,
            "menu_items": 0,
            "error": "Could not extract any text from the PDF.",
        }

    chunks = chunk_text(
        text, chunk_size=settings.chunk_size, overlap=settings.chunk_overlap
    )
    embeddings = await llm.embed_texts(chunks)
    warning = None
    if llm.embeddings_degraded:
        warning = (
            "Menu saved, but the OpenAI embedding service was unreachable so "
            "offline fallback embeddings were used. Semantic search quality "
            "will be reduced until you re-upload with a working connection."
        )
    metadatas = [
        {"source": source_name, "chunk_index": i, "restaurant": restaurant_slug}
        for i in range(len(chunks))
    ]

    # Refresh stored data.
    await repo.clear_documents(session, restaurant_id)
    inserted = await repo.insert_documents(
        session, restaurant_id, chunks, embeddings, metadatas
    )

    menu_items = extract_menu_items(text)
    await repo.clear_menu_items(session, restaurant_id)
    await repo.insert_menu_items(session, restaurant_id, menu_items)

    logger.info(
        "Ingested %s: %d chunks, %d menu items", restaurant_slug, inserted, len(menu_items)
    )
    return {
        "restaurant_id": restaurant_id,
        "chunks": inserted,
        "menu_items": len(menu_items),
        "error": warning,
    }
