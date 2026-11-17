// Customer order-status tracking. The customer sees ONLY their own session's
// orders (server-enforced via the session token). Statuses flow
// Customer status steps: Placed -> Accepted -> Preparing -> Ready -> Served.
//
// Realtime strategy:
//  - The browser never talks to the database provider. The backend relays
//    database change events as content-free pings over Server-Sent Events at
//    /events/session (this session's orders + the menu only). Each ping
//    triggers pollStatusOnce() for a fresh, authoritative server read.
//  - While the relay is unavailable we fall back to one request every 45 s
//    using a non-overlapping timeout.
//  - Only ONE stream and ONE fallback timer are ever live at a time.

import { api, money, DEVICE_ID } from "./config.js";
import { invalidateMenuCache, fetchMenu } from "./api.js";
import { state, ui } from "./state.js";
import { addMessage, el, _guard } from "./dom.js";
import { getJson } from "./api.js";
import { endLocalSession } from "./cart.js";
import { fetchCancelItem } from "./api.js";

var STATUS_FALLBACK_MS = 45000; // backup only; Realtime is primary
var STATUS_STEPS   = ["Placed", "Accepted", "Preparing", "Ready", "Served"];

// Item statuses the customer may cancel.
var CANCELLABLE_ITEM = { pending: true, accepted: true };

var _es         = null;  // EventSource to /events/session
var _rtActive   = false; // true while the server relay reports live
var _rtStarting = false;

function statusClass(s) {
  return "wa-st-" + String(s || "").toLowerCase();
}

export function renderStatus(data, moveToBottom) {
  var orders = (data && data.orders) || [];
  if (!orders.length) return;

  var card = el("div", { class: "wa-status-card" }, [
    el("div", { class: "wa-status-title" }, [
      el("span", {}, ["Your orders"]),
      el("span", { class: "wa-status-live" }, [
        el("span", { class: "wa-live-dot" }, []),
        "Live",
      ]),
    ]),
  ]);

  orders.forEach(function (o) {
    var isCancelled = o.status === "Cancelled";
    var reached = STATUS_STEPS.indexOf(o.status);

    var head = el("div", { class: "wa-status-head" }, [
      el("span", { class: "wa-status-no" }, ["Order " + o.order_no]),
      el("span", { class: "wa-status-badge " + statusClass(o.status) }, [
        o.status,
      ]),
    ]);

    var row = el("div", { class: "wa-status-row" }, [head]);

    var items = el("div", { class: "wa-status-items" },
      renderOrderItems(o)
    );
    if ((o.items || []).length) row.appendChild(items);

    if (!isCancelled) {
      var pct = reached <= 0 ? 0 : (reached / (STATUS_STEPS.length - 1)) * 100;
      var track = el("div", { class: "wa-track" }, [
        el("div", { class: "wa-track-line" }, [
          el("div", { class: "wa-track-fill", style: "width:" + pct + "%" }, []),
        ]),
        el("div", { class: "wa-track-nodes" },
          STATUS_STEPS.map(function (label, i) {
            var cls = "wa-node";
            if (i < reached) cls += " done";
            else if (i === reached) cls += " active";
            return el("div", { class: cls }, [
              el("span", { class: "wa-node-dot" }, [i < reached ? "✓" : String(i + 1)]),
              el("span", { class: "wa-node-label" }, [label]),
            ]);
          })
        ),
      ]);
      row.appendChild(track);
    } else {
      row.appendChild(el("div", { class: "wa-status-cancel-note" }, ["This order was cancelled."]));
    }

    row.appendChild(el("div", { class: "wa-status-total" }, [
      el("span", { class: "wa-status-total-label" }, ["Total"]),
      el("span", { class: "wa-status-total-amt" }, [money(o.total)]),
    ]));
    card.appendChild(row);
  });

  if (state.statusNode && state.statusNode.parentNode) {
    if (moveToBottom && ui.body) {
      state.statusNode.parentNode.removeChild(state.statusNode);
      ui.body.appendChild(card);
    } else {
      state.statusNode.parentNode.replaceChild(card, state.statusNode);
    }
  } else {
    addMessage(null, "bot", card);
  }
    state.statusNode = card;
    if (moveToBottom && ui.body) ui.body.scrollTop = ui.body.scrollHeight;
  }

  // ── Per-item status rows (customer tracking + cancellation) ───────────────
  function renderOrderItems(o) {
    var orderItems = o.order_items || o.items || [];
    if (!orderItems.length)
      return [el("div", { class: "wa-status-item wa-status-empty" }, ["No items"])];
    return orderItems.map(function (item) {
      var status = String(item.status || "pending").toLowerCase();
      var qty = item.quantity != null ? item.quantity : 1;
      var row = el("div", { class: "wa-status-item wa-item-st-" + status },
        [
          el("span", { class: "wa-item-name" }, [String(qty) + "\u00D7 " + escHtml(item.name)]),
          el("span", { class: "wa-item-status wa-st-" + status }, [item.status || "Pending"]),
          el("span", { class: "wa-item-amt" }, [money(item.line_total || 0)]),
        ]
      );
      if (CANCELLABLE_ITEM[status]) {
        var btn = el("button", { class: "wa-item-cancel" }, ["\u2716 Cancel"]);
        btn.addEventListener("click", _guard(btn, function () {
          if (!confirm("Cancel this item (" + escHtml(item.name) + ")?")) return;
          return fetchCancelItem(item.id, "customer cancelled")
            .then(function () {
              addMessage("Item \"" + escHtml(item.name) + "\" cancelled.", "bot");
              return pollStatusOnce();
            })
            .catch(function (e) {
              addMessage("Couldn't cancel item: " + (e && e.message ? e.message : "try again"), "bot");
            });
        }));
        row.appendChild(btn);
      }
      return row;
    });
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }


var _statusInFlight = null;

export function pollStatusOnce(moveToBottom) {
  if (!state.token) return Promise.resolve();
  if (_statusInFlight) return _statusInFlight;
  _statusInFlight = getJson(function () {
    return "/my-orders?session_id=" + encodeURIComponent(state.token);
  })
    .then(function (data) {
      renderStatus(data, !!moveToBottom);
      if (data && data.session_ended) {
        stopStatusPolling();
        _teardownRealtime();
        endLocalSession();
        addMessage(
          state.paymentMode === "postpaid"
            ? "Your bill has been paid and the table is now closed. Thanks for dining with us!"
            : "All your orders have been served. Thanks for dining with us! " +
              "Scan the QR again to start a new order.",
          "bot"
        );
      }
    })
    .catch(function () {
      // Transient error — keep trying; the next tick may succeed.
    })
    .then(function (result) {
      _statusInFlight = null;
      return result;
    });
  return _statusInFlight;
}

export function showOrders() {
  return pollStatusOnce(true).then(function () {
    if (ui.body) ui.body.scrollTop = ui.body.scrollHeight;
  });
}

// ── Realtime subscription (server-relayed) ────────────────────────────────

function _onMenuChanged() {
  invalidateMenuCache();
  fetchMenu().then(function () {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("dineos:menu-updated"));
    }
  }).catch(function () {});
}

function _setupRealtime() {
  if (_es || !state.token) return;
  if (typeof EventSource === "undefined") {
    _rtStarting = false;
    _ensureFallbackPolling();
    return;
  }

  _es = new EventSource(api(
    "/events/session?session_id=" + encodeURIComponent(state.token) +
    "&device=" + encodeURIComponent(DEVICE_ID)
  ));

  _es.addEventListener("live", function (e) {
    var live = false;
    try { live = !!JSON.parse(e.data).live; } catch (err) {}
    _rtStarting = false;
    if (live) {
      _rtActive = true;
      _stopFallbackPolling();
      pollStatusOnce(); // resync on every (re)connect
    } else {
      _rtActive = false;
      _ensureFallbackPolling();
    }
  });

  _es.addEventListener("change", function (e) {
    var d = {};
    try { d = JSON.parse(e.data); } catch (err) { return; }
    if (d.table === "menu_items") _onMenuChanged();
    else pollStatusOnce();
  });

  _es.onerror = function () {
    // EventSource reconnects by itself; poll slowly until it is back. If the
    // server rejected the stream (e.g. session ended) it stays CLOSED.
    _rtActive = false;
    _rtStarting = false;
    if (_es && _es.readyState === 2) _es = null;
    _ensureFallbackPolling();
  };
}

function _teardownRealtime() {
  if (_es) {
    try { _es.close(); } catch (e) {}
    _es = null;
  }
  _rtActive = false;
  _rtStarting = false;
}

// ── Slow fallback ─────────────────────────────────────────────────────────
// Realtime is primary. A recursive timeout is used for the backup so
// failed/slow requests cannot overlap and only one backup request is pending.
function _scheduleFallback() {
  if (!state.token || _rtActive || state.statusTimer) return;
  state.statusTimer = setTimeout(function () {
    state.statusTimer = null;
    pollStatusOnce().then(_scheduleFallback);
  }, STATUS_FALLBACK_MS);
}

function _ensureFallbackPolling() {
  if (!state.token || _rtActive || state.statusTimer) return;
  pollStatusOnce().then(_scheduleFallback);
}

function _stopFallbackPolling() {
  if (state.statusTimer) {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function startStatusPolling() {
  if (!state.token || _rtActive || _rtStarting || _es) return;
  _rtStarting = true;
  // Realtime is primary. The backup starts only while the relay is down.
  _setupRealtime();
}

export function stopStatusPolling() {
  _stopFallbackPolling();
  _teardownRealtime();
}

export function resumeStatusPollingIfNeeded() {
  if (!state.token) return;
  // Realtime pushes changes; focus/visibility must not trigger a read.
  if (_rtActive || _rtStarting || _es) return;
  if (state.statusTimer) return;
  startStatusPolling();
}
