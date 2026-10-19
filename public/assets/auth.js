/* The auth pages' one script (spec 11.3): /login, /signup, /signup/confirm,
 * /reset (a new password with a token, the forgot form without). Vanilla, no
 * build. Every word on screen comes from the server: data-* attributes, or
 * the API's own `message`. Text is set with textContent, never innerHTML.
 * A form is disabled while its request is in flight, and enabled again on a
 * refusal so the person can correct it. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  var status = document.getElementById('status');
  function say(text) { if (status) status.textContent = text || ''; }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    }, function () {
      return { ok: false, status: 0, body: {} };
    });
  }
  function busy(form, on) {
    Array.prototype.forEach.call(form.querySelectorAll('button, input'), function (el) { el.disabled = on; });
  }
  function refused(r) { return r.body.message || r.body.error || ''; }

  /* A same-origin path only: never //host, /\host or a scheme. */
  function safeNext(raw) {
    var s = String(raw || '');
    if (s.charAt(0) !== '/' || s.charAt(1) === '/' || s.charAt(1) === '\\' || /[\u0000-\u001f]/.test(s)) return '/app';
    return s;
  }

  // ── /login ──
  var login = document.getElementById('login');
  var loginForm = document.getElementById('login-form');
  if (login && loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      busy(loginForm, true);
      say(login.getAttribute('data-working'));
      post('/api/login', { email: loginForm.elements.email.value, password: loginForm.elements.password.value }).then(function (r) {
        if (r.ok) { location.assign(safeNext(login.getAttribute('data-next'))); return; }
        busy(loginForm, false);
        say(refused(r));
        loginForm.elements.password.focus();
      });
    });
  }

  // ── /signup ──
  var signup = document.getElementById('signup');
  var signupForm = document.getElementById('signup-form');
  if (signup && signupForm) initSignup(signup, signupForm);
  function initSignup(signup, signupForm) {
    var slug = signupForm.elements.slug;
    var nameStatus = document.getElementById('name-status');
    var checkTimer = 0;
    var NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
    slug.addEventListener('input', function () {
      var v = slug.value.trim().toLowerCase();
      clearTimeout(checkTimer);
      nameStatus.textContent = '';
      if (!v) return;
      if (!NAME_RE.test(v)) { nameStatus.textContent = signup.getAttribute('data-badname'); return; }
      checkTimer = setTimeout(function () {
        fetch('/api/names/' + encodeURIComponent(v), { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
          if (slug.value.trim().toLowerCase() !== v) return;
          nameStatus.textContent = j.available ? signup.getAttribute('data-free') : signup.getAttribute('data-taken');
        }).catch(function () {});
      }, 350);
    });
    signupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      busy(signupForm, true);
      say(signup.getAttribute('data-working'));
      var f = signupForm.elements;
      post('/api/signup', {
        email: f.email.value,
        password: f.password.value,
        slug: f.slug.value.trim().toLowerCase(),
        display_name: f.display_name.value,
        invite: f.invite ? f.invite.value.trim() : '',
      }).then(function (r) {
        if (r.ok) { signupForm.hidden = true; say(r.body.message); return; }
        busy(signupForm, false);
        say(refused(r));
      });
    });
  }

  // ── /signup/confirm ──
  // A submit confirms, never the page load: a mail scanner that runs scripts must
  // not end up holding the new member's session. The password chosen at signup
  // goes with the token: only its holder can finish the signup.
  var confirm = document.getElementById('confirm');
  var confirmForm = document.getElementById('confirm-form');
  var button = document.getElementById('confirm-button');
  var next = document.getElementById('next');
  if (confirm && confirmForm && button) {
    confirmForm.addEventListener('submit', function (e) {
      e.preventDefault();
      button.disabled = true;
      say(confirm.getAttribute('data-working'));
      post('/api/signup/confirm', { token: token, password: confirmForm.elements.password.value }).then(function (r) {
        if (r.ok) {
          confirmForm.hidden = true;
          if (next) { next.hidden = false; if (next.firstElementChild) next.firstElementChild.focus(); }
        } else button.disabled = false;
        say(r.ok ? confirm.getAttribute('data-done') : refused(r));
      });
    });
  }

  // ── /reset with a token: the new password ──
  var reset = document.getElementById('reset');
  var form = document.getElementById('reset-form');
  if (reset && form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      busy(form, true);
      post('/api/password/reset', { token: token, password: form.elements.password.value }).then(function (r) {
        if (r.ok) { form.hidden = true; if (next) next.hidden = false; } else busy(form, false);
        say(r.ok ? reset.getAttribute('data-done') : refused(r));
      });
    });
  }

  // ── /reset without one: the forgot form ──
  var forgot = document.getElementById('forgot');
  var forgotForm = document.getElementById('forgot-form');
  if (forgot && forgotForm) {
    forgotForm.addEventListener('submit', function (e) {
      e.preventDefault();
      busy(forgotForm, true);
      say(forgot.getAttribute('data-working'));
      post('/api/password/forgot', { email: forgotForm.elements.email.value }).then(function (r) {
        if (r.ok) { forgotForm.hidden = true; say(r.body.message); return; }
        busy(forgotForm, false);
        say(refused(r));
      });
    });
  }
})();
