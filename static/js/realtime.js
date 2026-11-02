/**
 * realtime.js — RealtimeManager
 *
 * Manages Supabase Realtime postgres_changes subscriptions for DineOS
 * kitchen / manager pages.
 *
 * Requirements on the Supabase side (one-time dashboard setup):
 *   1. Table Editor → orders → Enable Realtime  (toggle in the top bar)
 *   2. No RLS policies needed — we use standard (non-private) channels
 *      and filter server-side by restaurant_id.
 *
 * Falls back to polling when Supabase is not configured.
 */
(function (global) {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  var TOKEN_REFRESH_BEFORE_EXPIRY_MS = 60 * 1000;  // refresh 60 s before expiry
  var TOKEN_DEFAULT_TTL_MS           = 300 * 1000; // server issues 5-min tokens

  // Reconnect back-off: 3 s → 6 s → 12 s … capped at 60 s.
  // Deliberately conservative to avoid hammering Supabase on auth failure.
  var RECONNECT_BASE_MS = 3000;
  var RECONNECT_MAX_MS  = 60000;
  // Maximum reconnect attempts before giving up and staying on polling.
  var RECONNECT_MAX_ATTEMPTS = 5;

  // ── Internal state ────────────────────────────────────────────────────────
  var _client            = null;
  var _config            = null;
  var _channels          = {};   // { name: SupabaseChannel }
  var _listeners         = {};   // { 'orders': [fn], 'orders:INSERT': [fn] }
  var _tokenTimer        = null;
  var _reconnectTimer    = null;
  var _reconnectAttempts = 0;
  var _destroyed         = false;
  var _outletId          = null;
  var _ready             = false;

  // ── Public API ────────────────────────────────────────────────────────────
  var RealtimeManager = {

    /**
     * init({ outletId })
     * Returns Promise<boolean> — true = realtime connected, false = use polling.
     */
    init: function (opts) {
      opts = opts || {};
      if (_destroyed) return Promise.resolve(false);
      // Already connected for this outlet — nothing to do.
      if (_ready && _outletId === opts.outletId) return Promise.resolve(true);

      _outletId = opts.outletId;
      return _fetchToken().then(function (cfg) {
        if (!cfg) return false;
        _config = cfg;
        _client = _createClient(cfg);
        _scheduleTokenRefresh(cfg);
        return _openSubscriptions(cfg.outletId);
      }).catch(function () { return false; });
    },

    /**
     * on(eventKey, handler)
     * eventKey: 'orders' | 'orders:INSERT' | 'orders:UPDATE' | 'orders:DELETE'
     */
    on: function (eventKey, handler) {
      if (typeof handler !== 'function') return;
      if (!_listeners[eventKey]) _listeners[eventKey] = [];
      for (var i = 0; i < _listeners[eventKey].length; i++) {
        if (_listeners[eventKey][i] === handler) return; // deduplicate
      }
      _listeners[eventKey].push(handler);
    },

    off: function (eventKey, handler) {
      if (!_listeners[eventKey]) return;
      _listeners[eventKey] = _listeners[eventKey].filter(function (fn) {
        return fn !== handler;
      });
    },

    /**
     * subscribe(table)
     * Open an additional table subscription after init(). Returns Promise<boolean>.
     */
    subscribe: function (table) {
      if (_destroyed || !_outletId || !_client) return Promise.resolve(false);
      return _subscribe(table, _outletId);
    },

    get isReady() { return _ready; },

    destroy: function () {
      _destroyed = true;
      _clearTimers();
      _unsubscribeAll();
      _client    = null;
      _config    = null;
      _listeners = {};
      _ready     = false;
    },
  };

  // ── Token ─────────────────────────────────────────────────────────────────

  function _fetchToken() {
    return fetch('/auth/realtime-token', { credentials: 'include' })
      .then(function (r) {
        if (r.status === 404) return null; // Supabase not configured
        if (!r.ok) throw new Error('realtime-token ' + r.status);
        return r.json();
      })
      .catch(function () { return null; });
  }

  function _scheduleTokenRefresh(cfg) {
    _clearTokenTimer();
    var ttlMs = TOKEN_DEFAULT_TTL_MS;
    try {
      var parts = (cfg.accessToken || '').split('.');
      var body  = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      ttlMs = Math.max(body.exp * 1000 - Date.now(), 10000);
    } catch (e) {}
    var refreshIn = Math.max(ttlMs - TOKEN_REFRESH_BEFORE_EXPIRY_MS, 5000);
    _tokenTimer = setTimeout(_doTokenRefresh, refreshIn);
  }

  function _doTokenRefresh() {
    if (_destroyed) return;
    _fetchToken().then(function (cfg) {
      if (!cfg || _destroyed) return;
      _config = cfg;
      // Recreate client with new token; reopen all channels.
      _unsubscribeAll();
      _client = _createClient(cfg);
      _ready  = false;
      _scheduleTokenRefresh(cfg);
      _openSubscriptions(cfg.outletId);
    });
  }

  function _clearTokenTimer() {
    if (_tokenTimer) { clearTimeout(_tokenTimer); _tokenTimer = null; }
  }

  // ── Supabase client ───────────────────────────────────────────────────────

  function _createClient(cfg) {
    return window.supabase.createClient(cfg.url, cfg.anonKey, {
      realtime: { heartbeatIntervalMs: 30000 },
      // Pass the staff JWT as the access token. Supabase Realtime uses this
      // to evaluate RLS policies. The JWT contains outlet_id so the policy:
      //   (auth.jwt() ->> 'outlet_id')::int = restaurant_id
      // will pass for this outlet's rows only.
      // If you have no RLS SELECT policy on orders, remove accessToken here
      // and add an anon SELECT policy instead (see README).
      accessToken: function () {
        return Promise.resolve((_config && _config.accessToken) || cfg.accessToken);
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  function _openSubscriptions(outletId) {
    return _subscribe('orders', outletId).then(function (ok) {
      _ready = ok;
      return ok;
    });
  }

  function _subscribe(table, outletId) {
    var name = 'dineos-' + table + '-' + outletId;
    if (_channels[name]) return Promise.resolve(true); // already open

    var filter  = 'restaurant_id=eq.' + outletId;

    // Use a STANDARD channel (not private). Private channels require
    // Supabase RLS policies on realtime.messages. Standard channels work
    // as long as Realtime is enabled on the table in the Supabase dashboard.
    var channel = _client.channel(name);

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: table, filter: filter },
      function (payload) { _dispatch(table, payload); }
    );

    _channels[name] = channel;

    // resolved flag: the subscribe callback fires on every status change;
    // we only resolve the promise once and only reconnect AFTER a successful
    // first subscribe (to avoid a reconnect storm on auth/config errors).
    var resolved = false;

    return new Promise(function (resolve) {
      channel.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          _reconnectAttempts = 0;
          if (!resolved) { resolved = true; resolve(true); }

        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          _channels[name] = null;

          if (!resolved) {
            // Never successfully subscribed — give up, let caller use polling.
            resolved = true;
            resolve(false);
          } else {
            // Was subscribed, then dropped — schedule a reconnect.
            _scheduleReconnect();
          }
        }
        // CLOSED = deliberate unsubscribe; ignore.
      });
    });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  function _dispatch(table, payload) {
    var eventType = (payload.eventType || '').toUpperCase();
    _invokeListeners(table, payload);
    _invokeListeners(table + ':' + eventType, payload);
  }

  function _invokeListeners(key, payload) {
    var fns = _listeners[key];
    if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](payload); } catch (e) {}
    }
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  function _scheduleReconnect() {
    if (_destroyed) return;
    if (_reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      // Too many failures — stop trying. The fallback polling in kitchen.js /
      // manager.js will keep the page functional.
      return;
    }
    _clearReconnectTimer();
    var delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, _reconnectAttempts), RECONNECT_MAX_MS);
    delay += delay * 0.1 * (Math.random() * 2 - 1); // ±10% jitter
    _reconnectAttempts++;

    _reconnectTimer = setTimeout(function () {
      if (_destroyed) return;
      _fetchToken().then(function (cfg) {
        if (!cfg || _destroyed) return;
        _config   = cfg;
        _client   = _createClient(cfg);
        _channels = {};
        _ready    = false;
        _scheduleTokenRefresh(cfg);
        _openSubscriptions(cfg.outletId);
      });
    }, delay);
  }

  function _clearReconnectTimer() {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function _clearTimers() { _clearTokenTimer(); _clearReconnectTimer(); }

  function _unsubscribeAll() {
    Object.keys(_channels).forEach(function (name) {
      var ch = _channels[name];
      if (ch) { try { ch.unsubscribe(); } catch (e) {} }
    });
    _channels = {};
  }

  // ── Page lifecycle ────────────────────────────────────────────────────────

  window.addEventListener('pagehide', function () { RealtimeManager.destroy(); });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !_ready || _destroyed) return;
    Object.keys(_channels).forEach(function (name) {
      var ch = _channels[name];
      if (ch && ch.state === 'closed') {
        _channels[name] = null;
        _scheduleReconnect();
      }
    });
  });

  global.RealtimeManager = RealtimeManager;

}(window));
