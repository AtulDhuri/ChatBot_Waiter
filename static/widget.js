/*!
 * Chatbot Waiter — self-contained embeddable widget.
 * Usage:  <script src="https://your-host/widget.js"
 *                 data-api="https://your-host"
 *                 data-restaurant="demo"></script>
 * Everything (styles, markup, state) is injected by this file. No deps.
 */
(function () {
  "use strict";

  // ---- Config -----------------------------------------------------------
  var currentScript =
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

  // Derive the API base from the widget's own <script src>. This is the heart
  // of "plug and play": a restaurant only needs
  //   <script src="https://your-host/widget.js" data-restaurant="slug"></script>
  // and the widget talks back to the host it was loaded from — no separate
  // data-api to set (and get wrong). An explicit data-api still overrides this
  // for the rare cross-host setup. Same-origin embeds resolve to "" (relative),
  // exactly as before.
  function apiBaseFromScript() {
    try {
      var src = currentScript && currentScript.src;
      if (!src) return "";
      var u = new URL(src, window.location.href);
      // If the widget is served from the same origin as the page, keep using a
      // relative base ("") so it works behind proxies/path rewrites.
      if (u.origin === window.location.origin) return "";
      return u.origin;
    } catch (e) {
      return "";
    }
  }

  // Tenant identity resolution.
  //   `qrToken`  : opaque token from the table sticker (?r=<token>). This is
  //                the ONLY tenant reference a customer holds — the slug/id are
  //                resolved server-side and never sent to the browser.
  //   `legacySlug`: a plaintext slug via data-restaurant / ?restaurant=. Kept
  //                only for same-origin demo/admin pages; real QR flows use a
  //                token. Never shown to the customer.
  var CONFIG = {
    // data-api is now optional: default to the origin the script came from.
    apiBase:
      (currentScript && currentScript.getAttribute("data-api")) ||
      apiBaseFromScript(),
    // ?r= is now an opaque QR token (not a slug). We still read ?restaurant= /
    // data-restaurant as a legacy slug fallback for demo pages.
    qrToken: urlParam("r"),
    legacySlug:
      urlParam("restaurant") ||
      (currentScript && currentScript.getAttribute("data-restaurant")) ||
      null,
    // Optional table number carried by legacy slug links (?t=12). Token flows
    // carry the table inside the token, so this is unused there.
    presetTable: urlParam("t") || urlParam("table") || null,
    currency: "$",
    title: "Waiter",
  };

  // Decide whether ?r= looks like an opaque token vs. a legacy slug. Tokens are
  // URL-safe base64 from secrets.token_urlsafe(16): ~22 chars, include - or _
  // or mixed case, and never look like a tidy human slug. We treat a value as a
  // token when it's long enough; short, lowercase, hyphenated values fall back
  // to the legacy slug path so existing /?r=demo links still work.
  function looksLikeToken(v) {
    if (!v) return false;
    if (v.length < 16) return false; // demo slugs are short
    return /[A-Z_]/.test(v) || v.length >= 20;
  }

  // Resolve the effective tenant reference used only for namespacing local
  // storage (NOT sent anywhere as a slug when it's a token).
  var IS_TOKEN = looksLikeToken(CONFIG.qrToken);
  // A legacy slug is used directly only when ?r= is not a token.
  var LEGACY_SLUG = IS_TOKEN
    ? null
    : (CONFIG.qrToken || CONFIG.legacySlug || "demo");

  // Stable per-browser device id so a rescan can continue this device's cart.
  // Stored in localStorage (survives tab close) under a global key.
  function getDeviceId() {
    var KEY = "waiter_device_id";
    try {
      var id = localStorage.getItem(KEY);
      if (!id) {
        id =
          (window.crypto && window.crypto.randomUUID
            ? window.crypto.randomUUID()
            : "d-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (e) {
      // Private mode / storage blocked: fall back to an ephemeral id.
      return "d-" + Math.random().toString(36).slice(2);
    }
  }
  var DEVICE_ID = getDeviceId();

  // Namespace the session cache per tenant reference (token or slug) so carts
  // for different tables/restaurants on the same device stay separate.
  var SESSION_KEY =
    "waiter_session_" + (IS_TOKEN ? CONFIG.qrToken : LEGACY_SLUG || "demo");

  // ---- State ------------------------------------------------------------
  var state = {
    token: null,
    tableNumber: null,
    orderType: null, // 'dine_in' | 'takeaway'
    customerName: null, // for takeaway
    zone: null, // pricing zone label (from the token/table); display only
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

  // ---- Helpers ----------------------------------------------------------
  function api(path) {
    return (CONFIG.apiBase || "").replace(/\/$/, "") + path;
  }

  function money(n) {
    return CONFIG.currency + Number(n || 0).toFixed(2);
  }

  // Wrap a click handler so its element can't be re-triggered until the
  // handler (and any promise it returns) finishes. Prevents double-taps from
  // firing duplicate requests (e.g. starting two sessions or two orders).
  function _guard(node, handler) {
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
          // Sync handler that may have kicked off async work; brief lock to
          // swallow rapid double-taps.
          setTimeout(release, 600);
        }
      }
    };
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0 && typeof attrs[k] === "function")
        node.addEventListener(
          k.slice(2).toLowerCase(),
          _guard(node, attrs[k])
        );
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    });
    return node;
  }

  function saveSession() {
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          token: state.token,
          tableNumber: state.tableNumber,
          orderType: state.orderType,
          customerName: state.customerName,
          zone: state.zone,
          cart: state.cart,
        })
      );
    } catch (e) {}
  }

  function loadSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      state.token = data.token || null;
      state.tableNumber = data.tableNumber || null;
      state.orderType = data.orderType || null;
      state.customerName = data.customerName || null;
      state.zone = data.zone || null;
      // Cart restore policy:
      //   - Token flow: the SERVER is the source of truth. resolveQrToken runs
      //     on boot and sets the cart authoritatively ([] for a fresh session,
      //     or the stored cart for a continued one). Restoring the cached cart
      //     here would resurrect a previous (ended) session's items before
      //     resolve completes, so we DO NOT restore it for the token flow.
      //   - Legacy slug flow: there is no server resolve on boot, so the cache
      //     is the only cart source; restore it.
      state.cart = (!IS_TOKEN && Array.isArray(data.cart)) ? data.cart : [];
    } catch (e) {}
  }

  // ---- Styles -----------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("waiter-widget-styles")) return;
    var css =
      "" +
      ".wa-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
      ".wa-fab{width:60px;height:60px;border-radius:50%;background:#e4572e;color:#fff;border:none;box-shadow:0 6px 18px rgba(0,0,0,.25);font-size:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;}" +
      ".wa-panel{position:fixed;bottom:92px;right:20px;width:360px;max-width:calc(100vw - 32px);height:70vh;max-height:620px;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;}" +
      ".wa-header{background:#e4572e;color:#fff;padding:14px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center;}" +
      ".wa-header small{display:block;font-weight:400;opacity:.9;font-size:12px;}" +
      ".wa-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;}" +
      ".wa-body{flex:1;overflow-y:auto;padding:14px;background:#f7f7f8;}" +
      ".wa-msg{margin:8px 0;display:flex;}" +
      ".wa-msg.bot{justify-content:flex-start;}" +
      ".wa-msg.user{justify-content:flex-end;}" +
      ".wa-bubble{max-width:80%;padding:10px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;}" +
      ".wa-msg.bot .wa-bubble{background:#fff;color:#222;border:1px solid #eee;border-bottom-left-radius:4px;}" +
      ".wa-msg.user .wa-bubble{background:#e4572e;color:#fff;border-bottom-right-radius:4px;}" +
      ".wa-menu-item{background:#fff;border:1px solid #eee;border-radius:10px;padding:8px 10px;margin:6px 0;display:flex;justify-content:space-between;align-items:center;}" +
      ".wa-menu-item .wa-mi-info{flex:1;padding-right:8px;}" +
      ".wa-menu-item .wa-mi-name{font-weight:600;font-size:14px;}" +
      ".wa-menu-item .wa-mi-desc{font-size:12px;color:#666;}" +
      ".wa-cat{font-weight:700;margin:12px 0 4px;color:#e4572e;font-size:13px;text-transform:uppercase;letter-spacing:.4px;}" +
      ".wa-menu-search{width:100%;position:sticky;top:0;margin-bottom:6px;}" +
      ".wa-menu-count{margin-bottom:6px;}" +
      ".wa-cat-chips{overflow-x:auto;flex-wrap:nowrap;padding-bottom:4px;}" +
      ".wa-chip-on{background:#e4572e;color:#fff;}" +
      ".wa-add{background:#2e9e5b;color:#fff;border:none;border-radius:8px;padding:6px 10px;font-size:13px;cursor:pointer;white-space:nowrap;}" +
      ".wa-mi-action{display:flex;align-items:center;gap:6px;}" +
      ".wa-mi-remove{color:#b53030;font-size:16px;line-height:1;}" +
      ".wa-bill-updating{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(255,255,255,.78);border-radius:10px;font-size:13px;color:#555;font-weight:600;}" +
      ".wa-spinner{width:16px;height:16px;border:2px solid #d9d9d9;border-top-color:#e4572e;border-radius:50%;display:inline-block;animation:wa-spin .7s linear infinite;}" +
      "@keyframes wa-spin{to{transform:rotate(360deg);}}" +
      ".wa-footer{border-top:1px solid #eee;padding:10px;background:#fff;}" +
      ".wa-row{display:flex;gap:8px;}" +
      ".wa-input{flex:1;border:1px solid #ddd;border-radius:10px;padding:10px;font-size:14px;outline:none;}" +
      ".wa-btn{background:#e4572e;color:#fff;border:none;border-radius:10px;padding:10px 14px;font-size:14px;cursor:pointer;}" +
      ".wa-btn.secondary{background:#333;}" +
      ".wa-btn:disabled,.wa-chip:disabled,.wa-add:disabled{opacity:.55;cursor:default;}" +
      ".wa-quick{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}" +
      ".wa-chip{background:#efe9e6;color:#8a3b22;border:none;border-radius:16px;padding:6px 10px;font-size:12px;cursor:pointer;}" +
      ".wa-cart-badge{background:#2e9e5b;color:#fff;border-radius:12px;padding:1px 7px;font-size:11px;margin-left:6px;}" +
      ".wa-bill table{width:100%;border-collapse:collapse;font-size:13px;}" +
      ".wa-bill td{padding:3px 0;}" +
      ".wa-bill .r{text-align:right;}" +
      ".wa-bill .tot{font-weight:700;border-top:1px solid #ccc;}" +
      ".wa-cart-card{background:#fff;border:1px solid #eee;border-radius:10px;padding:10px;}" +
      ".wa-cart-title{font-weight:700;margin-bottom:6px;color:#e4572e;}" +
      ".wa-cart-row{display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid #f0f0f0;}" +
      ".wa-cart-info{flex:1;padding-right:8px;}" +
      ".wa-item-note{margin-top:6px;width:100%;font-size:13px;padding:7px 9px;resize:vertical;min-height:38px;line-height:1.35;font-family:inherit;}" +
      ".wa-qty{display:flex;align-items:center;gap:6px;}" +
      ".wa-qty-btn{width:26px;height:26px;border-radius:6px;border:1px solid #ddd;background:#f7f7f8;font-size:16px;line-height:1;cursor:pointer;color:#333;}" +
      ".wa-qty-n{min-width:18px;text-align:center;font-size:14px;}" +
      ".wa-remove{border:none;background:none;cursor:pointer;font-size:15px;padding:2px 4px;}" +
      ".wa-cart-sum{text-align:right;font-weight:700;margin-top:8px;}" +
      ".wa-cart-actions{display:flex;gap:8px;margin-top:10px;}" +
      ".wa-cart-actions .wa-btn{flex:1;}" +
      ".wa-pay-card{background:#fff;border:1px solid #eee;border-radius:12px;padding:14px;text-align:center;}" +
      ".wa-pay-amt{font-size:20px;font-weight:800;color:#2e9e5b;}" +
      ".wa-qr{display:flex;justify-content:center;margin:12px 0;min-height:200px;align-items:center;}" +
      ".wa-qr img,.wa-qr canvas{display:block;}" +
      ".wa-pay-link{display:inline-block;margin:6px 0;background:#2e9e5b;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-size:14px;}" +
      ".wa-order-card{background:#eafaf0;border:1px solid #bfe8cf;border-radius:12px;padding:14px;text-align:center;}" +
      ".wa-order-no{font-size:22px;font-weight:800;color:#2e9e5b;margin-bottom:4px;}" +
      ".wa-status-card{background:#fff;border:1px solid #ececec;border-radius:14px;padding:14px;box-shadow:0 2px 10px rgba(0,0,0,.04);}" +
      ".wa-status-title{font-weight:700;font-size:14px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;}" +
      ".wa-status-live{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#2e9e5b;text-transform:uppercase;letter-spacing:.4px;}" +
      ".wa-live-dot{width:7px;height:7px;border-radius:50%;background:#2e9e5b;box-shadow:0 0 0 0 rgba(46,158,91,.5);animation:wa-pulse 1.8s infinite;}" +
      "@keyframes wa-pulse{0%{box-shadow:0 0 0 0 rgba(46,158,91,.5);}70%{box-shadow:0 0 0 6px rgba(46,158,91,0);}100%{box-shadow:0 0 0 0 rgba(46,158,91,0);}}" +
      ".wa-status-row{border-top:1px solid #f1f1f1;padding:12px 0 4px;}" +
      ".wa-status-row:first-of-type{border-top:none;padding-top:2px;}" +
      ".wa-status-head{display:flex;justify-content:space-between;align-items:center;}" +
      ".wa-status-no{font-weight:700;font-size:13px;color:#222;}" +
      ".wa-status-badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.3px;}" +
      ".wa-st-paid{background:#eef2ff;color:#3b53c0;}" +
      ".wa-st-preparing{background:#fff5e0;color:#a5720a;}" +
      ".wa-st-served{background:#eafaf0;color:#2e9e5b;}" +
      ".wa-st-cancelled{background:#fdecec;color:#b53030;}" +
      // ---- Connected progress tracker ----
      ".wa-track{position:relative;margin:16px 4px 6px;}" +
      ".wa-track-line{position:absolute;top:11px;left:11px;right:11px;height:3px;background:#ececec;border-radius:3px;overflow:hidden;}" +
      ".wa-track-fill{height:100%;background:#2e9e5b;border-radius:3px;transition:width .45s ease;}" +
      ".wa-track-nodes{position:relative;display:flex;justify-content:space-between;}" +
      ".wa-node{display:flex;flex-direction:column;align-items:center;gap:5px;flex:1;}" +
      ".wa-node-dot{width:23px;height:23px;border-radius:50%;background:#fff;border:2px solid #dcdcdc;color:#aaa;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;transition:all .3s ease;}" +
      ".wa-node-label{font-size:10px;color:#9a9a9a;font-weight:600;transition:color .3s ease;}" +
      ".wa-node.done .wa-node-dot{background:#2e9e5b;border-color:#2e9e5b;color:#fff;}" +
      ".wa-node.done .wa-node-label{color:#2e9e5b;}" +
      ".wa-node.active .wa-node-dot{background:#fff;border-color:#2e9e5b;color:#2e9e5b;box-shadow:0 0 0 0 rgba(46,158,91,.45);animation:wa-pulse 1.8s infinite;}" +
      ".wa-node.active .wa-node-label{color:#2e9e5b;font-weight:700;}" +
      ".wa-status-cancel-note{font-size:12px;color:#b53030;margin:10px 0 2px;}" +
      ".wa-status-total{display:flex;justify-content:space-between;align-items:baseline;margin-top:10px;padding-top:9px;border-top:1px dashed #eee;}" +
      ".wa-status-total-label{font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.4px;font-weight:600;}" +
      ".wa-status-total-amt{font-size:15px;font-weight:800;color:#222;}" +
      "@media (max-width:600px){" +
      // Full-screen chat on mobile: edge-to-edge, no rounded corners, uses the
      // dynamic viewport height so the mobile browser's URL bar doesn't crop it.
      ".wa-panel{top:0;left:0;right:0;bottom:0;width:100%;max-width:100%;" +
      "height:100vh;height:100dvh;max-height:none;border-radius:0;}" +
      // Give the header a little safe-area padding for notched phones.
      ".wa-header{padding-top:calc(14px + env(safe-area-inset-top));}" +
      // Hide the floating button while the full-screen chat is open.
      ".wa-open .wa-fab{display:none;}" +
      // Prevent the page behind from scrolling under the full-screen chat.
      ".wa-open,.wa-open body{overflow:hidden;}" +
      "}";
    var style = el("style", { id: "waiter-widget-styles" });
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // ---- UID refs ---------------------------------------------------------
  var ui = {};

  // The cart view currently rendered on screen (set by showCart). The
  // availability poller uses this to refresh the visible cart in place after
  // reconciling sold-out items. { card, rerender } or null.
  var activeCart = null;

  // Menu rows currently on screen, so any cart change (from the menu, the cart
  // view, a sold-out reconcile, etc.) can flip their Add/Added state in sync.
  // Each entry is { row: <DOM node>, render: fn }. The list is pruned of rows
  // that have left the DOM on every refresh, so it stays small and cheap — no
  // selector scans, no full re-render of the menu.
  var menuRows = [];

  function refreshMenuRows() {
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

  // Availability polling state. _availTimer is the scheduled next poll;
  // _availInFlight prevents overlapping requests; _availFailStreak backs off
  // after repeated failures so a flaky network doesn't hammer the server.
  var _availTimer = null;
  var _availInFlight = false;
  var _availFailStreak = 0;
  var AVAIL_POLL_MS = 15000; // base cadence while idle on an open cart
  var AVAIL_POLL_MAX_MS = 120000; // cap when backing off after failures

  function addMessage(text, who, node) {
    var bubble = el("div", { class: "wa-bubble" });
    if (node) bubble.appendChild(node);
    else bubble.textContent = text;
    var msg = el("div", { class: "wa-msg " + (who || "bot") }, [bubble]);
    ui.body.appendChild(msg);
    ui.body.scrollTop = ui.body.scrollHeight;
    return msg;
  }

  // ---- API calls --------------------------------------------------------
  function startSession(label) {
    var takeaway = state.orderType === "takeaway";
    return fetch(api("/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_type: state.orderType || "dine_in",
        table_number: takeaway ? "" : label,
        customer_name: takeaway ? label : "",
        // Legacy slug path only (demo/admin pages). Token flows never call
        // /session — they resolve a session from the opaque token instead.
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
        if (takeaway) state.customerName = label;
        // Prefer the server's stored display name (lets two outlets share a
        // name while keeping distinct slugs).
        if (data.restaurant_name) {
          CONFIG.title = data.restaurant_name;
          if (ui.titleEl) ui.titleEl.firstChild.textContent = CONFIG.title;
        }
        saveSession();
        return data;
      });
  }

  // Resolve the opaque QR token (?r=<token>) into a customer-safe session.
  // The server maps token -> (tenant, table) internally; we only ever receive
  // display name, table number, zone and cart. On a same-device rescan the
  // server may `continue` an existing session (keeping the cart).
  var _qrResolving = null;
  function resolveQrToken() {
    // Coalesce concurrent calls (boot + panel-open) into one request.
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
        // Continue the device's cart when the server reused a live session.
        state.cart = Array.isArray(data.cart) ? data.cart : [];
        applyRestaurantName(data.restaurant_name || CONFIG.title);
        saveSession();

        // The table is known from the token, so skip the dine-in/table prompt
        // and go straight to chat. Only (re)render if the panel is built.
        if (ui.panel) {
          renderChat(); // fresh, enabled input (replaces any loading state)
          ui.body.innerHTML = "";
          var where = state.tableNumber && state.tableNumber !== "-"
            ? " at table " + state.tableNumber
            : "";
          addMessage(
            (data.continued ? "Welcome back" : "Welcome") + " to " +
              CONFIG.title + "!" + (where ? " You're" + where + "." : "") +
              " Ask about the menu, place an order, or request the bill.",
            "bot"
          );
          renderQuickChips();
        }
        updateCartBadge();
        // A continued session may already have orders placed before this load;
        // resume tracking so their live status (incl. Served) keeps updating.
        resumeStatusPollingIfNeeded();
        _qrResolving = null;
        return data;
      })
      .catch(function (err) {
        // Invalid / revoked / expired token. Make the panel show a clear,
        // tenant-agnostic error. Never reveal anything about the tenant.
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

  // Re-resolve from the stored token after a session expires (HTTP 440). Used
  // by API callers to transparently get a fresh session without losing the
  // guest's place. Returns a promise resolving to the new signed token.
  function reauthFromToken() {
    if (!IS_TOKEN || !CONFIG.qrToken) return Promise.reject(new Error("no token"));
    // Force a fresh resolve (bypass the in-flight coalescer's cached result).
    _qrResolving = null;
    return resolveQrToken().then(function () {
      return state.token;
    });
  }

  // POST JSON to a session-bound endpoint with transparent re-auth. If the
  // server replies 440 (session expired), we re-resolve from the durable QR
  // token, patch the new session id into the body, and retry once. Any other
  // non-2xx is surfaced as an Error carrying the server's detail message.
  // `bodyFn` returns the request body fresh each attempt so the retry picks up
  // the refreshed session id. Falls back to a plain error when there's no token
  // to re-auth with (legacy slug flow).
  function postJson(path, bodyFn, _retried) {
    return fetch(api(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Device pinning: the server binds the session to this id + the
        // browser's User-Agent and rejects mismatches as replay attempts.
        "X-Device-Id": DEVICE_ID,
      },
      body: JSON.stringify(bodyFn()),
    }).then(function (r) {
      if (r.status === 440 && IS_TOKEN && !_retried) {
        // Session expired: silently mint a new one and retry once.
        return reauthFromToken().then(function () {
          return postJson(path, bodyFn, true);
        });
      }
      if (r.status === 403) {
        // Device/UA pinning rejected this session (likely a replayed token).
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

  // GET a session-bound endpoint with the same transparent re-auth as
  // postJson: on 440 we re-resolve from the durable QR token and retry once.
  // `urlFn` returns the path fresh each attempt so the retry uses the new
  // session id.
  function getJson(urlFn, _retried) {
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

  function fetchMenu() {
    // Tenant scoping for the menu:
    //   - Token flow: the server derives the tenant (and zone) from the
    //     session, so we pass ONLY session_id — the slug never leaves the
    //     server. No menu is fetched before a session exists.
    //   - Legacy slug flow: pass the slug (demo/admin pages only).
    var url;
    if (LEGACY_SLUG) {
      url = "/menu?restaurant=" + encodeURIComponent(LEGACY_SLUG);
      if (state.token) url += "&session_id=" + encodeURIComponent(state.token);
    } else {
      if (!state.token) {
        // Token flow with no session yet: nothing to scope to.
        return Promise.resolve({ items: [], categories: {} });
      }
      url = "/menu?session_id=" + encodeURIComponent(state.token);
    }
    return fetch(api(url)).then(function (r) {
      if (!r.ok) throw new Error("no menu");
      return r.json();
    }).then(function (data) {
      // Cache items so natural-language ordering can match dish names without
      // an extra round trip.
      if (data && data.items) state.menu = data.items;
      // The menu carries the restaurant's real display name (e.g. "Demo 2"),
      // which we can't derive from the slug ("demov2"). Apply it so the header
      // and messages show the proper name even before a session starts.
      if (data && data.restaurant_name) applyRestaurantName(data.restaurant_name);
      return data;
    });
  }

  // Set the restaurant's display name everywhere it's shown (config + header),
  // but only when it actually differs, to avoid needless DOM churn. If the
  // pre-session welcome prompt is currently on screen, re-render it so it
  // picks up the corrected name instead of the slug-derived placeholder.
  function applyRestaurantName(name) {
    name = String(name || "").trim();
    if (!name || name === CONFIG.title) return;
    CONFIG.title = name;
    if (ui.titleEl && ui.titleEl.firstChild) {
      ui.titleEl.firstChild.textContent = name;
    }
    // Only the legacy pre-session prompt bakes the name into its text; re-render
    // it so "Welcome to <slug>" becomes "Welcome to <real name>". Never do this
    // for the token flow (it has no table prompt and resolve owns the UI).
    if (!IS_TOKEN && state.open && !state.token && ui.body) {
      renderTablePrompt();
    }
  }

  // Cheap, non-blocking lookup of the restaurant's display name via /menu.
  // Never throws: a missing menu just leaves the slug-derived title in place.
  function prefetchRestaurantName() {
    try {
      fetchMenu().catch(function () {});
    } catch (e) {}
  }

  // Ensure the menu is cached (fetch once if we haven't yet).
  function ensureMenu() {
    if (state.menu && state.menu.length) return Promise.resolve(state.menu);
    return fetchMenu()
      .then(function (d) { return (d && d.items) || []; })
      .catch(function () { return []; });
  }

  function askQuestion(question) {
    return postJson("/ask", function () {
      return { session_id: state.token, question: question };
    });
  }

  // Server-side NL order parsing (gated LLM fallback). No secrets here — the
  // OpenAI key lives only on the server; we just send the guest's text.
  function parseOrderServer(text) {
    return postJson("/order/parse", function () {
      return { session_id: state.token, text: text };
    });
  }

  function fetchPlaceOrder(orderType) {
    return postJson("/order", function () {
      return {
        session_id: state.token,
        cart: state.cart,
        order_type: orderType || "dine_in",
        payment_status: "paid_unverified",
      };
    });
  }

  function placeOrder(orderType) {
    if (!state.cart.length) {
      addMessage("Your order is empty.", "bot");
      return;
    }
    // Returned so the triggering button stays disabled until this resolves.
    return fetchPlaceOrder(orderType)
      .then(function (o) {
        // Stop tracking the pre-order bill BEFORE clearing the cart so the
        // empty-cart refresh doesn't turn the placed bill into an "empty"
        // message. The order confirmation card replaces it.
        state.billNode = null;
        state.billPayBtn = null;
        clearCart();
        var isTakeaway = o.order_type === "takeaway";
        var card = el("div", { class: "wa-order-card" }, [
          el("div", { class: "wa-order-no" }, ["Order " + o.order_no]),
          el("div", {}, [
            (isTakeaway ? "Takeaway" : "Dine-in") +
              " · Total paid: " +
              money(o.total),
          ]),
          el("div", { class: "wa-mi-desc" }, [
            isTakeaway
              ? "We'll call your number when it's ready for pickup."
              : "Sent to the kitchen. We'll bring it to your table.",
          ]),
        ]);
        addMessage("✅ Order placed!", "bot");
        addMessage(null, "bot", card);
        // Begin showing this session's live order statuses to the customer.
        startStatusPolling();
      })
      .catch(function (e) {
        addMessage("Couldn't place the order: " + e.message, "bot");
      });
  }

  // ---- Customer order-status tracking -----------------------------------
  // The customer sees ONLY their own session's orders (server-enforced via the
  // session token). Statuses flow Paid -> Preparing -> Served. Once the server
  // reports the session ended (all orders served), we stop polling.
  var STATUS_POLL_MS = 6000;
  var STATUS_STEPS = ["Paid", "Preparing", "Served"];

  function statusClass(s) {
    return "wa-st-" + String(s || "").toLowerCase();
  }

  function renderStatus(data) {
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
        el("span", { class: "wa-status-badge " + statusClass(o.status) }, [o.status]),
      ]);

      var row = el("div", { class: "wa-status-row" }, [head]);

      if (!isCancelled) {
        // Connected Paid -> Preparing -> Served tracker. The fill width is
        // derived from how far the order has advanced; each node shows a tick
        // once reached and the active node is highlighted.
        var pct = reached <= 0 ? 0 : (reached / (STATUS_STEPS.length - 1)) * 100;
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

    // Replace the previous status card in place so the transcript doesn't fill
    // up with one card per poll.
    if (state.statusNode && state.statusNode.parentNode) {
      state.statusNode.parentNode.replaceChild(card, state.statusNode);
      state.statusNode = card;
    } else {
      addMessage(null, "bot", card);
      state.statusNode = card;
    }
  }

  function pollStatusOnce() {
    if (!state.token) return Promise.resolve();
    return getJson(function () {
      return "/my-orders?session_id=" + encodeURIComponent(state.token);
    })
      .then(function (data) {
        renderStatus(data);
        if (data && data.session_ended) {
          stopStatusPolling();
          // The session is over (all orders served). Wipe every trace of it
          // from this device so a reorder/rescan starts completely fresh and
          // can never inherit the previous cart or dead session token.
          endLocalSession();
          addMessage(
            "All your orders have been served. Thanks for dining with us! " +
              "Scan the QR again to start a new order.",
            "bot"
          );
        }
      })
      .catch(function () {
        // Transient error — keep polling; the next tick may succeed.
      });
  }

  function startStatusPolling() {
    if (state.statusTimer) return; // already polling
    pollStatusOnce();
    state.statusTimer = setInterval(pollStatusOnce, STATUS_POLL_MS);
  }

  function stopStatusPolling() {
    if (state.statusTimer) {
      clearInterval(state.statusTimer);
      state.statusTimer = null;
    }
  }

  // Resume live status tracking whenever we have a session but aren't already
  // polling. This matters after a page reload (boot restores the token but the
  // transcript — and the old poll timer — are gone) and after the token flow
  // resolves/continues a session that may already have in-flight orders. The
  // first poll re-creates the "Your orders" card, so a status change made by
  // the kitchen while the customer was away (e.g. Preparing -> Served) shows
  // up instead of the card staying frozen on its last value.
  function resumeStatusPollingIfNeeded() {
    if (!state.token) return;
    if (state.statusTimer) return;
    startStatusPolling();
  }

  // The server rejected this session for a device/UA mismatch (replay
  // defense). Drop the local session and ask the guest to rescan. We do NOT
  // auto-reauth here: a mismatch means this client isn't the one the token was
  // bound to, so silently minting a new session would defeat the protection.
  var _pinningHandled = false;
  function handlePinningRejection() {
    if (_pinningHandled) return; // avoid duplicate messages on parallel calls
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

  // Ask dine-in vs takeaway, then place.
  function chooseAndPlaceOrder() {
    if (!state.cart.length) {
      addMessage("Your order is empty.", "bot");
      return;
    }
    // Order type was chosen at the start, so place directly.
    return placeOrder(state.orderType || "dine_in");
  }

  function fetchPay() {
    return postJson("/pay", function () {
      return { session_id: state.token, cart: state.cart };
    });
  }

  function fetchBill() {
    return postJson("/bill", function () {
      return { session_id: state.token, cart: state.cart, format: "json" };
    });
  }

  // ---- Cart -------------------------------------------------------------
  function addToCart(item) {
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

  function cartCount() {
    return state.cart.reduce(function (n, c) {
      return n + c.quantity;
    }, 0);
  }

  function updateCartBadge() {
    if (ui.badge) {
      var c = cartCount();
      ui.badge.textContent = c;
      ui.badge.style.display = c > 0 ? "inline-block" : "none";
    }
    // Every cart mutation flows through here, so it's the natural place to
    // start polling when the cart becomes non-empty and stop it when it
    // empties. refreshPolling is defined later in the module; guard in case
    // this runs during very early init.
    if (typeof refreshPolling === "function") refreshPolling();
    // Likewise, keep any visible bill in sync with the cart so the guest never
    // has to re-type "bill" after adding/removing an item.
    if (typeof refreshBillIfShown === "function") refreshBillIfShown();
    // And flip any on-screen menu rows between Add / Added + ✕ so the menu,
    // cart and badge never disagree about what's in the order.
    if (typeof refreshMenuRows === "function") refreshMenuRows();
    // Keep the on-screen "Your order" card live when items are added/removed
    // from elsewhere (e.g. the menu). The card's own rerender() calls back into
    // updateCartBadge, so _syncingCart guards against infinite recursion.
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
      // The cart view has left the transcript; drop the stale handle.
      activeCart = null;
    }
  }
  var _syncingCart = false;

  function findCartItem(name) {
    return state.cart.filter(function (c) {
      return c.name === name;
    })[0];
  }

  function changeQty(name, delta) {
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

  function removeItem(name) {
    state.cart = state.cart.filter(function (c) {
      return c.name !== name;
    });
    saveSession();
    updateCartBadge();
  }

  function clearCart() {
    state.cart = [];
    saveSession();
    updateCartBadge();
  }

  // Fully reset this device's local session state. Used when the server says
  // the session ended (all orders served): we drop the cart, the dead session
  // token, and the cached sessionStorage blob so the next load/rescan mints a
  // brand-new session and can never show the previous order's items.
  function endLocalSession() {
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

  function cartTotal() {
    return state.cart.reduce(function (n, c) {
      return n + (Number(c.price) || 0) * c.quantity;
    }, 0);
  }

  // Reconcile the local cart with the server's `dropped` list. An item can go
  // sold out (or be pulled from the menu) after it was added to the cart; the
  // server refuses to bill it, so we remove it locally too — otherwise the
  // cart would show a higher subtotal than the real bill/pay total. Whenever
  // something is dropped we tell the guest exactly what and why. Returns true
  // if anything was dropped.
  function reconcileDropped(dropped) {
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

  // ---- Live availability sync -------------------------------------------
  // Re-check the cart against the current menu so a dish that sells out (or is
  // pulled from the menu, or re-priced) while the guest is idle is caught and
  // the guest is told — without them having to tap Bill/Pay. The server stays
  // the source of truth: /bill and /pay still re-price, this is just a faster,
  // friendlier heads-up. Returns a promise that resolves to true if the cart
  // changed.
  function syncAvailability() {
    // Nothing to reconcile without a session or an empty cart.
    if (!state.token || !state.cart.length) return Promise.resolve(false);
    if (_availInFlight) return Promise.resolve(false);
    _availInFlight = true;

    return fetchMenu()
      .then(function (data) {
        _availFailStreak = 0;
        var items = (data && data.items) || [];
        // Index the fresh menu by lowercased name for quick lookup.
        var byName = {};
        items.forEach(function (it) {
          byName[String(it.name).toLowerCase()] = it;
        });

        var dropped = [];
        var repriced = []; // {name, from, to}
        state.cart.forEach(function (ci) {
          var fresh = byName[String(ci.name).toLowerCase()];
          // Gone from the menu entirely, or explicitly sold out -> drop it.
          if (!fresh || fresh.available === false) {
            dropped.push(ci.name);
            return;
          }
          // Price drifted (e.g. manager edited it). Correct the cart line so
          // the displayed subtotal matches what the bill will actually charge.
          if (
            fresh.price != null &&
            Math.abs(Number(fresh.price) - Number(ci.price)) > 0.001
          ) {
            repriced.push({ name: ci.name, from: Number(ci.price), to: Number(fresh.price) });
            ci.price = Number(fresh.price);
          }
        });

        var changed = false;

        if (dropped.length) {
          // reconcileDropped removes the items, saves, updates the badge and
          // messages the guest with the exact names.
          reconcileDropped(dropped);
          changed = true;
        }

        if (repriced.length) {
          saveSession();
          var msg = repriced
            .map(function (r) {
              return r.name + " is now " + money(r.to) + " (was " + money(r.from) + ")";
            })
            .join("; ");
          addMessage("Heads up — a price changed: " + msg + ".", "bot");
          changed = true;
        }

        if (changed) refreshVisibleCart();
        return changed;
      })
      .catch(function () {
        // Network/menu error: never disturb the guest, just back off a bit.
        _availFailStreak += 1;
        return false;
      })
      .then(function (result) {
        _availInFlight = false;
        return result;
      });
  }

  // Re-render the cart card if it's still the one on screen. If the cart went
  // empty, tell the guest once.
  function refreshVisibleCart() {
    if (!activeCart) return;
    // If the card was detached (guest navigated to another view) drop the ref.
    if (!activeCart.card || !activeCart.card.isConnected) {
      activeCart = null;
      return;
    }
    if (!state.cart.length) {
      activeCart.rerender(); // shows the "Order is now empty" state
      addMessage("Your cart is now empty. Browse the menu to add items.", "bot");
      activeCart = null;
      return;
    }
    activeCart.rerender();
  }

  // ---- Availability polling lifecycle -----------------------------------
  // Poll only while it's useful: panel open, a session exists, and the cart is
  // non-empty. Each tick reschedules itself (no setInterval, so a slow request
  // can never overlap the next tick). Backoff grows the gap after failures.
  function nextPollDelay() {
    var base = AVAIL_POLL_MS * Math.pow(2, Math.min(_availFailStreak, 3));
    var capped = Math.min(base, AVAIL_POLL_MAX_MS);
    // Jitter ±15% so many open tabs don't sync in lockstep.
    var jitter = capped * 0.15 * (Math.random() * 2 - 1);
    return Math.round(capped + jitter);
  }

  function shouldPoll() {
    return !!(state.open && state.token && state.cart.length);
  }

  function scheduleAvailabilityPoll() {
    clearTimeout(_availTimer);
    if (!shouldPoll()) return;
    _availTimer = setTimeout(function () {
      // Don't poll a backgrounded tab; we sync on visibility/focus instead.
      var hidden = typeof document !== "undefined" && document.hidden;
      var run = hidden ? Promise.resolve(false) : syncAvailability();
      run.then(function () {
        scheduleAvailabilityPoll(); // reschedule regardless of outcome
      });
    }, nextPollDelay());
  }

  // Call after anything that changes open-state or the cart, to start or stop
  // polling as appropriate.
  function refreshPolling() {
    if (shouldPoll()) scheduleAvailabilityPoll();
    else clearTimeout(_availTimer);
  }

  // An immediate, foreground-triggered sync: when the guest returns to the tab
  // or refocuses the window, re-check right away (sold-out may have happened
  // while they were away) then resume the normal cadence.
  function syncNowIfVisible() {
    if (!shouldPoll()) return;
    if (typeof document !== "undefined" && document.hidden) return;
    syncAvailability().then(function () {
      scheduleAvailabilityPoll();
    });
  }

  // ---- Flows ------------------------------------------------------------
  function menuItemRow(item) {
    // A dish flagged unavailable is shown greyed as "Sold out" and can't be
    // added. available is only ever false when explicitly set by the server.
    var soldOut = item.available === false;
    var info = el("div", { class: "wa-mi-info" }, [
      el("div", { class: "wa-mi-name" }, [
        item.name +
          (item.price != null ? "  " + money(item.price) : "") +
          (soldOut ? "  · Sold out" : ""),
      ]),
      item.description
        ? el("div", { class: "wa-mi-desc" }, [item.description])
        : null,
    ]);
    // Action area: a plain "Add" button until the dish is in the cart, then a
    // disabled "Added" button alongside a "×" control to remove it. Re-rendered
    // in place on each click so it always mirrors the cart.
    var action = el("div", { class: "wa-mi-action" }, []);

    function renderAction() {
      action.innerHTML = "";
      if (soldOut) {
        action.appendChild(
          el("button", { class: "wa-add", disabled: "disabled" }, ["Sold out"])
        );
        return;
      }
      var inCart = !!findCartItem(item.name);
      if (inCart) {
        action.appendChild(
          el("button", { class: "wa-add", disabled: "disabled" }, ["Added"])
        );
        action.appendChild(
          el(
            "button",
            {
              class: "wa-remove wa-mi-remove",
              title: "Remove from order",
              "aria-label": "Remove " + item.name + " from order",
              // removeItem -> updateCartBadge -> refreshMenuRows keeps every
              // visible row (including this one) in sync; no manual call needed.
              onclick: function () {
                removeItem(item.name);
              },
            },
            ["✕"]
          )
        );
      } else {
        action.appendChild(
          el(
            "button",
            {
              class: "wa-add",
              onclick: function () {
                addToCart(item);
              },
            },
            ["Add"]
          )
        );
      }
    }
    renderAction();

    var row = el("div", { class: "wa-menu-item" }, [info, action]);
    if (soldOut) row.style.opacity = "0.5";
    // Track this row so cart changes made anywhere flip its Add/Added state.
    menuRows.push({ row: row, render: renderAction });
    return row;
  }

  function showMenu() {
    addMessage("Here's our menu:", "bot");
    fetchMenu()
      .then(function (data) {
        if (!data.items || !data.items.length) {
          addMessage("The menu isn't loaded yet. Please check back soon.", "bot");
          return;
        }

        // Trust the menu's own currency (items are priced per-tenant). This
        // overrides the global default so e.g. a ₹ menu never renders as $.
        var itemCurrency =
          (data.items[0] && data.items[0].currency) || CONFIG.currency;
        if (itemCurrency) CONFIG.currency = itemCurrency;

        var items = data.items;
        var cats = Object.keys(data.categories);
        var wrap = el("div", {});
        var activeCat = "all"; // current category filter

        // Search box — filters the already-loaded menu live (good for big menus).
        var search = el("input", {
          class: "wa-input wa-menu-search",
          type: "search",
          placeholder: "🔍 Search dishes…",
          "aria-label": "Search menu",
        });

        // Category chips (only shown when there's more than one category).
        var chipBar = el("div", { class: "wa-quick wa-cat-chips" });
        var chipEls = {};
        function makeChip(key, label) {
          var c = el(
            "button",
            {
              class: "wa-chip",
              onclick: function () {
                activeCat = key;
                Object.keys(chipEls).forEach(function (k) {
                  chipEls[k].className =
                    "wa-chip" + (k === key ? " wa-chip-on" : "");
                });
                renderList(search.value);
              },
            },
            [label]
          );
          chipEls[key] = c;
          return c;
        }
        if (cats.length > 1) {
          chipBar.appendChild(makeChip("all", "All"));
          cats.forEach(function (cat) {
            chipBar.appendChild(makeChip(cat, cat));
          });
          chipEls.all.className = "wa-chip wa-chip-on";
        }

        var count = el("div", { class: "wa-mi-desc wa-menu-count" }, []);
        var results = el("div", {});
        wrap.appendChild(search);
        if (cats.length > 1) wrap.appendChild(chipBar);
        wrap.appendChild(count);
        wrap.appendChild(results);

        function renderList(q) {
          q = (q || "").trim().toLowerCase();
          results.innerHTML = "";
          var shown = 0;
          cats.forEach(function (cat) {
            if (activeCat !== "all" && cat !== activeCat) return;
            var matches = data.categories[cat].filter(function (it) {
              if (!q) return true;
              return (
                (it.name || "").toLowerCase().indexOf(q) !== -1 ||
                (it.description || "").toLowerCase().indexOf(q) !== -1 ||
                (it.category || "").toLowerCase().indexOf(q) !== -1
              );
            });
            if (!matches.length) return;
            results.appendChild(el("div", { class: "wa-cat" }, [cat]));
            matches.forEach(function (item) {
              results.appendChild(menuItemRow(item));
              shown++;
            });
          });
          if (!shown) {
            results.appendChild(
              el("div", { class: "wa-mi-desc" }, [
                q ? 'No dishes match "' + q + '".' : "No dishes in this category.",
              ])
            );
          }
          count.textContent = shown + " item" + (shown === 1 ? "" : "s") +
            (activeCat === "all" && !q ? "" : " shown");
        }

        var _t = null;
        search.addEventListener("input", function () {
          clearTimeout(_t);
          _t = setTimeout(function () {
            renderList(search.value);
          }, 120);
        });

        renderList("");
        addMessage(null, "bot", wrap);
      })
      .catch(function () {
        addMessage("Sorry, I couldn't load the menu right now.", "bot");
      });
  }

  function showCart() {
    if (!state.cart.length) {
      addMessage("Your order is empty. Browse the menu to add items.", "bot");
      return;
    }
    // Snapshot the cart so we re-render on every edit for live feedback.
    var card = el("div", { class: "wa-cart-card" });

    function rerender() {
      card.innerHTML = "";
      card.appendChild(el("div", { class: "wa-cart-title" }, ["Your order"]));

      if (!state.cart.length) {
        card.appendChild(
          el("div", { class: "wa-mi-desc" }, ["Order is now empty."])
        );
        updateCartBadge();
        return;
      }

      state.cart.forEach(function (ci) {
        var name = ci.name;
        // Per-item free-text note (e.g. "no onions"). Stored on the cart line
        // and sent with the order so the kitchen and manager can see it.
        // Per-item free-text note as a textarea. We attach the input handler
        // with addEventListener directly (NOT via el's on* attribute) because
        // el wraps on* handlers in _guard, which disables the field for 600ms
        // after each event — on a text field that drops focus mid-typing.
        var note = el("textarea", {
          class: "wa-input wa-item-note",
          rows: "2",
          maxlength: "200",
          placeholder: "Add a note (e.g. no onions)",
          "aria-label": "Instructions for " + name,
        });
        note.value = ci.instructions || "";
        note.addEventListener("input", function (e) {
          ci.instructions = e.target.value;
          saveSession();
        });
        var line = el("div", { class: "wa-cart-row" }, [
          el("div", { class: "wa-cart-info" }, [
            el("div", { class: "wa-mi-name" }, [name]),
            el("div", { class: "wa-mi-desc" }, [
              money(ci.price) + " each · " + money(ci.price * ci.quantity),
            ]),
            note,
          ]),
          el("div", { class: "wa-qty" }, [
            el(
              "button",
              {
                class: "wa-qty-btn",
                "aria-label": "Decrease " + name,
                onclick: function () {
                  changeQty(name, -1);
                  rerender();
                },
              },
              ["−"]
            ),
            el("span", { class: "wa-qty-n" }, [String(ci.quantity)]),
            el(
              "button",
              {
                class: "wa-qty-btn",
                "aria-label": "Increase " + name,
                onclick: function () {
                  changeQty(name, 1);
                  rerender();
                },
              },
              ["+"]
            ),
            el(
              "button",
              {
                class: "wa-remove",
                "aria-label": "Remove " + name,
                onclick: function () {
                  removeItem(name);
                  rerender();
                },
              },
              ["🗑"]
            ),
          ]),
        ]);
        card.appendChild(line);
      });

      card.appendChild(
        el("div", { class: "wa-cart-sum" }, [
          "Subtotal: " + money(cartTotal()),
        ])
      );
      card.appendChild(
        el("div", { class: "wa-cart-actions" }, [
          el(
            "button",
            {
              class: "wa-btn",
              onclick: function () {
                showBill();
              },
            },
            ["Get bill"]
          ),
          el(
            "button",
            {
              class: "wa-btn secondary",
              onclick: function () {
                if (state.cart.length) {
                  clearCart();
                  rerender();
                  addMessage("Your order has been cancelled.", "bot");
                }
              },
            },
            ["Cancel order"]
          ),
        ])
      );
      updateCartBadge();
    }

    rerender();
    addMessage("Here's your current order. Tap +/− to adjust or 🗑 to remove:", "bot");
    addMessage(null, "bot", card);
    // Expose this cart view so the availability poller can refresh it in place
    // when an item sells out while the guest is just looking at the cart. We
    // keep the card node too, so we can tell whether this view is still the
    // one on screen (a newer showCart would replace the handle).
    activeCart = { card: card, rerender: rerender };
  }

  // Lazily load a QR library (used only when the guest wants to pay).
  var _qrLoading = null;
  function ensureQrLib() {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    if (_qrLoading) return _qrLoading;
    _qrLoading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      // Vendored locally so payment QRs work with no external dependency.
      // Served from the same origin as the widget (apiBase or current host).
      s.src = api("/qrcode.min.js");
      s.onload = function () {
        resolve(window.QRCode);
      };
      s.onerror = function () {
        reject(new Error("qr lib failed"));
      };
      document.head.appendChild(s);
    });
    return _qrLoading;
  }

  function showPayment() {
    if (!state.cart.length) {
      addMessage("Your order is empty, nothing to pay for yet.", "bot");
      return;
    }
    fetchPay()
      .then(function (pay) {
        // If an item sold out between adding it and paying, the server already
        // excluded it from `pay.amount`. Reconcile the local cart and tell the
        // guest so the amount they're about to pay makes sense.
        if (reconcileDropped(pay.dropped)) {
          if (!state.cart.length) {
            addMessage(
              "Your cart is now empty, so there's nothing to pay for. " +
                "Please add some items.",
              "bot"
            );
            return;
          }
          // Re-fetch so the QR/amount reflect the reconciled cart exactly.
          showPayment();
          return;
        }
        if (!pay.configured || !pay.upi_uri) {
          // No UPI set up — still let the guest place the order (demo/testing).
          var fb = el("div", { class: "wa-pay-card" }, [
            el("div", { class: "wa-pay-amt" }, [money(pay.amount)]),
            el("div", { class: "wa-mi-desc" }, [
              "Online payment isn't set up yet. Pay at the counter, then place "
                + "your order.",
            ]),
            el(
              "button",
              {
                class: "wa-btn",
                style: "margin-top:10px;width:100%",
                onclick: function () {
                  return chooseAndPlaceOrder();
                },
              },
              ["✅ I've paid — place my order"]
            ),
          ]);
          addMessage(null, "bot", fb);
          return;
        }

        var card = el("div", { class: "wa-pay-card" }, [
          el("div", { class: "wa-pay-amt" }, ["Pay " + money(pay.amount)]),
          el("div", { class: "wa-mi-desc" }, ["to " + pay.payee_name]),
        ]);
        var qrBox = el("div", { class: "wa-qr" });
        card.appendChild(qrBox);

        // A tappable link is the always-works path on a phone: it opens the
        // UPI app directly with the amount pre-filled.
        var payLink = el(
          "a",
          { class: "wa-pay-link", href: pay.upi_uri },
          ["📲 Open in UPI app"]
        );
        card.appendChild(payLink);
        card.appendChild(
          el("div", { class: "wa-mi-desc" }, [
            "Scan the QR with any UPI app (GPay, PhonePe, Paytm).",
          ])
        );
        // Pay-first: confirming payment places the order to the kitchen.
        card.appendChild(
          el(
            "button",
            {
              class: "wa-btn",
              style: "margin-top:12px;width:100%",
              onclick: function () {
                return chooseAndPlaceOrder();
              },
            },
            ["✅ I've paid — place my order"]
          )
        );

        addMessage("Scan to pay — the amount is already filled in:", "bot");
        addMessage(null, "bot", card);

        ensureQrLib()
          .then(function (QRCode) {
            qrBox.innerHTML = "";
            new QRCode(qrBox, {
              text: pay.upi_uri,
              width: 200,
              height: 200,
              correctLevel: QRCode.CorrectLevel.M,
            });
          })
          .catch(function () {
            qrBox.innerHTML =
              "<div class='wa-mi-desc'>Couldn't render the QR here. " +
              "Tap 'Open in UPI app' above instead.</div>";
          });
      })
      .catch(function (e) {
        addMessage("Couldn't start payment: " + e.message, "bot");
      });
  }

  // Build the inner HTML of a bill card from a server bill payload.
  function billHtml(bill) {
    var rows = bill.line_items
      .map(function (li) {
        return (
          "<tr><td>" +
          li.quantity +
          "× " +
          li.name +
          "</td><td class='r'>" +
          money(li.line_total) +
          "</td></tr>"
        );
      })
      .join("");
    return (
      "<div class='wa-bill'><table>" +
      rows +
      "<tr><td>Subtotal</td><td class='r'>" +
      money(bill.subtotal) +
      "</td></tr>" +
      "<tr><td>Tax (" +
      Math.round(bill.tax_rate * 100) +
      "%)</td><td class='r'>" +
      money(bill.tax) +
      "</td></tr>" +
      "<tr class='tot'><td>Total</td><td class='r'>" +
      money(bill.total) +
      "</td></tr></table></div>"
    );
  }

  function showBill() {
    if (!state.cart.length) {
      addMessage("Your cart is empty. Add some items first.", "bot");
      return;
    }
    fetchBill()
      .then(function (bill) {
        // Reconcile the local cart with what the server actually billed and
        // tell the guest about anything that went sold out. If the cart is now
        // empty, stop here (the helper already messaged the guest).
        if (reconcileDropped(bill.dropped) && !bill.line_items.length) {
          addMessage("Your cart is now empty. Please add some items.", "bot");
          return;
        }
        var node = el("div", { html: billHtml(bill) });
        addMessage("Here's your bill for table " + bill.table_number + ":", "bot");
        addMessage(null, "bot", node);
        // Track this card so later cart changes refresh it in place instead of
        // forcing the guest to type "bill" again.
        state.billNode = node;

        var payBtn = el(
          "button",
          {
            class: "wa-btn",
            style: "margin-top:8px;width:100%",
            onclick: function () {
              showPayment();
            },
          },
          ["💳 Pay now " + money(bill.total)]
        );
        addMessage(null, "bot", payBtn);
        state.billPayBtn = payBtn;
      })
      .catch(function (e) {
        addMessage("Couldn't generate the bill: " + e.message, "bot");
      });
  }

  // Keep a visible bill in sync with the cart. Called after every cart change
  // so adding/removing items updates the already-shown bill automatically —
  // the guest never has to re-type "bill". Does nothing if no bill is showing.
  var _billRefreshing = false;
  function refreshBillIfShown() {
    // Only when a bill card is on screen and still attached to the transcript.
    if (!state.billNode || !state.billNode.parentNode) {
      state.billNode = null;
      state.billPayBtn = null;
      return;
    }
    if (!state.token) return;
    if (!state.cart.length) {
      // Cart emptied: collapse the stale bill so it can't be paid.
      state.billNode.innerHTML =
        "<div class='wa-mi-desc'>Your cart is empty — add items to see an " +
        "updated bill.</div>";
      if (state.billPayBtn) state.billPayBtn.style.display = "none";
      return;
    }
    if (_billRefreshing) return; // coalesce rapid taps
    _billRefreshing = true;
    // Let the guest know the bill is recalculating so a brief pause doesn't
    // look like nothing happened. The spinner overlays the bill without
    // discarding it, so the old totals stay visible until the new ones land.
    showBillUpdating();
    fetchBill()
      .then(function (bill) {
        _billRefreshing = false;
        if (!state.billNode) return;
        reconcileDropped(bill.dropped);
        state.billNode.innerHTML = billHtml(bill);
        if (state.billPayBtn) {
          state.billPayBtn.style.display = "";
          // Update the amount on the existing Pay button.
          while (state.billPayBtn.firstChild) {
            state.billPayBtn.removeChild(state.billPayBtn.firstChild);
          }
          state.billPayBtn.appendChild(
            document.createTextNode("💳 Pay now " + money(bill.total))
          );
        }
      })
      .catch(function () {
        _billRefreshing = false; // leave the last-good bill on a transient error
        hideBillUpdating();
      });
  }

  // A lightweight "please wait" overlay on the live bill card while it refetches.
  // We overlay rather than replace so the previous totals stay readable; the
  // overlay is removed automatically when billHtml() rewrites the card, but we
  // also clear it explicitly on error.
  function showBillUpdating() {
    if (!state.billNode) return;
    if (state.billNode.querySelector(".wa-bill-updating")) return;
    state.billNode.style.position = "relative";
    var overlay = el("div", { class: "wa-bill-updating" }, [
      el("span", { class: "wa-spinner" }, []),
      el("span", {}, ["Updating your bill…"]),
    ]);
    state.billNode.appendChild(overlay);
  }

  function hideBillUpdating() {
    if (!state.billNode) return;
    var overlay = state.billNode.querySelector(".wa-bill-updating");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // ---- Natural-language ordering ---------------------------------------

  var NUM_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, "a couple": 2,
  };

  function parseQuantity(text) {
    // Digit form: "2", "x2", "2x", "2 plates".
    var d = text.match(/\b(\d{1,2})\b/);
    if (d) return Math.max(1, parseInt(d[1], 10));
    // Word form: "two", "a couple".
    var words = text.toLowerCase().split(/\s+/);
    for (var i = 0; i < words.length; i++) {
      var w = words[i].replace(/[^a-z]/g, "");
      if (NUM_WORDS[w] != null) return NUM_WORDS[w];
    }
    return 1;
  }

  function normalize(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  var STOP = {
    i: 1, want: 1, will: 1, have: 1, like: 1, would: 1, get: 1, add: 1,
    order: 1, me: 1, please: 1, the: 1, a: 1, an: 1, of: 1, plate: 1,
    plates: 1, portion: 1, portions: 1, piece: 1, pieces: 1, some: 1,
    to: 1, my: 1, cart: 1, for: 1, and: 1, give: 1, could: 1, can: 1,
    you: 1, it: 1, that: 1, this: 1, one: 1, two: 1, three: 1, four: 1,
    five: 1, six: 1, seven: 1, eight: 1, nine: 1, ten: 1,
  };

  // Score how well a dish name matches the query by shared significant tokens.
  function matchDish(query, menu) {
    var q = normalize(query);
    if (!q || !menu || !menu.length) return null;

    // 1) Exact / substring on the full dish name.
    var best = null, bestScore = 0;
    for (var i = 0; i < menu.length; i++) {
      var name = normalize(menu[i].name);
      if (!name) continue;
      if (q === name) return menu[i];
      if (q.indexOf(name) !== -1) {
        // whole dish name appears in the sentence — strong signal.
        if (name.length > bestScore) { best = menu[i]; bestScore = name.length; }
      }
    }
    if (best) return best;

    // 2) Token-overlap scoring (ignore stop/quantity words).
    var qTokens = q.split(" ").filter(function (t) { return t && !STOP[t]; });
    if (!qTokens.length) return null;
    var winner = null, winScore = 0;
    for (var j = 0; j < menu.length; j++) {
      var nTokens = normalize(menu[j].name).split(" ")
        .filter(function (t) { return t && !STOP[t]; });
      if (!nTokens.length) continue;
      var hits = 0;
      for (var k = 0; k < nTokens.length; k++) {
        if (qTokens.indexOf(nTokens[k]) !== -1) hits++;
      }
      // Require matching most of the dish's own tokens to avoid false hits.
      var score = hits / nTokens.length;
      if (hits > 0 && score > winScore) { winScore = score; winner = menu[j]; }
    }
    return winScore >= 0.5 ? winner : null;
  }

  function addQtyToCart(item, qty) {
    for (var i = 0; i < qty; i++) addToCart(item);
  }

  function looksOrderish(text) {
    var lower = text.toLowerCase();
    return (
      /\b(order|add|want|get|have|take|i'?ll have|give me|bring)\b/.test(lower) ||
      /\b\d+\s*(plate|plates|portion|portions|piece|pieces|x)\b/.test(lower) ||
      /\bx\s*\d+\b/.test(lower)
    );
  }

  // Add resolved [{name, price, quantity}] lines to the cart. Returns the
  // total number of units added.
  function addParsedItems(items) {
    var added = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qty = Math.max(1, it.quantity || 1);
      for (var q = 0; q < qty; q++) addToCart(it);
      added += qty;
    }
    return added;
  }

  // Returns true if the text was handled as an order intent.
  function tryOrderIntent(text, menu) {
    var lower = text.toLowerCase();
    var orderish = looksOrderish(text);

    // An explicit quantity is itself a strong order signal, e.g. "2 thatte
    // idli" has no verb but clearly means order 2.
    var hasExplicitQty =
      /\b\d{1,2}\b/.test(lower) ||
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|a couple)\b/.test(lower);

    // Resolve the dish: try to match menu names; fall back to the last dish
    // the guest asked about when they say "it"/"that"/"one".
    var dish = matchDish(text, menu);
    var refersBack = /\b(it|that|this|one|same)\b/.test(lower) && !dish;
    if (!dish && refersBack && state.lastDish) dish = state.lastDish;

    if (!dish) return false;          // nothing to order

    var qty = parseQuantity(text);

    // Commit directly when there's a clear order signal: an ordering verb, a
    // back-reference ("2 of it"), or an explicit quantity next to a dish.
    if (orderish || refersBack || hasExplicitQty) {
      addQtyToCart(dish, qty);
      state.lastDish = dish;
      addMessage(
        "Added " + qty + " × " + dish.name +
          (dish.price != null ? " (" + money(dish.price) + " each)" : "") +
          " to your order. Say \"cart\" to review or \"pay\" to checkout.",
        "bot"
      );
      return true;
    }

    // A bare dish name with no quantity/verb is ambiguous: offer to add it and
    // remember it so a following "yes" or "2 of it" resolves.
    state.lastDish = dish;
    state.pendingOrder = { item: dish, quantity: qty };
    addMessage(
      "Would you like to add " + dish.name +
        (dish.price != null ? " (" + money(dish.price) + ")" : "") +
        " to your order? Say \"yes\" to confirm.",
      "bot"
    );
    return true;
  }

  function handleSend() {
    var text = ui.input.value.trim();
    if (!text) return;
    ui.input.value = "";
    addMessage(text, "user");

    var lower = text.toLowerCase();

    // Confirmation for a pending "add X to your order?" prompt.
    if (state.pendingOrder) {
      var po = state.pendingOrder;
      if (/^(y|yes|yeah|yep|sure|ok|okay|confirm|please do|go ahead)\b/.test(lower)) {
        state.pendingOrder = null;
        addQtyToCart(po.item, po.quantity);
        state.lastDish = po.item;
        return addMessage(
          "Added " + po.quantity + " × " + po.item.name +
            (po.item.price != null ? " (" + money(po.item.price) + " each)" : "") +
            " to your order. Say \"cart\" to review or \"pay\" to checkout.",
          "bot"
        );
      }
      if (/^(n|no|nope|nah|cancel|don'?t)\b/.test(lower)) {
        state.pendingOrder = null;
        return addMessage("No problem — I won't add that. Anything else?", "bot");
      }
      // Any other message: drop the pending state and process normally.
      state.pendingOrder = null;
    }

    if (/\b(menu|what.*(have|serve))\b/.test(lower)) return showMenu();
    if (/\b(cancel|clear).*(order|cart)|^(cancel|clear)$/.test(lower)) {
      if (!state.cart.length) {
        return addMessage("There's no order to cancel yet.", "bot");
      }
      clearCart();
      return addMessage("Your order has been cancelled.", "bot");
    }
    if (/\b(cart|edit|my items|review)\b/.test(lower)) return showCart();
    if (/\b(pay|upi|scan to pay)\b/.test(lower)) return showPayment();
    if (/\b(bill|check|total)\b/.test(lower)) return showBill();

    // Natural-language ordering. Order of resolution (cheapest first):
    //   1. Local matcher ($0, handles the common cases).
    //   2. If it looks like an order but the matcher was unsure, ask the
    //      server to parse it (gated LLM — keeps API usage minimal).
    //   3. Otherwise fall back to RAG Q&A.
    ensureMenu().then(function (menu) {
      if (tryOrderIntent(text, menu)) {
        ui.body.scrollTop = ui.body.scrollHeight;
        return;
      }

      if (looksOrderish(text)) {
        var thinking = addMessage("…", "bot");
        parseOrderServer(text)
          .then(function (res) {
            if (res && res.understood && res.items && res.items.length) {
              var added = addParsedItems(res.items);
              var names = res.items
                .map(function (x) { return x.quantity + " × " + x.name; })
                .join(", ");
              thinking.querySelector(".wa-bubble").textContent =
                "Added " + names +
                " to your order. Say \"cart\" to review or \"pay\" to checkout.";
              state.lastDish = res.items[res.items.length - 1];
              ui.body.scrollTop = ui.body.scrollHeight;
              return;
            }
            // Couldn't parse an order — fall through to Q&A.
            return askQuestion(text).then(function (ans) {
              thinking.querySelector(".wa-bubble").textContent = ans.answer;
              var d = matchDish(text, state.menu);
              if (d) state.lastDish = d;
              ui.body.scrollTop = ui.body.scrollHeight;
            });
          })
          .catch(function () {
            // On any error, degrade to Q&A rather than failing the message.
            askQuestion(text)
              .then(function (ans) {
                thinking.querySelector(".wa-bubble").textContent = ans.answer;
              })
              .catch(function () {
                thinking.querySelector(".wa-bubble").textContent =
                  "Sorry, something went wrong. Please try again.";
              });
          });
        return;
      }

      // Not an order — straight to Q&A.
      var typing = addMessage("…", "bot");
      askQuestion(text)
        .then(function (res) {
          typing.querySelector(".wa-bubble").textContent = res.answer;
          // Remember a dish named in the question so "2 of it" works next.
          var d = matchDish(text, state.menu);
          if (d) state.lastDish = d;
          ui.body.scrollTop = ui.body.scrollHeight;
        })
        .catch(function () {
          typing.querySelector(".wa-bubble").textContent =
            "Sorry, something went wrong. Please try again.";
        });
    });
  }

  // ---- Rendering --------------------------------------------------------
  function renderTablePrompt() {
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
  function askIdentifier(orderType) {
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

  function renderQuickChips() {
    var chips = el("div", { class: "wa-quick" }, [
      el("button", { class: "wa-chip", onclick: showMenu }, ["📋 View menu"]),
      el("button", { class: "wa-chip", onclick: showCart }, ["🛒 My order"]),
      el("button", { class: "wa-chip", onclick: showBill }, ["🧾 My bill"]),
      el(
        "button",
        {
          class: "wa-chip",
          onclick: function () {
            addMessage("What do you recommend?", "user");
            var t = addMessage("…", "bot");
            askQuestion("What do you recommend?")
              .then(function (r) {
                t.querySelector(".wa-bubble").textContent = r.answer;
              })
              .catch(function () {
                t.querySelector(".wa-bubble").textContent =
                  "Sorry, try again.";
              });
          },
        },
        ["⭐ Recommend"]
      ),
    ]);
    ui.body.appendChild(chips);
    ui.body.scrollTop = ui.body.scrollHeight;
  }

  function renderChat() {
    ui.footer.innerHTML = "";
    var input = el("input", {
      class: "wa-input",
      type: "text",
      placeholder: "Ask about the menu or type 'bill'…",
      "aria-label": "Message",
    });
    ui.input = input;
    var send = el("button", { class: "wa-btn", onclick: handleSend }, ["Send"]);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") handleSend();
    });
    ui.footer.appendChild(el("div", { class: "wa-row" }, [input, send]));
  }

  function _headerSub() {
    if (!state.token) return "Tap to order";
    if (state.orderType === "takeaway")
      return "Takeaway" + (state.customerName ? " · " + state.customerName : "");
    return state.tableNumber ? "Table " + state.tableNumber : "Tap to order";
  }

  function buildPanel() {
    ui.badge = el("span", { class: "wa-cart-badge" }, ["0"]);
    ui.badge.style.display = "none";

    ui.titleEl = el("div", {}, [
      document.createTextNode(CONFIG.title),
      el("small", {}, [_headerSub()]),
    ]);
    var header = el("div", { class: "wa-header" }, [
      ui.titleEl,
      el("button", {
        class: "wa-close",
        html: "&times;",
        "aria-label": "Close",
        onclick: togglePanel,
      }),
    ]);

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
          ? "Welcome back" + (state.customerName ? ", " + state.customerName : "")
          : "Welcome back to table " + state.tableNumber;
      addMessage(who + "! How can I help? (menu / bill)", "bot");
      renderQuickChips();
    } else if (IS_TOKEN) {
      // Token flow but resolve hasn't completed (or failed). Show a brief
      // loading line; resolveQrToken will render chat or an error when done.
      renderChat();
      ui.input.disabled = true;
      addMessage("One moment — getting your table ready…", "bot");
      // Kick a resolve if one isn't already in flight (e.g. panel opened fast).
      resolveQrToken().catch(function () {});
    } else {
      renderTablePrompt();
    }
    updateCartBadge();
  }

  function togglePanel() {
    state.open = !state.open;
    var root = document.documentElement;
    if (state.open) {
      if (!ui.panel) buildPanel();
      ui.panel.style.display = "flex";
      // Marker used by the mobile stylesheet to hide the FAB and (optionally)
      // lock background scroll while the full-screen chat is open.
      root.classList.add("wa-open");
      // Opening the panel is a foreground event: re-check availability right
      // away (something may have sold out while it was closed), then poll.
      syncNowIfVisible();
      refreshPolling();
    } else {
      if (ui.panel) ui.panel.style.display = "none";
      root.classList.remove("wa-open");
      // Stop polling while closed.
      refreshPolling();
    }
  }

  function buildFab() {
    var fab = el("button", {
      class: "wa-fab",
      "aria-label": "Open chat waiter",
      html: "🍽️",
      onclick: togglePanel,
    });
    var root = el("div", { class: "wa-root" }, [fab]);
    document.body.appendChild(root);
  }

  // ---- Boot -------------------------------------------------------------
  function titleFromSlug(slug) {
    return String(slug)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function boot() {
    if (window.WAITER_CONFIG) {
      CONFIG.currency = window.WAITER_CONFIG.currency || CONFIG.currency;
      if (!CONFIG.apiBase && window.WAITER_CONFIG.apiBase)
        CONFIG.apiBase = window.WAITER_CONFIG.apiBase;
    }
    // Title: for a token flow we don't know the name until /qr/resolve returns
    // (and we must NOT derive anything from the slug). For the legacy slug path
    // we can title-case the slug as a placeholder until the menu/name loads.
    if (!IS_TOKEN && LEGACY_SLUG && LEGACY_SLUG !== "demo") {
      CONFIG.title = titleFromSlug(LEGACY_SLUG);
    } else if (window.WAITER_CONFIG && window.WAITER_CONFIG.name) {
      CONFIG.title = window.WAITER_CONFIG.name;
    }
    injectStyles();
    loadSession();
    buildFab();

    // Opaque-token flow: resolve the token to a (hidden) tenant + table and a
    // customer-safe session before anything else. This also learns the display
    // name. The slug is never involved on the client.
    if (IS_TOKEN) {
      resolveQrToken();
    } else {
      // Legacy slug path: learn the real display name up front via /menu.
      prefetchRestaurantName();
      // A reload restores the session token but not the poll timer, so pick
      // live order tracking back up here (token flow resumes in resolveQrToken).
      resumeStatusPollingIfNeeded();
    }

    // Re-check availability the moment the guest returns to the tab/window.
    // A sell-out could have happened while they were away; this catches it
    // immediately instead of waiting for the next poll tick.
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
          syncNowIfVisible();
          // Mobile browsers often throttle or kill background intervals, so the
          // status poll may have stalled while the customer was away. Resume it
          // (no-op if already running) and poll once immediately so a kitchen
          // update like Served appears right when they look back at the chat.
          resumeStatusPollingIfNeeded();
          if (state.token && state.statusTimer) pollStatusOnce();
        }
      });
    }
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("focus", function () {
        syncNowIfVisible();
        resumeStatusPollingIfNeeded();
        if (state.token && state.statusTimer) pollStatusOnce();
      });
      // Stop timers cleanly if the page is being torn down.
      window.addEventListener("pagehide", function () {
        clearTimeout(_availTimer);
        stopStatusPolling();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Expose a tiny API for host pages.
  window.ChatbotWaiter = {
    open: function () {
      if (!state.open) togglePanel();
    },
    config: CONFIG,
  };
})();
