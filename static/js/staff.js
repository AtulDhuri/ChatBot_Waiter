// staff.js — Staff management (legacy standalone page)
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function api(url, opts) {
    opts = opts || {};
    opts.credentials = 'include';
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) { location.href = '/login.html'; throw new Error('Login required'); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.detail || 'Request failed');
        return d;
      });
    });
  }

  function load() {
    api('/staff').then(function (d) {
      $('rows').innerHTML = (d.users || []).map(function (u) {
        var actions = u.role === 'admin' ? '\u2014' :
          '<button class="small" data-id="' + u.id + '" data-status="' + (u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE') + '">' + (u.status === 'ACTIVE' ? 'Disable' : 'Enable') + '</button> ' +
          '<button class="small" data-reset="' + u.id + '">Reset</button>';
        return '<tr><td>' + u.name + '</td><td>' + u.username + '</td><td>' + u.role.toUpperCase() + '</td><td>' + u.status + '</td><td>' + (u.last_login ? new Date(u.last_login).toLocaleString() : 'Never') + '</td><td>' + actions + '</td></tr>';
      }).join('');

      document.querySelectorAll('[data-id]').forEach(function (b) {
        b.onclick = function () {
          api('/staff/' + b.dataset.id + '/status', {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: b.dataset.status }),
          }).then(load).catch(function (e) { $('msg').textContent = e.message; });
        };
      });
      document.querySelectorAll('[data-reset]').forEach(function (b) {
        b.onclick = function () {
          var p = prompt('New password (10+ characters):');
          if (!p) return;
          api('/staff/' + b.dataset.reset + '/reset-password', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: p }),
          }).then(function () { alert('Password reset.'); })
            .catch(function (e) { $('msg').textContent = e.message; });
        };
      });
    }).catch(function (e) { $('msg').textContent = e.message; });
  }

  $('create').onsubmit = function (e) {
    e.preventDefault();
    $('msg').textContent = '';
    if ($('password').value !== $('confirm').value) { $('msg').textContent = 'Passwords do not match'; return; }
    api('/staff', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: $('name').value.trim(), username: $('username').value.trim(),
        email: $('email').value.trim(), password: $('password').value, role: $('role').value,
      }),
    }).then(function () { e.target.reset(); load(); })
      .catch(function (x) { $('msg').textContent = x.message; });
  };

  load();

}());
