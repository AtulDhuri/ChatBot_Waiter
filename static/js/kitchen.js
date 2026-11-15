// kitchen.js — Kitchen Display System (item-level lifecycle)
(function () {
  'use strict';

  var TIMER_MS      = 60000; // elapsed-time badge refresh interval (cosmetic)
  var grid          = document.getElementById('grid');
  var emptyEl       = document.getElementById('empty');
  var errEl         = document.getElementById('err');
  var liveEl        = document.getElementById('live');
  var currentRole   = '';
  var realtimeActive = false;

  // Item-level lifecycle: pending -> accepted -> preparing -> ready -> served.
  var ITEM_NEXT = {
    pending:   'accepted',
    accepted:  'preparing',
    preparing: 'ready',
    ready:     'served',
  };
  var ITEM_NEXT_LABEL = {
    pending:   'Accept',
    accepted:  'Start cooking',
    preparing: 'Mark ready',
    ready:     'Mark served',
  };
  var ITEM_STATUS_LABEL = {
    pending:   'Pending',
    accepted:  'Accepted',
    preparing: 'Preparing',
    ready:     'Ready',
    served:    'Served',
    cancelled: 'Cancelled',
  };
  var ITEM_TERMINAL = { served: true, cancelled: true };
  var ITEM_CANCELLABLE = { pending: true, accepted: true };
  var ORDER_TERMINAL = { served: true, cancelled: true };

  // Older orders may have only the legacy `items` array. Prefer lifecycle
  // rows when present, but fall back when the API returns an empty array.
  function orderItems(order) {
    return order.order_items && order.order_items.length
      ? order.order_items
      : (order.items || []);
  }

  // ── Elapsed-time helpers ──────────────────────────────────────────────────
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

  function tickElapsedBadges() {
    var badges = grid.querySelectorAll('[data-placed-at]');
    Array.prototype.forEach.call(badges, function (el) {
      var status = el.getAttribute('data-order-status');
      if (ORDER_TERMINAL[status]) return;
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

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── API helpers ───────────────────────────────────────────────────────────
  function patch(url, body) {
    return sfetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (!r.ok) throw new Error('update failed (' + r.status + ')');
      return r.json();
    });
  }

  function patchItem(orderId, itemId, status, reason) {
    return patch('/order/' + orderId + '/items/' + itemId, { status: status, reason: reason || '' });
  }

  function cancelItem(orderId, itemId, reason) {
    return sfetch('/order/' + orderId + '/items/' + itemId + '/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || '' }),
    }).then(function (r) {
      if (!r.ok) throw new Error('cancel failed (' + r.status + ')');
      return r.json();
    });
  }

  function cancelOrder(orderId) {
    return sfetch('/order/' + orderId + '/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then(function (r) {
      if (!r.ok) throw new Error('cancel failed (' + r.status + ')');
      return r.json();
    });
  }

  function groupKey(o)   { return o.order_type === 'takeaway' ? '__takeaway__' : (o.table_number || '-'); }
  function groupLabel(o) { return o.order_type === 'takeaway' ? '\uD83E\uDD61 Takeaway' : 'Table ' + o.table_number; }

  // ── Notification integration ──────────────────────────────────────────────
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

  function statusPill(status, cur) {
    var cls = 'item-pill item-st-' + String(status || '').toLowerCase();
    return "<span class='" + esc(cls) + "'>" + esc(ITEM_STATUS_LABEL[status] || status) + '</span>';
  }

  function buildCard(o) {
    var card = document.createElement('div');
    card.className = 'card ' + o.status;
    card.setAttribute('data-order-id', o.id);

    var isOrderTerminal = ORDER_TERMINAL[o.status];
    var mins       = elapsedMinutes(o.created_at);
    var info       = elapsedInfo(mins);
    var badgeHtml  = isOrderTerminal
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
        "<span class='order-pill order-st-" + esc(o.status) + "'>" +
          esc(ITEM_STATUS_LABEL[o.status] || o.status) + '</span>' +
        badgeHtml +
      '</div>' +
      (o.zone ? "<div class='zone'>Zone: " + esc(o.zone) + '</div>' : '') +
      "<div class='items'>" + buildItemsHtml(o) + '</div>' +
      "<div class='meta'>" + o.currency + Number(o.total || 0).toFixed(2) + ' \xB7 placed ' + new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div>';

    var actions = document.createElement('div');
    actions.className = 'actions';

    function lock(promise) {
      Array.prototype.forEach.call(actions.querySelectorAll('button'), function (b) { b.disabled = true; });
      Array.prototype.forEach.call(card.querySelectorAll('button'), function (b) { b.disabled = true; });
      promise.then(function () {
        poll(); // refresh board; realtime pushes to other devices
      }, function (e) {
        Array.prototype.forEach.call(actions.querySelectorAll('button'), function (b) { b.disabled = false; });
        Array.prototype.forEach.call(card.querySelectorAll('button'), function (b) { b.disabled = false; });
        showErr(e);
      });
    }

    // Cancel whole order (cancels every active item).
    var allTerminal = true;
    (orderItems(o)).forEach(function (it) {
      if (!ITEM_TERMINAL[it.status]) allTerminal = false;
    });
    if (!isOrderTerminal && !allTerminal) {
      var cancelAll = document.createElement('button');
      cancelAll.className = 'b-cancel-order';
      cancelAll.textContent = 'Cancel order';
      cancelAll.onclick = function () {
        if (confirm('Cancel order ' + o.order_no + ' (all items)?'))
          lock(cancelOrder(o.id));
      };
      actions.appendChild(cancelAll);
    }
    card.appendChild(actions);

    // Wire up per-item buttons now that the card is in the DOM.
    wireItemButtons(card, o.id, o, lock);
    return card;
  }

  function buildItemsHtml(o) {
    var items = orderItems(o);
    if (!items.length) return "<div class='item-row'><span class='nm'>No items</span></div>";
    return items.map(function (it) {
      var status = it.status || 'pending';
      var isTerminal = ITEM_TERMINAL[status];
      var isCancellable = ITEM_CANCELLABLE[status];
      var next = ITEM_NEXT[status];
      var note = it.instructions ? "<div class='item-note'>\uD83D\uDCDD " + esc(it.instructions) + '</div>' : '';
      var qty = it.quantity != null ? it.quantity : 1;
      var controls = '';
      var actionLabel = ITEM_NEXT_LABEL[next] || ('Mark ' + next);
      if (next) {
        controls += "<button class='item-advance' data-item-id='" + esc(it.id) + "' data-next='" + esc(next) + "' aria-label='" + esc(actionLabel) + "'>" + esc(actionLabel) + '</button>';
      } else if (isTerminal) {
        controls += "<span class='item-terminal'>" + esc(ITEM_STATUS_LABEL[status]) + '</span>';
      }
      if (isCancellable) {
        controls += "<button class='item-cancel' data-item-id='" + esc(it.id) + "'>\u2716 Cancel</button>";
      }
      return (
        "<div class='item-row item-st-" + esc(String(status).toLowerCase()) + "' data-item-id='" + esc(it.id) + "'>" +
        "<div class='item-left'>" +
          "<span class='item-qty'>" + esc(qty) + '\xD7</span>' +
          "<span class='item-name'>" + esc(it.name) + '</span>' + note +
        '</div>' +
        "<div class='item-price'>" + (o.currency || '$') + Number(it.line_total || 0).toFixed(2) + '</div>' +
        "<div class='item-right'>" +
          statusPill(status, o.currency) + controls +
        '</div>' +
        '</div>'
      );
    }).join('');
  }

  function wireItemButtons(card, orderId, order, lock) {
    var items = orderItems(order);
    Array.prototype.forEach.call(card.querySelectorAll('button.item-advance'), function (btn) {
      btn.onclick = function () {
        var itemId = btn.getAttribute('data-item-id');
        var next   = btn.getAttribute('data-next');
        var item   = items.find(function (it) { return String(it.id) === itemId; });
        var promise = patchItem(orderId, itemId, next).then(function () {
          if (next === 'ready' && window.DineNotify && item) {
            window.DineNotify.onItemReady(order, item);
          }
        });
        lock(promise);
      };
    });
    Array.prototype.forEach.call(card.querySelectorAll('button.item-cancel'), function (btn) {
      btn.onclick = function () {
        var itemId = btn.getAttribute('data-item-id');
        if (!confirm('Cancel this item?')) return;
        lock(cancelItem(orderId, itemId));
      };
    });
  }

  function showErr(e) { errEl.textContent = 'Error: ' + e.message; }

  // ── Data fetch ────────────────────────────────────────────────────────────
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

  setInterval(function () {
    liveEl.textContent = liveEl.textContent === 'live' ? '\xB7live\xB7' : 'live';
  }, 3000);

  setInterval(tickElapsedBadges, TIMER_MS);

  function setupRealtime(identity) {
    if (!window.supabase || !window.RealtimeManager) return Promise.resolve(false);
    if (!identity || !identity.outletId)               return Promise.resolve(false);
    return window.RealtimeManager.init({ outletId: identity.outletId })
      .then(function (ok) {
        if (!ok) return false;
        window.RealtimeManager.on('orders', function () { poll(); });
        realtimeActive = true;
        return true;
      })
      .catch(function () {
        realtimeActive = false;
        return false;
      });
  }

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

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

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
