// Customer order-status tracking. The customer sees ONLY their own session's
// orders (server-enforced via the session token). Statuses flow
// Customer status steps: Placed -> Preparing -> Ready -> Served.
//
// Realtime strategy:
//  - If the page loaded with @supabase/supabase-js present on the window AND
//    the backend returns a realtime config from /session-realtime-token, we
//    subscribe to postgres_changes on the `orders` table filtered to this
//    session_id. Each push triggers pollStatusOnce() for a fresh server read.
//  - If Supabase is not available or the subscription fails, we fall back
//    to one request every 45 seconds using a non-overlapping timeout.
//  - Only ONE subscription and ONE fallback timer are ever live at a time.

import { api, money } from "./config.js";
import { state, ui } from "./state.js";
import { addMessage, el } from "./dom.js";
import { getJson } from "./api.js";
import { endLocalSession } from "./cart.js";

var STATUS_FALLBACK_MS = 45000; // backup only; Realtime is primary
var STATUS_STEPS   = ["Placed", "Preparing", "Ready", "Served"];

// Realtime changes are filtered by the server-resolved internal session ID,
// not the signed token. Orders store the internal session ID.
var _rtClient  = null;  // Supabase client instance
var _rtChannel = null;  // active channel
var _rtActive  = false; // true when channel is SUBSCRIBED
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
      (o.items || []).map(function (item) {
        return el("div", { class: "wa-status-item" }, [
          el("span", {}, [String(item.quantity || 1) + "× " + item.name]),
          el("span", {}, [money(item.line_total || 0)]),
        ]);
      })
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

export function pollStatusOnce(moveToBottom) {
  if (!state.token) return Promise.resolve();
  return getJson(function () {
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
    });
}

export function showOrders() {
  return pollStatusOnce(true).then(function () {
    if (ui.body) ui.body.scrollTop = ui.body.scrollHeight;
  });
}

// ── Realtime subscription ─────────────────────────────────────────────────
// Tries to subscribe to postgres_changes on the orders table, filtered
// to this session's restaurant. Each push triggers a server read so the
// customer always sees authoritative data (not just the Supabase payload,
// which omits the computed customer-safe fields the server adds).

function _setupRealtime() {
  if (_rtChannel || !state.token || typeof window === "undefined") return;
  if (!window.supabase) return; // Supabase JS not loaded in this embed

  fetch(api("/auth/session-realtime-token?session_id=" + encodeURIComponent(state.token)))
    .then(function (r) {
      if (!r.ok) throw new Error("not configured");
      return r.json();
    })
    .then(function (cfg) {
      if (!cfg.url || !cfg.anonKey || !cfg.restaurantId || !cfg.sessionId) {
        _rtStarting = false;
        _ensureFallbackPolling();
        return;
      }

      _rtClient = window.supabase.createClient(cfg.url, cfg.anonKey, {
        realtime: { heartbeatIntervalMs: 30000 },
        // No staff JWT for customer channels — they use the anon key plus RLS.
      });

      // Channel name is scoped to this specific session — one customer,
      // one channel, zero cross-session bleed.
      var channelName = "customer-session-" + cfg.restaurantId + "-" + state.token.slice(0, 12);
      _rtChannel = _rtClient.channel(channelName);

      // Filter to this session's orders only. `session_id` is a column on
      // the orders table that was set when the order was placed.
      // This means the channel only fires when THIS customer's orders change,
      // not every other table in the restaurant.
      _rtChannel.on(
        "postgres_changes",
        {
          event:  "UPDATE",  // only status/payment changes matter for the tracker
          schema: "public",
          table:  "orders",
          filter: "session_id=eq." + cfg.sessionId,
        },
        function () {
          // Re-fetch from server — the server maps raw DB status to the
          // customer-safe labels (Placed / Preparing / Served).
          pollStatusOnce();
        }
      );

      // Also catch INSERT in case the first order of a session arrives
      // after the channel is already open.
      _rtChannel.on(
        "postgres_changes",
        {
          event:  "INSERT",
          schema: "public",
          table:  "orders",
          filter: "session_id=eq." + cfg.sessionId,
        },
        function () { pollStatusOnce(); }
      );

      _rtChannel.subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          _rtActive = true;
          _rtStarting = false;
          // Realtime is authoritative. Stop backup scheduling and make one
          // initial read to render the current state.
          _stopFallbackPolling();
          pollStatusOnce();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          _rtActive = false;
          _rtStarting = false;
          _rtChannel = null;
          // Realtime failed; use the slow backup only.
          _ensureFallbackPolling();
        }
      });
    })
    .catch(function () {
      _rtStarting = false;
      // Supabase is unavailable or not configured. Use the slow backup.
      _ensureFallbackPolling();
    });
}

function _teardownRealtime() {
  if (_rtChannel) {
    try { _rtChannel.unsubscribe(); } catch (e) {}
    _rtChannel = null;
  }
  _rtClient  = null;
  _rtActive  = false;
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
  if (!state.token || _rtActive || _rtStarting || _rtChannel) return;
  _rtStarting = true;
  if (typeof window === "undefined" || !window.supabase) {
    _rtStarting = false;
    _ensureFallbackPolling();
    return;
  }
  // Realtime is primary. The backup starts only after connection failure.
  _setupRealtime();
}

export function stopStatusPolling() {
  _stopFallbackPolling();
  _teardownRealtime();
}

export function resumeStatusPollingIfNeeded() {
  if (!state.token) return;
  // Realtime pushes changes; focus/visibility must not trigger a read.
  if (_rtActive || _rtStarting || _rtChannel) return;
  if (state.statusTimer) return;
  startStatusPolling();
}
