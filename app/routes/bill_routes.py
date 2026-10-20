"""/bill — compute totals from the cart and return JSON, HTML or PDF invoice."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import repository as repo
from app.routes.deps import get_db, resolve_cart, resolve_session
from app.schemas import BillRequest, BillResponse
from app.services import billing

router = APIRouter(prefix="/bill", tags=["bill"])


@router.post("")
async def bill(
    body: BillRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    row = await resolve_session(body.session_id, db, request)

    # Re-price against the stored menu; never trust client prices.
    cart, dropped = await resolve_cart(db, row, body.cart)
    if body.cart is not None:
        await repo.update_cart(db, _session_id(body.session_id), cart)

    if not cart:
        raise HTTPException(status_code=400, detail="Cart is empty.")

    computed = billing.calculate_bill(cart)
    table_number = row["table_number"]

    if body.format == "json":
        return BillResponse(
            table_number=table_number,
            zone=row.get("zone"),
            dropped=dropped,
            **computed,
        )

    html = billing.render_invoice_html(computed, table_number)
    if body.format == "html":
        return HTMLResponse(content=html)

    # format == "pdf"
    pdf = billing.render_invoice_pdf(html)
    if pdf is None:
        # Fall back to HTML if the PDF engine is unavailable.
        return HTMLResponse(
            content=html,
            headers={"X-PDF-Fallback": "weasyprint-unavailable"},
        )
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="invoice-table-{table_number}.pdf"'
        },
    )


def _session_id(token: str) -> str:
    # token is 'id.signature'; strip the signature for the DB key.
    return token.rpartition(".")[0]
