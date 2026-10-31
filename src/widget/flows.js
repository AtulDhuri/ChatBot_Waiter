// The interactive flows: placing an order, rendering the menu / cart / payment
// / bill, the live-updating bill, and the main chat message handler.

import { CONFIG, money, api } from "./config.js";
import { state, ui, saveSession } from "./state.js";
import { addMessage, el } from "./dom.js";
import {
  fetchPlaceOrder,
  fetchPay,
  fetchBill,
  fetchPostpaidBill,
  fetchPostpaidPay,
  fetchMenu,
  askQuestion,
  parseOrderServer,
  ensureMenu,
} from "./api.js";
import {
  addToCart,
  clearCart,
  changeQty,
  removeItem,
  findCartItem,
  cartTotal,
  reconcileDropped,
  updateCartBadge,
  activeCart,
  setActiveCart,
  menuRows,
} from "./cart.js";
import { startStatusPolling, showOrders } from "./status.js";
import {
  matchDish,
  looksOrderish,
  tryOrderIntent,
  addParsedItems,
} from "./nlorder.js";
import { renderChat, renderQuickChips } from "./render.js";

export function placeOrder(orderType) {
  if (!state.cart.length) {
    addMessage("Your order is empty.", "bot");
    return;
  }
  return fetchPlaceOrder(orderType)
    .then(function (o) {
      state.billNode = null;
      state.billPayBtn = null;
      if (activeCart && activeCart.card && activeCart.card.parentNode) {
        activeCart.card.parentNode.removeChild(activeCart.card);
      }
      setActiveCart(null);
      clearCart();
      var isTakeaway = o.order_type === "takeaway";
      var card = el("div", { class: "wa-order-card" }, [
        el("div", { class: "wa-order-no" }, ["Order " + o.order_no]),
        el("div", {}, [
          (isTakeaway ? "Takeaway" : "Dine-in") +
            (state.paymentMode === "postpaid"
              ? " · Added to open table bill: "
              : " · Order total: ") +
            money(o.total),
        ]),
        el("div", { class: "wa-mi-desc" }, [
          isTakeaway
            ? "We'll call your number when it's ready for pickup."
            : "Sent to the kitchen. We'll bring it to your table.",
        ]),
        el("div", { class: "wa-order-items" },
          (o.items || []).map(function (item) {
            return el("div", { class: "wa-order-item" }, [
              el("span", {}, [String(item.quantity || 1) + "× " + item.name]),
              el("span", {}, [money(item.line_total || 0)]),
            ]);
          })
        ),
      ]);
      addMessage("✅ Order placed!", "bot");
      addMessage(null, "bot", card);
      startStatusPolling();
    })
    .catch(function (e) {
      addMessage("Couldn't place the order: " + e.message, "bot");
    });
}

// Ask dine-in vs takeaway, then place. Order type was chosen at the start.
export function chooseAndPlaceOrder() {
  if (!state.cart.length) {
    addMessage("Your order is empty.", "bot");
    return;
  }
  return placeOrder(state.orderType || "dine_in");
}

export function showOrderOverview() {
  return showOrders().then(function () {
    // Keep the current unsubmitted cart accessible after the placed-order
    // history. The placed orders remain the primary content of this action.
    if (state.cart.length) showCart();
    else if (!state.statusNode) addMessage("You have no placed orders yet.", "bot");
  });
}

export function menuItemRow(item) {
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
  menuRows.push({ row: row, render: renderAction });
  return row;
}

export function showMenu() {
  addMessage("Here's our menu:", "bot");
  fetchMenu()
    .then(function (data) {
      if (!data.items || !data.items.length) {
        addMessage("The menu isn't loaded yet. Please check back soon.", "bot");
        return;
      }

      var itemCurrency =
        (data.items[0] && data.items[0].currency) || CONFIG.currency;
      if (itemCurrency) CONFIG.currency = itemCurrency;

      var cats = Object.keys(data.categories);
      var wrap = el("div", {});
      var activeCat = "all";

      var search = el("input", {
        class: "wa-input wa-menu-search",
        type: "search",
        placeholder: "🔍 Search dishes…",
        "aria-label": "Search menu",
      });

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
              q
                ? 'No dishes match "' + q + '".'
                : "No dishes in this category.",
            ])
          );
        }
        count.textContent =
          shown +
          " item" +
          (shown === 1 ? "" : "s") +
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
    .catch(function (error) {
      addMessage("Sorry, I couldn't load the menu right now. " + (error && error.message ? error.message : "Please check the restaurant link."), "bot");
    });
}

export function showCart() {
  if (!state.cart.length) {
    addMessage("Your order is empty. Browse the menu to add items.", "bot");
    return;
  }
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
      // Per-item note as a textarea. We attach the input handler with
      // addEventListener directly (NOT via el's on*) because el wraps on*
      // handlers in _guard, which would disable the field mid-typing.
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
      // Row layout: a top line holds the dish info and the qty/remove controls
      // side by side; the note textarea sits BELOW them spanning the full row
      // width (so it isn't squeezed into the narrow info column).
      var top = el("div", { class: "wa-cart-top" }, [
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
      var line = el("div", { class: "wa-cart-row" }, [top, note]);
      card.appendChild(line);
    });

    card.appendChild(
      el("div", { class: "wa-cart-sum" }, ["Subtotal: " + money(cartTotal())])
    );
    card.appendChild(
      el("div", { class: "wa-cart-actions" }, [
        el(
          "button",
          {
            class: "wa-btn",
            onclick: function () {
              if (state.paymentMode === "postpaid") {
                return chooseAndPlaceOrder();
              }
              showBill();
            },
          },
          [state.paymentMode === "postpaid" ? "Place order" : "Get bill"]
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
  addMessage(
    "Here's your current order. Tap +/− to adjust or 🗑 to remove:",
    "bot"
  );
  addMessage(null, "bot", card);
  setActiveCart({ card: card, rerender: rerender });
}

// Lazily load a QR library (used only when the guest wants to pay).
var _qrLoading = null;
function ensureQrLib() {
  if (window.QRCode) return Promise.resolve(window.QRCode);
  if (_qrLoading) return _qrLoading;
  _qrLoading = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
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

export function showPayment() {
  var isPostpaid = state.paymentMode === "postpaid";
  if (!isPostpaid && !state.cart.length) {
    addMessage("Your order is empty, nothing to pay for yet.", "bot");
    return;
  }
  (isPostpaid ? fetchPostpaidPay() : fetchPay())
    .then(function (pay) {
      if (reconcileDropped(pay.dropped)) {
        if (!state.cart.length) {
          addMessage(
            "Your cart is now empty, so there's nothing to pay for. " +
              "Please add some items.",
            "bot"
          );
          return;
        }
        showPayment();
        return;
      }
      if (!pay.configured || !pay.upi_uri) {
        var fb = el("div", { class: "wa-pay-card" }, [
          el("div", { class: "wa-pay-amt" }, [money(pay.amount)]),
          el("div", { class: "wa-mi-desc" }, [
            isPostpaid
              ? "Online payment isn't set up yet. Please pay this bill at the counter and ask the manager to mark it PAID."
              : "Online payment isn't set up yet. Pay at the counter, then place your order.",
          ]),
        ]);
        if (!isPostpaid) {
          fb.appendChild(
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
            )
          );
        }
        addMessage(null, "bot", fb);
        return;
      }

      var card = el("div", { class: "wa-pay-card" }, [
        el("div", { class: "wa-pay-amt" }, ["Pay " + money(pay.amount)]),
        el("div", { class: "wa-mi-desc" }, ["to " + pay.payee_name]),
      ]);
      var qrBox = el("div", { class: "wa-qr" });
      card.appendChild(qrBox);

      var payLink = el(
        "a",
        { class: "wa-pay-link", href: pay.upi_uri },
        ["📲 Open in UPI app"]
      );
      card.appendChild(payLink);
      var openUpi = el(
        "button",
        {
          class: "wa-btn",
          style: "margin-top:10px;width:100%",
          onclick: function () {
            // Assigning the custom scheme directly works in mobile Chrome,
            // Safari, and embedded browsers where an anchor click is ignored.
            window.location.href = pay.upi_uri;
            setTimeout(function () {
              addMessage(
                "If no UPI app opened, use the QR code above or copy the payment link below.",
                "bot"
              );
            }, 1200);
          },
        },
        ["📲 Open UPI app"]
      );
      card.appendChild(openUpi);
      var copyUpi = el(
        "button",
        {
          class: "wa-btn secondary",
          style: "margin-top:8px;width:100%",
          onclick: function () {
            var done = function () {
              addMessage("UPI payment link copied. Open it in a UPI app.", "bot");
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(pay.upi_uri).then(done).catch(function () {
                addMessage("Could not copy the link. Please use the QR code above.", "bot");
              });
            } else {
              addMessage("Copy is unavailable here. Please use the QR code above.", "bot");
            }
          },
        },
        ["📋 Copy payment link"]
      );
      card.appendChild(copyUpi);
      card.appendChild(
        el("div", { class: "wa-mi-desc" }, [
          "Scan the QR with any UPI app (GPay, PhonePe, Paytm).",
        ])
      );
      if (!isPostpaid) {
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
      } else {
        card.appendChild(
          el("div", { class: "wa-mi-desc" }, [
            "After paying, ask the manager to mark this bill PAID. Your table closes after all orders are served and paid.",
          ])
        );
      }

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

export function showBill() {
  if (state.paymentMode === "postpaid") {
    return fetchPostpaidBill()
      .then(function (bill) {
        var node = el("div", { html: billHtml(bill) });
        addMessage("Here's your current bill for table " + bill.table_number + ":", "bot");
        addMessage(null, "bot", node);
        if (bill.payment_status !== "paid") {
          var postpaidPayBtn = el(
            "button",
            {
              class: "wa-btn",
              style: "margin-top:8px;width:100%",
              onclick: function () {
                showPayment();
              },
            },
            ["💳 Pay bill " + money(bill.total)]
          );
          addMessage(null, "bot", postpaidPayBtn);
          addMessage(
            "Your bill is due. Pay online and ask the manager to mark it PAID.",
            "bot"
          );
        } else {
          addMessage("This bill has already been paid.", "bot");
        }
      })
      .catch(function (e) {
        addMessage("Couldn't generate the table bill: " + e.message, "bot");
      });
  }
  if (!state.cart.length) {
    addMessage("Your cart is empty. Add some items first.", "bot");
    return;
  }
  fetchBill()
    .then(function (bill) {
      if (reconcileDropped(bill.dropped) && !bill.line_items.length) {
        addMessage("Your cart is now empty. Please add some items.", "bot");
        return;
      }
      var node = el("div", { html: billHtml(bill) });
      addMessage("Here's your bill for table " + bill.table_number + ":", "bot");
      addMessage(null, "bot", node);
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

// Keep a visible bill in sync with the cart.
var _billRefreshing = false;
export function refreshBillIfShown() {
  if (!state.billNode || !state.billNode.parentNode) {
    state.billNode = null;
    state.billPayBtn = null;
    return;
  }
  if (!state.token) return;
  if (!state.cart.length) {
    state.billNode.innerHTML =
      "<div class='wa-mi-desc'>Your cart is empty — add items to see an " +
      "updated bill.</div>";
    if (state.billPayBtn) state.billPayBtn.style.display = "none";
    return;
  }
  if (_billRefreshing) return;
  _billRefreshing = true;
  showBillUpdating();
  fetchBill()
    .then(function (bill) {
      _billRefreshing = false;
      if (!state.billNode) return;
      reconcileDropped(bill.dropped);
      state.billNode.innerHTML = billHtml(bill);
      if (state.billPayBtn) {
        state.billPayBtn.style.display = "";
        while (state.billPayBtn.firstChild) {
          state.billPayBtn.removeChild(state.billPayBtn.firstChild);
        }
        state.billPayBtn.appendChild(
          document.createTextNode("💳 Pay now " + money(bill.total))
        );
      }
    })
    .catch(function () {
      _billRefreshing = false;
      hideBillUpdating();
    });
}

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

export function handleSend() {
  var text = ui.input.value.trim();
  if (!text) return;
  ui.input.value = "";
  addMessage(text, "user");

  var lower = text.toLowerCase();

  if (state.pendingOrder) {
    var po = state.pendingOrder;
    if (/^(y|yes|yeah|yep|sure|ok|okay|confirm|please do|go ahead)\b/.test(lower)) {
      state.pendingOrder = null;
      for (var i = 0; i < po.quantity; i++) addToCart(po.item);
      state.lastDish = po.item;
      return addMessage(
        "Added " +
          po.quantity +
          " × " +
          po.item.name +
          (po.item.price != null
            ? " (" + money(po.item.price) + " each)"
            : "") +
          ' to your order. Say "cart" to review or "pay" to checkout.',
        "bot"
      );
    }
    if (/^(n|no|nope|nah|cancel|don'?t)\b/.test(lower)) {
      state.pendingOrder = null;
      return addMessage("No problem — I won't add that. Anything else?", "bot");
    }
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
  if (/^(my\s+)?order$/.test(lower) || /^(show|view|see)\s+(my\s+)?orders?$/.test(lower)) {
    return showOrders();
  }
  if (/\b(pay|upi|scan to pay)\b/.test(lower)) return showPayment();
  if (/\b(bill|check|total)\b/.test(lower)) return showBill();

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
            addParsedItems(res.items);
            var names = res.items
              .map(function (x) {
                return x.quantity + " × " + x.name;
              })
              .join(", ");
            thinking.querySelector(".wa-bubble").textContent =
              "Added " +
              names +
              ' to your order. Say "cart" to review or "pay" to checkout.';
            state.lastDish = res.items[res.items.length - 1];
            ui.body.scrollTop = ui.body.scrollHeight;
            return;
          }
          return askQuestion(text).then(function (ans) {
            thinking.querySelector(".wa-bubble").textContent = ans.answer;
            var d = matchDish(text, state.menu);
            if (d) state.lastDish = d;
            ui.body.scrollTop = ui.body.scrollHeight;
          });
        })
        .catch(function () {
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

    var typing = addMessage("…", "bot");
    askQuestion(text)
      .then(function (res) {
        typing.querySelector(".wa-bubble").textContent = res.answer;
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
