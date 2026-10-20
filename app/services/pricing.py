"""Server-authoritative cart re-pricing.

The client UI sends a cart with names, quantities and (untrusted) prices. We
never bill based on client prices — we look up each item's canonical price
from the stored menu. Items not found in the menu are dropped (they can't be
priced reliably), and quantities are clamped to a sane range.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

MAX_QTY_PER_ITEM = 99


def resolve_zone_price(canonical: Dict[str, Any], zone: Optional[str]) -> float:
    """Pick the price for a dish in a given zone.

    Returns the explicit ``zone_prices[zone]`` when present, otherwise the
    base ``price``. Passing ``zone=None`` (unregistered table) always yields
    the base price — identical to the pre-zone behaviour.
    """
    base = float(canonical.get("price") or 0)
    if not zone:
        return base
    zone_prices = canonical.get("zone_prices") or {}
    override = zone_prices.get(zone)
    return float(override) if override is not None else base


def reprice_cart(
    cart: List[Dict[str, Any]],
    price_lookup: Dict[str, Dict[str, Any]],
    zone: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Return (clean_cart, dropped_names).

    clean_cart uses canonical names + DB prices (zone-aware). dropped_names
    lists items that weren't found in the menu OR are currently unavailable
    (sold out) — both are ignored so a guest can never order them. If the menu
    is empty we fall back to the client cart's prices so the demo still works
    before a menu is loaded.

    ``instructions`` free-text carried from the client is preserved verbatim
    on each clean line. ``zone`` selects a per-zone price; None = base price.
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
                    "instructions": _clean_instructions(item.get("instructions")),
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
        # Sold-out items can't be ordered. Treat like an unknown item: drop it.
        if canonical.get("available") is False:
            dropped.append(canonical.get("name") or name)
            continue
        clean.append(
            {
                "name": canonical["name"],
                "price": resolve_zone_price(canonical, zone),
                "quantity": _clamp_qty(item.get("quantity")),
                "instructions": _clean_instructions(item.get("instructions")),
            }
        )
    return clean, dropped


# Keep notes short and plain; this is stored and shown to kitchen/manager.
MAX_INSTRUCTION_LEN = 200


def _clean_instructions(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()[:MAX_INSTRUCTION_LEN]


def _clamp_qty(q: Any) -> int:
    try:
        q = int(q)
    except (TypeError, ValueError):
        q = 1
    return max(1, min(MAX_QTY_PER_ITEM, q))
