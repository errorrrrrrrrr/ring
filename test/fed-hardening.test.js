'use strict';
/* Gate: fed-hardening (spec 5.2, 5.3, 5.6, 5.9, 6.1, 15.2, 15.3). The P5 review's
 * findings, each turned from its proof script into the behaviour it now has:
 *   F1  the digest the signature covers is the one checked; Digest and
 *       Content-Digest that disagree are refused; the replay guard survives a
 *       restart
 *   F2  an object is read with redirects off: an open redirect on a victim's
 *       host cannot make an attacker's document count as the victim's
 *   F3  a host's budget is spent only once its signature verifies; strangers
 *       spend their own client budget; signed GETs and inbox POSTs are two buckets
 *   F4  key fetches: a client budget, a negative cache, a capped wait line with
 *       the wait counted against the deadline, and their own gate (deliveries
 *       never wait behind them)
 *   F5  a domain block ends every follow it matches, both ways; a follower
 *       blocked after an emit gets nothing at send time
 *   F6  FED_TEST_LOOPBACK only on a loopback PUBLIC_ORIGIN
 *   F7  a trailing-dot origin and the platform hosts are refused;
 *       ::ffff:0:0:0/96 is classed like the mapped form
 * Nothing leaves loopback: every remote is a fake in this process. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const clock = require('../lib/clock');
const { createReplayGuard } = require('../lib/http-sig');
const { createGate, createNet, resolveTarget, isPrivateAddress, isLoopbackAddress } = require('../lib/net');
const { loadConfig, federationOriginProblem } = require('../lib/config');
const { NEG_MS } = require('../lib/actors');
const { boot } = require('./helpers/harness');
const { crowd } = require('./helpers/social');
const { fedRing, fakeMastodon, remoteFollow, followFrom, undoFrom, sign, until } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());

const AP = 'application/activity+json';
const followersOf = (h, name = 'ana') => h.ctx.follows.load(name).followers.map((r) => `${r.handle}:${r.state}`);
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const shut = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });
const tally = (list) => list.reduce((a, s) => { a[s] = (a[s] || 0) + 1; return a; }, {});

/* A signed-LOOKING request with a junk signature value, from client `ip` (the
 * server trusts X-Forwarded-For from loopback in these tests). */
function junkHeaders(keyId, { ip, post = false } = {}) {
  const h = {
    date: new Date(clock.now()).toUTCString(),
    signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date${post ? ' digest' : ''}",signature="AAAA"`,
  };
  if (ip) h['x-forwarded-for'] = ip;
  if (post) { h['content-type'] = AP; h.digest = `SHA-256=${crypto.createHash('sha256').update('{}').digest('base64')}`; } else h.accept = AP;
  return h;
}
const junkGet = (url, keyId, ip) => fetch(url, { headers: junkHeaders(keyId, { ip }) }).then((r) => r.status);
const junkPost = (url, keyId, ip) => fetch(url, { method: 'POST', headers: junkHeaders(keyId, { ip, post: true }), body: '{}' }).then((r) => r.status).catch((e) => e.message);

// ── F1 ──

test('F1: an unsigned Content-Digest cannot carry a forged body past a captured signature', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const follow = await remoteFollow(h, c, m, 'ana');
    const inbox = `${h.base}/users/ana/inbox`;
    assert.deepEqual(followersOf(h), [`bob@${m.host}:accepted`]);
    // What bob legitimately signed (a Like, captured before delivery), and the forgery.
    const original = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.base}/likes/1`, type: 'Like', actor: m.actor(), object: `${h.base}/users/ana/posts/x` });
    const forged = JSON.stringify(undoFrom(m, follow));
    const cd = `sha-256=:${crypto.createHash('sha256').update(forged).digest('base64')}:`;
    let r = await m.post(inbox, null, { body: forged, signBody: original });
    assert.equal(r.status, 401, 'no Content-Digest: the signed Digest does not match');
    r = await m.post(inbox, null, { body: forged, signBody: original, headers: { 'content-digest': cd } });
    assert.equal(r.status, 401, 'an UNSIGNED Content-Digest of the forged body changes nothing');
    assert.deepEqual(followersOf(h), [`bob@${m.host}:accepted`], 'the follow stands');
    assert.ok(h.logs.some((l) => l.includes('inbox refused (401 digest)')));

    // Both headers present and disagreeing: refused whichever is signed.
    const like = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.base}/likes/2`, type: 'Like', actor: m.actor(), object: `${h.base}/users/ana/posts/x` });
    const other = `sha-256=:${crypto.createHash('sha256').update('something else').digest('base64')}:`;
    r = await m.post(inbox, null, { body: like, headers: { 'content-digest': other } });
    assert.equal(r.status, 401);
    assert.ok(h.logs.some((l) => l.includes('inbox refused (401 digest_conflict)')));
    // A signature that covers no digest at all: refused.
    r = await m.post(inbox, null, { body: like, signed: ['(request-target)', 'host', 'date', 'content-type'] });
    assert.equal(r.status, 401);
    assert.ok(h.logs.some((l) => l.includes('inbox refused (401 unsigned_digest)')));

    // Positive controls: Content-Digest alone, signed and right, is accepted; so
    // is an unsigned Content-Digest that agrees; and bob's real Undo lands.
    const goodCd = `sha-256=:${crypto.createHash('sha256').update(like).digest('base64')}:`;
    r = await m.post(inbox, null, { body: like, headers: { 'content-digest': goodCd, digest: '' }, drop: ['digest'], signed: ['(request-target)', 'host', 'date', 'content-digest', 'content-type'] });
    assert.equal(r.status, 202, 'a signed Content-Digest that matches');
    const like3 = like.replace('/likes/2', '/likes/3');
    r = await m.post(inbox, null, { body: like3, headers: { 'content-digest': `sha-256=:${crypto.createHash('sha256').update(like3).digest('base64')}:` } });
    assert.equal(r.status, 202, 'an unsigned Content-Digest that agrees rides along');
    r = await m.post(inbox, undoFrom(m, follow));
    assert.equal(r.status, 202);
    assert.deepEqual(followersOf(h), [], 'the real Undo applies');
  } finally { await m.close(); await h.close(); }
});

/* One POST on its own connection (agent: false), answering the status code. */
function postNoPool(url, headers, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = require('node:http').request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

test('F1: the replay guard survives a restart (signature hashes in hour files, pruned past the window)', async () => {
  // Unit: two guards over one directory, the second built after the first.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ring-replay-'));
  try {
    let t = Date.parse('2026-10-15T10:20:00Z');
    const a = createReplayGuard({ dir, now: () => t });
    assert.equal(a.seen('sig-one'), false);
    assert.equal(a.seen('sig-one'), true);
    const b = createReplayGuard({ dir, now: () => t });
    assert.equal(b.seen('sig-one'), true, 'a fresh guard (a restart) still knows it');
    assert.equal(b.seen('sig-two'), false, 'positive control: an unseen value passes');
    assert.ok(!fs.readFileSync(path.join(dir, '2026-10-15T10.txt'), 'utf8').includes('sig-one'), 'stored as a hash, never the value');
    t += 3 * 3600_000 + 1;
    assert.equal(b.prune(), 1, 'the hour file past the window goes');
    const c = createReplayGuard({ dir, now: () => t });
    assert.equal(c.seen('sig-one'), false, 'past the window it is forgotten');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // Integration: the very same signed POST, before and after a restart.
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  const dataDir = h.dir;
  const port = Number(new URL(h.base).port);
  let again = null;
  try {
    const inbox = `${h.base}/users/ana/inbox`;
    const body = JSON.stringify(followFrom(m, `${h.base}/users/ana`));
    const hd = sign({ method: 'POST', url: inbox, body, keyId: m.keyId(), privateKey: m.keys.bob.privateKey, headers: { 'content-type': AP } });
    delete hd.host;
    // A fresh socket for each POST: fetch's pool would reuse a kept-alive socket to the
    // server that just closed on this same port and fail with ECONNRESET (a flake).
    assert.equal(await postNoPool(inbox, hd, body), 202);
    await h.close({ keepData: true });
    again = await boot({ federated: true, dataDir, port });
    assert.equal(await postNoPool(inbox, hd, body), 401, 'the captured request, replayed after the restart');
    assert.ok(again.logs.some((l) => l.includes('inbox refused (401 replay)')));
  } finally {
    await m.close();
    if (again) await again.close({ keepData: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── F2 ──

test('F2: a forwarded activity behind an open redirect on the victim host is never processed', async () => {
  const { h, c } = await fedRing(['ana']);
  // The victim server has an open redirect at /go?to=.
  const orig = http.createServer;
  http.createServer = (handler) => orig((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/go') { res.writeHead(302, { location: u.searchParams.get('to') }); return res.end(); }
    return handler(req, res);
  });
  let victim;
  try { victim = await fakeMastodon({ users: ['alice'] }); } finally { http.createServer = orig; }
  const evil = await fakeMastodon({ users: ['eve'], keyIndex: 3 });
  try {
    const follow = await remoteFollow(h, c, victim, 'ana', { as: 'alice' });
    assert.deepEqual(followersOf(h), [`alice@${victim.host}:accepted`]);
    const undoOf = (id) => ({ '@context': 'https://www.w3.org/ns/activitystreams', id, type: 'Undo', actor: victim.actor('alice'), object: { id: follow.id, type: 'Follow', actor: victim.actor('alice'), object: `${h.base}/users/ana` } });
    const fakeId = `${victim.base}/go?to=${encodeURIComponent(`${evil.base}/forged`)}`;
    const forged = undoOf(fakeId);
    evil.serve('/forged', forged);
    // Eve signs with HER key; the body names Alice: the forwarded path.
    const r = await evil.post(`${h.base}/users/ana/inbox`, forged, { name: 'eve' });
    assert.equal(r.status, 202);
    assert.deepEqual(followersOf(h), [`alice@${victim.host}:accepted`], 'the follow stands');
    assert.ok(!evil.gets.some((g) => g.path === '/forged'), 'the redirect is never followed to the attacker');
    await assert.rejects(h.ctx.federation.actors.getDoc(fakeId), /redirect/, 'every object fetch refuses a 3xx');

    // Positive control: the same Undo served by the victim AT its id (no
    // redirect), forwarded by eve: the origin copy is processed.
    const realId = `${victim.base}/undo/1`;
    victim.serve('/undo/1', undoOf(realId));
    assert.equal((await evil.post(`${h.base}/users/ana/inbox`, undoOf(realId), { name: 'eve' })).status, 202);
    assert.deepEqual(followersOf(h), [], 'the origin copy lands');
  } finally { await victim.close(); await evil.close(); await h.close(); }
});

// ── F3 ──

test('F3: a stranger naming a host keyId spends none of its budget; signed GETs and POSTs have their own buckets', async () => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const keyId = m.keyId();
    const ATTACKER = '198.51.100.66';
    // 125 junk POSTs naming bob's host, from another client: all refused 401
    // (unverified), none charged to bob's host.
    const posts = [];
    for (let i = 0; i < 125; i++) posts.push(await junkPost(`${h.base}/inbox`, keyId, ATTACKER));
    assert.deepEqual(tally(posts), { 401: 125 });
    let r = await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`));
    assert.equal(r.status, 202, 'the real host, correctly signed, still has its whole budget');
    assert.equal(h.ctx.follows.load('ana').followers.length, 1);

    // 125 junk signed GETs: the CLIENT's signed-GET budget (120 a minute) ends them.
    const gets = [];
    for (let i = 0; i < 125; i++) gets.push(await junkGet(`${h.base}/users/ana/outbox`, keyId, ATTACKER));
    assert.equal(gets.filter((s) => s === 401).length, 120);
    assert.equal(gets.filter((s) => s === 429).length, 5, 'unverified signed GETs have a per-client budget');
    const g = await m.get(`${h.base}/users/ana/outbox`);
    assert.equal(g.status, 200, 'the real host reads on');

    // The verified host's own GET bucket (120 a minute, whatever client it comes
    // from), and it is not its inbox bucket.
    const bobGet = (ip) => {
      const url = `${h.base}/users/ana/outbox`;
      const hd = sign({ method: 'GET', url, keyId, privateKey: m.keys.bob.privateKey, headers: { accept: AP } });
      delete hd.host;
      hd['x-forwarded-for'] = ip;
      return fetch(url, { headers: hd }).then((x) => x.status);
    };
    const got = [];
    for (let i = 0; i < 119; i++) got.push(await bobGet(`192.0.2.${1 + (i % 3)}`));
    assert.deepEqual(tally(got), { 200: 119 });
    assert.equal(await bobGet('192.0.2.9'), 429, 'the 121st signed GET from one verified host in a minute, from a fresh client');
    r = await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`));
    assert.equal(r.status, 202, 'its inbox budget is untouched');
  } finally { await m.close(); await h.close(); }
});

// ── F4 ──

test('F4: an unsigned client cannot turn signed-looking GETs into a fetch per request', async () => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  const servers = [];
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    let hits = 0;
    for (let i = 0; i < 2; i++) servers.push(await listen((req, res) => { hits++; res.writeHead(404); res.end(); }));
    const statuses = [];
    let n = 0;
    for (const s of servers) {
      for (let i = 0; i < 100; i++) statuses.push(await junkGet(`${h.base}/users/ana/outbox`, `http://127.0.0.1:${s.address().port}/k/${n++}#main-key`, '203.0.113.5'));
    }
    assert.deepEqual(tally(statuses), { 401: 30, 429: 170 }, '30 key fetches a minute per client, then 429');
    assert.equal(hits, 30, 'one outbound fetch per budgeted key, no more');

    // The negative cache: one dead keyId, asked ten times by another client, is fetched once.
    const dead = `http://127.0.0.1:${servers[0].address().port}/k/dead#main-key`;
    for (let i = 0; i < 10; i++) assert.equal(await junkGet(`${h.base}/users/ana/outbox`, dead, '203.0.113.6'), 401);
    assert.equal(hits, 31, 'a failed keyId is not fetched again inside the window');
    clock.advance(NEG_MS + 1000);
    assert.equal(await junkGet(`${h.base}/users/ana/outbox`, dead, '203.0.113.6'), 401);
    assert.equal(hits, 32, 'positive control: past the window it is fetched again');
  } finally { for (const s of servers) await shut(s); await h.close(); }
});

test('F4: silent key hosts hold neither a real remote nor a delivery: client slots, a capped line, their own gate', async () => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  const m = await fakeMastodon({ users: ['bob'] });
  const hang = [];
  const pending = [];
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await remoteFollow(h, c, m, 'ana');
    for (let i = 0; i < 4; i++) hang.push(await listen(() => { /* never answers */ }));
    let k = 0;
    const junkFrom = (ip, count) => {
      for (let i = 0; i < count; i++) {
        const s = hang[k % hang.length];
        pending.push(junkPost(`${h.base}/inbox`, `http://127.0.0.1:${s.address().port}/slow/${k++}#main-key`, ip));
      }
    };
    // One client, 16 junk POSTs naming 4 silent hosts: 4 hold a fetch, 12 are 429 at once.
    junkFrom('198.51.100.1', 16);
    await until(() => h.ctx.federation.inboundGate.stats().total === 4, { what: 'four key fetches in flight' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.ctx.federation.inboundGate.stats().total, 4, 'one client holds at most 4 key fetches');

    // A real Follow from a server never seen: its key fetch is not stuck behind them.
    const m2 = await fakeMastodon({ users: ['dora'], keyIndex: 4 });
    try {
      const t0 = Date.now();
      const r = await m2.post(`${h.base}/users/ana/inbox`, followFrom(m2, `${h.base}/users/ana`));
      assert.equal(r.status, 202);
      assert.ok(Date.now() - t0 < 3000, `the real Follow took ${Date.now() - t0} ms`);
    } finally { await m2.close(); }

    // Two more clients fill the inbound gate (8 in flight, the rest in line).
    junkFrom('198.51.100.2', 6);
    junkFrom('198.51.100.3', 6);
    await until(() => h.ctx.federation.inboundGate.stats().total === 8 && h.ctx.federation.inboundGate.stats().waiting === 4, { what: 'the inbound gate full' });
    // A delivery is on the deliveries' gate: it does not wait for any of them.
    await c.ana.post('/api/posts', { kind: 'note', note: 'still goes out' });
    const t1 = Date.now();
    await h.ctx.federation.queue.drain();
    assert.ok(Date.now() - t1 < 3000, `the delivery took ${Date.now() - t1} ms`);
    assert.ok(m.deliveries.some((d) => d.body?.type === 'Create' && d.verified === true), 'the Create reached the follower');
    for (const s of hang) await shut(s);
    const answers = tally(await Promise.all(pending));
    assert.deepEqual(answers, { 401: 12, 429: 12 + 2 + 2 }, 'past 4 in flight per client, a 429 at once');
  } finally {
    for (const s of hang) await shut(s);
    await Promise.allSettled(pending);
    await m.close();
    await h.close();
  }
});

test('F4: the fetch line is capped and the wait counts against the deadline', async () => {
  const g = createGate({ perHost: 1, overall: 1, maxWaiting: 2 });
  await g.acquire('a');
  const w1 = g.acquire('a');
  const w2 = g.acquire('a');
  const t0 = Date.now();
  await assert.rejects(g.acquire('a'), (e) => e.code === 'ERR_BUSY', 'past the line: refused at once');
  assert.ok(Date.now() - t0 < 50);
  g.release('a'); await w1; g.release('a'); await w2;
  assert.equal(g.stats().waiting, 0, 'positive control: the two in line got their turn');

  // A waiter whose deadline passes leaves the line.
  const late = g.acquire('a', { deadline: Date.now() + 60 });
  await assert.rejects(late, (e) => e.code === 'ERR_BUSY');
  assert.equal(g.stats().waiting, 0);
  g.release('a');

  // Through the fetcher: a full gate, a 300 ms budget, a host that would answer.
  const srv = await listen((req, res) => res.end('ok'));
  try {
    const full = createGate({ perHost: 1, overall: 1 });
    const net = createNet({ allowLoopback: true, gate: full });
    const base = `http://127.0.0.1:${srv.address().port}`;
    await full.acquire(`127.0.0.1:${srv.address().port}`);
    const t1 = Date.now();
    await assert.rejects(net.fetchGuarded(`${base}/`, { timeoutMs: 300 }), (e) => e.code === 'ERR_BUSY');
    assert.ok(Date.now() - t1 < 1500, 'the wait for a slot is inside the 300 ms');
    full.release(`127.0.0.1:${srv.address().port}`);
    assert.equal((await net.fetchGuarded(`${base}/`, { timeoutMs: 300 })).body.toString(), 'ok', 'positive control');
  } finally { await shut(srv); }
});

// ── F5 ──

test('F5: a domain block ends every follow it matches, both ways, with Undo and Reject', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await remoteFollow(h, c, m, 'ana', { as: 'bob' });
    await remoteFollow(h, c, m, 'ana', { as: 'carol', accept: false });
    assert.equal((await c.bram.post('/api/friends', { handle: 'ana' })).status, 200);
    // ana's own follow of bob (befriending across servers arrives in P6: planted).
    const bob = `bob@${m.host}`;
    const f = h.ctx.follows.load('ana');
    f.following.push({ handle: bob, state: 'accepted', follow_id: `${h.base}/users/ana#follows/planted`, at: clock.iso(), accepted_at: clock.iso() });
    fs.writeFileSync(path.join(h.dir, 'members', 'ana', 'follows.json'), JSON.stringify(f));
    const before = m.deliveries.length;

    const r = await c.ana.put('/api/me/page', { block_domain: '127.0.0.1' });
    assert.equal(r.status, 200);
    const after = h.ctx.follows.load('ana');
    assert.deepEqual(after.following.map((x) => x.handle), [], 'my follow of them: undone');
    assert.deepEqual(after.followers.map((x) => x.handle), ['bram'], 'theirs removed; a local follower stays');
    await h.ctx.federation.queue.drain();
    const sent = m.deliveries.slice(before).map((d) => `${d.body.type}{${d.body.object?.type}} ${d.path}`).sort();
    assert.deepEqual(sent, ['Reject{Follow} /users/bob/inbox', 'Reject{Follow} /users/carol/inbox', 'Undo{Follow} /users/bob/inbox']);
    assert.ok(h.ctx.audit.read().some((e) => e.event === 'member.blocked_domain' && e.follows === 2));
  } finally { await m.close(); await h.close(); }
});

test('F5: a follower blocked after the emit gets nothing at send time', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  const m2 = await fakeMastodon({ users: ['carol'], keyIndex: 2 });
  try {
    await remoteFollow(h, c, m, 'ana', { as: 'bob' });
    await remoteFollow(h, c, m2, 'ana', { as: 'carol' });
    const q = h.ctx.federation.queue;
    q.stop();
    const n1 = m.deliveries.length;
    const n2 = m2.deliveries.length;
    await c.ana.post('/api/posts', { kind: 'note', note: 'written before the block' });
    assert.ok(q.list().some((j) => j.kind === 'fanout' && j.activity_type === 'Create'), 'queued, not yet sent');
    assert.equal((await c.ana.put('/api/me/page', { block: `bob@${m.host}` })).status, 200);
    await q.drain();
    assert.deepEqual(m.deliveries.slice(n1).map((d) => d.body.type), ['Reject'], 'bob: the block\'s Reject, never the post');
    assert.deepEqual(m2.deliveries.slice(n2).map((d) => d.body.type), ['Create'], 'positive control: carol gets it');

    // A deliver job already written (its first attempt failed), then the block: dropped at the retry.
    const m3 = await fakeMastodon({ users: ['dora'], keyIndex: 5 });
    try {
      await remoteFollow(h, c, m3, 'ana', { as: 'dora' });
      m3.answer(() => 500);
      await c.ana.post('/api/posts', { kind: 'note', note: 'a retry later' });
      await q.drain();
      const job = q.list().find((j) => j.kind === 'deliver' && j.activity_type === 'Create');
      assert.ok(job, 'a retry is waiting');
      m3.answer(() => 202);
      assert.equal((await c.ana.put('/api/me/page', { block: `dora@${m3.host}` })).status, 200);
      const before = m3.deliveries.length;
      clock.set(job.next_at + 1);
      await q.drain();
      assert.ok(!m3.deliveries.slice(before).some((d) => d.body?.type === 'Create'), 'the retry never goes');
      assert.ok(h.ctx.audit.read().some((e) => e.event === 'delivery_dropped' && e.reason === 'blocked'));
    } finally { await m3.close(); }
  } finally { await m.close(); await m2.close(); await h.close(); }
});

// ── F6, F7 ──

test('F6: FED_TEST_LOOPBACK only on a loopback PUBLIC_ORIGIN, and never in production', () => {
  const base = { SESSION_SECRET: 'Zq8#kP2!vL9@xR4$mN7&bT1*wY6^cH3%', FEDERATION: 'on', FED_TEST_LOOPBACK: '1', MAIL_PROVIDER: 'log' };
  for (const NODE_ENV of ['staging', '', 'test']) {
    assert.throws(() => loadConfig({ ...base, NODE_ENV, PUBLIC_ORIGIN: 'https://ring.example.org' }), /FED_TEST_LOOPBACK is a test hook: it needs PUBLIC_ORIGIN on loopback/, `NODE_ENV=${NODE_ENV}`);
  }
  assert.throws(() => loadConfig({ ...base, FEDERATION: 'off', PUBLIC_ORIGIN: 'https://ring.example.org' }), /needs PUBLIC_ORIGIN on loopback/, 'federation off too');
  assert.throws(() => loadConfig({ ...base, FEDERATION: 'off' }), /needs PUBLIC_ORIGIN on loopback/, 'no origin at all');
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production', ADMIN_EMAIL: 'a@b.c', TRUST_PROXY: '1', PUBLIC_ORIGIN: 'http://127.0.0.1:4000' }), /refused in production/);
  // Positive controls: loopback origins boot with the hook; a real domain boots without it.
  for (const o of ['http://127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000']) {
    assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: o }).fedTestLoopback, true, o);
  }
  const { FED_TEST_LOOPBACK, ...noHook } = base;
  void FED_TEST_LOOPBACK;
  assert.equal(loadConfig({ ...noHook, PUBLIC_ORIGIN: 'https://ring.example.org' }).fedTestLoopback, false);
});

test('F7: a trailing-dot origin and platform hosts are refused; ::ffff:0:0:0/96 is classed like the mapped form', async () => {
  const base = { SESSION_SECRET: 'Zq8#kP2!vL9@xR4$mN7&bT1*wY6^cH3%', FEDERATION: 'on', MAIL_PROVIDER: 'log' };
  assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'https://ring.example.org.' }), /without a trailing dot/);
  assert.throws(() => loadConfig({ ...base, FEDERATION: 'off', PUBLIC_ORIGIN: 'https://ring.example.org.' }), /without a trailing dot/, 'refused, never normalised, federation off too');
  assert.match(federationOriginProblem('https://ring.example.org.'), /trailing dot/);
  for (const host of ['x.pages.dev', 'x.workers.dev', 'x.azurewebsites.net', 'x.web.app', 'x.firebaseapp.com', 'x.appspot.com', 'x-abc.a.run.app', 'x.github.io', 'x.ondigitalocean.app', 'box.tail1234.ts.net', 'x.deno.dev']) {
    assert.match(federationOriginProblem(`https://${host}`), /provider's default host/, host);
  }
  assert.equal(federationOriginProblem('https://ring.example.org'), '', 'positive control: a real domain');
  assert.equal(federationOriginProblem('https://pages.devotion.example'), '', 'a suffix match is a whole label, never a substring');

  for (const a of ['::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '::ffff:0:10.0.0.1', '::ffff:0:a9fe:a9fe', '::ffff:0:c0a8:101']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  assert.equal(isPrivateAddress('::ffff:0:808:808'), false, 'positive control: a public IPv4, translated, is public like the mapped form');
  assert.equal(isPrivateAddress('::ffff:808:808'), false);
  assert.equal(isLoopbackAddress('::ffff:0:127.0.0.1'), true);
  await assert.rejects(resolveTarget('https://[::ffff:0:7f00:1]/'), (e) => e.code === 'ERR_PUBLIC_URL_REQUIRED');
  await assert.rejects(resolveTarget('https://rebind.example/', { lookup: async () => [{ address: '::ffff:0:a00:1', family: 6 }] }), (e) => e.code === 'ERR_PUBLIC_URL_REQUIRED');
});
