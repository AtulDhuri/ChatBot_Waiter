// manager.js — Manager Dashboard logic
(function () {
  'use strict';

  var cardsEl   = document.getElementById('cards');
  var emptyEl   = document.getElementById('empty');
  var errEl     = document.getElementById('err');
  var summaryEl = document.getElementById('summary');
  var receiptEl = document.getElementById('receipt');
  var ORDERS    = {};
  var RECEIPT_CFG = {};
  var REFRESH_MS  = 8000;
  var _refreshTimer = null;
  var _lastSig = null;

  // Elapsed-time helpers (shared logic identical to kitchen.js)
  var ACTIVE_STATUSES = { 'new': true, preparing: true, ready: true };

  // ---- Notification integration ----
  // Track what status each order had in the previous render so we can detect
  // the preparing → ready transition without needing a WebSocket.
  var _prevStatus   = {};   // { orderId: status }
  var _firstRender  = true; // true until after the first successful load

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

  function elapsedBadgeHtml(mins) {
    var info = elapsedInfo(mins);
    return "<span class='elapsed-badge elapsed-" + info.cls + "'>" + info.label + ' ' + info.urgency + '</span>';
  }

  // Tick elapsed badges in-place (avoids full re-render on the 60 s timer)
  function tickElapsedBadges() {
    var badges = cardsEl.querySelectorAll('[data-placed-at]');
    Array.prototype.forEach.call(badges, function (el) {
      var mins = elapsedMinutes(el.getAttribute('data-placed-at'));
      var info = elapsedInfo(mins);
      el.className = 'elapsed-badge elapsed-' + info.cls;
      el.textContent = info.label + ' ' + info.urgency;
    });
    // Also refresh the delayed-orders panel
    var delayedPanel = document.getElementById('delayedPanel');
    if (delayedPanel && Object.keys(ORDERS).length) {
      renderDelayedPanel(Object.values(ORDERS));
    }
  }

  // Start the 60-second elapsed-badge ticker
  setInterval(tickElapsedBadges, 60000);

  function restaurant() {
    return document.getElementById('restaurant').value.trim() || 'demo';
  }
  function money(cur, n) { return esc(cur) + Number(n || 0).toFixed(2); }
  function num(n)         { return Number(n || 0).toFixed(2); }

  function query() {
    var p  = new URLSearchParams();
    p.set('restaurant', restaurant());
    var s  = document.getElementById('status').value;
    var df = document.getElementById('dateFrom').value;
    var dt = document.getElementById('dateTo').value;
    if (s)  p.set('status',    s);
    if (df) p.set('date_from', df);
    if (dt) p.set('date_to',   dt);
    return p.toString();
  }

  // ---- Receipt config ----
  function fetchReceiptCfg() {
    return sfetch('/manager/receipt-profile?restaurant=' + encodeURIComponent(restaurant()))
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (cfg) { RECEIPT_CFG = cfg || {}; return RECEIPT_CFG; })
      .catch(function () { RECEIPT_CFG = {}; return RECEIPT_CFG; });
  }

  function openReceiptSettings() {
    fetchReceiptCfg().then(function (c) {
      document.getElementById('rsName').value     = c.name     || '';
      document.getElementById('rsSubtitle').value = c.subtitle || '';
      document.getElementById('rsAddress').value  = c.address  || '';
      document.getElementById('rsFssai').value    = c.fssai    || '';
      document.getElementById('rsPhone').value    = c.phone    || '';
      document.getElementById('rsGstin').value    = c.gstin    || '';
      document.getElementById('rsFooter').value   = c.footer   || '';
      document.getElementById('modalBg').classList.add('open');
    });
  }

  function closeReceiptSettings() {
    document.getElementById('modalBg').classList.remove('open');
  }

  // ---- Render helpers ----
  function itemsBlock(items, cur) {
    if (!items || !items.length)
      return "<div class='line'><span class='nm' style='color:#98a2b3'>No items</span></div>";
    return items.map(function (it) {
      var note = it.instructions
        ? "<div class='note'>\uD83D\uDCDD " + esc(it.instructions) + '</div>'
        : '';
      return "<div class='line'><span class='nm'>" + esc(it.quantity) + '\xD7 ' + esc(it.name) +
        "</span><span class='amt'>" + money(cur, it.line_total) + '</span></div>' + note;
    }).join('');
  }

  function renderSummary(orders) {
    var cur = orders.length ? orders[0].currency : '';
    var revenue = 0, count = 0;
    orders.forEach(function (o) {
      if (o.status !== 'cancelled') { revenue += Number(o.total || 0); count++; }
    });

    // Active-only analytics
    var activeOrders = orders.filter(function (o) { return ACTIVE_STATUSES[o.status]; });
    var delayedOrders = activeOrders.filter(function (o) { return elapsedMinutes(o.created_at) >= 20; });

    // Prep-time analytics (use all non-cancelled orders for the date range shown)
    var nonCancelled = orders.filter(function (o) { return o.status !== 'cancelled'; });
    var prepTimes = nonCancelled.map(function (o) { return elapsedMinutes(o.created_at); });
    var avgPrep   = prepTimes.length ? Math.round(prepTimes.reduce(function (s, v) { return s + v; }, 0) / prepTimes.length) : 0;
    var maxPrep   = prepTimes.length ? Math.max.apply(null, prepTimes) : 0;
    var over20    = nonCancelled.length ? Math.round(delayedOrders.length / nonCancelled.length * 100) : 0;

    summaryEl.innerHTML =
      "<div class='kpi'><div class='n'>" + orders.length + "</div><div class='l'>Orders shown</div></div>" +
      "<div class='kpi'><div class='n'>" + count           + "</div><div class='l'>Billable</div></div>" +
      "<div class='kpi'><div class='n'>" + money(cur, revenue) + "</div><div class='l'>Revenue</div></div>" +
      "<div class='kpi delayed-kpi'><div class='n'>" + delayedOrders.length + "</div><div class='l'>Delayed (&gt;20 min)</div></div>" +
      "<div class='kpi'><div class='n'>" + avgPrep + " min</div><div class='l'>Avg prep time</div></div>" +
      "<div class='kpi'><div class='n'>" + maxPrep + " min</div><div class='l'>Longest order today</div></div>" +
      "<div class='kpi'><div class='n'>" + over20 + "%</div><div class='l'>Orders over 20 min</div></div>";
  }

  function signature(orders) {
    return (orders || []).map(function (o) {
      return o.id + ':' + o.status + ':' + o.payment_status + ':' + o.total;
    }).join('|');
  }

  // ---- Delayed Orders panel ----
  function renderDelayedPanel(orders) {
    var panel = document.getElementById('delayedPanel');
    if (!panel) return;
    var activeOrders = orders.filter(function (o) { return ACTIVE_STATUSES[o.status]; });
    var delayed = activeOrders
      .map(function (o) { return { o: o, mins: elapsedMinutes(o.created_at) }; })
      .filter(function (x) { return x.mins >= 20; })
      .sort(function (a, b) { return b.mins - a.mins; });

    if (!delayed.length) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    var rows = delayed.map(function (x) {
      var o   = x.o;
      var who = o.order_type === 'takeaway'
        ? '\uD83E\uDD61 ' + (o.customer_name ? esc(o.customer_name) : 'Takeaway')
        : 'Table ' + esc(o.table_number);
      return "<div class='delayed-row'>" +
        "<span class='delayed-dot'>\uD83D\uDD34</span>" +
        "<span class='delayed-who'>" + who + '</span>' +
        "<span class='elapsed-badge elapsed-red'>" + x.mins + "m Delayed</span>" +
        (o.zone ? "<span class='delayed-zone'>" + esc(o.zone) + '</span>' : '') +
      '</div>';
    }).join('');

    panel.innerHTML =
      "<div class='delayed-header'>" +
        "<span>\u26A0\uFE0F Delayed Orders</span>" +
        "<span class='delayed-count'>" + delayed.length + ' order' + (delayed.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      "<div class='delayed-list'>" + rows + '</div>';
  }

  function render(orders) {
    errEl.textContent = '';
    cardsEl.innerHTML = '';

    var notify = window.DineNotify;

    // First render: seed all visible orders so we don't play stale sounds
    if (_firstRender) {
      if (notify) notify.seedKnown((orders || []).map(function (o) { return o.id; }));
      _firstRender = false;
    }

    // Detect orders that newly became "ready" since the last render
    if (notify) {
      orders.forEach(function (o) {
        if (o.status === 'ready' && _prevStatus[o.id] && _prevStatus[o.id] !== 'ready') {
          notify.onOrderReady(o);
        }
      });
    }

    // Update previous-status snapshot
    orders.forEach(function (o) { _prevStatus[o.id] = o.status; });

    ORDERS = {};
    orders = (orders || []).slice().sort(function (a, b) {
      return new Date(b.created_at) - new Date(a.created_at);
    });
    renderSummary(orders);
    renderDelayedPanel(orders);
    if (!orders.length) { emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';

    orders.forEach(function (o) {
      ORDERS[o.id] = o;
      var cur  = o.currency;
      var who  = o.order_type === 'takeaway'
        ? '\uD83E\uDD61 ' + (o.customer_name ? esc(o.customer_name) : 'Takeaway')
        : 'Table ' + esc(o.table_number);
      var zone = o.zone ? "<div class='zone'>Zone: " + esc(o.zone) + '</div>' : '';
      var when = new Date(o.created_at);
      var whenTxt = isNaN(when.getTime()) ? esc(o.created_at) : when.toLocaleString();

      // Elapsed time badge — only for active (non-terminal) orders
      var isActive = ACTIVE_STATUSES[o.status];
      var elapsedBadge = '';
      if (isActive) {
        var mins = elapsedMinutes(o.created_at);
        var info = elapsedInfo(mins);
        elapsedBadge =
          "<span class='elapsed-badge elapsed-" + info.cls + "' " +
            "data-placed-at='" + esc(o.created_at) + "'>" +
            info.label + ' ' + info.urgency +
          '</span>';
      }

      var card = document.createElement('div');
      card.className = 'bill';
      card.innerHTML =
        "<div class='bill-top'>" +
          '<div>' +
            "<div class='bill-no'>"   + esc(o.order_no)  + '</div>' +
            "<div class='bill-who'>"  + who               + '</div>' + zone +
            "<div class='bill-when'>" + whenTxt            + '</div>' +
          '</div>' +
          "<div class='badges'>" +
            "<span class='pill " + esc(o.status) + "'>" + esc(o.status) + '</span>' +
            (elapsedBadge ? elapsedBadge : '') +
            "<span class='pay "  + (o.payment_status === 'verified' ? 'paid' : 'unpaid') + "'>" +
              (o.payment_status === 'verified' ? 'PAID' : 'UNPAID') +
            '</span>' +
          '</div>' +
        '</div>' +
        "<div class='items'>"   + itemsBlock(o.items, cur) + '</div>' +
        "<div class='totals'>" +
          "<div class='row'><span>Subtotal</span><span>" + money(cur, o.subtotal) + '</span></div>' +
          (Number(o.tax) ? "<div class='row'><span>Tax</span><span>" + money(cur, o.tax) + '</span></div>' : '') +
          "<div class='row grand'><span>Total</span><span>" + money(cur, o.total) + '</span></div>' +
        '</div>' +
        "<div class='bill-actions'>" +
          "<button class='print' data-id='" + esc(o.id) + "'>\uD83D\uDDB8 Print receipt</button>" +
          (o.payment_status !== 'verified'
            ? "<button class='mark-paid'   data-id='" + esc(o.id) + "' data-payment='paid'>\u2713 Mark bill PAID</button>"
            : "<button class='mark-unpaid' data-id='" + esc(o.id) + "' data-payment='unpaid'>\u21A9 Mark bill UNPAID</button>") +
        '</div>';
      cardsEl.appendChild(card);
    });

    // Print buttons
    Array.prototype.forEach.call(cardsEl.querySelectorAll('button.print'), function (btn) {
      btn.addEventListener('click', function () { printReceipt(ORDERS[btn.getAttribute('data-id')]); });
    });

    // Payment toggle
    Array.prototype.forEach.call(cardsEl.querySelectorAll('button.mark-paid, button.mark-unpaid'), function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var isPaid   = btn.getAttribute('data-payment') === 'paid';
        var orderId  = btn.getAttribute('data-id');
        var card     = btn.closest('.bill');
        if (card) {
          var other = card.querySelector(isPaid ? '.mark-paid' : '.mark-unpaid');
          if (other) {
            other.className   = isPaid ? 'mark-unpaid' : 'mark-paid';
            other.setAttribute('data-payment', isPaid ? 'unpaid' : 'paid');
            other.textContent = isPaid ? '\u21A9 Mark bill UNPAID' : '\u2713 Mark bill PAID';
            other.disabled    = false;
          }
          if (ORDERS[orderId]) ORDERS[orderId].payment_status = isPaid ? 'verified' : 'unpaid';
        }
        sfetch('/order/' + encodeURIComponent(orderId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payment_status: isPaid ? 'verified' : 'unpaid' }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('Could not change payment status');
            return r.json();
          })
          .then(function () {
            sfetch('/manager/orders?' + query())
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (data) {
                if (!data) return;
                var sig = signature(data);
                if (sig !== _lastSig) { _lastSig = sig; render(data); }
              })
              .catch(function () {});
          })
          .catch(function (e) { btn.disabled = false; errEl.textContent = e.message; load(); });
      });
    });
  }

  // ---- Thermal receipt ----
  function printReceipt(o) {
    if (!o) return;
    var cfg  = RECEIPT_CFG || {};
    var name = cfg.name || (window.__restName || restaurant());
    var when = new Date(o.created_at);
    var dateStr, timeStr;
    if (isNaN(when.getTime())) { dateStr = esc(o.created_at); timeStr = ''; }
    else {
      dateStr = when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit', weekday: 'short' });
      timeStr = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    var header =
      "<div class='r-center'>" +
      "<div class='r-name'>" + esc(name) + '</div>' +
      (cfg.subtitle ? '<div>' + esc(cfg.subtitle) + '</div>' : '') +
      (cfg.address  ? "<div class='r-small'>" + esc(cfg.address)  + '</div>' : '') +
      (cfg.fssai    ? "<div class='r-small'>FSSAI No. " + esc(cfg.fssai) + '</div>' : '') +
      (cfg.phone    ? "<div class='r-small'>Tel. "      + esc(cfg.phone) + '</div>' : '') +
      '</div>';
    var items = (o.items || []).map(function (it) {
      var q  = Number(it.quantity  || 0);
      var lt = Number(it.line_total != null ? it.line_total : (Number(it.price || 0) * q));
      var rt = Number(it.price     != null ? it.price      : (q ? lt / q : 0));
      return '<tr><td>' + esc(it.name) + "</td><td class='n'>" + q + "</td><td class='n'>" + num(rt) + "</td><td class='n'>" + num(lt) + '</td></tr>';
    }).join('');
    var who = o.order_type === 'takeaway'
      ? ('Takeaway' + (o.customer_name ? ' \xB7 ' + esc(o.customer_name) : ''))
      : ('Tbl: ' + esc(o.table_number));
    receiptEl.innerHTML =
      header +
      "<hr class='r-sep'/><div class='r-center'>*** TAX INVOICE ***</div><hr class='r-sep'/>" +
      "<div class='r-row r-small'><span>" + dateStr + ' ' + timeStr + "</span><span>Bill: " + esc(o.order_no) + '</span></div>' +
      "<div class='r-row r-small'><span>" + who + '</span>' + (o.zone ? '<span>' + esc(o.zone) + '</span>' : '<span></span>') + '</div>' +
      "<hr class='r-sep'/>" +
      "<table><thead><tr><th>Name Of Item</th><th class='n'>Qty</th><th class='n'>Rate</th><th class='n'>Amount</th></tr></thead>" +
      '<tbody>' + items + '</tbody></table>' +
      "<hr class='r-sep'/>" +
      "<div class='r-row'><span></span><span>Sub Total: " + num(o.subtotal) + '</span></div>' +
      (Number(o.tax) ? "<div class='r-row'><span></span><span>Tax: " + num(o.tax) + '</span></div>' : '') +
      "<div class='r-row'><span></span><span>Food Total: " + num(o.total) + '</span></div>' +
      "<hr class='r-sep'/>" +
      "<div class='r-total'>TOTAL =&gt; RS. " + num(o.total) + '</div>' +
      (cfg.gstin ? "<div class='r-small'>GSTIN: " + esc(cfg.gstin) + '</div>' : '') +
      "<div class='r-center' style='margin-top:6px'>***** " + esc(cfg.footer || 'Thank You') + ' *****</div>';
    window.print();
  }

  // ---- Load ----
  function load() {
    fetchReceiptCfg();
    sfetch('/manager/orders?' + query())
      .then(function (r) { if (!r.ok) throw new Error('Load failed (' + r.status + ')'); return r.json(); })
      .then(function (data) {
        if (data.length && data[0].restaurant_name) window.__restName = data[0].restaurant_name;
        _lastSig = signature(data);
        render(data);
      })
      .catch(function (e) { errEl.textContent = e.message; });
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function setToday() {
    var t = todayStr();
    document.getElementById('dateFrom').value = t;
    document.getElementById('dateTo').value   = t;
  }

  // ---- Auto-refresh ----
  function quietRefresh() {
    if (document.hidden) return;
    if (document.getElementById('modalBg').classList.contains('open')) return;
    fetchReceiptCfg();
    sfetch('/manager/orders?' + query())
      .then(function (r) { if (!r.ok) throw Error(); return r.json(); })
      .then(function (data) {
        if (data.length && data[0].restaurant_name) window.__restName = data[0].restaurant_name;
        var sig = signature(data);
        if (sig !== _lastSig) { _lastSig = sig; render(data); }
      })
      .catch(function () {});
  }

  // ---- Event wiring ----
  document.getElementById('applyBtn').onclick         = load;
  document.getElementById('todayBtn').onclick         = function () { setToday(); load(); };
  document.getElementById('tokenBtn').onclick         = function () { promptToken(true); };
  document.getElementById('receiptSettingsBtn').onclick = openReceiptSettings;
  document.getElementById('rsCancel').onclick           = closeReceiptSettings;
  document.getElementById('modalBg').addEventListener('click', function (e) {
    if (e.target === this) closeReceiptSettings();
  });

  document.getElementById('rsSave').onclick = function () {
    var btn  = this;
    var body = {
      restaurant: restaurant(),
      name:       document.getElementById('rsName').value.trim(),
      subtitle:   document.getElementById('rsSubtitle').value.trim(),
      address:    document.getElementById('rsAddress').value.trim(),
      fssai:      document.getElementById('rsFssai').value.trim(),
      phone:      document.getElementById('rsPhone').value.trim(),
      gstin:      document.getElementById('rsGstin').value.trim(),
      footer:     document.getElementById('rsFooter').value.trim(),
    };
    btn.disabled = true;
    sfetch('/manager/receipt-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { if (!r.ok) throw new Error('Save failed (' + r.status + ')'); return r.json(); })
      .then(function (cfg) { RECEIPT_CFG = cfg || {}; closeReceiptSettings(); })
      .catch(function (e) { errEl.textContent = e.message; })
      .then(function () { btn.disabled = false; });
  };

  document.getElementById('csvBtn').onclick = function () {
    window.open('/manager/orders.csv?' + query(), '_blank');
  };
  document.getElementById('jsonBtn').onclick = function () {
    sfetch('/manager/orders?' + query())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        a.download = 'orders-' + restaurant() + '.json';
        a.click();
      })
      .catch(function (e) { errEl.textContent = e.message; });
  };

  document.addEventListener('visibilitychange', function () { if (!document.hidden) quietRefresh(); });
  window.addEventListener('focus', quietRefresh);

  document.getElementById('restaurant').addEventListener('change', function () {
    document.getElementById('availLink').href = 'availability.html?r=' + encodeURIComponent(restaurant());
  });

  // ---- Init ----
  (function () {
    var r = new URLSearchParams(location.search).get('r');
    if (r) {
      document.getElementById('restaurant').value = r;
      document.getElementById('availLink').href   = 'availability.html?r=' + encodeURIComponent(r);
    }
    // Init notifications — manager plays "order ready" sounds
    if (window.DineNotify) window.DineNotify.init('manager');
    setToday();
    load();
    _refreshTimer = setInterval(quietRefresh, REFRESH_MS);
  }());

}());
