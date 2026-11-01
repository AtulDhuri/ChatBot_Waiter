// qr.js — Table QR Code Generator
(function () {
  'use strict';

  // Pre-fill slug from URL ?r= param (set by the nav link in admin-header.js).
  (function () {
    var r = new URLSearchParams(location.search).get('r');
    if (r) document.getElementById('restaurant').value = r;
  })();

  // ── helpers ────────────────────────────────────────────────────────────

  function baseUrl() {
    var base = document.getElementById('base').value.trim();
    if (!base) base = window.location.origin;
    return base.replace(/\/$/, '');
  }

  function mintToken(slug, table) {
    return fetch('/qr/token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant: slug, table_number: table }),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(
          function (e) { throw new Error((e && e.detail) || "Couldn't create the code."); },
          function ()  { throw new Error("Couldn't create the code (HTTP " + r.status + ').'); }
        );
      }
      return r.json();
    });
  }

  function buildQr(container, url) {
    if (window.QRCode) {
      new QRCode(container, {
        text: url,
        width: 180,
        height: 180,
        correctLevel: QRCode.CorrectLevel.M,
      });
    } else {
      container.innerHTML =
        "<p class='muted'>QR library unavailable.</p>" +
        "<p><a href='" + url + "'>" + url + '</a></p>';
    }
  }

  // ── Single QR ──────────────────────────────────────────────────────────

  function renderQr(url, table) {
    var out   = document.getElementById('out');
    var box   = document.getElementById('qrcode');
    var title = document.getElementById('title');
    var link  = document.getElementById('link');
    out.style.display = 'block';
    box.innerHTML     = '';
    title.textContent = table ? 'Table ' + table : 'Table QR';
    link.textContent  = url;
    buildQr(box, url);
  }

  document.getElementById('go').addEventListener('click', function () {
    var slug  = document.getElementById('restaurant').value.trim() || 'demo';
    var table = document.getElementById('table').value.trim();
    var go    = document.getElementById('go');
    if (!table) { alert('Enter a table number.'); return; }
    go.disabled = true;
    var old = go.textContent;
    go.textContent = 'Generating\u2026';
    mintToken(slug, table)
      .then(function (data) {
        renderQr(baseUrl() + '/?r=' + encodeURIComponent(data.token), data.table_number || table);
      })
      .catch(function (err) { alert(err.message); })
      .then(function () { go.disabled = false; go.textContent = old; });
  });

  // ── Print-all tables ───────────────────────────────────────────────────

  document.getElementById('printAll').addEventListener('click', function () {
    var slug = document.getElementById('restaurant').value.trim();
    if (!slug) { alert('Enter the restaurant slug first.'); return; }

    var btn       = document.getElementById('printAll');
    var statusEl  = document.getElementById('printAllStatus');

    btn.disabled      = true;
    btn.textContent   = 'Loading\u2026';
    statusEl.style.display = 'block';
    statusEl.className     = 'status-msg';
    statusEl.textContent   = 'Fetching tables\u2026';

    // 1. Load tables from setup-data (already cached on server).
    fetch('/manager/setup-data?restaurant=' + encodeURIComponent(slug), {
      credentials: 'include',
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Failed to load tables (HTTP ' + r.status + ').');
        return r.json();
      })
      .then(function (data) {
        var tables = (data.tables || []).map(function (t) { return t.table_number; });
        if (tables.length === 0) {
          throw new Error('No tables found for this restaurant. Set them up in Admin first.');
        }
        statusEl.textContent = 'Preparing QR codes for ' + tables.length + ' tables\u2026';

        // 2. Mint tokens for all tables in parallel.
        // Capture what we need from data now, before the next .then().
        var restaurantName = data.restaurant_name || '';
        var tableRows      = data.tables || [];

        return Promise.all(
          tables.map(function (tbl) {
            return mintToken(slug, tbl).then(function (d) {
              return {
                table: d.table_number || tbl,
                url: baseUrl() + '/?r=' + encodeURIComponent(d.token),
                zone: (tableRows.find(function (t) { return t.table_number === tbl; }) || {}).zone || '',
              };
            });
          })
        ).then(function (entries) {
          // Pass restaurantName along so the next step can use it.
          return { entries: entries, restaurantName: restaurantName };
        });
      })
      .then(function (result) {
        var entries        = result.entries;
        var restaurantName = result.restaurantName;

        // 3. Render all QR codes into the hidden print grid.
        var grid = document.getElementById('printGridInner');
        grid.innerHTML = '';

        entries.forEach(function (entry) {
          var cell = document.createElement('div');
          cell.className = 'qr-print-cell';

          var nameEl = document.createElement('div');
          nameEl.className = 'qr-print-name';
          nameEl.textContent = restaurantName;

          var tableEl = document.createElement('div');
          tableEl.className = 'qr-print-table';
          tableEl.textContent = 'Table ' + entry.table;

          var zoneEl = document.createElement('div');
          zoneEl.className = 'qr-print-zone';
          zoneEl.textContent = entry.zone || '';

          var qrBox = document.createElement('div');
          qrBox.className = 'qr-print-code';
          buildQr(qrBox, entry.url);

          var urlEl = document.createElement('div');
          urlEl.className = 'qr-print-url';
          urlEl.textContent = 'Scan to order';

          cell.appendChild(nameEl);
          cell.appendChild(tableEl);
          cell.appendChild(zoneEl);
          cell.appendChild(qrBox);
          cell.appendChild(urlEl);
          grid.appendChild(cell);
        });

        statusEl.className     = 'status-msg ok';
        statusEl.textContent   = '\u2713 ' + entries.length + ' QR codes ready. Printing\u2026';

        // 4. Show grid (screen only so it doesn't flash), trigger print, then hide.
        var printGrid = document.getElementById('printGrid');
        printGrid.style.display = 'block';

        // Small delay so the QR canvas renders before print dialog opens.
        setTimeout(function () {
          window.print();
          // Hide after print dialog closes (afterprint fires on all modern browsers).
          function cleanup() {
            printGrid.style.display = 'none';
            window.removeEventListener('afterprint', cleanup);
          }
          window.addEventListener('afterprint', cleanup);
        }, 300);
      })
      .catch(function (err) {
        statusEl.className   = 'status-msg err';
        statusEl.textContent = err.message || 'Something went wrong.';
      })
      .then(function () {
        btn.disabled    = false;
        btn.textContent = '\uD83D\uDDA8\uFE0F Print all tables';
      });
  });

}());
