'use strict';
/* Gate: fed-hardening-r2 (spec 3.5, 4.9, 5.2, 5.5, 5.9, 5.10, 7, 15.2, 15.4). The
 * P5 review's second round, each finding turned from its proof script into the
 * behaviour it now has:
 *   F4b  a full or slow inbound gate is a 429 with Retry-After, never a 401; an
 *        inbound document fetch takes 5 s at most; an IPv6 /48 has an aggregate
 *        budget on top of each /64's
 *   N1   the queue is indexed: a pass over 10 000 due jobs touches a handful
 *   N2   the instance actor answers a Follow once per actor per day; an accepted
 *        follower's re-sent Follow is re-Accepted once an hour; the queue caps
 *        what is not essential; a crowd of hanging hosts never holds every slot
 *   N3   a suspended or deleted signer's queued jobs go (Delete, Reject, Undo
 *        excepted); a Create still queued when the page goes off is not sent
 *   N4   the post route spends its budget first and reads one post by id
 *   N5   seen ids are fixed-length hashes, capped, and only handled ones
 *   N6   the hosts table is read once, written on a debounce, kept across a restart
 *   N7   pending follow requests have their own caps, apart from the accepted
 *   N8   a forwarded activity's fetch spends the client's budget and is cached
 *        when it fails
 *   N9   every signer-dependent answer is private, no-store, Vary Signature
 *   N10  only a post that was once shown federates its Delete or answers 410
 *   N11  a lost origin lock refuses the boot when the data dir has federated;
 *        a verified signed GET stamps federated_at
 *   N12  a damaged job file is moved aside with an audit line
 *   N13  an AP type at q=0 is a refusal of it
 * Nothing leaves loopback: every remote is a fake in this process. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const clock = require('../lib/clock');
const { createQueue, DELIVERY_TIMEOUT_MS } = require('../lib/queue');
const { createHosts } = require('../lib/hosts');
const { createSeen } = require('../lib/seen');
const { createFollows, normalizeFollows, MAX_FOLLOWERS, MAX_PENDING, MAX_PENDING_PER_HOST } = require('../lib/follows');
const { normalizePage } = require('../lib/ring');
const { wantsAp, wantsHtml } = require('../lib/http');
const { boot } = require('./helpers/harness');
const { crowd } = require('./helpers/social');
const { fedRing, fakeMastodon, remoteFollow, followFrom, keypair, until } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());

const AP = 'application/activity+json';
const quiet = { log() {}, warn() {}, error() {} };
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const shut = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); });
const tally = (list) => list.reduce((a, s) => { a[s] = (a[s] || 0) + 1; return a; }, {});
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ORIGIN = 'https://ring.example';

function junkHeaders(keyId, { ip, post = false } = {}) {
  const h = {
    date: new Date(clock.now()).toUTCString(),
    signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date${post ? ' digest' : ''}",signature="AAAA"`,
  };
  if (ip) h['x-forwarded-for'] = ip;
  if (post) { h['content-type'] = AP; h.digest = `SHA-256=${crypto.createHash('sha256').update('{}').digest('base64')}`; } else h.accept = AP;
  return h;
}
const junkPost = (url, keyId, ip) => fetch(url, { method: 'POST', headers: junkHeaders(keyId, { ip, post: true }), body: '{}' })
  .then((r) => ({ status: r.status, retryAfter: r.headers.get('retry-after') })).catch((e) => ({ status: e.message }));
const junkGet = (url, keyId, ip) => fetch(url, { headers: junkHeaders(keyId, { ip }) }).then((r) => r.status);

// ── a queue over stubs (N1, N2, N12) ──

function stubQueue(dir, { fetch, hostRow = () => ({ last_success_at: '2026-01-01T00:00:00.000Z' }), ...opts } = {}) {
  const { privateKey } = keypair(0);
  const audits = [];
  const logs = [];
  const q = createQueue({
    paths: { queueDir: dir },
    net: { fetchGuarded: fetch || (async () => ({ status: 202, headers: {}, body: Buffer.alloc(0) })) },
    keys: { has: () => true, privateKey: () => privateKey, instancePrivateKey: () => privateKey },
    actors: { resolve: async (id) => ({ id, inbox: `${id}/inbox`, shared_inbox: '' }), inboxOf: (rec) => rec.inbox },
    hosts: { unavailable: () => false, success() {}, failure: () => false, get: hostRow },
    cfg: { publicOrigin: ORIGIN },
    audit: (event, actor, d) => audits.push({ event, ...d }),
    logger: { log() {}, warn: (l) => logs.push(l), error: (l) => logs.push(l) },
    ...opts,
  });
  return { q, audits, logs };
}

/* Deliver job files as a boot after an outage finds them. `at(i)` -> { object, host, inbox? }. */
function layJobs(dir, n, at, { order = (i) => i } = {}) {
  const now = Date.now();
  for (let k = 0; k < n; k++) {
    const i = order(k);
    const { object, host, inbox = `https://${host}/inbox` } = at(i);
    const id = `j${now.toString(36)}${String(i).padStart(6, '0')}${crypto.randomBytes(4).toString('hex')}`;
    const objectId = `${ORIGIN}/users/ana/posts/${object}`;
    const body = JSON.stringify({ id: `${objectId}/activity`, type: 'Create', actor: `${ORIGIN}/users/ana`, object: { id: objectId, type: 'Note', content: `n${i}` } });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      id, seq: now * 1000 + i, kind: 'deliver', activity_id: `${objectId}/activity#${i}`, activity_type: 'Create', object_id: objectId,
      signer: 'ana', inbox, host, body, attempts: 3, next_at: now - 1000, created_at: new Date(now).toISOString(), last_status: 503,
    }));
  }
}

// ── F4b ──

test('F4b: a full inbound gate answers 429 with Retry-After, never 401; a silent key host is given up on after 5 s', async () => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  const hang = [];
  const pending = [];
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    for (let i = 0; i < 4; i++) hang.push(await listen(() => { /* never answers */ }));
    // One fetch alone, from a fresh client: answered once its 5 s run out.
    const t0 = Date.now();
    const one = await junkPost(`${h.base}/inbox`, `http://127.0.0.1:${hang[0].address().port}/alone#main-key`, '198.51.100.99');
    const took = Date.now() - t0;
    assert.equal(one.status, 401, 'a key that never came is an unknown key');
    assert.ok(took >= 4000 && took < 8000, `an inbound key fetch takes 5 s at most (took ${took} ms)`);

    // 11 clients x 4 = 44 fetches: 8 in flight (2 per silent host), 32 in line, 4 past the line.
    let k = 0;
    const early = [];
    for (let ip = 1; ip <= 11; ip++) {
      for (let j = 0; j < 4; j++) {
        const s = hang[k % hang.length];
        const p = junkPost(`${h.base}/inbox`, `http://127.0.0.1:${s.address().port}/slow/${k++}#main-key`, `198.51.100.${ip}`);
        pending.push(p);
        p.then((r) => early.push(r));
      }
    }
    await until(() => early.length >= 4, { ms: 3000, what: 'the refusals past the line' });
    assert.ok(early.length <= 4 + 0, `only those past the line answered at once (${early.length})`);
    assert.deepEqual(tally(early.map((r) => r.status)), { 429: 4 }, 'a full gate is this server being busy: 429, never 401');
    assert.ok(early.every((r) => Number(r.retryAfter) > 0), 'with Retry-After');
    assert.equal(h.ctx.federation.inboundGate.stats().total, 8, 'positive control: the gate was full');
  } finally {
    for (const s of hang) await shut(s);
    await Promise.allSettled(pending);
    await h.close();
  }
});

test('F4b: an IPv6 /48 has one aggregate key-fetch budget over all its /64s', async () => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  let hits = 0;
  const dead = await listen((req, res) => { hits++; res.writeHead(404); res.end(); });
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const url = `${h.base}/users/ana/outbox`;
    let n = 0;
    const key = () => `http://127.0.0.1:${dead.address().port}/k/${n++}#main-key`;
    // Two /64s of 2001:db8:aa::/48, each within its own 30 a minute: 60 together.
    for (const ip of ['2001:db8:aa:1::1', '2001:db8:aa:2::1']) {
      const st = [];
      for (let i = 0; i < 30; i++) st.push(await junkGet(url, key(), ip));
      assert.deepEqual(tally(st), { 401: 30 });
    }
    assert.equal(hits, 60);
    // A third /64 of the same /48: its own budget is untouched, the /48's is spent.
    const third = [];
    for (let i = 0; i < 5; i++) third.push(await junkGet(url, key(), '2001:db8:aa:3::1'));
    assert.deepEqual(tally(third), { 429: 5 }, 'the /48 is spent');
    assert.equal(hits, 60, 'and nothing was fetched for it');
    // Positive control: another /48 fetches.
    assert.equal(await junkGet(url, key(), '2001:db8:bb:1::1'), 401);
    assert.equal(hits, 61);
  } finally { await shut(dead); await h.close(); }
});

// ── N1 ──

test('N1: a pass over 10 000 due jobs is indexed, not a scan: the first pass and each delivery are cheap', async () => {
  const dir = tmpDir('ring-q-');
  try {
    layJobs(dir, 10_000, (i) => ({ object: `p${i % 10}`, host: `h${Math.floor(i / 10)}.example` }));
    let sent = 0;
    const { q } = stubQueue(dir, { fetch: async () => { sent++; return { status: 202, headers: {}, body: Buffer.alloc(0) }; } });
    assert.equal(q.depth(), 10_000);   // boot's read, not measured
    // Counted, not timed (a wall-clock bound flaked under full-suite load). Indexing at
    // start touches each job once; the old scan-per-job pass was quadratic (~10^8).
    const vStart = q.counters().visited;
    q.start();
    const firstVisited = q.counters().visited - vStart;
    assert.ok(firstVisited < 2 * 10_000, `the first pass touched ${firstVisited} index entries (linear is ~10 000, a quadratic pass ~100 000 000)`);
    const v0 = q.counters().visited;
    const s0 = sent;
    await until(() => sent - s0 >= 1000, { ms: 10_000, what: '1000 deliveries' });
    const per = (q.counters().visited - v0) / (sent - s0);
    q.stop();
    assert.ok(per < 20, `index entries touched per delivery: ${per.toFixed(1)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N1: a 3000-job chain (one object, one inbox) runs in seq order without a pass per job', async () => {
  const dir = tmpDir('ring-q-');
  try {
    // Files written in a scrambled order: the chain is ordered by seq, not by the disk.
    layJobs(dir, 3000, () => ({ object: 'p1', host: 'one.example' }), { order: (k) => (k * 7919) % 3000 });
    const got = [];
    const { q } = stubQueue(dir, { fetch: async (url, o) => { got.push(JSON.parse(o.body).object.content); return { status: 202, headers: {}, body: Buffer.alloc(0) }; } });
    q.depth();
    const t0 = performance.now();
    q.start();
    await until(() => got.length >= 300, { ms: 5000, what: '300 in order' });
    q.stop();
    assert.ok(performance.now() - t0 < 5000);
    assert.deepEqual(got.slice(0, 300), Array.from({ length: 300 }, (_, i) => `n${i}`), 'one at a time, in the order they were made');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── N2 ──

test('N2: hosts that hang (or never answered) share four slots, one each: a proven host is never stuck behind them', async () => {
  const dir = tmpDir('ring-q-');
  try {
    // 12 jobs for 6 silent new hosts, made first; then one for a proven host.
    layJobs(dir, 13, (i) => (i < 12 ? { object: `s${i}`, host: `slow${i % 6}.example` } : { object: 'g', host: 'good.example' }));
    const hung = new Set();
    let good = 0;
    const { q } = stubQueue(dir, {
      fetch: (url) => {
        if (url.includes('good.example')) { good++; return Promise.resolve({ status: 202, headers: {}, body: Buffer.alloc(0) }); }
        hung.add(url);
        return new Promise(() => { /* never answers */ });
      },
      hostRow: (host) => (host === 'good.example' ? { last_success_at: '2026-01-01T00:00:00.000Z' } : null),
    });
    q.start();
    await until(() => good === 1 && q.depth() === 12, { ms: 2000, what: 'the proven host\'s delivery' });
    assert.ok(q.inflight() <= 4, `the silent hosts hold ${q.inflight()} slots, at most 4`);
    assert.equal(hung.size, 4, 'four silent hosts, one job each, in flight');
    q.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N2: past the queue caps a new job is refused with an audit line; Delete, Reject and Undo are kept and said so', async () => {
  const dir = tmpDir('ring-q-');
  try {
    const { q, audits, logs } = stubQueue(dir, { maxJobs: 3, maxPerHost: 2, fetch: async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }) });
    const create = (i, to = 'https://far.example/users/zed') => q.enqueue({ id: `${ORIGIN}/a/${i}`, type: 'Create', actor: `${ORIGIN}/users/ana`, object: { id: `${ORIGIN}/users/ana/posts/p${i}`, type: 'Note' } }, [to], { signer: 'ana' });
    assert.ok(create(1) && create(2) && create(3));
    assert.equal(create(4), null, 'the fourth is refused');
    assert.ok(audits.some((a) => a.event === 'delivery_refused' && a.reason === 'queue_full'));
    const del = q.enqueue({ id: `${ORIGIN}/a/d`, type: 'Delete', actor: `${ORIGIN}/users/ana`, object: { id: `${ORIGIN}/users/ana/posts/p9`, type: 'Tombstone' } }, ['https://far.example/users/zed'], { signer: 'ana' });
    assert.ok(del, 'a Delete is never refused');
    assert.ok(logs.some((l) => l.includes('over the cap') && l.includes('Delete')), 'and the log says it was kept over the cap');
    const courtesy = q.enqueue({ id: `${ORIGIN}/actor/a/r`, type: 'Reject', actor: `${ORIGIN}/actor`, object: { type: 'Follow' } }, ['https://far.example/users/zed'], { signer: '_instance', courtesy: true });
    assert.equal(courtesy, null, 'a courtesy Reject (an answer to a stranger) is not essential');
    assert.equal(q.depth(), 4);

    // The per-host cap, at fan-out: 4 jobs for one host, two get deliver jobs.
    const dir2 = tmpDir('ring-q-');
    const s2 = stubQueue(dir2, { maxPerHost: 2, fetch: async () => ({ status: 503, headers: {}, body: Buffer.alloc(0) }) });
    try {
      for (let i = 0; i < 4; i++) s2.q.enqueue({ id: `${ORIGIN}/a/${i}`, type: 'Create', actor: `${ORIGIN}/users/ana`, object: { id: `${ORIGIN}/users/ana/posts/p${i}`, type: 'Note' } }, ['https://far.example/users/zed'], { signer: 'ana' });
      await s2.q.drain();
      assert.equal(s2.q.hostDepth('far.example'), 2, 'two deliver jobs for that host, no more');
      assert.equal(s2.audits.filter((a) => a.event === 'delivery_refused' && a.reason === 'host_queue_full').length, 2);
      s2.q.enqueue({ id: `${ORIGIN}/a/u`, type: 'Undo', actor: `${ORIGIN}/users/ana`, object: { id: `${ORIGIN}/f/1`, type: 'Follow' } }, ['https://far.example/users/zed'], { signer: 'ana' });
      await s2.q.drain();
      assert.equal(s2.q.hostDepth('far.example'), 3, 'positive control: an Undo goes over the host cap');
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N2: a delivery waits 10 s at most', async () => {
  assert.ok(DELIVERY_TIMEOUT_MS <= 10_000);
  const dir = tmpDir('ring-q-');
  try {
    let asked = null;
    const { q } = stubQueue(dir, { fetch: async (url, o) => { asked = o.timeoutMs; return { status: 202, headers: {}, body: Buffer.alloc(0) }; } });
    layJobs(dir, 1, () => ({ object: 'p', host: 'x.example' }));
    await q.drain();
    assert.equal(asked, DELIVERY_TIMEOUT_MS);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N2: the instance actor answers a Follow once per actor per day, as a courtesy job', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    h.ctx.federation.queue.stop();   // the jobs stay put to be counted
    const followInstance = () => m.post(`${h.base}/inbox`, { '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.base}/f/${crypto.randomUUID()}`, type: 'Follow', actor: m.actor(), object: `${h.base}/actor` });
    for (let i = 0; i < 10; i++) assert.equal((await followInstance()).status, 202);
    const rejects = () => h.ctx.federation.queue.list().filter((j) => j.activity_type === 'Reject' && j.signer === '_instance');
    assert.equal(rejects().length, 1, 'ten Follows, one Reject job');
    assert.equal(rejects()[0].courtesy, true);
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.filter((d) => d.body?.type === 'Reject').length, 1);
    clock.advance(24 * 3600_000 + 1000);
    await followInstance();
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.filter((d) => d.body?.type === 'Reject').length, 2, 'positive control: a day later it is answered again');
  } finally { await m.close(); await h.close(); }
});

test('N2: an accepted follower\'s re-sent Follow is re-Accepted at most once an hour', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m, 'ana');
    const accepts = () => m.deliveries.filter((d) => d.body?.type === 'Accept').length;
    assert.equal(accepts(), 1);
    for (let i = 0; i < 5; i++) assert.equal((await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`))).status, 202);
    await h.ctx.federation.queue.drain();
    assert.equal(accepts(), 1, 'five re-sent Follows inside the hour: no Accept job each');
    clock.advance(3600_000 + 1000);
    await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`));
    await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`));
    await h.ctx.federation.queue.drain();
    assert.equal(accepts(), 2, 'an hour later: one re-Accept, not two');
    assert.deepEqual(h.ctx.follows.load('ana').followers.map((r) => r.state), ['accepted']);
  } finally { await m.close(); await h.close(); }
});

// ── N3 ──

test('N3: queued jobs of a suspended or deleted signer go at once (a Delete kept); a Create queued before the page went off is not sent', async () => {
  const { PASSWORD } = require('./helpers/harness');
  const { h, c } = await fedRing(['ana', 'bram', 'cleo']);
  const m = await fakeMastodon();
  const q = h.ctx.federation.queue;
  try {
    for (const n of ['ana', 'bram', 'cleo']) await remoteFollow(h, c, m, n);
    m.answer(() => 503);
    for (const n of ['ana', 'bram', 'cleo']) await c[n].post('/api/posts', { kind: 'note', note: `${n.toUpperCase()}: queued` });
    await q.drain();
    const queued = () => q.list().map((j) => `${j.activity_type}:${j.signer}`).sort();
    assert.deepEqual(queued(), ['Create:ana', 'Create:bram', 'Create:cleo']);

    h.ctx.members.update('cleo', { status: 'suspended' });
    assert.deepEqual(queued(), ['Create:ana', 'Create:bram'], 'suspension cancels at once');
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200);
    // P6: a remote edge ends with the farewell's Delete{Person}, not a sever's Reject.
    assert.deepEqual(queued(), ['Create:ana', 'Delete:bram'], 'the purge cancels the Create, keeps the farewell');
    await c.ana.put('/api/me/page', { enabled: false });

    const n0 = m.deliveries.length;
    m.answer(() => 202);
    clock.advance(2 * 60_000);
    await q.drain();
    const sent = m.deliveries.slice(n0).map((d) => `${d.body.type}${d.body.object?.type ? `{${d.body.object.type}}` : ''}:${d.body.actor.split('/').pop()}`).sort();
    assert.deepEqual(sent, ['Delete:bram', 'Update{Person}:ana'], 'no Create after page off, suspension or deletion');
    const dropped = h.ctx.audit.read().filter((r) => r.event === 'delivery_dropped').map((r) => r.reason);
    assert.ok(dropped.includes('page_off') && dropped.includes('signer_suspended') && dropped.includes('signer_gone'), dropped.join(','));
  } finally { await m.close(); await h.close(); }
});

// ── N4 ──

test('N4: the post route spends its budget before reading, and reads one post from an index, never the log per request', async (t) => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1 });
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'hello' })).body;
    const logFile = path.join(h.dir, 'members', 'ana', 'log.json');
    const real = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', function (...a) { if (a[0] === logFile) reads++; return real.apply(this, a); });
    const html = { accept: 'text/html' };
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${h.base}/users/ana/posts/${p.id}`, { headers: html, redirect: 'manual' });
      assert.equal(r.status, 302);
    }
    assert.ok(reads <= 2, `the log was read ${reads} times for 20 requests`);
    const st = [];
    for (let i = 0; i < 50; i++) st.push((await fetch(`${h.base}/users/ana/posts/pzzzzzzzzzzzz`, { headers: html, redirect: 'manual' })).status);
    assert.deepEqual(tally(st), { 404: 40, 429: 10 }, 'the HTML branch spends the 60-a-minute read budget');
    assert.equal((await fetch(`${h.base}/users/ana`, { headers: html, redirect: 'manual' })).status, 429, 'and so does /users/:name in HTML');
  } finally { await h.close(); }
});

// ── N5 ──

test('N5: seen ids are fixed-length hashes, capped oldest out, kept across a restart', () => {
  const dir = tmpDir('ring-seen-');
  try {
    const s = createSeen(dir, { max: 50 });
    const id = (i) => `https://far.example/${'a'.repeat(1960)}${String(i).padStart(10, '0')}`;
    for (let i = 0; i < 80; i++) s.add(id(i));
    assert.equal(s.size(), 50, 'capped');
    assert.equal(s.has(id(0)), false, 'the oldest went');
    assert.equal(s.has(id(79)), true);
    const lines = () => fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean));
    assert.ok(lines().every((l) => /^[0-9a-f]{32}$/.test(l)), 'a line is 32 hex characters, never the id');
    assert.equal(createSeen(dir).has(id(79)), true, 'a restart reads them back');
    // The day file is bounded too: past twice the cap it is rewritten from memory.
    for (let i = 80; i < 400; i++) s.add(id(i));
    assert.ok(lines().length <= 100, `the day file holds ${lines().length} lines`);
    const back = createSeen(dir, { max: 50 });
    assert.equal(back.has(id(399)), true, 'the newest survive the rewrite');
    assert.equal(back.has(id(300)), false, 'the oldest went');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N5: only a handled activity is recorded as seen; a dropped one costs nothing', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    const seen = h.ctx.federation.seen;
    const s0 = seen.size();
    for (let i = 0; i < 5; i++) {
      const r = await m.post(`${h.base}/inbox`, { '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.base}/like/${i}`, type: 'Like', actor: m.actor(), object: `${m.base}/nothing` });
      assert.equal(r.status, 202);
    }
    assert.equal(seen.size(), s0, 'five dropped Likes: nothing recorded');
    await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`));
    assert.equal(seen.size(), s0 + 1, 'positive control: a handled Follow is');
  } finally { await m.close(); await h.close(); }
});

// ── N6 ──

test('N6: the hosts table is read once, written on a debounce, atomic and kept across a restart', async () => {
  const dir = tmpDir('ring-hosts-');
  const real = fs.readFileSync;
  try {
    const file = path.join(dir, 'hosts.json');
    const rows = {};
    for (let i = 0; i < 10_000; i++) rows[`x${i}.example`] = { failing_since: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(rows));
    let reads = 0;
    // A counting wrapper (not t.mock, which would keep every 1 MB answer it saw).
    fs.readFileSync = function (...a) { if (a[0] === file) reads++; return real.apply(this, a); };
    const hosts = createHosts(file, { debounceMs: 40, logger: quiet });
    for (let i = 0; i < 2000; i++) { hosts.heard('legit.example'); hosts.unavailable(`x${i}.example`); }
    assert.equal(reads, 1, 'read once, then answered from memory');
    hosts.failure('new.example');
    assert.equal(JSON.parse(real(file, 'utf8'))['new.example'], undefined, 'not written at once');
    await until(() => JSON.parse(real(file, 'utf8'))['new.example'], { ms: 2000, what: 'the debounced write' });
    assert.ok(createHosts(file).get('new.example').failing_since, 'a restart reads it back');
    hosts.failure('now.example');
    hosts.flush();
    assert.ok(JSON.parse(real(file, 'utf8'))['now.example'], 'flush() writes at once (shutdown)');
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temp left: the write is a rename');
  } finally { fs.readFileSync = real; fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── N7 ──

test('N7: pending requests have their own caps (500 oldest out, 20 per host) and never count toward 10 000 accepted', () => {
  const dir = tmpDir('ring-follows-');
  try {
    const settings = { blocked: [], blocked_domains: [], open_follows: false };
    const emitted = [];
    const f = createFollows({
      paths: { memberFile: (n, file) => path.join(dir, n, file) },
      members: { get: () => ({ status: 'active' }) },
      pages: { settings: () => settings },
      outbox: { emit: (a, to, o) => emitted.push({ type: a.type, courtesy: !!o?.courtesy }) },
      audit() {},
      remote: { handleOf: (u) => { const x = new URL(u); return `${x.pathname.split('/').pop()}@${x.host}`; }, idOf: () => '' },
    });
    const follow = (user, host) => f.handlers.Follow(
      { id: `https://${host}/f/${user}`, type: 'Follow', actor: `https://${host}/users/${user}`, object: `${ORIGIN}/users/ana` },
      { inbox: { kind: 'person', name: 'ana' }, origin: ORIGIN },
    );
    const pending = () => f.load('ana').followers.filter((r) => r.state === 'pending');
    for (let i = 0; i < 25; i++) follow(`u${i}`, 'one.example');
    assert.equal(pending().length, MAX_PENDING_PER_HOST, 'one host: 20 pending at most');
    assert.equal(emitted.length, 0, 'the rest dropped silently, no Reject');
    for (let i = 0; i < 500; i++) follow('p', `h${i}.example`);
    assert.equal(pending().length, MAX_PENDING, '500 pending at most');
    assert.ok(!pending().some((r) => r.handle === 'u0@one.example'), 'the oldest went');
    assert.ok(pending().some((r) => r.handle === 'p@h499.example'), 'the newest stayed');

    // 9 999 accepted and 500 pending: pending do not fill the accepted cap.
    const rows = [];
    for (let i = 0; i < MAX_FOLLOWERS - 1; i++) rows.push({ handle: `a@acc${i}.example`, state: 'accepted', follow_id: 'x', at: 't', accepted_at: 't' });
    for (let i = 0; i < MAX_PENDING; i++) rows.push({ handle: `w@wait${i}.example`, state: 'pending', follow_id: 'x', at: 't' });
    fs.writeFileSync(path.join(dir, 'ana', 'follows.json'), JSON.stringify({ following: [], followers: rows }));
    assert.equal(normalizeFollows({ followers: rows }).followers.length, MAX_FOLLOWERS - 1 + MAX_PENDING, 'nothing cut');
    settings.open_follows = true;
    emitted.length = 0;
    assert.equal(follow('new', 'fresh.example').accepted, true, 'the 10 000th accepted follower');
    assert.deepEqual(emitted, [{ type: 'Accept', courtesy: false }]);
    assert.equal(follow('late', 'fresh2.example').rejected, true, 'positive control: past 10 000 accepted, a Reject');
    assert.equal(emitted.at(-1).courtesy, true, 'as a courtesy job');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── N8 ──

test('N8: a forwarded activity\'s fetch spends the client\'s budget and a failed one is not fetched again', async () => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  const m = await fakeMastodon();
  let hits = 0;
  const dead = await listen((req, res) => { hits++; res.writeHead(404); res.end(); });
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const db = `http://127.0.0.1:${dead.address().port}`;
    const fwd = (i) => ({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${db}/a/${i}`, type: 'Like', actor: `${db}/users/eve`, object: `${h.base}/users/ana` });
    const send = (i, ip, dateMs) => m.post(`${h.base}/inbox`, fwd(i), { headers: { 'x-forwarded-for': ip }, dateMs });
    // The negative cache: one dead forwarded id, sent twice (signed a second apart,
    // or the replay guard would answer), is fetched once.
    assert.equal((await send('same', '203.0.113.40')).status, 202);
    assert.equal((await send('same', '203.0.113.40', clock.now() - 2000)).status, 202);
    assert.equal(hits, 1, 'a failed forwarded id is not fetched again inside the window');
    // The client's budget (30 a minute, bob's own key fetch spent one).
    const st = [];
    for (let i = 0; i < 40; i++) st.push((await send(i, '203.0.113.41')).status);
    assert.equal(hits, 1 + 30, 'thirty fetches for that client, no more');
    assert.deepEqual(tally(st), { 202: 30, 429: 10 });
  } finally { await shut(dead); await m.close(); await h.close(); }
});

// ── N9 ──

test('N9: every signer-dependent answer is private, no-store and varies on Signature; a WebFinger 404 is not cacheable', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m, 'ana');
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'hi' })).body;
    const check = (r, vary, what) => {
      assert.equal(r.headers.get('cache-control'), 'private, no-store', `${what}: cache-control`);
      assert.equal(r.headers.get('vary'), vary, `${what}: vary`);
    };
    check(await m.get(`${h.base}/users/ana/outbox`), 'Signature', 'signed 200');
    check(await fetch(`${h.base}/users/ana/outbox`, { headers: { accept: AP } }), 'Signature', 'unsigned 401');
    await c.ana.put('/api/me/page', { block: `bob@${m.host}` });
    for (const what of ['outbox', 'featured', 'followers']) {
      const r = await m.get(`${h.base}/users/ana/${what}`);
      assert.equal(r.status, 404);
      check(r, 'Signature', `blocked ${what}`);
    }
    const r = await m.get(`${h.base}/users/ana/posts/${p.id}`);
    assert.equal(r.status, 404);
    check(r, 'Accept, Signature', 'blocked post');
    const host = new URL(h.base).host;
    assert.equal((await fetch(`${h.base}/.well-known/webfinger?resource=acct:nobody@${host}`)).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${h.base}/.well-known/webfinger?resource=acct:ana@${host}`)).headers.get('cache-control'), 'max-age=300', 'positive control');
  } finally { await m.close(); await h.close(); }
});

// ── N10 ──

test('N10: only a post that was once shown federates its Delete with the page off, or answers 410', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  const q = h.ctx.federation.queue;
  try {
    await remoteFollow(h, c, m, 'ana');
    const shown = (await c.ana.post('/api/posts', { kind: 'note', note: 'public while on' })).body;
    await q.drain();
    await c.ana.put('/api/me/page', { enabled: false });
    const secret = (await c.ana.post('/api/posts', { kind: 'note', note: 'drafted while off' })).body;
    await c.ana.del(`/api/posts/${secret.id}`);
    await c.ana.del(`/api/posts/${shown.id}`);
    await q.drain();
    const deletes = m.deliveries.filter((d) => d.body?.type === 'Delete').map((d) => d.body.object.id.split('/').pop());
    assert.deepEqual(deletes, [shown.id], 'the shown post is recalled; the one never shown is not');
    await c.ana.put('/api/me/page', { enabled: true });
    assert.equal((await m.get(`${h.base}/users/ana/posts/${secret.id}`)).status, 404, 'never shown: 404');
    assert.equal((await m.get(`${h.base}/users/ana/posts/${shown.id}`)).status, 410, 'positive control: shown, then deleted: 410');
  } finally { await m.close(); await h.close(); }
});

test('N10: a page store written before the mark counts its public posts as shown; a tracked one does not', () => {
  const post = { id: 'p1', kind: 'note', note: 'x', audience: 'public', created_at: 't' };
  assert.equal(normalizePage({ posts: [post] }).posts[0].shown, true, 'legacy: the safe side');
  assert.equal(normalizePage({ shown_tracked: true, posts: [post] }).posts[0].shown, undefined);
  assert.equal(normalizePage({ shown_tracked: true, posts: [{ ...post, shown: true }] }).posts[0].shown, true);
});

// ── N11 ──

test('N11: a lost origin lock refuses the boot when the data dir has federated; with no evidence it boots', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  const dir = h.dir;
  const port = Number(new URL(h.base).port);
  const file = path.join(dir, 'instance.json');
  try {
    await remoteFollow(h, c, m, 'ana');
    await h.close({ keepData: true });
    const orig = fs.readFileSync(file);
    assert.ok(JSON.parse(orig).federated_at);
    const tamper = {
      deleted: () => fs.rmSync(file),
      empty: () => fs.writeFileSync(file, '{}'),
      blank: () => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(orig), federated_at: '' })),
    };
    for (const [k, fn] of Object.entries(tamper)) {
      fs.writeFileSync(file, orig);
      fn();
      await assert.rejects(boot({ federated: true, dataDir: dir, port }), /instance\.json .*federated \(.*fed\/seen/, k);
    }
    // An explicit null with a seen inbound activity: edited by hand.
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(orig), federated_at: null }));
    await assert.rejects(boot({ federated: true, dataDir: dir, port }), /never federated, but it has/);
    fs.writeFileSync(file, orig);
    const again = await boot({ federated: true, dataDir: dir, port });
    await again.close({ keepData: true });
  } finally { await m.close(); fs.rmSync(dir, { recursive: true, force: true }); }

  // No evidence (federation never on): a lost instance.json is just written again.
  const plain = await boot({});
  const pdir = plain.dir;
  await plain.close({ keepData: true });
  try {
    fs.rmSync(path.join(pdir, 'instance.json'));
    const b = await boot({ dataDir: pdir });
    await b.close({ keepData: true });
  } finally { fs.rmSync(pdir, { recursive: true, force: true }); }
});

test('N11: the first verified signed GET stamps federated_at', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    const inst = () => JSON.parse(fs.readFileSync(path.join(h.dir, 'instance.json'), 'utf8'));
    assert.equal(inst().federated_at, null);
    assert.equal((await fetch(`${h.base}/users/ana`, { headers: { accept: AP } })).status, 200);
    assert.equal(inst().federated_at, null, 'an unsigned read stamps nothing');
    assert.equal((await m.get(`${h.base}/users/ana/outbox`)).status, 200);
    assert.ok(inst().federated_at, 'a verified signed GET: another server holds this origin now');
  } finally { await m.close(); await h.close(); }
});

// ── N12 ──

test('N12: a damaged job file is moved to queue/damaged/ with an audit line naming its activity', () => {
  const dir = tmpDir('ring-q-');
  try {
    layJobs(dir, 1, () => ({ object: 'ok', host: 'x.example' }));
    fs.writeFileSync(path.join(dir, 'jtorn.json'), '{"id":"jtorn","activity_id":"https://ring.example/a/torn","bo');
    fs.writeFileSync(path.join(dir, 'jshape.json'), JSON.stringify({ id: 'jshape', kind: 'deliver', inbox: 42, body: JSON.stringify({ id: 'https://ring.example/a/shape' }), created_at: new Date().toISOString() }));
    const { q, audits } = stubQueue(dir);
    assert.equal(q.depth(), 1, 'the good job loads');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'damaged')).sort(), ['jshape.json', 'jtorn.json'], 'both moved aside, nothing deleted');
    assert.ok(!fs.existsSync(path.join(dir, 'jtorn.json')) && !fs.existsSync(path.join(dir, 'jshape.json')));
    const lines = audits.filter((a) => a.event === 'delivery_damaged');
    assert.deepEqual(lines.map((a) => a.activity).sort(), ['https://ring.example/a/shape', 'https://ring.example/a/torn']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── N13 ──

test('N13: an ActivityStreams type at q=0 is a refusal of it', async () => {
  const req = (accept) => ({ get: () => accept });
  assert.equal(wantsAp(req('application/activity+json;q=0, text/html')), false);
  assert.equal(wantsHtml(req('application/activity+json;q=0, text/html')), true);
  assert.equal(wantsAp(req('application/ld+json; profile="https://www.w3.org/ns/activitystreams"')), true);
  assert.equal(wantsAp(req('text/html;q=0.9, application/activity+json')), true);
  assert.equal(wantsAp(req('application/activity+json;q=0.5, text/html')), false);
  const { h, c } = await fedRing(['ana']);
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'hi' })).body;
    const hd = { accept: 'application/activity+json;q=0, text/html' };
    const wall = await fetch(`${h.base}/@ana`, { headers: hd, redirect: 'manual' });
    assert.equal(wall.status, 200, '/@ana stays the page');
    const actor = await fetch(`${h.base}/users/ana`, { headers: hd, redirect: 'manual' });
    assert.equal(actor.status, 302, '/users/ana goes to the page');
    const post = await fetch(`${h.base}/users/ana/posts/${p.id}`, { headers: hd, redirect: 'manual' });
    assert.equal(post.status, 302, 'the post goes to its anchor');
    assert.equal((await fetch(`${h.base}/@ana`, { headers: { accept: AP }, redirect: 'manual' })).status, 302, 'positive control: AP goes to the actor');
  } finally { await h.close(); }
});
