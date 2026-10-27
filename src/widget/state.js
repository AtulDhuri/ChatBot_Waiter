// Shared mutable runtime state and session persistence. Every module imports
// the same `state` and `ui` object references and mutates them in place; the
// bindings are never reassigned, so cross-module reads stay live.

import { CONFIG, IS_TOKEN, SESSION_KEY } from "./config.js";

export var state = {
  token: null,
  tableNumber: null,
  orderType: null, // 'dine_in' | 'takeaway'
  customerName: null, // for takeaway
  zone: null, // pricing zone label (from the token/table); display only
  paymentMode: "prepaid",
  cart: [], // [{name, price, quantity}]
  open: false,
  menu: [], // cached menu items for NL order matching
  lastDish: null, // last dish the guest/bot referenced (for "2 of it")
  pendingOrder: null, // {item, quantity} awaiting a yes/no confirmation
  statusTimer: null, // interval id for polling this session's order statuses
  statusNode: null, // the live-updating "your orders" card in the transcript
  billNode: null, // the live bill card in the transcript (auto-refreshes)
  billPayBtn: null, // the "Pay now" button under the live bill
};

// UI node references, populated by the render module.
export var ui = {};

export function saveSession() {
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        token: state.token,
        tableNumber: state.tableNumber,
        orderType: state.orderType,
        customerName: state.customerName,
        zone: state.zone,
        paymentMode: state.paymentMode,
        cart: state.cart,
      })
    );
  } catch (e) {}
}

export function loadSession() {
  try {
    var raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    var data = JSON.parse(raw);
    state.token = data.token || null;
    state.tableNumber = data.tableNumber || null;
    state.orderType = data.orderType || null;
    state.customerName = data.customerName || null;
    state.zone = data.zone || null;
    // Accept both keys so sessions saved by the current bundle and older
    // bundles restore correctly. The server remains authoritative on a fresh
    // QR/session resolution.
    state.paymentMode = data.paymentMode || data.payment_mode || "prepaid";
    // Cart restore policy:
    //   - Token flow: the SERVER is the source of truth (resolveQrToken sets
    //     the cart authoritatively on boot), so DO NOT restore the cache here.
    //   - Legacy slug flow: no server resolve on boot, so restore the cache.
    state.cart = !IS_TOKEN && Array.isArray(data.cart) ? data.cart : [];
  } catch (e) {}
}
