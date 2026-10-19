'use strict';
/* Gate: the pages P3 adds (spec 11.3, 10.12, 13.1). /app, /login, /signup, the
 * forgot form at /reset and the join door answer the right page to the right
 * person, keep `next` same-origin, and carry the headers: CSP self-only, no
 * inline script anywhere, noindex on every auth page and on /app. The built
 * composer (app-dist/, `npm run build`, run by `pretest`) is what /app serves. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, joinAdmin, joinInvited } = require('./helpers/harness');

const DIST = path.join(__dirname, '..', 'app-dist', 'index.html');

/* Self-only: every directive that can load script names this origin alone. */
function assertSelfOnly(r, where) {
  const csp = r.headers.get('content-security-policy') || '';
  const dir = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '';
  assert.equal(dir('default-src'), "default-src 'self'", where);
  assert.equal(dir('script-src'), "script-src 'self'", where);
  assert.equal(dir('img-src'), "img-src 'self'", where);
  assert.equal(dir('object-src'), "object-src 'none'", where);
  assert.equal(dir('frame-ancestors'), "frame-ancestors 'none'", where);
}

/* No <script> without src, no inline handler, no javascript: URL. */
function assertNoInlineScript(html, where) {
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  for (const s of scripts) assert.match(s, /\ssrc="\/[^/]/, `${where}: inline or off-origin script ${s}`);
  assert.ok(!/<script\b[^>]*>[^<\s]/i.test(html), `${where}: a script with a body`);
  assert.ok(!/\son[a-z]+\s*=/i.test(html), `${where}: an inline event handler`);
  assert.ok(!/javascript:/i.test(html), `${where}: a javascript: URL`);
}

test('the built composer exists (npm run build)', () => {
  assert.ok(fs.existsSync(DIST), 'app-dist/index.html is missing: run npm run build (npm test runs it first)');
});

test('/app: signed out goes to /login and back; signed in gets the built page, self-only', async () => {
  const h = await boot();
  try {
    const anon = h.client();
    const r1 = await anon.get('/app');
    assert.equal(r1.status, 302);
    assert.equal(r1.headers.get('location'), '/login?next=%2Fapp');
    const r2 = await anon.get('/app?ring=abc');
    assert.equal(r2.headers.get('location'), `/login?next=${encodeURIComponent('/app?ring=abc')}`);

    const ada = await joinAdmin(h);
    const page = await ada.get('/app');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.match(page.headers.get('cache-control'), /no-store/);
    assertSelfOnly(page, '/app');
    assertNoInlineScript(page.text, '/app');
    assert.match(page.text, /<div id="root"><\/div>/);
    assert.match(page.text, /<meta name="robots" content="noindex">/);

    // The bundle it names is served from this origin, cached for good (hashed names).
    const js = /<script type="module"[^>]*src="(\/app\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    const css = /<link rel="stylesheet"[^>]*href="(\/app\/assets\/[^"]+\.css)"/.exec(page.text)?.[1];
    assert.ok(js && css, 'one module script and one stylesheet');
    for (const asset of [js, css]) {
      const a = await anon.get(asset);   // no session needed for a bundle file
      assert.equal(a.status, 200, asset);
      assert.match(a.headers.get('cache-control'), /immutable/, asset);
      assertSelfOnly(a, asset);
    }
    const bundle = (await anon.get(js)).text;
    assert.ok(!/https?:\/\/(cdn|unpkg|cdnjs|fonts\.googleapis)/.test(bundle), 'no CDN in the bundle');
    assert.equal((await anon.get('/app/assets/nothing-here.js')).status, 404);
    assert.equal((await anon.get('/app/assets/../../package.json')).status, 404);
  } finally { await h.close(); }
});

test('/login: the form, noindex, no inline script; a member goes on to a same-origin next only', async () => {
  const h = await boot();
  try {
    const anon = h.client();
    const page = await anon.get('/login?next=%2Fapp%3Fring%3Dxyz');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assertSelfOnly(page, '/login');
    assertNoInlineScript(page.text, '/login');
    assert.match(page.text, /<form id="login-form">/);
    assert.match(page.text, /<script src="\/assets\/auth\.js" defer><\/script>/);
    assert.match(page.text, /data-next="\/app\?ring=xyz"/);
    assert.match(page.text, /href="\/reset"/, 'the forgot link');
    // A next that leaves this origin is never carried.
    for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
      const p = await anon.get(`/login?next=${encodeURIComponent(bad)}`);
      assert.match(p.text, /data-next="\/app"/, bad);
    }

    const ada = await joinAdmin(h);
    const on = await ada.get('/login?next=%2Fapp%3Fring%3Dxyz');
    assert.equal(on.status, 302);
    assert.equal(on.headers.get('location'), '/app?ring=xyz');
    const evil = await ada.get(`/login?next=${encodeURIComponent('//evil.example/')}`);
    assert.equal(evil.headers.get('location'), '/app');
  } finally { await h.close(); }
});

test('/signup reads ?invite= (escaped), checks names, and the invite URL signs a member up', async () => {
  const h = await boot();
  try {
    const anon = h.client();
    const plain = await anon.get('/signup');
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('x-robots-tag'), 'noindex');
    assertSelfOnly(plain, '/signup');
    assertNoInlineScript(plain.text, '/signup');
    assert.match(plain.text, /<form id="signup-form">/);
    assert.match(plain.text, /<input type="text" name="invite"/, 'no invite in the URL: a field for it');

    const nasty = await anon.get(`/signup?invite=${encodeURIComponent('"><script>alert(1)</script>')}`);
    assertNoInlineScript(nasty.text, '/signup?invite=<script>');
    assert.match(nasty.text, /value="&quot;&gt;&lt;script&gt;/);

    const ada = await joinAdmin(h);
    assert.equal((await ada.get('/signup')).headers.get('location'), '/app', 'a member has no signup page');
    const inv = await ada.post('/api/invites');
    const url = new URL(inv.body.url);
    assert.equal(url.pathname, '/signup');
    const held = await anon.get(url.pathname + url.search);
    assert.match(held.text, new RegExp(`<input type="hidden" name="invite" value="${inv.body.code}">`));
    // What the page's form posts is what the server takes.
    const bea = await joinInvited(h, ada, { slug: 'bea' });
    assert.equal((await bea.get('/api/me')).body.name, 'bea');
  } finally { await h.close(); }
});

test('/reset: the forgot form without a token, the new password with one; /signup/confirm keeps its form', async () => {
  const h = await boot();
  try {
    const anon = h.client();
    const forgot = await anon.get('/reset');
    assert.equal(forgot.status, 200);
    assertSelfOnly(forgot, '/reset');
    assertNoInlineScript(forgot.text, '/reset');
    assert.match(forgot.text, /<form id="forgot-form">/);
    assert.ok(!/reset-form/.test(forgot.text));
    const withToken = await anon.get('/reset?token=abc');
    assert.match(withToken.text, /<form id="reset-form">/);
    assertNoInlineScript(withToken.text, '/reset?token');
    const confirm = await anon.get('/signup/confirm?token=abc');
    assert.match(confirm.text, /<form id="confirm-form">/);
    assert.match(confirm.text, /href="\/app"/, 'after confirming, the way into the composer');
    assertNoInlineScript(confirm.text, '/signup/confirm');
    for (const p of ['/reset', '/signup/confirm', '/login', '/signup']) {
      assert.equal((await anon.get(p)).headers.get('x-robots-tag'), 'noindex', p);
    }
  } finally { await h.close(); }
});

test('the join door: a member lands on the offer, a visitor signs in first and comes back to it', async () => {
  const h = await boot();
  try {
    const ada = await joinAdmin(h);
    const ring = await ada.post('/api/rings', { name: 'Print Club' });
    const joinPath = new URL(ring.body.join.url).pathname;
    const code = joinPath.split('/').pop();
    assert.equal(joinPath, `/rings/join/${code}`);

    const anon = h.client();
    const r1 = await anon.get(joinPath);
    assert.equal(r1.status, 302);
    assert.equal(r1.headers.get('location'), `/login?next=${encodeURIComponent(`/app?ring=${code}`)}`);
    assert.equal(r1.headers.get('x-robots-tag'), 'noindex');
    const login = await anon.get(r1.headers.get('location'));
    assert.match(login.text, new RegExp(`data-next="/app\\?ring=${code}"`));

    const bea = await joinInvited(h, ada, { slug: 'bea' });
    const r2 = await bea.get(joinPath);
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.get('location'), `/app?ring=${code}`);
    // The door admits nobody: bea is not a member until someone approves.
    const view = await bea.get(`/api/rings/join/${code}`);
    assert.equal(view.body.already_member, false);
    assert.equal(view.body.requested, false);
  } finally { await h.close(); }
});

test('/ is the landing for a visitor and the composer for a member', async () => {
  const h = await boot();
  try {
    const anon = h.client();
    const land = await anon.get('/');
    assert.equal(land.status, 200);
    assertNoInlineScript(land.text, '/');
    assert.match(land.text, /href="\/login"/);
    assert.match(land.text, /href="\/signup"/);
    const ada = await joinAdmin(h);
    const r = await ada.get('/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/app');
  } finally { await h.close(); }
});
