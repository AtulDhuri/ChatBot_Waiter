// Tiny DOM helpers: a guarded event wrapper, an element factory, and the
// transcript message appender. No framework, no deps.

import { ui } from "./state.js";

// Wrap a click handler so its element can't be re-triggered until the handler
// (and any promise it returns) finishes. Prevents double-taps from firing
// duplicate requests.
export function _guard(node, handler) {
  return function (ev) {
    if (node.disabled || node.getAttribute("aria-busy") === "true") return;
    var result;
    try {
      result = handler.call(node, ev);
    } finally {
      var canDisable = "disabled" in node;
      if (canDisable) node.disabled = true;
      node.setAttribute("aria-busy", "true");
      var release = function () {
        if (canDisable) node.disabled = false;
        node.removeAttribute("aria-busy");
      };
      if (result && typeof result.then === "function") {
        result.then(release, release);
      } else {
        setTimeout(release, 600);
      }
    }
  };
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
