// Config resolution: reads the widget's own <script> tag and URL params to
// derive the API base and tenant identity. This is the heart of "plug and
// play" — a restaurant embeds one <script> tag and nothing else.

export var currentScript =
  document.currentScript ||
  (function () {
    var s = document.getElementsByTagName("script");
    return s[s.length - 1];
  })();

function urlParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch (e) {
    return null;
  }
}

// Derive the API base from the widget's own <script src>. Same-origin embeds
// resolve to "" (relative). An explicit data-api overrides this.
function apiBaseFromScript() {
  try {
    var src = currentScript && currentScript.src;
    if (!src) return "";
    var u = new URL(src, window.location.href);
    if (u.origin === window.location.origin) return "";
    return u.origin;
  } catch (e) {
    return "";
  }
}

// Shared, mutable config object. Other modules import this reference and read
// (and occasionally mutate, e.g. title/currency) it in place.
export var CONFIG = {
  apiBase:
    (currentScript && currentScript.getAttribute("data-api")) ||
    apiBaseFromScript(),
  qrToken: urlParam("r"),
  legacySlug:
    urlParam("restaurant") ||
    (currentScript && currentScript.getAttribute("data-restaurant")) ||
    null,
  presetTable: urlParam("t") || urlParam("table") || null,
  currency: "$",
  title: "DineOS",
};

// Decide whether ?r= looks like an opaque token vs. a legacy slug.
function looksLikeToken(v) {
  if (!v) return false;
  if (v.length < 16) return false; // demo slugs are short
  return /[A-Z_]/.test(v) || v.length >= 20;
}

export var IS_TOKEN = looksLikeToken(CONFIG.qrToken);

// A legacy slug is used directly only when ?r= is not a token.
export var LEGACY_SLUG = IS_TOKEN
  ? null
  : CONFIG.qrToken || CONFIG.legacySlug || "demo";

// Stable per-browser device id so a rescan can continue this device's cart.
function getDeviceId() {
  var KEY = "waiter_device_id";
  try {
    var id = localStorage.getItem(KEY);
    if (!id) {
      id =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : "d-" +
            Math.random().toString(36).slice(2) +
            Date.now().toString(36);
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (e) {
    return "d-" + Math.random().toString(36).slice(2);
  }
}

export var DEVICE_ID = getDeviceId();

// Namespace the session cache per tenant reference (token or slug).
export var SESSION_KEY =
  "waiter_session_" + (IS_TOKEN ? CONFIG.qrToken : LEGACY_SLUG || "demo");

// Helpers that depend only on CONFIG.
export function api(path) {
  return (CONFIG.apiBase || "").replace(/\/$/, "") + path;
}

export function money(n) {
  return CONFIG.currency + Number(n || 0).toFixed(2);
}
