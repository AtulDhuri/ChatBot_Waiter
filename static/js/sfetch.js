/**
 * sfetch.js — Shared authenticated fetch wrapper.
 * Loaded before every page-specific script on authenticated pages.
 * JWT lives in an HttpOnly cookie — JS never reads or stores it.
 */
(function (g) {
  'use strict';

  g.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  g.sfetch = function (url, opts) {
    opts = opts || {};
    opts.credentials = 'include';
    return fetch(url, opts).then(function (r) {
      if (r.status === 401 || r.status === 402) {
        window.location.href = '/login.html';
        throw new Error('Authentication required');
      }
      return r;
    });
  };

  // Legacy stubs — token lives in HttpOnly cookie, never in JS.
  g.getToken    = function () { return ''; };
  g.promptToken = function (force) { if (force) window.location.href = '/login.html'; };

}(window));
