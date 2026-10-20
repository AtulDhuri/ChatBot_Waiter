"""Bill calculation and invoice rendering (HTML, optional PDF)."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)

TAX_RATE = 0.08  # 8% default; adjust per jurisdiction.


def calculate_bill(cart: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute line totals, subtotal, tax and grand total from a cart.

    Each cart item is expected to have ``name``, ``price`` and ``quantity``.
    """
    line_items: List[Dict[str, Any]] = []
    subtotal = 0.0
    for item in cart:
        price = float(item.get("price") or 0)
        qty = int(item.get("quantity") or 1)
        line_total = round(price * qty, 2)
        subtotal += line_total
        line_items.append(
            {
                "name": item.get("name", "Item"),
                "price": round(price, 2),
                "quantity": qty,
                "line_total": line_total,
                # Free-text customer note (empty string when none). Stored in
                # the order's items JSONB and shown to kitchen/manager.
                "instructions": (item.get("instructions") or ""),
            }
        )

    subtotal = round(subtotal, 2)
    tax = round(subtotal * TAX_RATE, 2)
    total = round(subtotal + tax, 2)
    return {
        "line_items": line_items,
        "subtotal": subtotal,
        "tax_rate": TAX_RATE,
        "tax": tax,
        "total": total,
        "currency": settings.currency,
    }


def render_invoice_html(
    bill: Dict[str, Any], table_number: str, restaurant_name: Optional[str] = None
) -> str:
    restaurant_name = restaurant_name or settings.restaurant_name
    cur = bill["currency"]
    rows = "\n".join(
        f"<tr><td>{li['name']}</td><td class='num'>{li['quantity']}</td>"
        f"<td class='num'>{cur}{li['price']:.2f}</td>"
        f"<td class='num'>{cur}{li['line_total']:.2f}</td></tr>"
        for li in bill["line_items"]
    )
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice</title>
<style>
  body {{ font-family: Arial, Helvetica, sans-serif; color:#222; margin:24px; }}
  h1 {{ font-size:20px; margin:0 0 4px; }}
  .meta {{ color:#666; font-size:13px; margin-bottom:16px; }}
  table {{ width:100%; border-collapse:collapse; font-size:14px; }}
  th, td {{ padding:8px 6px; border-bottom:1px solid #eee; text-align:left; }}
  th.num, td.num {{ text-align:right; }}
  tfoot td {{ border:none; font-weight:bold; }}
  .total {{ font-size:16px; }}
</style></head>
<body>
  <h1>{restaurant_name}</h1>
  <div class="meta">Table {table_number} &middot; {now}</div>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th>
      <th class="num">Price</th><th class="num">Total</th></tr></thead>
    <tbody>{rows}</tbody>
    <tfoot>
      <tr><td colspan="3" class="num">Subtotal</td>
        <td class="num">{cur}{bill['subtotal']:.2f}</td></tr>
      <tr><td colspan="3" class="num">Tax ({bill['tax_rate']*100:.0f}%)</td>
        <td class="num">{cur}{bill['tax']:.2f}</td></tr>
      <tr class="total"><td colspan="3" class="num">Total</td>
        <td class="num">{cur}{bill['total']:.2f}</td></tr>
    </tfoot>
  </table>
  <p class="meta">Thank you for dining with us!</p>
</body></html>"""


def render_invoice_pdf(html: str) -> Optional[bytes]:
    """Render invoice HTML to PDF bytes. Returns None if WeasyPrint missing."""
    try:
        from weasyprint import HTML

        return HTML(string=html).write_pdf()
    except Exception as exc:  # pragma: no cover - optional dep / system libs
        logger.warning("PDF rendering unavailable (%s).", exc)
        return None
