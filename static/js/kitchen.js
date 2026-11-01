// kitchen.js — Kitchen Display System
(function () {
  'use strict';

  var POLL_MS       = 8000;
  var TIMER_MS      = 60000; // elapsed-time badge refresh interval
  var grid          = document.getElementById('grid');
  var emptyEl       = document.getElementById('empty');
  var errEl         = document.getElementById('err');
  var liveEl        = document.getElementById('live');
  var currentRole   = '';
  var realtimeActive = false;
  var realtimeClient = null;
  var NEXT       = { 'new': 'preparing', preparing: 'ready', ready: 'served' };
  var NEXT_LABEL = { 'new': 'Start cooking', preparing: 'Mark ready', ready: 'Mark served' };

  // ---- Elapsed-time helpers ----
  var TERMINAL_STATUSES = { served: true, cancelled: true };

  function elapsedMinutes(isoTimestamp) {
    var t = new Date(isoTimestamp);
    if (isNaN(t.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - t.getTime()) / 60000));
  }

  // Returns { cls, label, urgency } where cls is the CSS modifier class.
  function elapsedInfo(mins) {
    if (mins >= 20) return { cls: 'red',    label: mins + 'm', urgency: 'Delayed'   };
    if (mins >= 10) return { cls: 'yellow', label: mins + 'm', urgency: 'Attention' };
    return             { cls: 'green',  label: mins + 'm', urgency: 'On Time'  };
  }

  // Rebuild only the elapsed-time badges without re-rendering the whole grid.
  function tickElapsedBadges() {
    var badges = grid.querySelectorAll('[data-placed-at]');
    Array.prototype.forEach.call(badges, function (el) {
      var status = el.getAttribute('data-order-status');
      if (TERMINAL_STATUSES[status]) return; // stop counting for terminal orders
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

  // ---- Notification integration ----
  // On the very first poll we seed all visible orders as "known" so a page
  // refresh does NOT replay sounds for orders that were already there.
  // _firstRender resets to true on every page load (in-memory only).
  var _firstRender = true;

  function render(orders) {
    errEl.textContent = '';

    var notify = window.DineNotify;

    if (_firstRender) {
      // Silent seed: mark all currently-visible orders as known.
      // No sounds fire for any of these on this render pass.
      if (notify) notify.seedKnown((orders || []).map(function (o) { return o.id; }));
      _firstRender = false;
    } else {
      // Not the first render — check for orders that have been waiting too long.
      if (notify) notify.checkReminders(orders);
    }

    grid.innerHTML    = '';
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
        // Fire new-order sound+flash — DineNotify deduplicates by order ID.
        if (notify) notify.onNewOrder(o, cardEl);
      });
      section.appendChild(cards);
      grid.appendChild(section);
    });
  }

  function buildCard(o) {
    var card = document.createElement('div');
    card.className = 'card ' + o.status;
    card.setAttribute('data-order-id', o.id);  // used by danger flash lookup
    var items = (o.items || []).map(function (it) {
      var note = it.instructions ? "<div class='note'>\uD83D\uDCDD " + esc(it.instructions) + '</div>' : '';
      return "<div><span class='q'>" + it.quantity + '\xD7</span> ' + esc(it.name) + note + '</div>';
    }).join('');

    var isTerminal = TERMINAL_STATUSES[o.status];
    var mins       = elapsedMinutes(o.created_at);
    var info       = elapsedInfo(mins);
    // Elapsed badge (hidden once terminal)
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
      "<div class='meta'>" + o.currency + Number(o.total).toFixed(2) + ' \xB7 placed ' + new Date(o.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + '</div>';

    var actions = document.createElement('div');
    actions.className = 'actions';

    function lock(btn, promise) {
      Array.prototype.forEach.call(actions.querySelectorAll('button'), function (b) { b.disabled = true; });
      promise.then(function (updated) {
        if (updated && updated.status) card.className = 'card ' + updated.status;
        poll();
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
    if (o.status !== 'cancelled' && currentRole !== 'kitchen') {
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
    fetch('/auth/logout', { method: 'POST', credentials: 'include' }).finally(function () { location.href = '/kitchen-login'; });
  });

  function setupRealtime(identity) {
    if (!window.supabase || !identity || !identity.outletId) return Promise.resolve(false);
    return fetch('/auth/realtime-token', { credentials: 'include' })
      .then(function (r) { if (!r.ok) throw new Error('Realtime not configured'); return r.json(); })
      .then(function (config) {
        realtimeClient = window.supabase.createClient(config.url, config.anonKey, {
          accessToken: function () { return Promise.resolve(config.accessToken); },
        });
        var channel = realtimeClient.channel('kitchen-outlet-' + config.outletId, { config: { private: true } });
        channel.on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: 'restaurant_id=eq.' + config.outletId }, function () { poll(); });
        return new Promise(function (resolve) {
          channel.subscribe(function (status) {
            if (status === 'SUBSCRIBED')                          { realtimeActive = true;  resolve(true);  }
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve(false);
          });
        });
      })
      .catch(function () { realtimeActive = false; return false; });
  }

  function loadIdentity() {
    return fetch('/auth/me', { credentials: 'include' })
      .then(function (r) { if (!r.ok) throw new Error('Authentication required'); return r.json(); })
      .then(function (me) {
        currentRole = me.role || '';
        if (currentRole === 'kitchen') {
          Array.prototype.forEach.call(document.querySelectorAll('.manager-only'), function (el) { el.style.display = 'none'; });
          document.querySelector('h1').textContent = 'Kitchen Portal';
        }
        // Init notifications — kitchen only plays "new order" sounds
        if (window.DineNotify) window.DineNotify.init('kitchen');
        return setupRealtime(me).then(function () { return poll(); });
      })
      .catch(function () { location.href = '/kitchen-login'; });
  }

  loadIdentity();
  setInterval(function () {
    liveEl.textContent = liveEl.textContent === 'live' ? '\xB7live\xB7' : 'live';
    if (!realtimeActive) poll();
  }, POLL_MS);

  // Elapsed-time badge refresh — runs every 60 s independently of polling
  // so colours change precisely at the 10-min and 20-min boundaries.
  setInterval(tickElapsedBadges, TIMER_MS);

}());
