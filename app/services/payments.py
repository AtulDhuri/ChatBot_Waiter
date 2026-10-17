"""UPI display-payment helpers.

Builds a standard UPI deep-link ("upi://pay?...") that any UPI app
(GPay, PhonePe, Paytm, BHIM, bank apps) can parse when encoded as a QR.
This is a *display* payment: the guest pays and the restaurant confirms
receipt in their own UPI app. No gateway, no secrets, no webhooks.

Spec reference: NPCI UPI deep-linking / QR (pa, pn, am, cu, tn parameters).
"""
from __future__ import annotations

from urllib.parse import quote
from typing import Optional


def build_upi_uri(
    payee_vpa: str,
    payee_name: str,
    amount: float,
    note: Optional[str] = None,
    currency: str = "INR",
) -> str:
    """Return a UPI deep-link string for the given payee and amount.

    - pa: payee address (VPA, e.g. name@bank)
    - pn: payee name
    - am: amount (two decimals)
    - cu: currency (UPI only supports INR today)
    - tn: transaction note (e.g. "Table 12 - Seaside Grill")
    """
    params = [
        ("pa", payee_vpa),
        ("pn", payee_name),
        ("am", f"{amount:.2f}"),
        ("cu", currency),
    ]
    if note:
        params.append(("tn", note))
    query = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params)
    return f"upi://pay?{query}"


def is_valid_vpa(vpa: Optional[str]) -> bool:
    """Loose validation: a UPI VPA looks like 'handle@provider'."""
    if not vpa or "@" not in vpa:
        return False
    local, _, provider = vpa.partition("@")
    return bool(local) and bool(provider)
