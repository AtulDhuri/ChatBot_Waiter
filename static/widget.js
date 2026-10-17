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

  // Restaurant resolution order (multi-tenant):
  //   1. ?r= / ?restaurant= in the URL  (what a scanned QR code carries)
  //   2. data-restaurant attribute on the <script> tag
  //   3. "demo" fallback
  var CONFIG = {
    apiBase: (currentScript && currentScript.getAttribute("data-api")) || "",
    restaurant:
      urlParam("r") ||
      urlParam("restaurant") ||
      (currentScript && currentScript.getAttribute("data-restaurant")) ||
      "demo",
    // Optional table number carried by the QR code (?t=12).
    presetTable: urlParam("t") || urlParam("table") || null,
    currency: "$",
    title: "Waiter",
  };

  // Namespacing the session by tenant keeps carts separate per restaurant.
  var SESSION_KEY = "waiter_session_" + CONFIG.restaurant;

  // ---- State ------------------------------------------------------------
  var state = {
    token: null,
    tableNumber: null,
    orderType: null, // 'dine_in' | 'takeaway'
    customerName: null, // for takeaway
    cart: [], // [{name, price, quantity}]
    open: false,
    menu: [], // cached menu items for NL order matching
    lastDish: null, // last dish the guest/bot referenced (for "2 of it")
    pendingOrder: null, // {item, quantity} awaiting a yes/no confirmation
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
      state.cart = Array.isArray(data.cart) ? data.cart : [];
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
      ".wa-cart-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f0f0f0;}" +
      ".wa-cart-info{flex:1;padding-right:8px;}" +
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
        restaurant: CONFIG.restaurant,
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

  function fetchMenu() {
    return fetch(
      api("/menu?restaurant=" + encodeURIComponent(CONFIG.restaurant))
    ).then(function (r) {
      if (!r.ok) throw new Error("no menu");
      return r.json();
    }).then(function (data) {
      // Cache items so natural-language ordering can match dish names without
      // an extra round trip.
      if (data && data.items) state.menu = data.items;
      return data;
    });
  }

  // Ensure the menu is cached (fetch once if we haven't yet).
  function ensureMenu() {
    if (state.menu && state.menu.length) return Promise.resolve(state.menu);
    return fetchMenu()
      .then(function (d) { return (d && d.items) || []; })
      .catch(function () { return []; });
  }

  function askQuestion(question) {
    return fetch(api("/ask"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.token, question: question }),
    }).then(function (r) {
      if (!r.ok) throw new Error("ask failed");
      return r.json();
    });
  }

  // Server-side NL order parsing (gated LLM fallback). No secrets here — the
  // OpenAI key lives only on the server; we just send the guest's text.
  function parseOrderServer(text) {
    return fetch(api("/order/parse"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.token, text: text }),
    }).then(function (r) {
      if (!r.ok) throw new Error("parse failed");
      return r.json();
    });
  }

  function fetchPlaceOrder(orderType) {
    return fetch(api("/order"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: state.token,
        cart: state.cart,
        order_type: orderType || "dine_in",
        payment_status: "paid_unverified",
      }),
    }).then(function (r) {
      if (!r.ok)
        return r.json().then(function (e) {
          throw new Error(e.detail || "order failed");
        });
      return r.json();
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
      })
      .catch(function (e) {
        addMessage("Couldn't place the order: " + e.message, "bot");
      });
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
    return fetch(api("/pay"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: state.token, cart: state.cart }),
    }).then(function (r) {
      if (!r.ok)
        return r.json().then(function (e) {
          throw new Error(e.detail || "pay failed");
        });
      return r.json();
    });
  }

  function fetchBill() {
    return fetch(api("/bill"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: state.token,
        cart: state.cart,
        format: "json",
      }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || "bill failed"); });
      return r.json();
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
    if (!ui.badge) return;
    var c = cartCount();
    ui.badge.textContent = c;
    ui.badge.style.display = c > 0 ? "inline-block" : "none";
  }

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

  function cartTotal() {
    return state.cart.reduce(function (n, c) {
      return n + (Number(c.price) || 0) * c.quantity;
    }, 0);
  }

  // ---- Flows ------------------------------------------------------------
  function menuItemRow(item) {
    var info = el("div", { class: "wa-mi-info" }, [
      el("div", { class: "wa-mi-name" }, [
        item.name + (item.price != null ? "  " + money(item.price) : ""),
      ]),
      item.description
        ? el("div", { class: "wa-mi-desc" }, [item.description])
        : null,
    ]);
    var btn = el(
      "button",
      {
        class: "wa-add",
        onclick: function () {
          addToCart(item);
          addMessage("Added " + item.name + " to your order.", "bot");
        },
      },
      ["Add"]
    );
    return el("div", { class: "wa-menu-item" }, [info, btn]);
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
        var line = el("div", { class: "wa-cart-row" }, [
          el("div", { class: "wa-cart-info" }, [
            el("div", { class: "wa-mi-name" }, [name]),
            el("div", { class: "wa-mi-desc" }, [
              money(ci.price) + " each · " + money(ci.price * ci.quantity),
            ]),
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

  function showBill() {
    if (!state.cart.length) {
      addMessage("Your cart is empty. Add some items first.", "bot");
      return;
    }
    fetchBill()
      .then(function (bill) {
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
        var html =
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
          "</td></tr></table></div>";
        var node = el("div", { html: html });
        addMessage("Here's your bill for table " + bill.table_number + ":", "bot");
        addMessage(null, "bot", node);

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
      })
      .catch(function (e) {
        addMessage("Couldn't generate the bill: " + e.message, "bot");
      });
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
    } else {
      if (ui.panel) ui.panel.style.display = "none";
      root.classList.remove("wa-open");
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
    // Per-tenant title: if the URL/attribute picked a real restaurant, show a
    // name derived from its slug; otherwise fall back to the global config.
    if (CONFIG.restaurant && CONFIG.restaurant !== "demo") {
      CONFIG.title = titleFromSlug(CONFIG.restaurant);
    } else if (window.WAITER_CONFIG && window.WAITER_CONFIG.name) {
      CONFIG.title = window.WAITER_CONFIG.name;
    }
    injectStyles();
    loadSession();
    buildFab();
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
