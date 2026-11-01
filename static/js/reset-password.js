// reset-password.js
(function () {
  'use strict';
  var token = new URLSearchParams(location.search).get('token') || '';
  document.getElementById('form').onsubmit = function (e) {
    e.preventDefault();
    var msg     = document.getElementById('msg');
    var pw      = document.getElementById('password').value;
    var confirm = document.getElementById('confirm').value;
    if (pw !== confirm) { msg.textContent = 'Passwords do not match'; msg.className = 'msg error'; return; }
    fetch('/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, password: pw }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { msg.textContent = res.d.detail || 'Reset failed'; msg.className = 'msg error'; return; }
        msg.textContent = res.d.message;
        msg.className   = 'msg ok';
        setTimeout(function () { location.href = '/login'; }, 1200);
      });
  };
}());
