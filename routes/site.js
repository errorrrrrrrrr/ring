'use strict';
/* ── Pages (spec 11.3) ────────────────────────────────────────────────────────
 *   /                 the landing; a signed-in member goes on to /app
 *   /login            sign in; `?next=` comes back to a same-origin path only
 *                     (safeNext); a member already signed in goes straight on
 *   /signup           reads `?invite=` (the URL every invite carries); checks
 *                     the name as it is typed; answers "check your email"
 *   /signup/confirm   asks for the password chosen at signup and confirms on
 *                     SUBMIT, never on load (a mail scanner spends nothing)
 *   /reset            with `?token=`: choose a new password. Without: the
 *                     forgot form, which mails a link (POST /api/password/forgot)
 *   /robots.txt, the 404 page
 * /app and /rings/join/:code are routes/app.js.
 *
 * Plain early-web register (spec 13.2): monospace, white, #0000ff links. Every
 * word comes from lib/strings.js; the pages carry no inline script (CSP is
 * `script-src 'self'`), so `/assets/auth.js` reads its words from data-*
 * attributes. Auth pages are `noindex`.
 */
const express = require('express');
const path = require('node:path');
const { t } = require('../lib/strings');
const { escapeHtml } = require('../lib/security');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const e = escapeHtml;

function shell({ title, body, script = '', noindex = true }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}<title>${e(title)}</title>
<link rel="stylesheet" href="/assets/base.css">
${script ? `<script src="${script}" defer></script>\n` : ''}</head>
<body>
${body}
</body>
</html>
`;
}

const send = (res, status, html, noindex = true) => {
  res.status(status).type('html');
  if (noindex) res.set('X-Robots-Tag', 'noindex');
  res.set('Cache-Control', 'no-cache');
  res.send(html);
};

/* A same-origin path to come back to, or ''. Never `//host`, `/\host`, a
 * scheme or a control character: the redirect after sign-in stays here. */
function safeNext(next) {
  const s = typeof next === 'string' ? next : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\u0000-\u001f\u007f]/.test(s)) return '';
  return s.length > 2000 ? '' : s;
}

function notFoundPage() {
  return shell({
    title: t('page.notfound.title'),
    body: `<main><h1>${e(t('page.notfound.title'))}</h1><p>${e(t('page.notfound.body'))}</p><p><a href="/">${e(t('page.home'))}</a></p></main>`,
  });
}

const field = (label, input) => `<p><label>${e(label)}<br>${input}</label></p>`;

module.exports = function siteRoutes() {
  const router = express.Router();

  router.get('/', (req, res) => {
    if (req.member) return res.redirect(302, '/app');
    send(res, 200, shell({
      title: t('page.index.title'),
      noindex: false,
      body: `<main><h1>${e(t('page.index.title'))}</h1><p>${e(t('page.index.body'))}</p>
<p><a href="/login">${e(t('page.index.signin'))}</a> · <a href="/signup">${e(t('page.index.signup'))}</a></p>
<p>${e(t('page.index.invite_only'))}</p></main>`,
    }), false);
  });

  router.get('/login', (req, res) => {
    const next = safeNext(req.query.next) || '/app';
    if (req.member) return res.redirect(302, next);
    send(res, 200, shell({
      title: t('page.login.title'),
      script: '/assets/auth.js',
      body: `<main id="login" data-next="${e(next)}" data-working="${e(t('page.login.working'))}">
<h1>${e(t('page.login.title'))}</h1>
<form id="login-form">
${field(t('page.login.email'), '<input type="email" name="email" autocomplete="username" required>')}
${field(t('page.login.password'), '<input type="password" name="password" autocomplete="current-password" required>')}
<p><button type="submit">${e(t('page.login.submit'))}</button></p>
</form>
<p id="status" role="status" aria-live="polite"></p>
<p><a href="/reset">${e(t('page.login.forgot'))}</a> · <a href="/signup">${e(t('page.login.signup'))}</a></p>
</main>`,
    }));
  });

  router.get('/signup', (req, res) => {
    if (req.member) return res.redirect(302, '/app');
    const invite = typeof req.query.invite === 'string' ? req.query.invite.slice(0, 64) : '';
    const inviteField = invite
      ? `<input type="hidden" name="invite" value="${e(invite)}"><p>${e(t('page.signup.invite_held'))}</p>`
      : field(t('page.signup.invite'), '<input type="text" name="invite" autocomplete="off" spellcheck="false">');
    send(res, 200, shell({
      title: t('page.signup.title'),
      script: '/assets/auth.js',
      body: `<main id="signup" data-working="${e(t('page.signup.working'))}" data-free="${e(t('page.signup.name_free'))}" data-taken="${e(t('page.signup.name_taken'))}" data-badname="${e(t('name_invalid'))}">
<h1>${e(t('page.signup.title'))}</h1>
<form id="signup-form">
${inviteField}
${field(t('page.signup.email'), '<input type="email" name="email" autocomplete="email" required>')}
<p><label>${e(t('page.signup.name'))}<br><input type="text" name="slug" autocomplete="username" required maxlength="30" pattern="[a-z0-9](?:[a-z0-9\\-]{0,28}[a-z0-9])?" spellcheck="false" aria-describedby="name-status name-hint"></label><br>
<small id="name-hint">${e(t('page.signup.name_hint'))}</small> <small id="name-status" aria-live="polite"></small></p>
${field(t('page.signup.display_name'), '<input type="text" name="display_name" autocomplete="name" maxlength="60">')}
${field(t('page.signup.password'), '<input type="password" name="password" autocomplete="new-password" minlength="10" maxlength="200" required>')}
<p><button type="submit">${e(t('page.signup.submit'))}</button></p>
</form>
<p id="status" role="status" aria-live="polite"></p>
<p><a href="/login">${e(t('page.signup.login'))}</a></p>
</main>`,
    }));
  });

  router.get('/signup/confirm', (req, res) => send(res, 200, shell({
    title: t('page.confirm.title'),
    script: '/assets/auth.js',
    body: `<main id="confirm" data-working="${e(t('page.confirm.working'))}" data-done="${e(t('page.confirm.done'))}">
<h1>${e(t('page.confirm.title'))}</h1>
<form id="confirm-form">
<label>${e(t('page.confirm.label'))}<br><input type="password" name="password" autocomplete="current-password" required></label>
<p><button type="submit" id="confirm-button">${e(t('page.confirm.submit'))}</button></p>
</form>
<p id="status" role="status" aria-live="polite"></p>
<p id="next" hidden><a href="/app">${e(t('page.confirm.open'))}</a></p>
</main>`,
  })));

  router.get('/reset', (req, res) => {
    if (typeof req.query.token === 'string' && req.query.token) {
      return send(res, 200, shell({
        title: t('page.reset.title'),
        script: '/assets/auth.js',
        body: `<main id="reset" data-done="${e(t('page.reset.done'))}">
<h1>${e(t('page.reset.title'))}</h1>
<form id="reset-form">
<label>${e(t('page.reset.label'))}<br><input type="password" name="password" minlength="10" autocomplete="new-password" required></label>
<p><button type="submit">${e(t('page.reset.submit'))}</button></p>
</form>
<p id="status" role="status" aria-live="polite"></p>
<p id="next" hidden><a href="/login">${e(t('page.reset.login'))}</a></p>
</main>`,
      }));
    }
    send(res, 200, shell({
      title: t('page.forgot.title'),
      script: '/assets/auth.js',
      body: `<main id="forgot" data-working="${e(t('page.forgot.working'))}">
<h1>${e(t('page.forgot.title'))}</h1>
<p>${e(t('page.forgot.body'))}</p>
<form id="forgot-form">
${field(t('page.forgot.label'), '<input type="email" name="email" autocomplete="email" required>')}
<p><button type="submit">${e(t('page.forgot.submit'))}</button></p>
</form>
<p id="status" role="status" aria-live="polite"></p>
<p><a href="/login">${e(t('page.forgot.login'))}</a></p>
</main>`,
    }));
  });

  return router;
};

/* Mounted BEFORE the session middleware: nothing here reads or makes a session. */
function publicRoutes() {
  const router = express.Router();
  router.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  });
  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nAllow: /api/images/\nDisallow: /api/\nDisallow: /app\nDisallow: /admin\nDisallow: /login\nDisallow: /signup\nDisallow: /reset\nDisallow: /rings/\n');
  });
  router.use('/assets', express.static(ASSETS, { index: false, dotfiles: 'ignore', fallthrough: true, maxAge: '1h' }));
  return router;
}

module.exports.publicRoutes = publicRoutes;
module.exports.notFoundPage = notFoundPage;
module.exports.sendPage = send;
module.exports.shell = shell;
module.exports.safeNext = safeNext;
