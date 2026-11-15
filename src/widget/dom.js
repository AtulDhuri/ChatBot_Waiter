// Tiny DOM helpers: a guarded event wrapper, an element factory, and the
// transcript message appender. No framework, no deps.

import { ui } from "./state.js";

// Wrap a click handler so its element can't be re-triggered until the handler
// (and any promise it returns) finishes. Prevents double-taps from firing
// duplicate requests and shows a consistent loading state while it runs.
export function _guard(node, handler) {
  return function (ev) {
    if (node.disabled || node.getAttribute("aria-busy") === "true") return;

    var originalHtml = node.innerHTML;
    var canDisable = "disabled" in node;
    var release;
    var result;

    node.setAttribute("aria-busy", "true");
    node.classList.add("wa-loading");
    if (canDisable) node.disabled = true;
    node.innerHTML = '<span class="wa-spinner" aria-hidden="true"></span><span class="wa-loading-label">Loading…</span>';

    release = function () {
      if (!node.isConnected) return;
      node.innerHTML = originalHtml;
      node.classList.remove("wa-loading");
      node.removeAttribute("aria-busy");
      if (canDisable) node.disabled = false;
    };

    try {
      result = handler.call(node, ev);
    } catch (error) {
      release();
      throw error;
    }

    if (result && typeof result.then === "function") {
      result.then(release, release);
    } else {
      // Local-only actions finish synchronously. Keep the indicator visible
      // briefly so a double tap cannot trigger the action twice.
      setTimeout(release, 600);
    }
  };
}


export function setOrderSubmitBusy(busy) {
  if (typeof document === "undefined") return;
  var buttons = document.querySelectorAll("[data-order-submit]");
  Array.prototype.forEach.call(buttons, function (button) {
    if (busy) {
      if (!button.hasAttribute("data-order-submit-html")) {
        button.setAttribute("data-order-submit-html", button.innerHTML);
      }
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.classList.add("wa-loading");
      button.innerHTML = '<span class="wa-spinner" aria-hidden="true"></span><span class="wa-loading-label">Loading…</span>';
    } else {
      var original = button.getAttribute("data-order-submit-html");
      if (original !== null) {
        button.innerHTML = original;
        button.removeAttribute("data-order-submit-html");
      }
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.classList.remove("wa-loading");
    }
  });
}

export function el(tag, attrs, children) {
  var node = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function (k) {
    if (k === "class") node.className = attrs[k];
    else if (k === "html") node.innerHTML = attrs[k];
    else if (k.indexOf("on") === 0 && typeof attrs[k] === "function")
      node.addEventListener(k.slice(2).toLowerCase(), _guard(node, attrs[k]));
    else node.setAttribute(k, attrs[k]);
  });
  (children || []).forEach(function (c) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  });
  return node;
}

export function addMessage(text, who, node) {
  var bubble = el("div", { class: "wa-bubble" });
  if (node) bubble.appendChild(node);
  else bubble.textContent = text;
  var msg = el("div", { class: "wa-msg " + (who || "bot") }, [bubble]);
  ui.body.appendChild(msg);
  ui.body.scrollTop = ui.body.scrollHeight;
  return msg;
}
