// Cart state, the central updateCartBadge orchestrator, and the shared view
// registries (activeCart, menuRows) that keep the menu, cart card, badge and
// live bill all in sync after any mutation.

import { money, SESSION_KEY } from "./config.js";
import { state, ui, saveSession } from "./state.js";
import { addMessage } from "./dom.js";
import { refreshPolling } from "./availability.js";
import { refreshBillIfShown } from "./flows.js";

// The cart view currently rendered on screen (set by showCart). { card, rerender }
export var activeCart = null;
export function setActiveCart(v) {
  activeCart = v;
}

// Menu rows currently on screen, each { row: <DOM node>, render: fn }.
export var menuRows = [];

export function refreshMenuRows() {
  if (!menuRows.length) return;
  var live = [];
  for (var i = 0; i < menuRows.length; i++) {
    var entry = menuRows[i];
    if (entry.row && entry.row.isConnected) {
      entry.render();
      live.push(entry);
    }
  }
  menuRows = live;
}

export function addToCart(item) {
  var existing = state.cart.filter(function (c) {
    return c.name === item.name;
  })[0];
  if (existing) existing.quantity += 1;
  else
    state.cart.push({
      name: item.name,
      price: item.price || 0,
      quantity: 1,
      instructions: "",
    });
  saveSession();
  updateCartBadge();
}

export function cartCount() {
  return state.cart.reduce(function (n, c) {
    return n + c.quantity;
  }, 0);
}

var _syncingCart = false;

export function updateCartBadge() {
  if (ui.badge) {
    var c = cartCount();
    ui.badge.textContent = c;
    ui.badge.style.display = c > 0 ? "inline-block" : "none";
  }
  if (typeof refreshPolling === "function") refreshPolling();
  if (typeof refreshBillIfShown === "function") refreshBillIfShown();
  if (typeof refreshMenuRows === "function") refreshMenuRows();
  if (
    !_syncingCart &&
    activeCart &&
    activeCart.card &&
    activeCart.card.parentNode &&
    typeof activeCart.rerender === "function"
  ) {
    _syncingCart = true;
    try {
      activeCart.rerender();
    } finally {
      _syncingCart = false;
    }
  } else if (activeCart && activeCart.card && !activeCart.card.parentNode) {
    activeCart = null;
  }
}

export function findCartItem(name) {
  return state.cart.filter(function (c) {
    return c.name === name;
  })[0];
}

export function changeQty(name, delta) {
  var item = findCartItem(name);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) {
    state.cart = state.cart.filter(function (c) {
      return c.name !== name;
    });
  }
  saveSession();
  updateCartBadge();
}

export function removeItem(name) {
  state.cart = state.cart.filter(function (c) {
    return c.name !== name;
  });
  saveSession();
  updateCartBadge();
}

export function clearCart() {
  state.cart = [];
  saveSession();
  updateCartBadge();
}

// Fully reset this device's local session state (server said session ended).
export function endLocalSession() {
  state.token = null;
  state.cart = [];
  state.customerName = null;
  state.pendingOrder = null;
  state.statusNode = null;
  state.billNode = null;
  state.billPayBtn = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {}
  updateCartBadge();
}

export function cartTotal() {
  return state.cart.reduce(function (n, c) {
    return n + (Number(c.price) || 0) * c.quantity;
  }, 0);
}

// Reconcile the local cart with the server's `dropped` list. Returns true if
// anything was dropped.
export function reconcileDropped(dropped) {
  if (!dropped || !dropped.length) return false;
  var droppedSet = {};
  dropped.forEach(function (n) {
    droppedSet[String(n).toLowerCase()] = true;
  });
  state.cart = state.cart.filter(function (c) {
    return !droppedSet[String(c.name).toLowerCase()];
  });
  saveSession();
  updateCartBadge();
  addMessage(
    "Sorry, these items just sold out and were removed from your order: " +
      dropped.join(", ") +
      ".",
    "bot"
  );
  return true;
}
