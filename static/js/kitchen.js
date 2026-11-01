// kitchen.js — Kitchen Display System
(function () {
  'use strict';

  var POLL_MS       = 8000;
  var grid          = document.getElementById('grid');
  var emptyEl       = document.getElementById('empty');
  var errEl         = document.getElementById('err');
  var liveEl        = document.getElementById('live');
  var currentRole   = '';
  var realtimeActive = false;
  var realtimeClient = null;
  var NEXT       = { 'new': 'preparing', preparing: 'ready', ready: 'served' };
  var NEXT_LABEL = { 'new': 'Start cooking', preparing: 'Mark ready', ready: 'Mark served' };

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

  function render(orders) {
    errEl.textContent = '';
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
      g.list.forEach(function (o) { cards.appendChild(buildCard(o)); });
      section.appendChild(cards);
      grid.appendChild(section);
    });
  }

  function buildCard(o) {
    var card = document.createElement('div');
    card.className = 'card ' + o.status;
    var items = (o.items || []).map(function (it) {
      var note = it.instructions ? "<div class='note'>\uD83D\uDCDD " + esc(it.instructions) + '</div>' : '';
      return "<div><span class='q'>" + it.quantity + '\xD7</span> ' + esc(it.name) + note + '</div>';
    }).join('');
    var t    = new Date(o.created_at);
    var mins = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
    card.innerHTML =
      "<div class='top'><span class='ono'>" + esc(o.order_no) + "</span>" +
      "<span class='badge " + o.order_type + "'>" +
        (o.order_type === 'takeaway' ? '\uD83E\uDD61 ' + (o.customer_name ? esc(o.customer_name) : 'Takeaway') : 'Table ' + esc(o.table_number)) +
      '</span></div>' +
      (o.zone ? "<div class='zone'>Zone: " + esc(o.zone) + '</div>' : '') +
      "<div class='items'>" + items + '</div>' +
      "<div class='meta'>" + o.currency + Number(o.total).toFixed(2) + ' \xB7 ' + mins + ' min ago</div>';

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
        return setupRealtime(me).then(function () { return poll(); });
      })
      .catch(function () { location.href = '/kitchen-login'; });
  }

  loadIdentity();
  setInterval(function () {
    liveEl.textContent = liveEl.textContent === 'live' ? '\xB7live\xB7' : 'live';
    if (!realtimeActive) poll();
  }, POLL_MS);

}());
