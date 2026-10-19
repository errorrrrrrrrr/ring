'use strict';
/* Gate: the production shape of accounts (spec 10.9, 10.10, 15.3). Boot refusals
 * (TRUST_PROXY, a real mail provider without PUBLIC_ORIGIN), mailed links never
 * from a Host header, the __Host- Secure cookie and HSTS behind the proxy, CSRF
 * against PUBLIC_ORIGIN and on every DELETE, a failing mail provider, and the
 * mail outbox's bound. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const clock = require('../lib/clock');
const { loadConfig, parseTrustProxy } = require('../lib/config');
const urls = require('../lib/urls');
const { boot, joinAdmin, joinInvited, SECRET, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');

test.afterEach(() => clock.reset());

const STRONG = 'Zq8f1-a9LmP0x7Kd2RtY6vWb3NcE5hGj';

test('config: a real mail provider needs PUBLIC_ORIGIN; production needs TRUST_PROXY', () => {
  const base = { SESSION_SECRET: SECRET };
  assert.throws(() => loadConfig({ ...base, MAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://mail.example' }), /MAIL_PROVIDER=smtp needs PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({ ...base, MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' }), /MAIL_PROVIDER=resend needs PUBLIC_ORIGIN/);
  assert.equal(loadConfig({ ...base, MAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://mail.example', PUBLIC_ORIGIN: 'https://ring.example' }).mail.provider, 'smtp', 'positive control');
  assert.equal(loadConfig({ ...base }).mail.provider, 'log', 'the log provider may use the request origin in development');

  const prod = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://ring.example', SESSION_SECRET: STRONG, ADMIN_EMAIL: 'a@b.example' };
  assert.throws(() => loadConfig(prod), /TRUST_PROXY is required in production/);
  assert.throws(() => loadConfig({ ...prod, TRUST_PROXY: 'true' }), /TRUST_PROXY must be/);
  assert.equal(loadConfig({ ...prod, TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(loadConfig({ ...prod, TRUST_PROXY: '1' }).trustProxy, 1);

  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('loopback, uniquelocal'), 'loopback,uniquelocal');
  assert.equal(parseTrustProxy('10.0.0.0/8,fd00::/8'), '10.0.0.0/8,fd00::/8');
  assert.equal(parseTrustProxy('true'), undefined);
  assert.equal(parseTrustProxy('everyone'), undefined);
});

test('a mailed link never takes its origin from the Host header (security-r1-03)', async () => {
  const fake = (host) => ({ protocol: 'http', get: (k) => (k === 'host' ? host : undefined) });
  assert.equal(urls.mailOriginOf(fake('evil.example'), { publicOrigin: '', production: false, mail: { provider: 'smtp' } }), '', 'no PUBLIC_ORIGIN, a real provider: no origin at all');
  assert.equal(urls.mailOriginOf(fake('evil.example'), { publicOrigin: '', production: true, mail: { provider: 'log' } }), '');
  assert.equal(urls.mailOriginOf(fake('localhost:3000'), { publicOrigin: '', production: false, mail: { provider: 'log' } }), 'http://localhost:3000');

  const h = await boot({ env: { PUBLIC_ORIGIN: 'https://ring.example' } });
  try {
    await joinAdmin(h);
    const { port } = new URL(h.base);
    const status = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ email: ADMIN_EMAIL });
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/password/forgot', headers: { host: 'evil.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', reject);
      r.end(body);
    });
    assert.equal(status, 202);
    const mail = h.mailsTo(ADMIN_EMAIL).at(-1);
    assert.match(mail.text, /https:\/\/ring\.example\/reset\?token=/);
    assert.ok(!mail.text.includes('evil.example'));
  } finally { await h.close(); }
});

const PROD = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://ring.example', TRUST_PROXY: 'loopback', MAIL_PROVIDER: 'log' };
const viaTls = { headers: { 'x-forwarded-proto': 'https' } };

test('production behind the proxy: a Secure __Host- cookie and HSTS (security-r1-12, tests-r1-production-cookie-proxy)', async () => {
  const h = await boot({ env: PROD });
  try {
    const c = h.client();
    assert.equal((await c.post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'ada' }, viaTls)).status, 202);
    const token = h.lastTokenTo(ADMIN_EMAIL);
    assert.match(h.mailsTo(ADMIN_EMAIL).at(-1).text, /^https:\/\/ring\.example\/signup\/confirm\?token=/m);
    const confirm = await c.raw('POST', '/api/signup/confirm', { json: { token, password: PASSWORD }, ...viaTls });
    assert.equal(confirm.status, 200);
    const cookie = confirm.headers.getSetCookie().find((x) => x.includes('ring.sid=')) || '';
    assert.match(cookie, /^__Host-ring\.sid=/, cookie);
    assert.match(cookie, /;\s*Secure/i);
    assert.match(cookie, /;\s*Path=\/(;|$)/i);
    assert.match(cookie, /HttpOnly/i);
    assert.ok(!/Domain=/i.test(cookie), 'a __Host- cookie carries no Domain');
    assert.equal(confirm.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal((await c.get('/api/me')).status, 200, 'the session works under its new name');
    assert.equal((await h.client().get('/api/health')).headers.get('strict-transport-security'), 'max-age=31536000', 'HSTS on every answer');

    const login = await h.client().raw('POST', '/api/login', { json: { email: ADMIN_EMAIL, password: PASSWORD }, ...viaTls });
    assert.match(login.headers.getSetCookie()[0], /^__Host-ring\.sid=.*Secure/i);

    const out = await c.raw('POST', '/api/logout', viaTls);
    assert.equal(out.status, 200);
    assert.ok(out.headers.getSetCookie().some((x) => /^__Host-ring\.sid=;/.test(x)), 'logout clears the same name');
    assert.equal((await c.get('/api/me')).status, 401);
  } finally { await h.close(); }

  const dev = await boot();
  try {
    const r = await dev.client().get('/api/health');
    assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS over plain http in development');
    const c = await joinAdmin(dev);
    assert.ok(c.cookies.has('ring.sid'), 'development keeps the plain name (no Secure, no prefix)');
  } finally { await dev.close(); }
});

test('CSRF: every DELETE is refused cross-site, by its csrf key (tests-r1-csrf-delete-and-public-origin)', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const post = (await ana.post('/api/posts', { kind: 'note', note: 'keep me' })).body;
    const inv = (await ana.post('/api/invites')).body;
    const cross = { headers: { 'sec-fetch-site': 'cross-site' } };
    const evil = { headers: { origin: 'https://evil.example' } };
    for (const o of [cross, evil]) {
      const me = await ana.req('DELETE', '/api/me', { json: { password: PASSWORD }, ...o });
      assert.equal(me.status, 403);
      assert.equal(me.body.error, 'csrf', 'refused as CSRF, with the RIGHT password');
      const p = await ana.del(`/api/posts/${post.id}`, undefined, o);
      assert.equal(p.body.error, 'csrf');
      const i = await ana.del(`/api/invites/${inv.id}`, undefined, o);
      assert.equal(i.body.error, 'csrf');
    }
    assert.ok(h.ctx.members.get('ana'), 'the account stands');
    assert.equal((await ana.get('/api/me/page')).body.posts.length, 1, 'the post stands');
    assert.equal(h.ctx.invites.get(inv.id)?.id, inv.id, 'the invite stands');
    assert.equal((await ana.del(`/api/posts/${post.id}`)).status, 200, 'positive control: same request, no cross-site marks');
  } finally { await h.close(); }
});

test('CSRF compares Origin with PUBLIC_ORIGIN, not the Host-derived origin', async () => {
  const h = await boot({ env: { PUBLIC_ORIGIN: 'https://ring.example' } });
  try {
    const ana = await joinAdmin(h, 'ana');
    const hostDerived = await ana.post('/api/posts', { kind: 'note', note: 'x' }, { headers: { origin: h.base } });
    assert.equal(hostDerived.status, 403);
    assert.equal(hostDerived.body.error, 'csrf');
    const right = await ana.post('/api/posts', { kind: 'note', note: 'x' }, { headers: { origin: 'https://ring.example' } });
    assert.equal(right.status, 201);
  } finally { await h.close(); }
});

test('a failing mail provider: 202 at once, logged without the link, no unhandled rejection (tests-r1-mail-failure-path)', async () => {
  const sockets = new Set();
  const dead = net.createServer((s) => { sockets.add(s); s.destroy(); });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const h = await boot({ env: { MAIL_PROVIDER: 'smtp', SMTP_URL: `smtp://127.0.0.1:${dead.address().port}`, PUBLIC_ORIGIN: 'https://ring.example', SIGNUP: 'open' } });
  try {
    h.ctx.members.insert({ slug: 'ada', email: ADMIN_EMAIL, email_lc: ADMIN_EMAIL, password_hash: 'x', display_name: 'Ada', role: 'admin', invited_by: null, created_at: clock.iso(), status: 'active' });
    const forgot = await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL });
    assert.equal(forgot.status, 202);
    const signup = await h.client().post('/api/signup', { email: 'new@example.test', password: PASSWORD, slug: 'newbie' });
    assert.equal(signup.status, 202);
    await h.ctx.mailer.flush();
    await new Promise((r) => setImmediate(r));
    const failed = h.logs.filter((l) => /send failed/.test(l));
    assert.equal(failed.length, 2, `both sends failed and were logged: ${h.logs.join('\n')}`);
    assert.ok(!h.logs.some((l) => /token=/.test(l)), 'no link in any log line');
    assert.deepEqual(unhandled, []);
  } finally {
    await h.close();
    process.off('unhandledRejection', onUnhandled);
    for (const s of sockets) s.destroy();
    await new Promise((r) => dead.close(r));
  }
});

test('the mail outbox keeps a day, and forgets a deleted member (spec-r1-04)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-outbox-'));
  const stale = { at: new Date(Date.now() - 25 * 3600_000).toISOString(), to: 'old@example.test', subject: 's', text: 'token=old' };
  const recent = { at: new Date(Date.now() - 3600_000).toISOString(), to: 'recent@example.test', subject: 's', text: 'token=recent' };
  fs.writeFileSync(path.join(dir, 'mail-outbox.jsonl'), `${JSON.stringify(stale)}\n${JSON.stringify(recent)}\n`);
  const h = await boot({ dataDir: dir });
  try {
    assert.deepEqual(h.mails().map((m) => m.to), ['recent@example.test'], 'pruned at boot');
    clock.set(Date.now());
    const admin = await joinAdmin(h, 'ada');
    const ana = await joinInvited(h, admin, { slug: 'ana', email: 'ana@example.test' });
    assert.ok(h.mailsTo('ana@example.test').length > 0);
    assert.equal((await ana.del('/api/me', { password: PASSWORD })).status, 200);
    assert.deepEqual(h.mailsTo('ana@example.test'), [], 'the purge forgot her mail');
    assert.ok(h.mailsTo(ADMIN_EMAIL).length > 0, 'positive control: other mail stays');

    clock.advance(25 * 3600_000);
    await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL });
    assert.deepEqual(h.mails().map((m) => m.to), [ADMIN_EMAIL], 'a send a day later prunes the rest first');
  } finally {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
