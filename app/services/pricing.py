"""Server-authoritative cart re-pricing.

The client UI sends a cart with names, quantities and (untrusted) prices. We
never bill based on client prices — we look up each item's canonical price
from the stored menu. Items not found in the menu are dropped (they can't be
priced reliably), and quantities are clamped to a sane range.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

MAX_QTY_PER_ITEM = 99


def reprice_cart(
    cart: List[Dict[str, Any]], price_lookup: Dict[str, Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Return (clean_cart, dropped_names).

    clean_cart uses canonical names + DB prices; dropped_names lists items that
    weren't found in the menu (ignored). If the menu is empty we fall back to
    the client cart's prices so the demo still works before a menu is loaded.
    """
    if not price_lookup:
        # No menu loaded — can't authoritatively price. Keep client values but
        # still clamp quantity.
        safe = []
        for item in cart:
            qty = _clamp_qty(item.get("quantity"))
            safe.append(
                {
                    "name": str(item.get("name", "Item")),
                    "price": float(item.get("price") or 0),
                    "quantity": qty,
                }
            )
        return safe, []

    clean: List[Dict[str, Any]] = []
    dropped: List[str] = []
    for item in cart:
        name = str(item.get("name", "")).strip()
        canonical = price_lookup.get(name.lower())
        if not canonical:
            dropped.append(name or "(unnamed)")
            continue
        clean.append(
            {
                "name": canonical["name"],
                "price": canonical["price"],
                "quantity": _clamp_qty(item.get("quantity")),
            }
        )
    return clean, dropped


def _clamp_qty(q: Any) -> int:
    try:
        q = int(q)
    except (TypeError, ValueError):
        q = 1
    return max(1, min(MAX_QTY_PER_ITEM, q))
