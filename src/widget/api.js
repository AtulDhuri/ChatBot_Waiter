// All network calls plus tenant-identity resolution and transparent re-auth.
// Cross-module runtime calls (render*, resume polling, cart badge) are imported
// lazily-safe: they're only invoked at runtime, never at module-eval time, so
// the circular imports between api/render/status/cart resolve cleanly.

import {
  CONFIG,
  IS_TOKEN,
  LEGACY_SLUG,
  DEVICE_ID,
  SESSION_KEY,
  api,
} from "./config.js";
import { state, ui, saveSession } from "./state.js";
import { addMessage } from "./dom.js";
import { renderChat, renderQuickChips, renderTablePrompt } from "./render.js";
import { updateCartBadge } from "./cart.js";
import {
  resumeStatusPollingIfNeeded,
  stopStatusPolling,
} from "./status.js";

export function startSession(label) {
  var takeaway = state.orderType === "takeaway";
  return fetch(api("/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order_type: state.orderType || "dine_in",
      table_number: takeaway ? "" : label,
      customer_name: takeaway ? label : "",
      restaurant: LEGACY_SLUG || "demo",
    }),
  })
    .then(function (r) {
      if (!r.ok) throw new Error("session failed");
      return r.json();
    })
    .then(function (data) {
      state.token = data.session_id;
      state.tableNumber = takeaway ? "-" : label;
      state.paymentMode = data.payment_mode || "prepaid";
      if (takeaway) state.customerName = label;
      if (data.restaurant_name) {
        CONFIG.title = data.restaurant_name;
        if (ui.titleEl) ui.titleEl.firstChild.textContent = CONFIG.title;
      }
      saveSession();
      return data;
    });
}

// Resolve the opaque QR token (?r=<token>) into a customer-safe session.
var _qrResolving = null;
export function resolveQrToken() {
  if (_qrResolving) return _qrResolving;
  _qrResolving = fetch(api("/qr/resolve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: CONFIG.qrToken, device_id: DEVICE_ID }),
  })
    .then(function (r) {
      if (!r.ok) {
        return r.json().then(
          function (e) {
            throw new Error((e && e.detail) || "invalid code");
          },
          function () {
            throw new Error("invalid code");
          }
        );
      }
      return r.json();
    })
    .then(function (data) {
      state.token = data.session_id;
      state.tableNumber = data.table_number || "-";
      state.orderType = data.order_type || "dine_in";
      state.zone = data.zone || null;
      state.paymentMode = data.payment_mode || "prepaid";
      state.cart = Array.isArray(data.cart) ? data.cart : [];
      applyRestaurantName(data.restaurant_name || CONFIG.title);
      saveSession();

      if (ui.panel) {
        renderChat();
        ui.body.innerHTML = "";
        var where =
          state.tableNumber && state.tableNumber !== "-"
            ? " at table " + state.tableNumber
            : "";
        addMessage(
          (data.continued ? "Welcome back" : "Welcome") +
            " to " +
            CONFIG.title +
            "!" +
            (where ? " You're" + where + "." : "") +
            " Ask about the menu, place an order, or request the bill.",
          "bot"
        );
        renderQuickChips();
      }
      updateCartBadge();
      resumeStatusPollingIfNeeded();
      _qrResolving = null;
      return data;
    })
    .catch(function (err) {
      state.token = null;
      if (ui.panel && ui.body) {
        ui.footer.innerHTML = "";
        ui.body.innerHTML = "";
        addMessage(
          "This code isn't valid anymore. Please scan the QR code on your " +
            "table again.",
          "bot"
        );
      }
      _qrResolving = null;
      throw err;
    });
  return _qrResolving;
}

// Re-resolve from the stored token after a session expires (HTTP 440).
export function reauthFromToken() {
  if (!IS_TOKEN || !CONFIG.qrToken)
    return Promise.reject(new Error("no token"));
  _qrResolving = null;
  return resolveQrToken().then(function () {
    return state.token;
  });
}

// POST JSON to a session-bound endpoint with transparent re-auth (440 retry).
export function postJson(path, bodyFn, _retried) {
  return fetch(api(path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": DEVICE_ID,
    },
    body: JSON.stringify(bodyFn()),
  }).then(function (r) {
    if (r.status === 440 && IS_TOKEN && !_retried) {
      return reauthFromToken().then(function () {
        return postJson(path, bodyFn, true);
      });
    }
    if (r.status === 403) {
      handlePinningRejection();
      throw new Error("session rejected");
    }
    if (!r.ok) {
      return r.json().then(
        function (e) {
          throw new Error((e && e.detail) || "request failed");
        },
        function () {
          throw new Error("request failed");
        }
      );
    }
    return r.json();
  });
}

// GET a session-bound endpoint with the same transparent re-auth as postJson.
export function getJson(urlFn, _retried) {
  return fetch(api(urlFn()), {
    headers: { "X-Device-Id": DEVICE_ID },
  }).then(function (r) {
    if (r.status === 440 && IS_TOKEN && !_retried) {
      return reauthFromToken().then(function () {
        return getJson(urlFn, true);
      });
    }
    if (r.status === 403) {
      handlePinningRejection();
      throw new Error("session rejected");
    }
    if (!r.ok) {
      return r.json().then(
        function (e) {
          throw new Error((e && e.detail) || "request failed");
        },
        function () {
          throw new Error("request failed");
        }
      );
    }
    return r.json();
  });
}

export function fetchMenu() {
  var url;
  if (LEGACY_SLUG) {
    url = "/menu?restaurant=" + encodeURIComponent(LEGACY_SLUG);
    if (state.token) url += "&session_id=" + encodeURIComponent(state.token);
  } else {
    if (!state.token) {
      return Promise.resolve({ items: [], categories: {} });
    }
    url = "/menu?session_id=" + encodeURIComponent(state.token);
  }
  return fetch(api(url))
    .then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (error) {
          throw new Error((error && error.detail) || "No menu found for this restaurant.");
        });
      }
      return r.json();
    })
    .then(function (data) {
      if (data && data.items) state.menu = data.items;
      if (data && data.restaurant_name)
        applyRestaurantName(data.restaurant_name);
      return data;
    });
}

// Set the restaurant's display name everywhere it's shown, only when it differs.
export function applyRestaurantName(name) {
  name = String(name || "").trim();
  if (!name || name === CONFIG.title) return;
  CONFIG.title = name;
  if (ui.titleEl && ui.titleEl.firstChild) {
    ui.titleEl.firstChild.textContent = name;
  }
  if (!IS_TOKEN && state.open && !state.token && ui.body) {
    renderTablePrompt();
  }
}

// Cheap, non-blocking lookup of the restaurant's display name via /menu.
export function prefetchRestaurantName() {
  try {
    fetchMenu().catch(function () {});
  } catch (e) {}
}

// Ensure the menu is cached (fetch once if we haven't yet).
export function ensureMenu() {
  if (state.menu && state.menu.length) return Promise.resolve(state.menu);
  return fetchMenu()
    .then(function (d) {
      return (d && d.items) || [];
    })
    .catch(function () {
      return [];
    });
}

export function askQuestion(question) {
  return postJson("/ask", function () {
    return { session_id: state.token, question: question };
  });
}

export function parseOrderServer(text) {
  return postJson("/order/parse", function () {
    return { session_id: state.token, text: text };
  });
}

export function fetchPlaceOrder(orderType) {
  return postJson("/order", function () {
    return {
      session_id: state.token,
      cart: state.cart,
      order_type: orderType || "dine_in",
      payment_status: "paid_unverified",
    };
  });
}

export function fetchPay() {
  return postJson("/pay", function () {
    return { session_id: state.token, cart: state.cart };
  });
}

export function fetchPostpaidPay() {
  return postJson("/postpaid/pay", function () {
    return { session_id: state.token };
  });
}

export function fetchPostpaidBill() {
  return postJson("/postpaid/bill", function () {
    return { session_id: state.token };
  });
}

export function fetchBill() {
  return postJson("/bill", function () {
    return { session_id: state.token, cart: state.cart, format: "json" };
  });
}

// The server rejected this session for a device/UA mismatch (replay defense).
var _pinningHandled = false;
export function handlePinningRejection() {
  if (_pinningHandled) return;
  _pinningHandled = true;
  stopStatusPolling();
  state.token = null;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
  addMessage(
    "For your security, this session can't be continued on this device. " +
      "Please scan your table's QR code again to start a new order.",
    "bot"
  );
}
