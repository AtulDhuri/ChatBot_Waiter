// reports.js — Merchant Analytics Dashboard
(function () {
  'use strict';

  var state = { data: null, rows: [], page: 1, pageSize: 10, sort: 'date', dir: -1 };

  function authFetch(url) {
    return fetch(url, { credentials: 'include' }).then(function (r) {
      if (r.status === 401 || r.status === 402) { location.href = '/login.html'; throw new Error('Authentication required'); }
      return r;
    });
  }
  function pad(n) { return n < 10 ? '0' + n : n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function money(n) { return (state.data && state.data.currency || '$') + Number(n || 0).toFixed(2); }

  function setRange(kind) {
    var to = new Date(), from = new Date();
    if (kind === '7')  from.setDate(to.getDate() - 6);
    if (kind === '30') from.setDate(to.getDate() - 29);
    if (kind !== 'custom') {
      document.getElementById('from').value = iso(from);
      document.getElementById('to').value   = iso(to);
    }
    Array.prototype.forEach.call(document.querySelectorAll('.range-buttons button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-range') === kind);
    });
  }

  function qs() {
    var p = new URLSearchParams();
    p.set('restaurant', document.getElementById('outlet').value);
    var f = document.getElementById('from').value, t = document.getElementById('to').value;
    if (f) p.set('date_from', f);
    if (t) p.set('date_to',   t);
    return p.toString();
  }

  function empty(el, text) { el.innerHTML = "<div class='empty'>" + text + '</div>'; }

  function svgLine(rows, key, currency) {
    if (!rows.length) return "<div class='empty'>No revenue in this period.</div>";
    var w = 650, h = 230, p = 28;
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r[key]); })) || 1;
    var pts = rows.map(function (r, i) { return [p + i * (w - p * 2) / Math.max(rows.length - 1, 1), h - p - (Number(r[key]) / max) * (h - p * 2)]; });
    var path = pts.map(function (x, i) { return (i ? 'L' : 'M') + x[0] + ' ' + x[1]; }).join(' ');
    return "<svg viewBox='0 0 " + w + ' ' + h + "' role='img' aria-label='Revenue line chart'>" +
      "<defs><linearGradient id='areaGradient' x1='0' x2='0' y1='0' y2='1'>" +
      "<stop stop-color='#8b5cf6'/><stop offset='1' stop-color='#6366f1' stop-opacity='0'/></linearGradient></defs>" +
      "<line class='gridline' x1='" + p + "' x2='" + (w - p) + "' y1='" + (h - p) + "' y2='" + (h - p) + "'/>" +
      "<path class='area' d='M" + pts[0][0] + ' ' + (h - p) + ' ' + path.slice(1) + ' L' + pts[pts.length - 1][0] + ' ' + (h - p) + " Z'/>" +
      "<path class='line' d='" + path + "'/>" +
      "<text class='axis' x='" + p + "' y='16'>" + esc(currency) + Number(max).toFixed(0) + ' max</text>' +
      pts.map(function (x, i) {
        return "<circle class='dot' cx='" + x[0] + "' cy='" + x[1] + "' r='4'><title>" + rows[i].date + ': ' + money(rows[i].revenue) + '</title></circle>';
      }).join('') + '</svg>';
  }

  function bars(rows) {
    if (!rows.length) return "<div class='empty'>No orders in this period.</div>";
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r.orders); })) || 1;
    return "<div class='bars'>" + rows.map(function (r) {
      var h = Math.max(3, Number(r.orders) / max * 100);
      return "<div class='bar-wrap'><div class='bar' style='height:" + h + "%'><title>" + r.date + ': ' + r.orders + " orders</title></div><div class='bar-label'>" + r.date.slice(5) + '</div></div>';
    }).join('') + '</div>';
  }

  function renderStatus(by) {
    var names  = ['new', 'preparing', 'ready', 'served', 'cancelled'];
    var labels = { 'new': 'Pending', preparing: 'Preparing', ready: 'Ready', served: 'Served', cancelled: 'Cancelled' };
    var colors = { 'new': '#6366f1', preparing: '#a855f7', ready: '#3b82f6', served: '#22c55e', cancelled: '#f87171' };
    var total  = names.reduce(function (a, n) { return a + (by[n] || 0); }, 0);
    var el     = document.getElementById('statusChart');
    if (!total) { empty(el, 'No order status data.'); return; }
    var start = 0;
    var stops = names.map(function (n) {
      var end = start + (by[n] || 0) / total * 100, part = colors[n] + ' ' + start + '% ' + end + '%';
      start = end; return part;
    }).join(',');
    el.innerHTML = "<div class='donut' style='background:conic-gradient(" + stops + ")'></div>" +
      "<div class='legend'>" + names.map(function (n) {
        return "<div class='legend-row'><i class='legend-dot' style='background:" + colors[n] + "'></i>" + labels[n] + '<strong>' + (by[n] || 0) + '</strong></div>';
      }).join('') + '</div>';
  }

  function renderItems(items) {
    var el = document.getElementById('itemsChart');
    if (!items.length) { empty(el, 'No completed item sales in this period.'); return; }
    var max = items[0].quantity;
    el.innerHTML = items.map(function (it) {
      return "<div class='hrow'><div class='hname' title='" + esc(it.name) + "'>" + esc(it.name) + "</div>" +
        "<div class='track'><div class='fill' style='width:" + (it.quantity / max * 100) + "%'></div></div>" +
        "<div class='qty'>" + it.quantity + ' \xB7 ' + money(it.revenue) + '</div></div>';
    }).join('');
  }

  function renderOutlets(outlets) {
    var card = document.getElementById('outletCard');
    if (outlets.length < 2) { card.hidden = true; return; }
    card.hidden = false;
    var max = Math.max.apply(null, outlets.map(function (o) { return o.revenue; })) || 1;
    document.getElementById('outletsChart').innerHTML = outlets.map(function (o) {
      return "<div class='outlet-row'><div class='outlet-name' title='" + esc(o.name) + "'>" + esc(o.name) + "</div>" +
        "<div class='outlet-bar'><span style='width:" + (o.revenue / max * 100) + "%'></span></div>" +
        "<div class='outlet-meta'>" + money(o.revenue) + "</div><div class='outlet-meta'>" + o.orders + ' orders</div></div>';
    }).join('');
  }

  function renderTable() {
    var q     = document.getElementById('search').value.toLowerCase();
    var rows  = state.rows.filter(function (r) { return (r.date + ' ' + r.orders + ' ' + r.revenue + ' ' + r.aov).toLowerCase().indexOf(q) >= 0; });
    rows.sort(function (a, b) { var x = a[state.sort], y = b[state.sort]; return x < y ? -state.dir : x > y ? state.dir : 0; });
    var pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(state.page, pages);
    var slice = rows.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    var tb = document.getElementById('summary');
    tb.innerHTML = slice.length
      ? slice.map(function (r) { return '<tr><td>' + r.date + "</td><td class='num'>" + r.orders + "</td><td class='num'>" + money(r.revenue) + "</td><td class='num'>" + money(r.aov) + '</td></tr>'; }).join('')
      : "<tr><td colspan='4' class='empty'>No matching dates.</td></tr>";
    document.getElementById('pageInfo').textContent    = 'Page ' + state.page + ' of ' + pages;
    document.getElementById('prev').disabled = state.page === 1;
    document.getElementById('next').disabled = state.page === pages;
  }

  function showData(d) {
    state.data = d; state.rows = d.summary || [];
    var completed = d.completed_orders || 0;
    document.getElementById('revenue').textContent  = money(d.total_revenue);
    document.getElementById('orders').textContent   = d.total_orders;
    document.getElementById('dineIn').textContent   = d.dine_in_orders  || 0;
    document.getElementById('takeaway').textContent = d.takeaway_orders || 0;
    document.getElementById('aov').textContent      = money(completed ? d.total_revenue / completed : 0);
    document.getElementById('tables').textContent   = d.active_tables;
    document.getElementById('cancelled').textContent = d.cancelled_orders;
    document.getElementById('staff').textContent    = d.total_staff || '\u2014';
    document.getElementById('revenueChart').innerHTML = svgLine(d.trend || [], 'revenue', d.currency);
    document.getElementById('ordersChart').innerHTML  = bars(d.trend || []);
    renderStatus(d.by_status || {});
    renderItems(d.top_items || []);
    renderOutlets(d.outlets || []);
    state.page = 1; renderTable();
  }

  function run() {
    document.getElementById('revenueChart').innerHTML = "<div class='skeleton' style='height:100%'></div>";
    authFetch('/reports/dashboard?' + qs())
      .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw Error(e.detail || 'Unable to load analytics'); }); return r.json(); })
      .then(showData)
      .catch(function (e) { document.getElementById('revenueChart').innerHTML = "<div class='error'>" + esc(e.message) + '</div>'; });
  }

  function download(kind) {
    var rows = state.rows.map(function (r) { return [r.date, r.orders, r.revenue.toFixed(2), r.aov.toFixed(2)]; });
    var head = ['Date', 'Orders', 'Revenue', 'Average Order Value'];
    var a = document.createElement('a');
    if (kind === 'csv') {
      a.href     = URL.createObjectURL(new Blob([[head].concat(rows).map(function (r) { return r.join(','); }).join('\n')], { type: 'text/csv' }));
      a.download = 'dineos-sales-summary.csv';
    } else {
      var html = '<table><tr>' + head.map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr>' +
        rows.map(function (r) { return '<tr>' + r.map(function (x) { return '<td>' + x + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
      a.href     = URL.createObjectURL(new Blob([html], { type: 'application/vnd.ms-excel' }));
      a.download = 'dineos-sales-summary.xls';
    }
    a.click();
  }

  document.getElementById('apply').onclick   = run;
  document.getElementById('refresh').onclick = run;
  document.getElementById('search').oninput  = function () { state.page = 1; renderTable(); };
  document.getElementById('prev').onclick    = function () { state.page--; renderTable(); };
  document.getElementById('next').onclick    = function () { state.page++; renderTable(); };
  document.getElementById('csv').onclick     = function () { download('csv'); };
  document.getElementById('excel').onclick   = function () { download('excel'); };
  Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
    th.onclick = function () {
      var k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = 1; }
      renderTable();
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll('.range-buttons button'), function (b) {
    b.onclick = function () { setRange(b.getAttribute('data-range')); if (b.getAttribute('data-range') !== 'custom') run(); };
  });

  var outletParam = new URLSearchParams(location.search).get('r');
  if (outletParam) document.getElementById('outlet').value = outletParam;
  setRange('30');
  run();

}());
