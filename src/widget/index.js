// Entry point. esbuild bundles this (and everything it imports) into a single
// IIFE at static/widget.js. Boot wiring and the public window.ChatbotWaiter API
// live here, matching the original single-file widget exactly.

import { CONFIG, IS_TOKEN, LEGACY_SLUG } from "./config.js";
import { state, loadSession } from "./state.js";
import { injectStyles } from "./styles.js";
import { resolveQrToken, prefetchRestaurantName } from "./api.js";
import {
  resumeStatusPollingIfNeeded,
  pollStatusOnce,
  stopStatusPolling,
} from "./status.js";
import {
  syncNowIfVisible,
  clearAvailabilityTimer,
} from "./availability.js";
import { buildFab, togglePanel } from "./render.js";

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
  // Keep the slug as a routing identifier only. Never show it as the
  // restaurant name; fetchMenu() replaces the generic title with the DB name.
  if (window.WAITER_CONFIG && window.WAITER_CONFIG.name && (!LEGACY_SLUG || LEGACY_SLUG === "demo")) {
    CONFIG.title = window.WAITER_CONFIG.name;
  }
  injectStyles();
  loadSession();
  buildFab();

  if (IS_TOKEN) {
    resolveQrToken();
  } else {
    prefetchRestaurantName();
    resumeStatusPollingIfNeeded();
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        syncNowIfVisible();
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
    window.addEventListener("pagehide", function () {
      clearAvailabilityTimer();
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
