// forgot-password.js
(function () {
  'use strict';
  document.getElementById('form').onsubmit = function (e) {
    e.preventDefault();
    var msg = document.getElementById('msg');
    msg.textContent = '';
    fetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: document.getElementById('identifier').value.trim() }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { msg.textContent = res.d.detail || 'Unable to start reset'; msg.className = 'msg error'; return; }
        msg.textContent = res.d.reset_url ? 'Reset link (dev): ' + res.d.reset_url : res.d.message;
        msg.className   = 'msg ok';
      });
  };
}());
