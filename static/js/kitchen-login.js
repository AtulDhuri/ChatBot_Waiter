// kitchen-login.js
(function () {
  'use strict';
  var form = document.getElementById('form');
  form.onsubmit = function (e) {
    e.preventDefault();
    var error  = document.getElementById('error');
    var button = form.querySelector('button');
    error.textContent = '';
    button.disabled   = true;
    fetch('/auth/kitchen-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
      }),
    })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || 'Login failed'); return d; }); })
      .then(function (d) { location.href = d.redirect || '/kitchen.html'; })
      .catch(function (x) { error.textContent = x.message; button.disabled = false; });
  };
}());
