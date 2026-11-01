// settings.js — Staff Management Settings page
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function showMessage(text, isError) {
    $('msg').textContent = text || '';
    $('msg').className   = isError ? 'msg error' : 'msg';
  }

  function api(url, options) {
    options = options || {};
    options.credentials = 'include';
    return fetch(url, options).then(function (response) {
      if (response.status === 401) { window.location.href = '/login.html'; throw new Error('Login required.'); }
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.detail || 'Request failed.');
        return data;
      });
    });
  }

  function loadUsers() {
    api('/staff').then(function (data) {
      $('rows').innerHTML = (data.users || []).map(function (user) {
        var actions = user.role === 'admin' ? '\u2014' :
          '<button type="button" class="action" data-status-id="' + user.id + '" data-status="' + (user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE') + '">' + (user.status === 'ACTIVE' ? 'Disable' : 'Enable') + '</button> ' +
          '<button type="button" class="action" data-reset-id="' + user.id + '">Reset password</button>';
        return '<tr><td>' + user.name + '</td><td>' + user.username + '</td><td>' + String(user.role).toUpperCase() +
          '</td><td>' + user.status + '</td><td>' + (user.last_login ? new Date(user.last_login).toLocaleString() : 'Never') + '</td><td>' + actions + '</td></tr>';
      }).join('');

      document.querySelectorAll('[data-status-id]').forEach(function (button) {
        button.onclick = function () {
          api('/staff/' + button.dataset.statusId + '/status', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: button.dataset.status }),
          }).then(loadUsers).catch(function (e) { showMessage(e.message, true); });
        };
      });
      document.querySelectorAll('[data-reset-id]').forEach(function (button) {
        button.onclick = function () {
          var password = window.prompt('New password, at least 10 characters:');
          if (!password) return;
          api('/staff/' + button.dataset.resetId + '/reset-password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password }),
          }).then(function () { showMessage('Password reset successfully.'); })
            .catch(function (e) { showMessage(e.message, true); });
        };
      });
    }).catch(function (e) { showMessage(e.message, true); });
  }

  function createUser() {
    var password = $('password').value;
    if (password !== $('confirm').value) { showMessage('Passwords do not match.', true); return; }
    var button = $('createButton');
    button.disabled = true;
    showMessage('Creating user\u2026');
    api('/staff', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:     $('name').value.trim(),
        username: $('username').value.trim(),
        email:    $('email').value.trim(),
        password: password,
        role:     $('role').value,
      }),
    }).then(function () {
      $('createStaffForm').reset();
      showMessage('User created successfully.');
      loadUsers();
    }).catch(function (e) { showMessage(e.message, true); })
      .then(function () { button.disabled = false; });
  }

  $('createButton').addEventListener('click', createUser);

  loadUsers();

}());
