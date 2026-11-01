// availability.js — Dish Availability toggle board
(function () {
  'use strict';

  var listEl  = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var errEl   = document.getElementById('err');
  var statEl  = document.getElementById('stat');
  var toastEl = document.getElementById('toast');
  var MENU    = [];

  function restaurant() {
    return document.getElementById('restaurant').value.trim() || 'demo';
  }

  var _toastT = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(_toastT);
    _toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 1800);
  }

  function stats() {
    var on = MENU.filter(function (m) { return m.available; }).length;
    statEl.textContent = MENU.length + ' dishes \xB7 ' + on + ' available \xB7 ' + (MENU.length - on) + ' sold out';
  }

  function setAvailable(item, available, inputEl) {
    inputEl.disabled = true;
    sfetch('/manager/menu/' + item.id + '?restaurant=' + encodeURIComponent(restaurant()), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ available: available }),
    })
      .then(function (r) { if (!r.ok) throw new Error('Update failed (' + r.status + ')'); return r.json(); })
      .then(function (res) {
        item.available = !!res.available;
        toast(esc(item.name) + (item.available ? ' is now available' : ' marked sold out'));
        render();
      })
      .catch(function (e) {
        errEl.textContent = e.message;
        inputEl.checked   = item.available;
        inputEl.disabled  = false;
      });
  }

  function render() {
    errEl.textContent = '';
    stats();
    var q      = document.getElementById('search').value.trim().toLowerCase();
    var filter = document.getElementById('filter').value;
    listEl.innerHTML = '';
    var byCat = {}, shown = 0;
    MENU.forEach(function (m) {
      if (filter === 'available'   && !m.available) return;
      if (filter === 'unavailable' &&  m.available) return;
      if (q && (m.name || '').toLowerCase().indexOf(q) === -1 &&
               (m.description || '').toLowerCase().indexOf(q) === -1) return;
      var cat = m.category || 'General';
      (byCat[cat] = byCat[cat] || []).push(m);
      shown++;
    });
    if (!shown) { emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';
    Object.keys(byCat).forEach(function (cat) {
      var sec = document.createElement('div');
      sec.className = 'cat';
      sec.innerHTML = '<h2>' + esc(cat) + '</h2>';
      byCat[cat].forEach(function (m) {
        var row   = document.createElement('div');
        row.className = 'dish' + (m.available ? '' : ' off');
        var price = m.price != null ? (esc(m.currency || '') + Number(m.price).toFixed(0)) : '';
        row.innerHTML =
          "<div class='info'>" +
            "<div class='name'>" + esc(m.name) + '</div>' +
            (m.description ? "<div class='desc'>" + esc(m.description) + '</div>' : '') +
            (price ? "<div class='price'>" + price + '</div>' : '') +
          '</div>' +
          "<span class='state " + (m.available ? 'on' : 'off') + "'>" + (m.available ? 'Available' : 'Sold out') + '</span>';
        var label  = document.createElement('label');
        label.className = 'switch';
        var input  = document.createElement('input');
        input.type    = 'checkbox';
        input.checked = m.available;
        input.setAttribute('aria-label', 'Toggle availability for ' + m.name);
        input.onchange = function () { setAvailable(m, input.checked, input); };
        var slider = document.createElement('span');
        slider.className = 'slider';
        label.appendChild(input);
        label.appendChild(slider);
        row.appendChild(label);
        sec.appendChild(row);
      });
      listEl.appendChild(sec);
    });
  }

  function load() {
    errEl.textContent = '';
    fetch('/menu?restaurant=' + encodeURIComponent(restaurant()))
      .then(function (r) {
        if (r.status === 404) { MENU = []; render(); throw new Error('No menu loaded for this restaurant yet.'); }
        if (!r.ok) throw new Error('Load failed (' + r.status + ')');
        return r.json();
      })
      .then(function (data) {
        MENU = (data.items || []).map(function (i) {
          return { id: i.id, name: i.name, description: i.description, category: i.category, price: i.price, currency: i.currency, available: i.available !== false };
        });
        render();
      })
      .catch(function (e) { errEl.textContent = e.message; });
  }

  function bulk(target) {
    var changes = MENU.filter(function (m) { return m.available !== target; });
    if (!changes.length) { toast('Nothing to change.'); return; }
    if (!confirm('Mark ' + changes.length + ' dish(es) as ' + (target ? 'available' : 'sold out') + '?')) return;
    var done = 0, failed = 0;
    changes.forEach(function (m) {
      sfetch('/manager/menu/' + m.id + '?restaurant=' + encodeURIComponent(restaurant()), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ available: target }),
      })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (res) { m.available = !!res.available; done++; })
        .catch(function () { failed++; })
        .then(function () {
          if (done + failed === changes.length) {
            render();
            toast('Updated ' + done + (failed ? ', ' + failed + ' failed' : '') + '.');
          }
        });
    });
  }

  document.getElementById('search').addEventListener('input', render);
  document.getElementById('filter').addEventListener('change', render);
  document.getElementById('reloadBtn').onclick  = load;
  document.getElementById('tokenBtn').onclick   = function () { promptToken(true); };
  document.getElementById('allOnBtn').onclick   = function () { bulk(true); };
  document.getElementById('allOffBtn').onclick  = function () { bulk(false); };
  document.getElementById('restaurant').addEventListener('change', function () {
    document.getElementById('mgrLink').href = 'manager.html?r=' + encodeURIComponent(restaurant());
    load();
  });

  (function () {
    var r = new URLSearchParams(location.search).get('r');
    if (r) {
      document.getElementById('restaurant').value = r;
      document.getElementById('mgrLink').href     = 'manager.html?r=' + encodeURIComponent(r);
    }
    load();
  }());

}());
