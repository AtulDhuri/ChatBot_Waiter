"""Restaurant-selected order/payment modes.

The mode is resolved from the restaurant, never chosen by the customer. This
small module keeps postpaid policy separate from the existing prepaid flow.
"""

PREPAID = "prepaid"
POSTPAID = "postpaid"


def normalize_mode(value: str | None) -> str:
    return POSTPAID if str(value or "").strip().lower() == POSTPAID else PREPAID


def is_postpaid(value: str | None) -> bool:
    return normalize_mode(value) == POSTPAID
