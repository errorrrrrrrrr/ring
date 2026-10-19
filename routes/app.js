'use strict';
/* ── The composer's page and the join door (spec 11.3, 13.1) ──────────────────
 *   GET /app                the built composer (app-dist/index.html, Vite) to
 *                           a signed-in member; anyone else goes to
 *                           /login?next=/app... and comes back after. noindex,
 *                           never cached (it names this build's files).
 *   GET /app/assets/*       the bundle: hashed file names, so cached a year,
 *                           immutable. Mounted before the session (assets()):
 *                           a script read needs no session.
 *   GET /rings/join/:code   a join link (lib/urls.js joinUrl). A member goes to
 *                           /app?ring=<code>, where the offer asks before
 *                           anything is sent (the link asks, it never admits);
 *                           a visitor signs in first and comes back to it.
 *                           P7: a visitor from another server is asked their
 *                           handle and sent home (spec 4.7).
 * The CSP stays self-only: the built page is one module script and one
 * stylesheet, both files from this origin, no inline script
 * (test/app-pages.test.js holds it). An unbuilt checkout answers /app with a
 * plain 503 page saying to run `npm run build`.
 */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { t } = require('../lib/strings');
const { escapeHtml } = require('../lib/security');
const { shell, sendPage } = require('./site');

const APP_DIST = path.join(__dirname, '..', 'app-dist');
const INDEX = path.join(APP_DIST, 'index.html');

/* The built page, re-read when the build changes underneath (a rebuild while
 * the server runs serves the new file names at once). */
let cached = { mtimeMs: -1, html: '' };
function indexHtml() {
  let st;
  try { st = fs.statSync(INDEX); } catch { return ''; }
  if (st.mtimeMs !== cached.mtimeMs) cached = { mtimeMs: st.mtimeMs, html: fs.readFileSync(INDEX, 'utf8') };
  return cached.html;
}

function assets() {
  const router = express.Router();
  router.use('/app/assets', express.static(path.join(APP_DIST, 'assets'), {
    index: false, dotfiles: 'ignore', fallthrough: true, immutable: true, maxAge: '365d',
  }));
  return router;
}

module.exports = function appRoutes(ctx = {}) {
  const router = express.Router();

  router.get(['/app', '/app/'], (req, res) => {
    if (!req.member) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    const html = indexHtml();
    if (!html) {
      return sendPage(res, 503, shell({
        title: t('page.app.unbuilt.title'),
        body: `<main><h1>${escapeHtml(t('page.app.unbuilt.title'))}</h1><p>${escapeHtml(t('page.app.unbuilt.body'))}</p></main>`,
      }));
    }
    res.status(200).type('html');
    res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'private, no-store');
    res.send(html);
  });

  /* /admin (P8, spec 6.3, 11.3): the same bundle, whose lazy admin chunk the
   * page loads by its path. Signed out: sign in and come back; a member who is
   * not an admin: 403 (the API refuses them too, every route). noindex, never
   * cached. */
  router.get(['/admin', '/admin/'], (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'private, no-store');
    if (!req.member) return res.redirect(302, `/login?next=${encodeURIComponent('/admin')}`);
    if (req.member.role !== 'admin') {
      return sendPage(res, 403, shell({
        title: t('page.forbidden.title'),
        body: `<main><h1>${escapeHtml(t('page.forbidden.title'))}</h1><p>${escapeHtml(t('page.forbidden.body'))}</p><p><a href="/app">/app</a></p></main>`,
      }));
    }
    const html = indexHtml();
    if (!html) {
      return sendPage(res, 503, shell({
        title: t('page.app.unbuilt.title'),
        body: `<main><h1>${escapeHtml(t('page.app.unbuilt.title'))}</h1><p>${escapeHtml(t('page.app.unbuilt.body'))}</p></main>`,
      }));
    }
    res.status(200).type('html');
    res.send(html);
  });

  router.get('/rings/join/:code', (req, res) => {
    const code = String(req.params.code || '').slice(0, 200);
    const target = `/app?ring=${encodeURIComponent(code)}`;
    res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'private, no-store');
    if (req.member) return res.redirect(302, target);
    // P7 (4.7): with federation on, a visitor may be from another Ring server:
    // the page asks their handle (and offers sign-in here); off, sign in.
    if (ctx.federation && /^[A-Za-z0-9_-]{8,64}$/.test(code)) {
      return res.redirect(302, `/authorize_interaction/remote?uri=${encodeURIComponent(require('../lib/urls').joinUrl(ctx.cfg.publicOrigin, code))}`);
    }
    res.redirect(302, `/login?next=${encodeURIComponent(target)}`);
  });

  return router;
};

module.exports.assets = assets;
module.exports.APP_DIST = APP_DIST;
