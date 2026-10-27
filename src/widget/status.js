// Customer order-status tracking. The customer sees ONLY their own session's
// orders (server-enforced via the session token). Statuses flow
// Placed -> Preparing -> Served. Payment is shown separately by staff and
// does not change the kitchen progress tracker.

import { money } from "./config.js";
import { state, ui } from "./state.js";
import { addMessage, el } from "./dom.js";
import { getJson } from "./api.js";
import { endLocalSession } from "./cart.js";

var STATUS_POLL_MS = 6000;
var STATUS_STEPS = ["Placed", "Preparing", "Served"];

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
      var pct =
        reached <= 0 ? 0 : (reached / (STATUS_STEPS.length - 1)) * 100;
      var track = el("div", { class: "wa-track" }, [
        el("div", { class: "wa-track-line" }, [
          el("div", {
            class: "wa-track-fill",
            style: "width:" + pct + "%",
          }, []),
        ]),
        el(
          "div",
          { class: "wa-track-nodes" },
          STATUS_STEPS.map(function (label, i) {
            var cls = "wa-node";
            if (i < reached) cls += " done";
            else if (i === reached) cls += " active";
            return el("div", { class: cls }, [
              el("span", { class: "wa-node-dot" }, [
                i < reached ? "✓" : String(i + 1),
              ]),
              el("span", { class: "wa-node-label" }, [label]),
            ]);
          })
        ),
      ]);
      row.appendChild(track);
    } else {
      row.appendChild(
        el("div", { class: "wa-status-cancel-note" }, [
          "This order was cancelled.",
        ])
      );
    }

    row.appendChild(
      el("div", { class: "wa-status-total" }, [
        el("span", { class: "wa-status-total-label" }, ["Total"]),
        el("span", { class: "wa-status-total-amt" }, [money(o.total)]),
      ])
    );
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
      // Transient error — keep polling; the next tick may succeed.
    });
}

export function showOrders() {
  return pollStatusOnce(true).then(function () {
    if (ui.body) ui.body.scrollTop = ui.body.scrollHeight;
  });
}

export function startStatusPolling() {
  if (state.statusTimer) return;
  pollStatusOnce();
  state.statusTimer = setInterval(pollStatusOnce, STATUS_POLL_MS);
}

export function stopStatusPolling() {
  if (state.statusTimer) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
}

export function resumeStatusPollingIfNeeded() {
  if (!state.token) return;
  if (state.statusTimer) return;
  startStatusPolling();
}
