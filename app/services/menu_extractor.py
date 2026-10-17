"""Extract structured menu items (name, category, price) from menu text.

Uses a regex heuristic that handles the most common menu layouts:
    - Category headers (markdown '#', ALL CAPS, or lines ending with ':')
    - Item lines like 'Margherita Pizza .... 12.50' or 'Caesar Salad - $9'
If an LLM key is available, callers may swap this for an LLM extractor, but
the heuristic keeps the system functional with zero external dependencies.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

from app.config import settings

# Matches a trailing price such as "12", "12.50", "$12.50", "12,50".
_PRICE_RE = re.compile(r"(?:[$€£])?\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*$")
# A line that is likely a category header.
_HEADER_RE = re.compile(r"^\s*#{1,6}\s*(.+?)\s*$")


def extract_menu_items(text: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    category = "General"

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        # Markdown header -> category.
        m = _HEADER_RE.match(line)
        if m:
            category = _clean(m.group(1))
            continue

        # ALL CAPS short line -> category.
        letters = re.sub(r"[^A-Za-z]", "", line)
        if letters and line.upper() == line and len(line) <= 40 and not _PRICE_RE.search(line):
            category = _clean(line)
            continue

        # Line ending with ':' and no price -> category.
        if line.endswith(":") and not _PRICE_RE.search(line):
            category = _clean(line.rstrip(":"))
            continue

        price_match = _PRICE_RE.search(line)
        if not price_match:
            continue

        price = float(price_match.group(1).replace(",", "."))
        # Everything before the price is the name (+ optional description).
        name_part = line[: price_match.start()].strip(" .-–—\t")
        name_part = re.sub(r"\.{2,}", " ", name_part).strip()
        if not name_part:
            continue

        name, _, description = name_part.partition(" - ")
        items.append(
            {
                "name": _clean(name),
                "description": _clean(description) or None,
                "category": category,
                "price": round(price, 2),
                "currency": settings.currency,
            }
        )

    return _dedupe(items)


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _dedupe(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for it in items:
        key = (it["name"].lower(), it["price"])
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out
