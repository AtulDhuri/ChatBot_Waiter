// Live availability sync: re-check the cart against the current menu so a dish
// that sells out / is pulled / re-priced while the guest is idle is caught and
// the guest is told, without them having to tap Bill/Pay. The server stays the
// source of truth; this is a faster, friendlier heads-up.

import { money } from "./config.js";
import { state, saveSession } from "./state.js";
import { addMessage } from "./dom.js";
import { fetchMenu } from "./api.js";
import { activeCart, setActiveCart, reconcileDropped } from "./cart.js";

var _availTimer = null;
var _availInFlight = false;
var _availFailStreak = 0;
var AVAIL_POLL_MS = 15000; // base cadence while idle on an open cart
var AVAIL_POLL_MAX_MS = 120000; // cap when backing off after failures

export function syncAvailability() {
  if (!state.token || !state.cart.length) return Promise.resolve(false);
  if (_availInFlight) return Promise.resolve(false);
  _availInFlight = true;

  return fetchMenu()
    .then(function (data) {
      _availFailStreak = 0;
      var items = (data && data.items) || [];
      var byName = {};
      items.forEach(function (it) {
        byName[String(it.name).toLowerCase()] = it;
      });

      var dropped = [];
      var repriced = []; // {name, from, to}
      state.cart.forEach(function (ci) {
        var fresh = byName[String(ci.name).toLowerCase()];
        if (!fresh || fresh.available === false) {
          dropped.push(ci.name);
          return;
        }
        if (
          fresh.price != null &&
          Math.abs(Number(fresh.price) - Number(ci.price)) > 0.001
        ) {
          repriced.push({
            name: ci.name,
            from: Number(ci.price),
            to: Number(fresh.price),
          });
          ci.price = Number(fresh.price);
        }
      });

      var changed = false;

      if (dropped.length) {
        reconcileDropped(dropped);
        changed = true;
      }

      if (repriced.length) {
        saveSession();
        var msg = repriced
          .map(function (r) {
            return (
              r.name + " is now " + money(r.to) + " (was " + money(r.from) + ")"
            );
          })
          .join("; ");
        addMessage("Heads up — a price changed: " + msg + ".", "bot");
        changed = true;
      }

      if (changed) refreshVisibleCart();
      return changed;
    })
    .catch(function () {
      _availFailStreak += 1;
      return false;
    })
    .then(function (result) {
      _availInFlight = false;
      return result;
    });
}

// Re-render the cart card if it's still the one on screen.
export function refreshVisibleCart() {
  if (!activeCart) return;
  if (!activeCart.card || !activeCart.card.isConnected) {
    setActiveCart(null);
    return;
  }
  if (!state.cart.length) {
    activeCart.rerender();
    addMessage(
      "Your cart is now empty. Browse the menu to add items.",
      "bot"
    );
    setActiveCart(null);
    return;
  }
  activeCart.rerender();
}

function nextPollDelay() {
  var base = AVAIL_POLL_MS * Math.pow(2, Math.min(_availFailStreak, 3));
  var capped = Math.min(base, AVAIL_POLL_MAX_MS);
  var jitter = capped * 0.15 * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}

function shouldPoll() {
  return !!(state.open && state.token && state.cart.length);
}

export function scheduleAvailabilityPoll() {
  clearTimeout(_availTimer);
  if (!shouldPoll()) return;
  _availTimer = setTimeout(function () {
    var hidden = typeof document !== "undefined" && document.hidden;
    var run = hidden ? Promise.resolve(false) : syncAvailability();
    run.then(function () {
      scheduleAvailabilityPoll();
    });
  }, nextPollDelay());
}

export function refreshPolling() {
  if (shouldPoll()) scheduleAvailabilityPoll();
  else clearTimeout(_availTimer);
}

export function syncNowIfVisible() {
  if (!shouldPoll()) return;
  if (typeof document !== "undefined" && document.hidden) return;
  syncAvailability().then(function () {
    scheduleAvailabilityPoll();
  });
}

// Exposed so boot's pagehide handler can clear the pending poll timer.
export function clearAvailabilityTimer() {
  clearTimeout(_availTimer);
}
