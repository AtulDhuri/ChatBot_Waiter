// kitchen.js — Kitchen Display System
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  // POLL_MS is only used for:
  //   (a) the live-indicator blink (purely cosmetic), and
  //   (b) the one-time recovery poll when Supabase is not configured.
  // It no longer drives a data-refresh loop.
  var TIMER_MS      = 60000; // elapsed-time badge refresh interval (cosmetic)
  var grid          = document.getElementById('grid');
  var emptyEl       = document.getElementById('empty');
  var errEl         = document.getElementById('err');
  var liveEl        = document.getElementById('live');
  var currentRole   = '';
  var realtimeActive = false;
  var NEXT       = { 'new': 'preparing', preparing: 'ready', ready: 'served' };
  var NEXT_LABEL = { 'new': 'Start cooking', preparing: 'Mark ready', ready: 'Mark served' };

  // ── Elapsed-time helpers ──────────────────────────────────────────────────
  var TERMINAL_STATUSES = { served: true, cancelled: true };

  function elapsedMinutes(isoTimestamp) {
    var t = new Date(isoTimestamp);
    if (isNaN(t.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - t.getTime()) / 60000));
  }

  function elapsedInfo(mins) {
    if (mins >= 20) return { cls: 'red',    label: mins + 'm', urgency: 'Delayed'   };
    if (mins >= 10) return { cls: 'yellow', label: mins + 'm', urgency: 'Attention' };
    return             { cls: 'green',  label: mins + 'm', urgency: 'On Time'  };
  }

  // Rebuild only the elapsed-time badges — no network call.
  function tickElapsedBadges() {
    var badges = grid.querySelectorAll('[data-placed-at]');
    Array.prototype.forEach.call(badges, function (el) {
      var status = el.getAttribute('data-order-status');
      if (TERMINAL_STATUSES[status]) return;
      var mins = elapsedMinutes(el.getAttribute('data-placed-at'));
      var info = elapsedInfo(mins);
      el.className = 'elapsed-badge elapsed-' + info.cls;
      el.textContent = info.label + ' ' + info.urgency;
    });
  }

  function restaurant() {
    var u = new URLSearchParams(location.search).get('r');
    if (u) document.getElementById('restaurant').value = u;
    return document.getElementById('restaurant').value.trim() || 'demo';
  }

  function patch(id, body) {
    return sfetch('/order/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (!r.ok) throw new Error('update failed');
      return r.json();
    });
  }

  function groupKey(o)   { return o.order_type === 'takeaway' ? '__takeaway__' : (o.table_number || '-'); }
  function groupLabel(o) { return o.order_type === 'takeaway' ? '\uD83E\uDD61 Takeaway' : 'Table ' + o.table_number; }

  // ── Notification integration ──────────────────────────────────────────────
  // On the very first poll we seed all visible orders as "known" so a page
  // refresh does NOT replay sounds for orders that were already there.
  var _firstRender = true;

  function render(orders) {
    errEl.textContent = '';

    var notify = window.DineNotify;

    if (_firstRender) {
      if (notify) notify.seedKnown((orders || []).map(function (o) { return o.id; }));
      _firstRender = false;
    } else {
      if (notify) notify.checkReminders(orders);
    }

    grid.innerHTML = '';
    if (!orders.length) { emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';
    var groups = {}, order = [];
    orders.forEach(function (o) {
      var k = groupKey(o);
      if (!groups[k]) { groups[k] = { label: groupLabel(o), list: [] }; order.push(k); }
      groups[k].list.push(o);
    });
    order.forEach(function (k) {
      var g       = groups[k];
      var section = document.createElement('div');
      section.className = 'table-group';
      var head = document.createElement('div');
      head.className = 'table-head';
      head.innerHTML = '<h2>' + esc(g.label) + "</h2><span class='count'>" + g.list.length + ' order' + (g.list.length === 1 ? '' : 's') + '</span>';
      section.appendChild(head);
      var cards = document.createElement('div');
      cards.className = 'table-cards';
      g.list.forEach(function (o) {
        var cardEl = buildCard(o);
        cards.appendChild(cardEl);
        if (notify) notify.onNewOrder(o, cardEl);
      });
      section.appendChild(cards);
      grid.appendChild(section);
    });
  }

  function buildCard(o) {
    var card = document.createElement('div');
    card.className = 'card ' + o.status;
    card.setAttribute('data-order-id', o.id);
    var items = (o.items || []).map(function (it) {
      var note = it.instructions ? "<div class='note'>\uD83D\uDCDD " + esc(it.instructions) + '</div>' : '';
      return "<div><span class='q'>" + it.quantity + '\xD7</span> ' + esc(it.name) + note + '</div>';
    }).join('');

    var isTerminal = TERMINAL_STATUSES[o.status];
    var mins       = elapsedMinutes(o.created_at);
    var info       = elapsedInfo(mins);
    var badgeHtml  = isTerminal
      ? ''
      : "<span class='elapsed-badge elapsed-" + info.cls + "' " +
          "data-placed-at='" + esc(o.created_at) + "' " +
          "data-order-status='" + esc(o.status) + "'>" +
          info.label + ' ' + info.urgency +
        '</span>';

    card.innerHTML =
      "<div class='top'>" +
        "<span class='ono'>" + esc(o.order_no) + "</span>" +
        "<span class='badge " + o.order_type + "'>" +
          (o.order_type === 'takeaway' ? '\uD83E\uDD61 ' + (o.customer_name ? esc(o.customer_name) : 'Takeaway') : 'Table ' + esc(o.table_number)) +
        '</span>' +
        badgeHtml +
      '</div>' +
      (o.zone ? "<div class='zone'>Zone: " + esc(o.zone) + '</div>' : '') +
      "<div class='items'>" + items + '</div>' +
      "<div class='meta'>" + o.currency + Number(o.total).toFixed(2) + ' \xB7 placed ' + new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div>';

    var actions = document.createElement('div');
    actions.className = 'actions';

    function lock(btn, promise) {
      // Disable all buttons immediately for visual feedback.
      Array.prototype.forEach.call(actions.querySelectorAll('button'), function (b) { b.disabled = true; });
      promise.then(function (updated) {
        // The PATCH returns the updated order. Rebuild just this card in-place
        // from the server response — no poll(), no full re-render.
        // Realtime fires on other devices from the same DB write.
        if (updated && updated.id) {
          var newCard = buildCard(updated);
          if (card.parentNode) card.parentNode.replaceChild(newCard, card);
          // If the order is now terminal (served/cancelled), check whether
          // the whole table-group is empty and remove it.
          if (TERMINAL_STATUSES[updated.status]) {
            var group = newCard.closest ? newCard.closest('.table-group') : null;
            if (group) {
              var remaining = group.querySelectorAll('.card:not(.served):not(.cancelled)');
              if (!remaining.length) group.parentNode && group.parentNode.removeChild(group);
            }
            if (!grid.querySelector('.card')) emptyEl.style.display = 'block';
          }
        } else {
          // Fallback: couldn't parse response — re-enable buttons.
          Array.prototype.forEach.call(actions.querySelectorAll('button'), function (b) { b.disabled = false; });
        }
      }, function (e) {
        Array.prototype.forEach.call(actions.querySelectorAll('button'), function (b) { b.disabled = false; });
        showErr(e);
      });
    }

    if (NEXT[o.status]) {
      var adv = document.createElement('button');
      adv.className   = 'b-advance';
      adv.textContent = NEXT_LABEL[o.status];
      adv.onclick     = function () { lock(adv, patch(o.id, { status: NEXT[o.status] })); };
      actions.appendChild(adv);
    }
    // Cancel is available to ALL roles (kitchen + manager/admin).
    // Backend allows kitchen to cancel but blocks payment changes.
    // Cancelled orders disappear from kitchen view and show as cancelled in manager.
    if (o.status !== 'cancelled' && o.status !== 'served') {
      var cancel = document.createElement('button');
      cancel.className   = 'b-cancel';
      cancel.textContent = 'Cancel';
      cancel.onclick     = function () {
        if (confirm('Cancel order ' + o.order_no + '?'))
          lock(cancel, patch(o.id, { status: 'cancelled' }));
      };
      actions.appendChild(cancel);
    }
    card.appendChild(actions);
    return card;
  }

  function showErr(e) { errEl.textContent = 'Error: ' + e.message; }

  // ── Data fetch ────────────────────────────────────────────────────────────
  // poll() is called in two cases only:
  //   1. Once on page load (initial render).
  //   2. When the realtime channel pushes a change from ANOTHER device
  //      (e.g. a second kitchen screen, manager marking paid, new order).
  // It is NOT called after your own button clicks — those update the card
  // in-place from the PATCH response via lock() above.
  var pollInFlight = false;
  function poll() {
    if (pollInFlight || document.hidden) return Promise.resolve();
    pollInFlight = true;
    return sfetch('/orders?restaurant=' + encodeURIComponent(restaurant()) + '&active_only=true')
      .then(function (r) { if (!r.ok) throw new Error('could not load orders'); return r.json(); })
      .then(render)
      .catch(showErr)
      .then(function () { pollInFlight = false; });
  }

  // ── Live-indicator blink ──────────────────────────────────────────────────
  // Purely cosmetic — runs regardless of realtime/polling mode.
  setInterval(function () {
    liveEl.textContent = liveEl.textContent === 'live' ? '\xB7live\xB7' : 'live';
  }, 3000);

  // Elapsed-time badge refresh — cosmetic, no network.
  setInterval(tickElapsedBadges, TIMER_MS);

  // ── Realtime setup (via RealtimeManager) ─────────────────────────────────
  function setupRealtime(identity) {
    if (!window.supabase || !window.RealtimeManager) return Promise.resolve(false);
    if (!identity || !identity.outletId)               return Promise.resolve(false);

    return window.RealtimeManager.init({ outletId: identity.outletId })
      .then(function (ok) {
        if (!ok) return false;

        // A change arrived from another device/session → full refresh.
        // This is the ONLY time poll() runs after initial load.
        window.RealtimeManager.on('orders', function () { poll(); });

        realtimeActive = true;
        return true;
      })
      .catch(function () {
        realtimeActive = false;
        return false;
      });
  }

  // ── Degraded polling (when realtime unavailable) ──────────────────────────
  // Only active when Supabase is not configured or unreachable.
  var _fallbackTimer = null;
  function startFallbackPolling() {
    if (_fallbackTimer || realtimeActive) return;
    _fallbackTimer = setInterval(function () {
      if (!realtimeActive) poll();
    }, 8000);
  }

  function stopFallbackPolling() {
    if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null; }
  }

  // ── Page focus recovery ───────────────────────────────────────────────────
  // When the tab regains visibility, pull a fresh snapshot.
  // With realtime active the channel resumes automatically; this one-shot
  // poll just fills the gap that may have occurred while hidden.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  // ── Buttons ───────────────────────────────────────────────────────────────
  document.getElementById('closeBtn').addEventListener('click', function () {
    var tn = document.getElementById('closeTable').value.trim();
    if (!tn) return;
    sfetch('/close-table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant: restaurant(), table_number: tn }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        errEl.textContent = 'Closed ' + d.closed + ' order(s) for table ' + tn + '.';
        document.getElementById('closeTable').value = '';
        poll();
      })
      .catch(showErr);
  });

  document.getElementById('tokenBtn').addEventListener('click', function () { promptToken(true); poll(); });
  document.getElementById('logoutBtn').addEventListener('click', function () {
    fetch('/auth/logout', { method: 'POST', credentials: 'include' }).finally(function () {
      if (window.RealtimeManager) window.RealtimeManager.destroy();
      location.href = '/kitchen-login';
    });
  });

  // ── Identity + init ───────────────────────────────────────────────────────
  function loadIdentity() {
    return fetch('/auth/me', { credentials: 'include' })
      .then(function (r) { if (!r.ok) throw new Error('Authentication required'); return r.json(); })
      .then(function (me) {
        currentRole = me.role || '';
        if (currentRole === 'kitchen') {
          Array.prototype.forEach.call(document.querySelectorAll('.manager-only'), function (el) { el.style.display = 'none'; });
          document.querySelector('h1').textContent = 'Kitchen Portal';
        }
        if (window.DineNotify) window.DineNotify.init('kitchen');

        // poll() once for the initial render, then realtime takes over.
        // setupRealtime resolves before poll() so the WS is open before
        // the first render — any order that arrives during the fetch is
        // caught by the channel and triggers a second poll automatically.
        return poll().then(function () {
          return setupRealtime(me).then(function (ok) {
            if (!ok) startFallbackPolling();
          });
        });
      })
      .catch(function () { location.href = '/kitchen-login'; });
  }

  loadIdentity();

}());
