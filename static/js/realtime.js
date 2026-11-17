/**
 * realtime.js — RealtimeManager
 *
 * Live updates for the kitchen / manager screens.
 *
 * The browser never talks to the database provider. The backend holds the
 * realtime connection and relays content-free "something changed" pings over
 * Server-Sent Events at /events/board (same-origin, cookie-authenticated).
 * Pages then re-fetch through the normal API, so no third-party URL, key,
 * token or row data ever appears in the page or the network tab.
 *
 * Events:
 *   'orders' | 'order_items'         a change for this outlet
 *   'orders:UPDATE' etc.             same, keyed by change type
 *   'live' (isLive: boolean)         relay up/down; pages poll while down
 */
(function (global) {
  'use strict';

  var INIT_TIMEOUT_MS = 8000;

  var _es        = null;
  var _listeners = {};
  var _ready     = false;
  var _destroyed = false;

  function _emit(key, arg) {
    var fns = _listeners[key];
    if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](arg); } catch (e) {}
    }
  }

  function _setLive(live) {
    if (live === _ready) return;
    _ready = live;
    _emit('live', live);
  }

  var RealtimeManager = {
    /**
     * init() -> Promise<boolean>: true once the relay reports it is live.
     * Resolves false (caller should poll) if unsupported, unauthorised, or
     * the relay is down; a later 'live' event reports recovery.
     */
    init: function () {
      if (_destroyed || typeof EventSource === 'undefined') return Promise.resolve(false);
      if (_es) return Promise.resolve(_ready);

      return new Promise(function (resolve) {
        var settled = false;
        function settle(v) { if (!settled) { settled = true; resolve(v); } }
        var timer = setTimeout(function () { settle(false); }, INIT_TIMEOUT_MS);

        _es = new EventSource('/events/board', { withCredentials: true });

        _es.addEventListener('live', function (e) {
          var live = false;
          try { live = !!JSON.parse(e.data).live; } catch (err) {}
          _setLive(live);
          clearTimeout(timer);
          settle(live);
          // Refetch on every (re)connect so nothing missed while down is lost.
          if (live) _emit('resync');
        });

        _es.addEventListener('change', function (e) {
          var d = {};
          try { d = JSON.parse(e.data); } catch (err) { return; }
          if (!d.table) return;
          _emit(d.table, d);
          _emit(d.table + ':' + String(d.type || '').toUpperCase(), d);
        });

        _es.onerror = function () {
          // EventSource retries by itself; while it is down the page polls.
          _setLive(false);
          if (_es && _es.readyState === 2) { _es = null; }
          clearTimeout(timer);
          settle(false);
        };
      });
    },

    on: function (eventKey, handler) {
      if (typeof handler !== 'function') return;
      if (!_listeners[eventKey]) _listeners[eventKey] = [];
      if (_listeners[eventKey].indexOf(handler) === -1) _listeners[eventKey].push(handler);
    },

    off: function (eventKey, handler) {
      if (!_listeners[eventKey]) return;
      _listeners[eventKey] = _listeners[eventKey].filter(function (fn) { return fn !== handler; });
    },

    get isReady() { return _ready; },

    destroy: function () {
      if (_es) { try { _es.close(); } catch (e) {} }
      _es = null;
      _ready = false;
      _listeners = {};
    },
  };

  window.addEventListener('pagehide', function () {
    _destroyed = true;
    RealtimeManager.destroy();
  });

  global.RealtimeManager = RealtimeManager;
}(window));
