// Natural-language ordering: quantity parsing, fuzzy dish matching, and the
// intent resolver that decides whether a message is an order and how to act.

import { money } from "./config.js";
import { state } from "./state.js";
import { addMessage } from "./dom.js";
import { addToCart } from "./cart.js";

var NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, "a couple": 2,
};

export function parseQuantity(text) {
  var d = text.match(/\b(\d{1,2})\b/);
  if (d) return Math.max(1, parseInt(d[1], 10));
  var words = text.toLowerCase().split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    var w = words[i].replace(/[^a-z]/g, "");
    if (NUM_WORDS[w] != null) return NUM_WORDS[w];
  }
  return 1;
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
export function matchDish(query, menu) {
  var q = normalize(query);
  if (!q || !menu || !menu.length) return null;

  var best = null,
    bestScore = 0;
  for (var i = 0; i < menu.length; i++) {
    var name = normalize(menu[i].name);
    if (!name) continue;
    if (q === name) return menu[i];
    if (q.indexOf(name) !== -1) {
      if (name.length > bestScore) {
        best = menu[i];
        bestScore = name.length;
      }
    }
  }
  if (best) return best;

  var qTokens = q.split(" ").filter(function (t) {
    return t && !STOP[t];
  });
  if (!qTokens.length) return null;
  var winner = null,
    winScore = 0;
  for (var j = 0; j < menu.length; j++) {
    var nTokens = normalize(menu[j].name)
      .split(" ")
      .filter(function (t) {
        return t && !STOP[t];
      });
    if (!nTokens.length) continue;
    var hits = 0;
    for (var k = 0; k < nTokens.length; k++) {
      if (qTokens.indexOf(nTokens[k]) !== -1) hits++;
    }
    var score = hits / nTokens.length;
    if (hits > 0 && score > winScore) {
      winScore = score;
      winner = menu[j];
    }
  }
  return winScore >= 0.5 ? winner : null;
}

function addQtyToCart(item, qty) {
  for (var i = 0; i < qty; i++) addToCart(item);
}

export function looksOrderish(text) {
  var lower = text.toLowerCase();
  return (
    /\b(order|add|want|get|have|take|i'?ll have|give me|bring)\b/.test(lower) ||
    /\b\d+\s*(plate|plates|portion|portions|piece|pieces|x)\b/.test(lower) ||
    /\bx\s*\d+\b/.test(lower)
  );
}

// Add resolved [{name, price, quantity}] lines to the cart. Returns units added.
export function addParsedItems(items) {
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
export function tryOrderIntent(text, menu) {
  var lower = text.toLowerCase();
  var orderish = looksOrderish(text);

  var hasExplicitQty =
    /\b\d{1,2}\b/.test(lower) ||
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|a couple)\b/.test(
      lower
    );

  var dish = matchDish(text, menu);
  var refersBack = /\b(it|that|this|one|same)\b/.test(lower) && !dish;
  if (!dish && refersBack && state.lastDish) dish = state.lastDish;

  if (!dish) return false;

  var qty = parseQuantity(text);

  if (orderish || refersBack || hasExplicitQty) {
    addQtyToCart(dish, qty);
    state.lastDish = dish;
    addMessage(
      "Added " +
        qty +
        " × " +
        dish.name +
        (dish.price != null ? " (" + money(dish.price) + " each)" : "") +
        ' to your order. Say "cart" to review or "pay" to checkout.',
      "bot"
    );
    return true;
  }

  state.lastDish = dish;
  state.pendingOrder = { item: dish, quantity: qty };
  addMessage(
    "Would you like to add " +
      dish.name +
      (dish.price != null ? " (" + money(dish.price) + ")" : "") +
      ' to your order? Say "yes" to confirm.',
    "bot"
  );
  return true;
}
