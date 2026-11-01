/**
 * notify.js — Real-Time Audio Notification Engine
 *
 * Generates all sounds via Web Audio API (no audio files needed).
 *
 * Public API (window.DineNotify):
 *   DineNotify.init(role)            — call once after auth resolves
 *   DineNotify.seedKnown(ids)        — mark existing orders silent on first render
 *   DineNotify.onNewOrder(o, cardEl) — new order arrived in kitchen feed
 *   DineNotify.onOrderReady(o)       — order status → ready (manager/staff)
 *   DineNotify.checkReminders(orders)— call each poll; fires reminder sound for stale orders
 *   DineNotify.showBanner(msg, type) — show transient toast
 */
(function (global) {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────
  var STORAGE_KEY_PREFS = 'dineos_notify_prefs';
  var BANNER_MS         = 5000;   // toast auto-dismiss
  var GLOW_MS           = 3000;   // new-order card highlight duration
  var DANGER_GLOW_MS    = 6000;   // danger card highlight duration (longer)

  // Reminder = order is being prepared but taking long (soft warning)
  var REMIND_FIRST_MIN  = 8;
  var REMIND_REPEAT_MIN = 5;

  // Danger = order still NEW (kitchen hasn't even started) after too long
  var DANGER_FIRST_MIN  = 5;   // first danger alarm after 5 min of status=new
  var DANGER_REPEAT_MIN = 3;   // repeat every 3 min until kitchen starts it

  // Statuses for each alarm type
  var DANGER_STATUSES  = { 'new': true };              // only unstarted orders
  var REMINDER_STATUSES = { preparing: true };          // only in-progress orders

  // Per-role event routing
  var ROLE_EVENTS = {
    kitchen: { newOrder: true,  orderReady: false, reminder: true, danger: true  },
    manager: { newOrder: false, orderReady: true,  reminder: false, danger: false },
    staff:   { newOrder: false, orderReady: true,  reminder: false, danger: false },
  };

  // ── State ─────────────────────────────────────────────────────────────────
  var _role         = 'kitchen';
  var _ctx          = null;
  var _unlocked     = false;
  var _pendingSounds = [];

  // In-memory only — intentionally NOT persisted to sessionStorage/localStorage.
  // This is the key fix: on every page load the set starts empty.
  // seedKnown() populates it silently on the first render so existing orders
  // don't trigger sounds. Every subsequent poll only sees genuinely new IDs.
  var _knownIds    = {};   // { "orderId": true }
  var _remindedIds = {};   // { "orderId:remind:N": true }

  var _prefs = {
    newOrderSound:    true,
    readyOrderSound:  true,
    reminderSound:    true,
    dangerSound:      true,
    volume:           0.7,
  };

  // ── Preference persistence ────────────────────────────────────────────────
  function loadPrefs() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_PREFS);
      if (raw) {
        var p = JSON.parse(raw);
        if (typeof p.newOrderSound   === 'boolean') _prefs.newOrderSound   = p.newOrderSound;
        if (typeof p.readyOrderSound === 'boolean') _prefs.readyOrderSound = p.readyOrderSound;
        if (typeof p.reminderSound   === 'boolean') _prefs.reminderSound   = p.reminderSound;
        if (typeof p.dangerSound     === 'boolean') _prefs.dangerSound     = p.dangerSound;
        if (typeof p.volume          === 'number')  _prefs.volume = Math.min(1, Math.max(0, p.volume));
      }
    } catch (e) {}
  }

  function savePrefs() {
    try { localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(_prefs)); } catch (e) {}
  }

  // ── Audio context ─────────────────────────────────────────────────────────
  function getCtx() {
    if (!_ctx) {
      var Ctor = global.AudioContext || global.webkitAudioContext;
      if (!Ctor) return null;
      _ctx = new Ctor();
    }
    return _ctx;
  }

  function ensureUnlocked() {
    var ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === 'running') { _unlocked = true; return; }
    ctx.resume().then(function () {
      _unlocked = true;
      var q = _pendingSounds.splice(0);
      q.forEach(function (fn) { fn(); });
    }).catch(function () {});
  }

  // Unlock AudioContext on any user gesture (covers browser autoplay policy).
  ['click', 'touchstart', 'keydown', 'pointerdown'].forEach(function (evt) {
    document.addEventListener(evt, ensureUnlocked, { once: false, passive: true });
  });

  // ── Sound synthesis ───────────────────────────────────────────────────────
  /**
   * Play a sequence of tones using the Web Audio API.
   * Each note: { freq, dur, type }
   */
  function playTones(notes, vol) {
    var ctx = getCtx();
    if (!ctx) return;

    function doPlay() {
      var now = ctx.currentTime;
      var offset = 0;
      notes.forEach(function (n) {
        var osc  = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = n.type || 'sine';
        osc.frequency.setValueAtTime(n.freq, now + offset);
        // Smooth attack → sustain → decay to avoid clicks
        gain.gain.setValueAtTime(0, now + offset);
        gain.gain.linearRampToValueAtTime(vol, now + offset + 0.02);
        gain.gain.setValueAtTime(vol, now + offset + n.dur - 0.05);
        gain.gain.linearRampToValueAtTime(0, now + offset + n.dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + n.dur);
        offset += n.dur + 0.04;
      });
    }

    if (_unlocked && ctx.state === 'running') {
      doPlay();
    } else {
      _pendingSounds.push(doPlay);
      ensureUnlocked();
    }
  }

  // ── Sound files (optional) ────────────────────────────────────────────────
  // Drop audio files into static/sounds/ to replace the synthesised tones.
  // Supported filenames (any browser-supported format: mp3, ogg, wav, m4a):
  //   new-order.mp3    — played when a new order arrives (kitchen)
  //   order-ready.mp3  — played when an order is marked ready (manager/staff)
  //   reminder.mp3     — played when an order is waiting too long (kitchen)
  //
  // If a file is not found (404) the engine silently falls back to the
  // built-in Web Audio API tones — no configuration required.
  //
  // Files are tried in this order until one loads:
  //   .mp3 → .ogg → .wav → .m4a
  // So naming the file new-order.mp3 is all you need.

  var SOUND_EXTS = ['mp3', 'ogg', 'wav', 'm4a'];
  var SOUND_BASE = '/sounds/';

  // Cache: { 'new-order': AudioBuffer | 'none' | null }
  //   null    = not yet attempted
  //   'none'  = tried all extensions, nothing found — use synth fallback
  //   AudioBuffer = decoded and ready to play
  var _soundCache = {
    'new-order':   null,
    'order-ready': null,
    'reminder':    null,
    'danger':      null,
  };

  // Try loading a named sound. Calls cb(buffer) on success, cb(null) on failure.
  function loadSound(name, cb) {
    var exts = SOUND_EXTS.slice();

    function tryNext() {
      if (!exts.length) { _soundCache[name] = 'none'; cb(null); return; }
      var ext = exts.shift();
      var url = SOUND_BASE + name + '.' + ext;
      fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error('not found');
          return r.arrayBuffer();
        })
        .then(function (buf) {
          var ctx = getCtx();
          if (!ctx) { _soundCache[name] = 'none'; cb(null); return; }
          return ctx.decodeAudioData(buf);
        })
        .then(function (decoded) {
          _soundCache[name] = decoded;
          cb(decoded);
        })
        .catch(tryNext);
    }
    tryNext();
  }

  // Ensure a sound is cached, then call cb(buffer|null).
  function getSound(name, cb) {
    if (_soundCache[name] === 'none') { cb(null); return; }
    if (_soundCache[name] !== null)   { cb(_soundCache[name]); return; }
    loadSound(name, cb);
  }

  // Play a decoded AudioBuffer at the given volume.
  function playBuffer(buffer, vol) {
    var ctx = getCtx();
    if (!ctx || !buffer) return;
    function doPlay() {
      var src  = ctx.createBufferSource();
      var gain = ctx.createGain();
      src.buffer = buffer;
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(ctx.currentTime);
    }
    if (_unlocked && ctx.state === 'running') {
      doPlay();
    } else {
      _pendingSounds.push(doPlay);
      ensureUnlocked();
    }
  }

  /**
   * NEW ORDER — plays new-order.mp3 (or .ogg/.wav/.m4a) if present,
   * otherwise falls back to synthesised ding-ding tones.
   */
  function playNewOrder(vol) {
    getSound('new-order', function (buf) {
      if (buf) { playBuffer(buf, vol); }
      else {
        playTones([
          { freq: 659.25, dur: 0.20, type: 'sine' },  // E5
          { freq: 783.99, dur: 0.25, type: 'sine' },  // G5
        ], vol);
      }
    });
  }

  /**
   * ORDER READY — plays order-ready.mp3 if present,
   * otherwise falls back to descending service-bell tones.
   */
  function playOrderReady(vol) {
    getSound('order-ready', function (buf) {
      if (buf) { playBuffer(buf, vol); }
      else {
        playTones([
          { freq: 987.77, dur: 0.15, type: 'sine' },  // B5
          { freq: 783.99, dur: 0.15, type: 'sine' },  // G5
          { freq: 659.25, dur: 0.28, type: 'sine' },  // E5
        ], vol);
      }
    });
  }

  /**
   * REMINDER — plays reminder.mp3 if present,
   * otherwise falls back to a soft two-note synth tone.
   * Used for orders that are PREPARING but taking long.
   */
  function playReminder(vol) {
    var softVol = Math.max(0.1, vol * 0.65);
    getSound('reminder', function (buf) {
      if (buf) { playBuffer(buf, softVol); }
      else {
        playTones([
          { freq: 659.25, dur: 0.18, type: 'sine' },  // E5
          { freq: 523.25, dur: 0.22, type: 'sine' },  // C5
        ], softVol);
      }
    });
  }

  /**
   * DANGER — plays danger.mp3 if present, otherwise a loud urgent repeating
   * burst. Used when an order is still NEW (not started) after DANGER_FIRST_MIN.
   * Intentionally louder and more alarming than the reminder.
   */
  function playDanger(vol) {
    getSound('danger', function (buf) {
      if (buf) { playBuffer(buf, vol); }
      else {
        // Three rapid high-pitched pulses — clearly urgent, not musical
        playTones([
          { freq: 1046.50, dur: 0.10, type: 'square' },  // C6
          { freq: 1046.50, dur: 0.10, type: 'square' },  // C6
          { freq: 1244.51, dur: 0.18, type: 'square' },  // D#6 — rising = alarm
        ], Math.min(1, vol * 1.1));
      }
    });
  }

  // ── Settings panel ────────────────────────────────────────────────────────
  function buildSettingsPanel() {
    var panel = document.createElement('div');
    panel.id = 'notifySettings';
    panel.className = 'notify-settings-panel';

    function row(id, label, checked) {
      return '<label class="notify-toggle">' +
        '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + ' />' +
        '<span>' + label + '</span></label>';
    }

    panel.innerHTML =
      '<div class="notify-settings-header">' +
        '<span>\uD83D\uDD14 Sound Notifications</span>' +
        '<button class="notify-close-btn" aria-label="Close">\u00D7</button>' +
      '</div>' +
      '<div class="notify-settings-body">' +
        row('nsNewOrder',   '\uD83D\uDD14 New Order Sound',                     _prefs.newOrderSound)   +
        row('nsReadyOrder', '\uD83D\uDECE\uFE0F Ready Order Sound',              _prefs.readyOrderSound) +
        row('nsReminder',   '\u23F0 Preparing reminder (' + REMIND_FIRST_MIN + ' min)', _prefs.reminderSound) +
        row('nsDanger',     '\uD83D\uDEA8 Danger: order not started (' + DANGER_FIRST_MIN + ' min)', _prefs.dangerSound) +
        '<label class="notify-toggle notify-volume-row">' +
          '<span>Volume</span>' +
          '<select id="nsVolume">' +
            '<option value="0.3"' + (_prefs.volume <= 0.35 ? ' selected' : '') + '>Low</option>'  +
            '<option value="0.7"' + (_prefs.volume >  0.35 && _prefs.volume <= 0.85 ? ' selected' : '') + '>Medium</option>' +
            '<option value="1.0"' + (_prefs.volume >  0.85 ? ' selected' : '') + '>High</option>' +
          '</select>' +
        '</label>' +
        '<button class="notify-test-btn" data-sound="new">Test New Order \uD83D\uDD14</button>'       +
        '<button class="notify-test-btn" data-sound="ready">Test Ready \uD83D\uDECE</button>'         +
        '<button class="notify-test-btn" data-sound="remind">Test Reminder \u23F0</button>'           +
        '<button class="notify-test-btn notify-test-danger" data-sound="danger">Test Danger \uD83D\uDEA8</button>' +
      '</div>';

    document.body.appendChild(panel);

    panel.querySelector('.notify-close-btn').onclick = function () {
      panel.style.display = 'none';
    };
    panel.querySelector('#nsNewOrder').onchange = function () {
      _prefs.newOrderSound = this.checked; savePrefs();
    };
    panel.querySelector('#nsReadyOrder').onchange = function () {
      _prefs.readyOrderSound = this.checked; savePrefs();
    };
    panel.querySelector('#nsReminder').onchange = function () {
      _prefs.reminderSound = this.checked; savePrefs();
    };
    panel.querySelector('#nsDanger').onchange = function () {
      _prefs.dangerSound = this.checked; savePrefs();
    };
    panel.querySelector('#nsVolume').onchange = function () {
      _prefs.volume = parseFloat(this.value); savePrefs();
    };
    // NodeList.forEach not available in old Android WebViews — use Array.prototype
    Array.prototype.forEach.call(panel.querySelectorAll('.notify-test-btn'), function (btn) {
      btn.onclick = function () {
        ensureUnlocked();
        var s = btn.getAttribute('data-sound');
        if (s === 'new')    playNewOrder(_prefs.volume);
        if (s === 'ready')  playOrderReady(_prefs.volume);
        if (s === 'remind') playReminder(_prefs.volume);
        if (s === 'danger') playDanger(_prefs.volume);
      };
    });

    return panel;
  }

  function getSettingsPanel() {
    return document.getElementById('notifySettings') || buildSettingsPanel();
  }

  // ── Permission banner ─────────────────────────────────────────────────────
  var _permBannerShown = false;

  function showPermissionBanner() {
    if (_permBannerShown) return;
    _permBannerShown = true;
    var bar = document.createElement('div');
    bar.id = 'notifyPermBar';
    bar.className = 'notify-perm-bar';
    bar.innerHTML =
      '<span>\uD83D\uDD14 Enable sound notifications to hear new orders and alerts.</span>' +
      '<button class="notify-enable-btn">Enable Sounds</button>' +
      '<button class="notify-dismiss-btn" aria-label="Dismiss">\u00D7</button>';
    document.body.appendChild(bar);

    bar.querySelector('.notify-enable-btn').onclick = function () {
      ensureUnlocked();
      bar.remove();
      // Play a confirmation tone so the user hears it worked
      setTimeout(function () { playNewOrder(_prefs.volume); }, 150);
    };
    bar.querySelector('.notify-dismiss-btn').onclick = function () {
      bar.remove();
    };
  }

  // ── Toast notifications ───────────────────────────────────────────────────
  var _toastContainer = null;

  function getToastContainer() {
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'notifyToasts';
      _toastContainer.className = 'notify-toasts';
      document.body.appendChild(_toastContainer);
    }
    return _toastContainer;
  }

  function showBanner(msg, type) {
    var toast = document.createElement('div');
    toast.className = 'notify-toast notify-toast-' + (type || 'new');
    toast.innerHTML = msg;
    getToastContainer().appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add('notify-toast-visible'); });
    var tid = setTimeout(dismiss, BANNER_MS);
    function dismiss() {
      clearTimeout(tid);
      toast.classList.remove('notify-toast-visible');
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 350);
    }
    toast.addEventListener('click', dismiss);
  }

  // ── Card highlight — new order (amber glow) ──────────────────────────────
  function flashCard(cardEl) {
    if (!cardEl) return;
    cardEl.classList.add('notify-new-flash');
    setTimeout(function () { cardEl.classList.remove('notify-new-flash'); }, GLOW_MS);
    try { cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
  }

  // ── Card highlight — danger (red pulse + shake) ───────────────────────────
  function flashDanger(cardEl) {
    if (!cardEl) return;
    cardEl.classList.remove('notify-danger-flash'); // reset if already active
    // Force reflow so re-adding the class restarts the animation
    void cardEl.offsetWidth;
    cardEl.classList.add('notify-danger-flash');
    setTimeout(function () { cardEl.classList.remove('notify-danger-flash'); }, DANGER_GLOW_MS);
    try { cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
  }

  // ── Bell button injected into header ─────────────────────────────────────
  function injectSoundButton() {
    var header = document.querySelector('header');
    if (!header || document.getElementById('notifySoundBtn')) return;
    var btn = document.createElement('button');
    btn.id = 'notifySoundBtn';
    btn.className = 'notify-sound-btn';
    btn.title = 'Sound notification settings';
    btn.setAttribute('aria-label', 'Sound notification settings');
    btn.innerHTML = '\uD83D\uDD14';
    btn.onclick = function () {
      var panel = getSettingsPanel();
      panel.style.display = (panel.style.display === 'none' || panel.style.display === '') ? 'block' : 'none';
    };
    var buttons = header.querySelectorAll('button');
    var lastBtn = buttons[buttons.length - 1];
    if (lastBtn) header.insertBefore(btn, lastBtn);
    else header.appendChild(btn);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  var DineNotify = {

    /**
     * Initialise for a given role.
     * Call AFTER the auth identity is resolved (so role is known).
     */
    init: function (role) {
      _role = role || 'kitchen';
      loadPrefs();
      // NOTE: do NOT loadKnown() from storage here. Known IDs are intentionally
      // in-memory only so they reset on every page load. seedKnown() on the
      // first render is what silences stale orders without touching storage.
      injectSoundButton();
      var ctx = getCtx();
      if (!ctx || ctx.state !== 'running') {
        showPermissionBanner();
      }
    },

    /**
     * Seed order IDs that were already visible on the first render.
     * Call ONCE, on the very first successful poll, with all returned order IDs.
     * These orders will be silently marked known — no sound plays for them.
     * All future polls compare against this set; any new ID triggers sound.
     */
    seedKnown: function (ids) {
      (ids || []).forEach(function (id) { _knownIds[String(id)] = true; });
    },

    /**
     * Fire when a new order appears in the kitchen feed.
     * DineNotify deduplicates: plays sound only once per order ID per page load.
     */
    onNewOrder: function (order, cardEl) {
      var id  = String(order.id);
      var cfg = ROLE_EVENTS[_role] || {};
      if (!cfg.newOrder) return;
      if (_knownIds[id]) return;    // already seen — dedup
      _knownIds[id] = true;         // mark known (in memory only)

      if (_prefs.newOrderSound) playNewOrder(_prefs.volume);
      flashCard(cardEl);

      var who = order.order_type === 'takeaway'
        ? ('\uD83E\uDD61 ' + (order.customer_name || 'Takeaway'))
        : ('Table ' + (order.table_number || '?'));
      showBanner(
        '<strong>\uD83D\uDD14 NEW ORDER</strong> &mdash; ' + escNotify(who) +
        ' &nbsp;<small>(' + escNotify(order.order_no) + ')</small>',
        'new'
      );
    },

    /**
     * Fire when an order transitions to "ready".
     * Deduplicates per order per page load.
     */
    onOrderReady: function (order) {
      var id  = String(order.id) + ':ready';
      var cfg = ROLE_EVENTS[_role] || {};
      if (!cfg.orderReady) return;
      if (_remindedIds[id]) return;
      _remindedIds[id] = true;

      if (_prefs.readyOrderSound) playOrderReady(_prefs.volume);

      var who = order.order_type === 'takeaway'
        ? ('\uD83E\uDD61 ' + (order.customer_name || 'Takeaway'))
        : ('Table ' + (order.table_number || '?'));
      showBanner(
        '<strong>\uD83D\uDECE\uFE0F ORDER READY</strong> &mdash; ' + escNotify(who) +
        ' &mdash; <em>Please Serve</em>',
        'ready'
      );
    },

    /**
     * Check active orders for two distinct alarm types. Call on every poll.
     *
     * DANGER  — order status is still "new" (kitchen hasn't started it).
     *           Fires at DANGER_FIRST_MIN, repeats every DANGER_REPEAT_MIN.
     *           Plays danger sound + red flash on the card.
     *
     * REMINDER — order is "preparing" but taking long.
     *            Fires at REMIND_FIRST_MIN, repeats every REMIND_REPEAT_MIN.
     *            Plays soft reminder sound.
     */
    checkReminders: function (orders) {
      var cfg = ROLE_EVENTS[_role] || {};
      if (!cfg.reminder && !cfg.danger) return;

      var now = Date.now();
      var dangerFired   = false;
      var reminderFired = false;

      (orders || []).forEach(function (o) {
        var t = new Date(o.created_at);
        if (isNaN(t.getTime())) return;
        var mins = Math.floor((now - t.getTime()) / 60000);

        // ── DANGER: order not started ──────────────────────────────────────
        if (cfg.danger && _prefs.dangerSound && DANGER_STATUSES[o.status]) {
          if (mins >= DANGER_FIRST_MIN) {
            var dSlot = Math.floor((mins - DANGER_FIRST_MIN) / DANGER_REPEAT_MIN);
            var dKey  = String(o.id) + ':danger:' + dSlot;
            if (!_remindedIds[dKey]) {
              _remindedIds[dKey] = true;
              dangerFired = true;

              // Flash the matching card element red
              var cardEl = document.querySelector('[data-order-id="' + o.id + '"]');
              flashDanger(cardEl);

              var who = o.order_type === 'takeaway'
                ? ('\uD83E\uDD61 ' + (o.customer_name || 'Takeaway'))
                : ('Table ' + (o.table_number || '?'));
              showBanner(
                '<strong>\uD83D\uDEA8 NOT STARTED \u2014 ' + mins + ' MIN</strong> &mdash; ' +
                escNotify(who) + ' &mdash; <em>Start cooking now!</em>',
                'danger'
              );
            }
          }
        }

        // ── REMINDER: order in preparing but slow ──────────────────────────
        if (cfg.reminder && _prefs.reminderSound && REMINDER_STATUSES[o.status]) {
          if (mins >= REMIND_FIRST_MIN) {
            var rSlot = Math.floor((mins - REMIND_FIRST_MIN) / REMIND_REPEAT_MIN);
            var rKey  = String(o.id) + ':remind:' + rSlot;
            if (!_remindedIds[rKey]) {
              _remindedIds[rKey] = true;
              reminderFired = true;

              var who2 = o.order_type === 'takeaway'
                ? ('\uD83E\uDD61 ' + (o.customer_name || 'Takeaway'))
                : ('Table ' + (o.table_number || '?'));
              showBanner(
                '<strong>\u23F0 STILL PREPARING \u2014 ' + mins + ' MIN</strong> &mdash; ' +
                escNotify(who2),
                'remind'
              );
            }
          }
        }
      });

      // Play one sound per type even if multiple orders fired
      if (dangerFired)   playDanger(_prefs.volume);
      if (reminderFired) playReminder(_prefs.volume);
    },

    showBanner: showBanner,

    // Test hooks
    _playNewOrder:    function (v) { playNewOrder(v != null ? v : _prefs.volume); },
    _playOrderReady:  function (v) { playOrderReady(v != null ? v : _prefs.volume); },
    _playReminder:    function (v) { playReminder(v != null ? v : _prefs.volume); },
    _playDanger:      function (v) { playDanger(v != null ? v : _prefs.volume); },
  };

  function escNotify(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  global.DineNotify = DineNotify;

}(window));
