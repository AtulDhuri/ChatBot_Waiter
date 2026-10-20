"""Pydantic request/response models shared across routes."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import AliasChoices, BaseModel, Field, model_validator


# ---- Sessions ------------------------------------------------------------

class SessionCreate(BaseModel):
    order_type: str = Field(default="dine_in", pattern="^(dine_in|takeaway)$")
    # Table number for dine-in (short). Optional for takeaway.
    table_number: str = Field(default="", max_length=32)
    # Customer name for takeaway (longer human names allowed).
    customer_name: str = Field(default="", max_length=80)
    restaurant: str = Field(default="demo", max_length=64)


class SessionInfo(BaseModel):
    session_id: str
    table_number: str
    customer_name: str = ""
    order_type: str = "dine_in"
    # Tenant slug (backend identity). Optional and only populated on the
    # slug-based create path, where the caller already supplied the slug. The
    # token-resolution path (GET /session/{token}) leaves this empty so the
    # slug never leaks to a customer who only holds an opaque QR token.
    restaurant: Optional[str] = None
    restaurant_name: str = ""  # display name (may repeat across outlets)
    zone: Optional[str] = None  # pricing zone resolved from the table
    cart: List["CartItem"] = []


# ---- QR tokens -----------------------------------------------------------

class QrResolveRequest(BaseModel):
    """Trade an opaque QR token (?r=...) for a session. The token is the only
    tenant reference the customer ever holds."""
    token: str = Field(..., min_length=1, max_length=128)
    # Stable per-browser id (localStorage). Lets us continue this device's cart
    # on a rescan instead of starting over.
    device_id: str = Field(default="", max_length=128)


class QrSession(BaseModel):
    """Customer-safe session payload. Deliberately omits slug / tenant_id and
    any backend identifier — only what a guest may see."""
    session_id: str
    table_number: str
    restaurant_name: str = ""  # display name only
    order_type: str = "dine_in"
    zone: Optional[str] = None  # pricing zone label (customer-safe, affects price)
    cart: List["CartItem"] = []
    # True when we continued an existing device session (kept the cart) vs.
    # started a fresh one. Purely informational for the widget.
    continued: bool = False


class QrTokenRequest(BaseModel):
    """Staff-only: mint (or fetch) the durable token for a table."""
    restaurant: str = Field(..., max_length=64)
    table_number: str = Field(..., max_length=32)


class QrTokenResponse(BaseModel):
    token: str
    table_number: str


# ---- Cart / Menu ---------------------------------------------------------

class CartItem(BaseModel):
    name: str
    price: float = 0.0
    quantity: int = Field(default=1, ge=1)
    # Optional free-text customer note (e.g. "no onions"). Kept as plain text
    # today; the field can later hold a structured value without a migration.
    instructions: str = Field(default="", max_length=200)


class MenuItem(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    category: Optional[str] = None
    price: Optional[float] = None
    currency: str = "$"
    available: bool = True
    zone_prices: Dict[str, float] = Field(default_factory=dict)


class MenuResponse(BaseModel):
    restaurant: str  # slug (tenant identity)
    restaurant_name: str = ""  # display name, e.g. "Demo 2"
    categories: Dict[str, List[MenuItem]]
    items: List[MenuItem]


# ---- Ask -----------------------------------------------------------------

class AskRequest(BaseModel):
    session_id: str
    question: str = Field(..., min_length=1, max_length=1000)


class AskResponse(BaseModel):
    answer: str
    sources: List[Dict[str, Any]] = []


# ---- Natural-language order parsing --------------------------------------

class OrderParseRequest(BaseModel):
    session_id: str
    text: str = Field(..., min_length=1, max_length=500)


class OrderParseResponse(BaseModel):
    # Resolved cart lines with authoritative DB prices (never from the model).
    items: List[CartItem] = []
    # True when the parser understood at least one orderable item.
    understood: bool = False
    # True when the LLM fallback was available/used; lets the client show a
    # sensible message when parsing is unavailable (e.g. offline demo mode).
    llm_used: bool = False


# ---- Bill ----------------------------------------------------------------

class BillRequest(BaseModel):
    session_id: str
    # Optional cart override; if omitted the server-side session cart is used.
    cart: Optional[List[CartItem]] = None
    format: str = Field(default="json", pattern="^(json|html|pdf)$")


class BillResponse(BaseModel):
    table_number: str
    zone: Optional[str] = None
    line_items: List[Dict[str, Any]]
    subtotal: float
    tax_rate: float
    tax: float
    total: float
    currency: str
    # Names of cart items the server refused to bill (unknown or sold out).
    # The client uses this to reconcile its local cart and inform the guest.
    dropped: List[str] = []


# ---- Payment -------------------------------------------------------------

class PayRequest(BaseModel):
    session_id: str
    cart: Optional[List[CartItem]] = None


class PayResponse(BaseModel):
    table_number: str
    # NOTE: the tenant slug is intentionally NOT returned here. This response
    # goes to the customer's browser; exposing the slug would leak backend
    # tenant identity. Routing is done server-side from the session.
    payee_name: str
    amount: float
    currency: str
    upi_uri: str
    configured: bool  # False when the tenant has no VPA set yet
    # Names of cart items the server refused to bill (unknown or sold out),
    # so the client can reconcile its local cart and tell the guest.
    dropped: List[str] = []


class UpiUpdate(BaseModel):
    restaurant: str = Field(default="demo", max_length=64)
    upi_vpa: str = Field(..., max_length=128)
    upi_name: str = Field(default="", max_length=128)


class UpiInfo(BaseModel):
    restaurant: str
    upi_vpa: Optional[str] = None
    upi_name: Optional[str] = None
    configured: bool


# ---- Orders --------------------------------------------------------------

class OrderCreate(BaseModel):
    session_id: str
    cart: Optional[List[CartItem]] = None
    order_type: str = Field(default="dine_in", pattern="^(dine_in|takeaway)$")
    # In the current demo, the client asserts payment. Later this is replaced
    # by a gateway webhook. "paid_unverified" means paid but not yet confirmed.
    payment_status: str = Field(
        default="paid_unverified",
        pattern="^(paid_unverified|verified|unpaid)$",
    )


class OrderItem(BaseModel):
    name: str
    price: float
    quantity: int
    line_total: float
    instructions: str = ""


class Order(BaseModel):
    id: int
    order_no: str
    order_type: str = "dine_in"
    table_number: str
    customer_name: Optional[str] = None
    zone: Optional[str] = None
    items: List[Dict[str, Any]]
    subtotal: float
    tax: float
    total: float
    currency: str
    status: str
    payment_status: str
    created_at: Any


class OrderPlaced(BaseModel):
    id: int
    order_no: str
    order_type: str = "dine_in"
    customer_name: Optional[str] = None
    status: str
    payment_status: str
    total: float
    currency: str


class MyOrder(BaseModel):
    """A single order as the customer's own device may see it.

    Deliberately customer-safe: no tenant_id, slug, internal order id, or
    backend identifiers. ``status`` is the customer-facing label
    (Paid / Preparing / Served / Cancelled), derived from the internal
    kitchen status, not the raw internal value.
    """
    order_no: str
    order_type: str = "dine_in"
    status: str  # Paid | Preparing | Served | Cancelled
    items: List[Dict[str, Any]]
    total: float
    currency: str
    created_at: Any


class MyOrdersResponse(BaseModel):
    """The customer's view of their current session's orders."""
    orders: List[MyOrder] = []
    # True once every order in the session is served/cancelled and the session
    # has been ended — the widget uses this to stop polling and show a "thanks,
    # session closed" state so a new guest never inherits these orders.
    session_ended: bool = False


class CloseTableRequest(BaseModel):
    restaurant: str = Field(default="demo", max_length=64)
    table_number: str = Field(..., min_length=1, max_length=16)


class CloseTableResponse(BaseModel):
    table_number: str
    closed: int


class OrderStatusUpdate(BaseModel):
    status: Optional[str] = Field(
        default=None, pattern="^(new|preparing|ready|served|cancelled)$"
    )
    payment_status: Optional[str] = Field(
        default=None, pattern="^(paid_unverified|verified|unpaid|refunded)$"
    )


# ---- Manager dashboard ---------------------------------------------------

class ManagerOrder(BaseModel):
    id: int
    order_no: str
    order_type: str = "dine_in"
    table_number: str
    customer_name: Optional[str] = None
    zone: Optional[str] = None
    items: List[Dict[str, Any]]
    subtotal: float
    tax: float
    total: float
    currency: str
    status: str
    payment_status: str
    created_at: Any


class ReceiptProfile(BaseModel):
    """Printed-receipt header fields for an outlet. All optional; blanks are
    simply omitted from the printed receipt."""
    name: str = ""
    subtitle: str = ""
    address: str = ""
    fssai: str = ""
    phone: str = ""
    gstin: str = ""
    footer: str = ""


class ReceiptProfileUpdate(ReceiptProfile):
    """Body for saving a receipt profile. Carries the restaurant slug."""
    restaurant: str = Field(default="demo", max_length=64)


class SecurityEvent(BaseModel):
    """A recorded security event (e.g. a replay attempt) for staff review."""
    id: int
    event_type: str
    session_id: Optional[str] = None
    table_number: Optional[str] = None
    detail: Dict[str, Any] = Field(default_factory=dict)
    client_ip: Optional[str] = None
    created_at: Any


class SecurityStatus(BaseModel):
    """Lightweight monitoring signal staff tooling can poll for alerting."""
    recent_replay_attempts: int = 0
    window_minutes: int = 60
    alert: bool = False  # True when recent attempts exceed the threshold
    events: List[SecurityEvent] = []


class TableZone(BaseModel):
    id: int
    table_number: str
    zone: str


class TableUpsertRequest(BaseModel):
    restaurant: str = Field(default="demo", max_length=64)
    table_number: str = Field(..., min_length=1, max_length=32)
    zone: str = Field(..., min_length=1, max_length=40)


class MenuAvailabilityUpdate(BaseModel):
    available: bool


# ---- Reports -------------------------------------------------------------

class ReportResponse(BaseModel):
    restaurant: str
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    order_count: int
    subtotal: float
    tax: float
    total: float
    currency: str
    by_status: Dict[str, int]
    top_items: List[Dict[str, Any]]


# ---- Crawl ---------------------------------------------------------------

class CrawlResponse(BaseModel):
    restaurant: str
    chunks: int
    menu_items: int
    error: Optional[str] = None


class MenuItemIn(BaseModel):
    """A single structured menu item for JSON ingestion.

    Flexible on field names so hand-written or exported menus both work:
    - price:   ``price_inr`` or ``price``
    - weight:  ``weight_gms`` or ``weight``
    - energy:  ``calories_kcal`` or ``calories``
    Unknown keys (e.g. ``variants``) are ignored.
    """
    model_config = {"extra": "ignore", "populate_by_name": True}

    category: Optional[str] = Field(default=None, max_length=120)
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    weight_gms: Optional[float] = Field(
        default=None, validation_alias=AliasChoices("weight_gms", "weight")
    )
    calories_kcal: Optional[float] = Field(
        default=None, validation_alias=AliasChoices("calories_kcal", "calories")
    )
    price_inr: Optional[float] = Field(
        default=None, ge=0,
        validation_alias=AliasChoices("price_inr", "price"),
    )
    # Optional per-zone price overrides, e.g. {"AC": 1350, "VIP": 1500}.
    # Zones not listed fall back to the base price. Empty = base everywhere.
    zone_prices: Dict[str, float] = Field(default_factory=dict)
    # Sold-out toggle. Defaults to available.
    available: bool = True


class TableZoneIn(BaseModel):
    """A single table -> zone mapping for JSON ingestion."""
    model_config = {"extra": "ignore"}

    table_number: str = Field(min_length=1, max_length=32)
    zone: str = Field(default="Non-AC", max_length=40)


class MenuJsonIn(BaseModel):
    """Request body for POST /crawl/json.

    Accepts two shapes and normalizes both to a flat ``menu`` list:

    1. Flat::   {"menu": [ {"category": ..., "name": ..., "price_inr": ...} ]}
    2. Nested:: {"categories": [ {"name": ...,
                    "items": [ {"name": ..., "price": ...} ]} ]}

    In the nested form each category name is pushed down onto its items.
    """
    model_config = {"extra": "ignore"}

    menu: List[MenuItemIn] = Field(default_factory=list)
    categories: Optional[List[Dict[str, Any]]] = None
    restaurant: str = Field(default="demo", max_length=64)
    name: str = Field(default="", max_length=120)
    currency: str = Field(default="₹", max_length=8)
    upi_vpa: str = Field(default="", max_length=120)
    upi_name: str = Field(default="", max_length=120)
    # Optional supported-zone list (informational) and table->zone mappings.
    zones: List[str] = Field(default_factory=list)
    tables: List[TableZoneIn] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _flatten_categories(cls, data: Any) -> Any:
        """Flatten a nested ``categories`` payload into ``menu`` before parse.

        Also derives a display ``name`` from a top-level ``restaurant`` string
        when the nested export used ``restaurant`` as a human name rather than
        a slug.
        """
        if not isinstance(data, dict):
            return data
        if not data.get("menu") and data.get("categories"):
            flat: List[Dict[str, Any]] = []
            for cat in data.get("categories") or []:
                if not isinstance(cat, dict):
                    continue
                cat_name = cat.get("name") or cat.get("category")
                for it in cat.get("items") or []:
                    if not isinstance(it, dict):
                        continue
                    merged = dict(it)
                    merged.setdefault("category", cat_name)
                    flat.append(merged)
            data = {**data, "menu": flat}
        return data

    @model_validator(mode="after")
    def _require_items(self) -> "MenuJsonIn":
        if not self.menu:
            raise ValueError(
                "No menu items found. Provide a non-empty 'menu' list or a "
                "'categories' list with items."
            )
        return self


SessionInfo.model_rebuild()
