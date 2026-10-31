(function () {
  var legacy = document.querySelectorAll('body > header, .topbar, .navbar, .top');
  legacy.forEach(function (element) { element.classList.add('dineos-legacy-header'); });
  var style = document.createElement('style');
  style.textContent = '.dineos-legacy-header{display:none!important}.dineos-global-header{position:sticky;top:0;z-index:1000;display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:13px 24px;margin:-28px -16px 28px;background:#111827;color:#fff;box-shadow:0 3px 14px #11182726;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.dineos-global-header .brand{font-weight:850;font-size:19px;letter-spacing:-.03em;white-space:nowrap}.dineos-global-header .outlet{font-size:12px;color:#c7d2fe;border-left:1px solid #ffffff33;padding-left:16px;white-space:nowrap}.dineos-global-header nav{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}.dineos-global-header nav a{color:#dbeafe;text-decoration:none;border-radius:7px;padding:8px 10px;font-size:12px;font-weight:700}.dineos-global-header nav a:hover,.dineos-global-header nav a.active{background:#ffffff18;color:#fff}.dineos-global-header .logout{border:1px solid #fca5a533;background:#7f1d1d;color:#fff;border-radius:7px;padding:8px 11px;font-size:12px;font-weight:800;cursor:pointer}@media(max-width:650px){.dineos-global-header{margin:-28px -16px 20px;padding:12px 14px}.dineos-global-header nav{order:3;width:100%;margin-left:0}.dineos-global-header nav a{flex:1;text-align:center}}';
  document.head.appendChild(style);
  var slug = new URLSearchParams(location.search).get('r') || '';
  var header = document.createElement('header');
  header.className = 'dineos-global-header';
  header.innerHTML = '<div class="brand">DineOS</div><div class="outlet" id="globalOutlet">Restaurant</div><nav id="globalNav"></nav><button class="logout" id="globalLogout" type="button">Log out</button>';
  document.body.insertBefore(header, document.body.firstChild);
  function render(role, outletSlug, displayName) {
    slug = outletSlug || slug;
    document.getElementById('globalOutlet').textContent = displayName || slug ? (displayName || slug) : 'Merchant console';
    var links = [];
    if (role === 'admin') links.push(['Admin setup', '/admin.html?r=' + encodeURIComponent(slug)]);
    if (role === 'admin' || role === 'manager') links.push(['Manager', '/manager.html?r=' + encodeURIComponent(slug)], ['Reports', '/reports.html?r=' + encodeURIComponent(slug)]);
    if (role === 'admin' || role === 'manager' || role === 'kitchen') links.push(['Kitchen', '/kitchen.html?r=' + encodeURIComponent(slug)]);
    if (role === 'admin') links.push(['Settings', '/settings.html']);
    document.getElementById('globalNav').innerHTML = links.map(function (link) { return '<a href="' + link[1] + '">' + link[0] + '</a>'; }).join('');
  }
  // Logout: redirect to role-appropriate login page
  document.getElementById('globalLogout').onclick = function () {
    var role = '';
    fetch('/auth/me', {credentials:'include'}).then(function(r){return r.ok?r.json():null;}).then(function(id){ role = id && id.role; }).catch(function(){}).finally(function(){
      fetch('/auth/logout', {method:'POST', credentials:'include'}).finally(function () {
        if (role === 'kitchen') { location.href='/kitchen-login'; }
        else if (role === 'manager') { location.href='/manager-login'; }
        else { location.href='/login.html'; }
      });
    });
  };
  fetch('/auth/me', {credentials:'include'}).then(function (response) { if (!response.ok) throw Error(); return response.json(); }).then(function (identity) { var displayName = identity.outletSlug || ''; fetch('/menu?restaurant=' + encodeURIComponent(identity.outletSlug || ''), {credentials:'include'}).then(function(r){return r.ok?r.json():null;}).then(function(d){ displayName = (d && d.restaurant_name) || displayName; render(identity.role, identity.outletSlug, displayName); }).catch(function(){ render(identity.role, identity.outletSlug, displayName); }); }).catch(function () { render('', slug); });
}());
