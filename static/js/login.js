// login.js — Merchant Login + Registration
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var loginTab      = $('loginTab');
  var registerTab   = $('registerTab');
  var loginForm     = $('loginForm');
  var registerForm  = $('registerForm');

  function show(mode) {
    var isLogin = mode === 'login';
    loginTab.classList.toggle('active',    isLogin);
    registerTab.classList.toggle('active', !isLogin);
    loginForm.classList.toggle('active',   isLogin);
    registerForm.classList.toggle('active',!isLogin);
    $('forgotLink').style.display = isLogin ? 'block' : 'none';
    $('title').textContent    = isLogin ? 'Welcome back'          : 'Create your account';
    $('subtitle').textContent = isLogin ? 'Sign in to manage your restaurant.' : 'Set up secure access for your restaurant.';
  }

  loginTab.onclick    = function () { show('login'); };
  registerTab.onclick = function () { show('register'); };
  show('login');

  function setMessage(id, text, type) {
    var el = $(id);
    el.textContent = text;
    el.className   = 'message ' + (type || 'error');
  }

  function readResponse(response) {
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Request failed.');
      return data;
    });
  }

  $('loginForm').onsubmit = function (event) {
    event.preventDefault();
    setMessage('loginMessage', '');
    var button = event.target.querySelector('button');
    button.disabled = true;
    fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: $('loginEmail').value.trim(), password: $('loginPassword').value }),
    })
      .then(readResponse)
      .then(function (d) {
        var next = new URLSearchParams(location.search).get('next');
        location.href = next || d.redirect || '/admin.html';
      })
      .catch(function (error) { setMessage('loginMessage', error.message); button.disabled = false; });
  };

  var slugTimer;
  $('registerSlug').oninput = function () {
    clearTimeout(slugTimer);
    var value = $('registerSlug').value.trim().toLowerCase();
    $('slugStatus').textContent = '';
    $('slugStatus').className   = 'slug-status';
    if (!value) return;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
      $('slugStatus').textContent = 'Use lowercase letters, numbers, and hyphens.';
      $('slugStatus').className   = 'slug-status bad';
      return;
    }
    slugTimer = setTimeout(function () {
      fetch('/auth/check-slug?slug=' + encodeURIComponent(value))
        .then(readResponse)
        .then(function (data) {
          $('slugStatus').textContent = data.available ? 'Slug is available.' : 'Slug is already in use.';
          $('slugStatus').className   = 'slug-status ' + (data.available ? 'ok' : 'bad');
        })
        .catch(function () {
          $('slugStatus').textContent = 'Could not check slug availability.';
          $('slugStatus').className   = 'slug-status bad';
        });
    }, 300);
  };

  $('registerForm').onsubmit = function (event) {
    event.preventDefault();
    setMessage('registerMessage', '');
    var slug     = $('registerSlug').value.trim().toLowerCase();
    var password = $('registerPassword').value;
    if (password !== $('confirmPassword').value) { setMessage('registerMessage', 'Passwords do not match.'); return; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { setMessage('registerMessage', 'Enter a valid unique outlet slug.'); return; }
    var button = $('registerButton');
    button.disabled = true;
    fetch('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: $('registerEmail').value.trim(), password: password, restaurant: slug, name: $('registerName').value.trim() }),
    })
      .then(readResponse)
      .then(function () { location.href = '/admin.html?r=' + encodeURIComponent(slug); })
      .catch(function (error) { setMessage('registerMessage', error.message); button.disabled = false; });
  };

}());
