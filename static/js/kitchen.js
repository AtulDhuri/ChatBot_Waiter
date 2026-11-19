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
    // Billboard: one flat wall of ticket cards, oldest first, so the most
    // urgent order is always top-left and every order is visible at once.
    var sorted = orders.slice().sort(function (a, b) {
      return new Date(a.created_at) - new Date(b.created_at);
    });
    document.title = '(' + sorted.length + ') DineOS \u2014 Kitchen Display';
    sorted.forEach(function (o) {
      var cardEl = buildCard(o);
      grid.appendChild(cardEl);
      if (notify) notify.onNewOrder(o, cardEl);
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
      "<div class='meta'>placed " + new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div>';

    var actions = document.createElement('div');
    actions.className = 'actions';

    // Disable only the buttons in `scope` (one line item, or the card-level
    // actions) so other items stay clickable while the request is in flight.
    function lock(promise, scope) {
      var btns = Array.prototype.slice.call((scope || actions).querySelectorAll('button'));
      btns.forEach(function (b) { b.disabled = true; });
      promise.then(function () {
        poll(); // refresh board; realtime pushes to other devices
      }, function (e) {
        btns.forEach(function (b) { b.disabled = false; });
        showErr(e);
      });
    }

    // Cancel whole order (cancels every active item).
    var allTerminal = true;
    (orderItems(o)).forEach(function (it) {
      if (!ITEM_TERMINAL[it.status]) allTerminal = false;
    });
    if (!isOrderTerminal && !allTerminal) {
      // Bulk action: advance every item that sits at the earliest active stage.
      var order_ = ['pending', 'accepted', 'preparing', 'ready'];
      var stage = -1;
      orderItems(o).forEach(function (it) {
        var i = order_.indexOf(it.status || 'pending');
        if (i >= 0 && (stage < 0 || i < stage)) stage = i;
      });
      if (stage >= 0) {
        var from = order_[stage];
        var targets = orderItems(o).filter(function (it) { return (it.status || 'pending') === from; });
        var bulk = document.createElement('button');
        bulk.className = 'b-advance-all';
        bulk.textContent = ITEM_NEXT_LABEL[from] + ' all' + (targets.length > 1 ? ' (' + targets.length + ')' : '');
        bulk.onclick = function () {
          lock(Promise.all(targets.map(function (it) {
            return patchItem(o.id, it.id, ITEM_NEXT[from]).then(function () {
              if (ITEM_NEXT[from] === 'ready' && window.DineNotify) window.DineNotify.onItemReady(o, it);
            });
          })));
        };
        actions.appendChild(bulk);
      }
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
      var actionLabel = ITEM_NEXT_LABEL[status] || ('Mark ' + next);
      if (next) {
        controls += "<button class='item-advance' data-item-id='" + esc(it.id) + "' data-next='" + esc(next) + "' aria-label='" + esc(actionLabel) + "'>" + esc(actionLabel) + '</button>';
      } else if (isTerminal) {
        controls += "<span class='item-terminal'>" + esc(ITEM_STATUS_LABEL[status]) + '</span>';
      }
      if (isCancellable) {
        controls += "<button class='item-cancel' data-item-id='" + esc(it.id) + "' title='Cancel item' aria-label='Cancel item'>\u2716</button>";
      }
      return (
        "<div class='item-row item-st-" + esc(String(status).toLowerCase()) + "' data-item-id='" + esc(it.id) + "'>" +
        "<div class='item-left'>" +
          (it.serve_order && items.length > 1
            ? "<span class='item-seq' title='Serving order'>#" + esc(it.serve_order) + '</span>'
            : '') +
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
        lock(promise, btn.closest('.item-row') || btn.parentNode);
      };
    });
    Array.prototype.forEach.call(card.querySelectorAll('button.item-cancel'), function (btn) {
      btn.onclick = function () {
        var itemId = btn.getAttribute('data-item-id');
        if (!confirm('Cancel this item?')) return;
        lock(cancelItem(orderId, itemId), btn.closest('.item-row') || btn.parentNode);
      };
    });
  }

  function showErr(e) { errEl.textContent = 'Error: ' + e.message; }

  // ── Data fetch ────────────────────────────────────────────────────────────
  var pollInFlight = false;
  var pollQueued = false;
  function poll() {
    if (document.hidden) return Promise.resolve();
    if (pollInFlight) { pollQueued = true; return Promise.resolve(); }
    pollInFlight = true;
    return sfetch('/orders?restaurant=' + encodeURIComponent(restaurant()) + '&active_only=true')
      .then(function (r) { if (!r.ok) throw new Error('could not load orders'); return r.json(); })
      .then(render)
      .catch(showErr)
      .then(function () {
        pollInFlight = false;
        if (pollQueued) { pollQueued = false; poll(); }
      });
  }

  setInterval(function () {
    liveEl.textContent = liveEl.textContent === 'live' ? '\xB7live\xB7' : 'live';
  }, 3000);

  setInterval(tickElapsedBadges, TIMER_MS);

  // Server-relayed realtime pings (see realtime.js).
  function setupRealtime(identity) {
    if (!window.RealtimeManager || !identity) return Promise.resolve(false);
    var rm = window.RealtimeManager;
    rm.on('orders', poll);
    rm.on('order_items', poll);
    rm.on('resync', poll);
    rm.on('live', function (live) { realtimeActive = live; });
    return rm.init()
      .then(function (ok) { realtimeActive = ok; return ok; })
      .catch(function () { realtimeActive = false; return false; });
  }

  // Fallback polling only fires while the realtime relay is down.
  var _fallbackTimer = null;
  function startFallbackPolling() {
    if (_fallbackTimer) return;
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
          startFallbackPolling();
          return setupRealtime(me);
        });
      })
      .catch(function () { location.href = '/kitchen-login'; });
  }

  loadIdentity();

}());
