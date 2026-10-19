'use strict';
/* Gate: origin-lock (spec 2, 11.2, 15.2, 15.3, 16.3). The domain is permanent:
 * once the server has federated it refuses to boot under another PUBLIC_ORIGIN;
 * before, the origin may move. FEDERATION defaults off, and off every AP route
 * 404s (WebFinger included) and nothing is ever delivered. FEDERATION=on needs a
 * PUBLIC_ORIGIN it can keep: https, a real domain, never a provider's default
 * host or a tunnel. One process per data dir; a retired name never comes back. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { createApp } = require('../lib/app');
const { boot, joinAdmin, PASSWORD, SECRET } = require('./helpers/harness');
const { crowd } = require('./helpers/social');
const { fedRing, fakeMastodon, followFrom } = require('./helpers/fediverse');

const base = { SESSION_SECRET: SECRET, ADMIN_EMAIL: 'a@example.test', MAIL_PROVIDER: 'log', FEDERATION: 'on' };
const prod = { ...base, NODE_ENV: 'production', TRUST_PROXY: 'loopback', SESSION_SECRET: 'Zq8#kP2!vL9@xR4$mN7&bT1*wY6^cH3%' };
const refuses = (env, re) => assert.throws(() => loadConfig(env), re, JSON.stringify(env));

test('FEDERATION=on needs an origin it can keep forever', () => {
  refuses({ ...base }, /FEDERATION=on needs PUBLIC_ORIGIN/);
  refuses({ ...base, PUBLIC_ORIGIN: 'http://ring.example' }, /needs an https PUBLIC_ORIGIN/);
  refuses({ ...base, PUBLIC_ORIGIN: 'https://ana-ring.onrender.com' }, /onrender\.com/);
  refuses({ ...base, PUBLIC_ORIGIN: 'https://abc123.ngrok-free.app' }, /ngrok-free\.app/);
  refuses({ ...base, PUBLIC_ORIGIN: 'https://quiet-cat.trycloudflare.com' }, /trycloudflare\.com/);
  refuses({ ...base, PUBLIC_ORIGIN: 'https://203.0.113.7' }, /refuses 203\.0\.113\.7/);
  refuses({ ...base, PUBLIC_ORIGIN: 'https://[2001:db8::1]' }, /refuses/);
  refuses({ ...base, PUBLIC_ORIGIN: 'https://localhost' }, /refuses localhost/);
  refuses({ ...base, PUBLIC_ORIGIN: 'https://ring.example:8443' }, /default https port/);
  refuses({ ...prod, PUBLIC_ORIGIN: 'http://127.0.0.1:4000', FED_TEST_LOOPBACK: '1' }, /FED_TEST_LOOPBACK is a test hook/);
  // Positive controls: a real domain; loopback only under the test hook, outside production.
  assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: 'https://ring.example' }).federation, true);
  assert.equal(loadConfig({ ...prod, PUBLIC_ORIGIN: 'https://social.ana-lima.art' }).federation, true);
  assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: 'http://127.0.0.1:4000', FED_TEST_LOOPBACK: '1' }).fedTestLoopback, true);
  assert.equal(loadConfig({ ...base, FEDERATION: 'off' }).federation, false, 'off needs nothing');
  assert.equal(loadConfig({ SESSION_SECRET: SECRET }).federation, false, 'off by default');
});

test('once federated, the server refuses to boot under another origin; before, it may move', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  const dir = h.dir;
  const port = Number(new URL(h.base).port);
  let again = null;
  try {
    // Not federated yet: the same data dir boots under another origin.
    await h.close({ keepData: true });
    const moved = await boot({ federated: true, dataDir: dir });
    const movedPort = Number(new URL(moved.base).port);
    assert.notEqual(movedPort, port);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8')).origin, moved.base);
    // A verified inbound activity: from now on this origin is permanent.
    const r = await m.post(`${moved.base}/users/ana/inbox`, followFrom(m, `${moved.base}/users/ana`));
    assert.equal(r.status, 202);
    const inst = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    assert.ok(inst.federated_at);
    assert.ok(moved.logs.some((l) => l.includes(`federated as ${moved.base}`)), 'the moment is logged');
    await moved.close({ keepData: true });

    await assert.rejects(boot({ federated: true, dataDir: dir }), new RegExp(`This server federated as ${moved.base.replace(/[.:/]/g, '\\$&')}; its actor URLs live in other servers' databases; a new domain is a new server: start with an empty DATA_DIR`));
    await assert.rejects(boot({ dataDir: dir, env: { PUBLIC_ORIGIN: 'https://elsewhere.example' } }), /federated as/, 'with federation off too');
    again = await boot({ federated: true, dataDir: dir, port: movedPort });
    assert.equal((await fetch(`${again.base}/users/ana`, { headers: { accept: 'application/activity+json' } })).status, 200, 'positive control: the same origin boots');
    void c;
  } finally {
    await m.close();
    if (again) await again.close({ keepData: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('FEDERATION=off: every AP route 404s, WebFinger included, and nothing is ever queued', async () => {
  const { h, c } = await crowd(['ana']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'local only' })).body;
    // A remote follower row from an earlier life, hand-planted: still nothing leaves.
    const f = h.ctx.follows.load('ana');
    f.followers.push({ handle: 'bob@mastodon.example', state: 'accepted', follow_id: 'https://mastodon.example/1', at: new Date().toISOString(), accepted_at: new Date().toISOString() });
    fs.writeFileSync(path.join(h.dir, 'members', 'ana', 'follows.json'), JSON.stringify(f));
    await c.ana.post('/api/posts', { kind: 'note', note: 'still local' });
    const AP = { accept: 'application/activity+json' };
    const gets = [
      '/.well-known/webfinger?resource=acct:ana@127.0.0.1', '/.well-known/nodeinfo', '/nodeinfo/2.1', '/nodeinfo/2.0', '/actor',
      '/users/ana', '/users/ana/outbox', '/users/ana/followers', '/users/ana/following', '/users/ana/featured', `/users/ana/posts/${p.id}`,
    ];
    for (const g of gets) assert.equal((await fetch(h.base + g, { headers: AP })).status, 404, g);
    for (const u of ['/inbox', '/users/ana/inbox', '/actor/inbox']) {
      assert.equal((await fetch(h.base + u, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: '{}' })).status, 404, `POST ${u}`);
    }
    assert.equal(h.ctx.federation, null);
    assert.equal(fs.existsSync(path.join(h.dir, 'queue')), false, 'no queue');
    assert.equal(fs.existsSync(path.join(h.dir, 'keys', '_instance.pem')), false, 'no instance key either');
  } finally { await h.close(); }
});

test('one process per data dir; a retired name never comes back, and its actor stays gone', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  try {
    assert.throws(() => createApp({ env: { SESSION_SECRET: SECRET, DATA_DIR: h.dir, MAIL_PROVIDER: 'log' }, timers: false }), /already uses this data dir/);
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200);
    const host = new URL(h.base).host;
    assert.equal((await fetch(`${h.base}/users/bram`, { headers: { accept: 'application/activity+json' } })).status, 410);
    assert.equal((await fetch(`${h.base}/.well-known/webfinger?resource=acct:bram@${host}`)).status, 404);
    const again = await c.ana.get('/api/names/bram');
    assert.equal(again.body.available, false, 'the name is never reissued');
    void joinAdmin;
  } finally { await h.close(); }
});
