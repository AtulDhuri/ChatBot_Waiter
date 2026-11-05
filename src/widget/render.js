// Panel/chat rendering: the table/takeaway prompt, identifier prompt, quick
// chips, the chat input, and the panel + FAB construction and toggle.

import { CONFIG, IS_TOKEN, TAKEAWAY_MODE } from "./config.js";
import { state, ui } from "./state.js";
import { addMessage, el } from "./dom.js";
import { startSession, resolveQrToken } from "./api.js";
import { showMenu, showCart, showOrderOverview, showBill, showPayment, handleSend } from "./flows.js";
import { showOrders } from "./status.js";
import {
  syncNowIfVisible,
  refreshPolling,
} from "./availability.js";
import { updateCartBadge, cartCount, cartTotal } from "./cart.js";

export function renderTablePrompt() {
  ui.body.innerHTML = "";
  ui.footer.innerHTML = "";
  addMessage(
    "Welcome to " + CONFIG.title + "! Are you dining in or taking away?",
    "bot"
  );
  var choice = el("div", { class: "wa-cart-actions" }, [
    el(
      "button",
      {
        class: "wa-btn",
        onclick: function () {
          askIdentifier("dine_in");
        },
      },
      ["🍽️ Eat-in"]
    ),
    el(
      "button",
      {
        class: "wa-btn secondary",
        onclick: function () {
          askIdentifier("takeaway");
        },
      },
      ["🥡 Takeaway"]
    ),
  ]);
  ui.footer.appendChild(choice);
}

// Step 2: ask for table number (eat-in) or customer name (takeaway).
export function askIdentifier(orderType) {
  state.orderType = orderType;
  var takeaway = orderType === "takeaway";
  ui.footer.innerHTML = "";
  addMessage(
    takeaway
      ? "Great — what name should we put on the order?"
      : "Please enter your table number.",
    "bot"
  );
  var input = el("input", {
    class: "wa-input",
    type: "text",
    inputmode: takeaway ? "text" : "numeric",
    placeholder: takeaway ? "Your name" : "e.g. 12",
    "aria-label": takeaway ? "Your name" : "Table number",
  });
  if (!takeaway && CONFIG.presetTable) input.value = CONFIG.presetTable;
  var go = el("button", { class: "wa-btn" }, ["Start"]);
  var back = el(
    "button",
    {
      class: "wa-btn secondary",
      onclick: function () {
        renderTablePrompt();
      },
    },
    ["←"]
  );

  function submit() {
    var val = input.value.trim();
    if (!val) return;
    go.disabled = true;
    go.textContent = "…";
    if (takeaway) state.customerName = val;
    startSession(val)
      .then(function () {
        renderChat();
        addMessage(
          (takeaway
            ? "Thanks " + val + "! It's a takeaway order. "
            : "You're at table " + val + ". ") +
            "Ask me about the menu, place an order, or request the bill.",
          "bot"
        );
        renderQuickChips();
      })
      .catch(function () {
        go.disabled = false;
        go.textContent = "Start";
        addMessage("Couldn't start your session. Please try again.", "bot");
      });
  }
  go.addEventListener("click", submit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") submit();
  });
  ui.footer.appendChild(el("div", { class: "wa-row" }, [back, input, go]));
  setTimeout(function () {
    input.focus();
  }, 50);
}

export function renderContextDock(mode) {
  if (!ui.dock) return;
  ui.dock.innerHTML = "";
  var buttons = [];
  function chip(label, action) {
    return el("button", { class: "wa-chip", onclick: action }, [label]);
  }
  if (mode === "ordered") {
    buttons = [chip("📦 Track Order", showOrders), chip("💳 Get Bill", showBill)];
  } else if (mode === "bill") {
    buttons = [chip("💳 Pay Now", showPayment), chip("⭐ Feedback", function () {
      addMessage("What could we improve about your experience?", "bot");
    })];
  } else if (mode === "review") {
    buttons = [chip("🍽 Menu", showMenu), chip("✅ Place Order", showCart)];
  } else if (state.cart.length) {
    buttons = [chip("➕ Add More", showMenu), chip("🛒 Cart (" + cartCount() + ")", showCart)];
  } else {
    buttons = [chip("🍽 Menu", showMenu)];
  }
  buttons.forEach(function (button) { ui.dock.appendChild(button); });
}

export function renderQuickChips() {
  var chips = el("div", { class: "wa-quick" }, [
    el("button", { class: "wa-chip", onclick: showMenu }, ["Show Menu"]),
  ]);
  ui.body.appendChild(chips);
  ui.body.scrollTop = ui.body.scrollHeight;
}

export function renderChat() {
  ui.footer.innerHTML = "";
  var input = el("input", {
    class: "wa-input",
    type: "text",
    placeholder: "Ask about the menu or type 'bill'…",
    "aria-label": "Message",
  });
  ui.input = input;
  var send = el("button", { class: "wa-btn", onclick: handleSend, "aria-label": "Send message" }, ["Send ➤"]);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") handleSend();
  });
  ui.dock = el("div", { class: "wa-dock", "aria-label": "Suggested actions" });
  ui.dockUpdate = function () {
    renderContextDock(state.cart.length ? "cart" : "initial");
  };
  ui.footer.appendChild(ui.dock);
  renderContextDock(state.cart.length ? "cart" : "initial");
  ui.footer.appendChild(el("div", { class: "wa-row" }, [input, send]));
}

function _headerSub() {
  if (!state.token) return "Tap to order";
  if (state.orderType === "takeaway")
    return (
      "Takeaway" + (state.customerName ? " · " + state.customerName : "")
    );
  return state.tableNumber ? "Table " + state.tableNumber : "Tap to order";
}

export function buildPanel() {
  ui.badge = el("button", { class: "wa-cart-badge", onclick: showCart, "aria-label": "Open cart" }, ["🛒 0 Items • ₹0"]);
  ui.badge.style.display = "none";

  ui.titleEl = el("div", { class: "wa-title" }, [
    document.createTextNode(CONFIG.title),
    el("small", {}, [_headerSub()]),
  ]);
  var header = el("header", { class: "wa-header" }, [ui.titleEl, ui.badge]);

  ui.body = el("div", { class: "wa-body" });
  ui.footer = el("div", { class: "wa-footer" });
  ui.panel = el("div", { class: "wa-panel", role: "dialog" }, [
    header,
    ui.body,
    ui.footer,
  ]);
  document.body.appendChild(ui.panel);

  if (state.token) {
    renderChat();
    var who =
      state.orderType === "takeaway"
        ? "Welcome back" +
          (state.customerName ? ", " + state.customerName : "")
        : "Welcome back to table " + state.tableNumber;
    addMessage(who + "! How can I help? (menu / bill)", "bot");
    renderQuickChips();
  } else if (IS_TOKEN && TAKEAWAY_MODE) {
    askIdentifier("takeaway");
  } else if (IS_TOKEN) {
    renderChat();
    ui.input.disabled = true;
    addMessage("One moment — getting your table ready…", "bot");
    resolveQrToken().catch(function () {});
  } else if (TAKEAWAY_MODE) {
    askIdentifier("takeaway");
  } else {
    renderTablePrompt();
  }
  updateCartBadge();
}

export function togglePanel() {
  if (!ui.panel) buildPanel();
  state.open = true;
  document.documentElement.classList.add("wa-open");
  if (ui.input) ui.input.focus();
  syncNowIfVisible();
  refreshPolling();
}

export function buildFab() {
  // The chat is the page. There is no floating launcher or popup state.
  buildPanel();
  state.open = true;
  document.documentElement.classList.add("wa-open");
}
