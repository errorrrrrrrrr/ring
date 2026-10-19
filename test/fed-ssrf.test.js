'use strict';
/* Gate: fed-ssrf (spec 5.6, 16.3). Every outgoing request goes through
 * lib/net.js: https only, every DNS answer
 * public, the approved answer pinned into the socket, redirects re-checked, a
 * POST never redirected, bodies and time capped, AP documents only by their
 * content type, an actor's inbox on its own host. Nothing here reaches a real
 * server: the "public" answers are checked without connecting, and the servers
 * that are reached are in-process on loopback, under the test hook, which opens
 * loopback ONLY. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createNet, createGate, resolveTarget, isPrivateAddress } = require('../lib/net');
const { loadConfig } = require('../lib/config');
const clock = require('../lib/clock');
const { NEG_MS } = require('../lib/actors');
const { fedRing, fakeMastodon, followFrom } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());
// A keyId whose fetch failed is not fetched again for NEG_MS (lib/actors.js):
// a test that fixes the remote and tries again moves the clock past it.
const pastNegativeCache = () => clock.advance(NEG_MS + 1000);

const fixedLookup = (...answers) => async () => answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const refusedP = (p) => assert.rejects(p, (e) => e.code === 'ERR_PUBLIC_URL_REQUIRED');

async function server(handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
}

test('private, loopback, link-local, CGNAT, ULA, multicast, mapped and NAT64 addresses are refused; a public one passes', async () => {
  const PRIVATE = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2001:db8::1',
  ];
  for (const a of PRIVATE) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34', '64:ff9b::5db8:d822']) assert.equal(isPrivateAddress(a), false, `positive control: ${a}`);

  // Through the resolver, with no connection made: IP literals, and names whose answer is fixed.
  for (const ip of ['127.0.0.1', '10.0.0.5', '[::1]', '[fe80::1]', '[::ffff:192.168.0.1]', '[64:ff9b::7f00:1]']) await refusedP(resolveTarget(`https://${ip}/users/x`));
  await refusedP(resolveTarget('https://localhost/x'));
  await refusedP(resolveTarget('https://ring.localhost/x'));
  await refusedP(resolveTarget('https://internal.example/x', { lookup: fixedLookup('10.0.0.7') }));
  await refusedP(resolveTarget('https://mixed.example/x', { lookup: fixedLookup('93.184.216.34', '10.0.0.7') }), 'one private answer among public ones refuses the host');
  await refusedP(resolveTarget('https://mixed6.example/x', { lookup: fixedLookup('2606:2800:220:1::1', 'fd00::1') }));
  const ok = await resolveTarget('https://public.example/x', { lookup: fixedLookup('93.184.216.34') });
  assert.equal(ok.addresses[0].address, '93.184.216.34', 'positive control: a public answer');
});

test('https only: http is refused, and the test hook opens loopback and nothing else', async () => {
  await refusedP(resolveTarget('http://public.example/x', { lookup: fixedLookup('93.184.216.34') }));
  await refusedP(resolveTarget('https://user:pw@public.example/x', { lookup: fixedLookup('93.184.216.34') }));
  // The hook: loopback yes ...
  assert.ok(await resolveTarget('http://127.0.0.1:9/x', { allowLoopback: true }));
  assert.ok(await resolveTarget('http://localhost:9/x', { allowLoopback: true }));
  // ... every other private range still no.
  for (const ip of ['10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '[fc00::1]']) await refusedP(resolveTarget(`http://${ip}/x`, { allowLoopback: true }));
  await refusedP(resolveTarget('http://rebind.example/x', { allowLoopback: true, lookup: fixedLookup('127.0.0.1', '10.9.9.9') }));
  // And production refuses the hook itself.
  assert.throws(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(16) + 'abcdefghijklmnop', ADMIN_EMAIL: 'a@b.c', PUBLIC_ORIGIN: 'https://ring.example', TRUST_PROXY: 'loopback', MAIL_PROVIDER: 'log', FED_TEST_LOOPBACK: '1' }), /FED_TEST_LOOPBACK is a test hook/);
});

test('the approved DNS answer is pinned: a rebinding second answer is never asked for', async () => {
  const srv = await server((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`host ${req.headers.host}`); });
  try {
    let calls = 0;
    const lookup = async () => { calls++; return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]; };
    const net = createNet({ allowLoopback: true });
    // `rebind.test` resolves nowhere on this machine: the request reaches the
    // server only through the pinned answer.
    const r = await net.fetchGuarded(`http://rebind.test:${srv.port}/x`, { lookup });
    assert.equal(r.status, 200);
    assert.equal(r.body.toString(), `host rebind.test:${srv.port}`);
    assert.equal(calls, 1, 'one lookup: the socket used the pinned answer, never a second one');
  } finally { await srv.close(); }
});

test('a redirect into a private address is refused; a GET follows at most 3; a POST follows none', async () => {
  let hits = 0;
  const srv = await server((req, res) => {
    hits++;
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/to-private') { res.writeHead(302, { location: 'http://10.0.0.1/secret' }); return res.end(); }
    if (u.pathname === '/to-meta') { res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (u.pathname.startsWith('/hop')) {
      const n = Number(u.pathname.slice(4));
      if (n > 0) { res.writeHead(302, { location: `/hop${n - 1}` }); return res.end('x'.repeat(1000)); }
    }
    if (u.pathname === '/post') { res.writeHead(307, { location: '/landed' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`at ${u.pathname} ${req.method}`);
  });
  try {
    const net = createNet({ allowLoopback: true });
    const base = `http://127.0.0.1:${srv.port}`;
    await refusedP(net.fetchGuarded(`${base}/to-private`));
    await refusedP(net.fetchGuarded(`${base}/to-meta`));
    const three = await net.fetchGuarded(`${base}/hop3`);
    assert.equal(three.body.toString(), 'at /hop0 GET', 'positive control: three redirects on loopback are followed');
    await assert.rejects(net.fetchGuarded(`${base}/hop4`), /too many redirects/);
    hits = 0;
    const post = await net.fetchGuarded(`${base}/post`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 307, 'a POST answers its 3xx');
    assert.equal(hits, 1, 'and never follows it');
  } finally { await srv.close(); }
});

test('an oversize body and a slow body abort; within the caps they pass', async () => {
  const srv = await server((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/activity+json' }); res.end(Buffer.alloc(1024 * 1024 + 10, 0x20)); return; }
    if (req.url === '/big-declared') { res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) }); res.write('x'); return; }
    if (req.url === '/small') { res.writeHead(200); res.end(Buffer.alloc(500 * 1024, 0x20)); return; }
    if (req.url === '/slow') {
      res.writeHead(200);
      const t = setInterval(() => res.write('x'), 100);
      req.on('close', () => clearInterval(t));
      return;
    }
    res.writeHead(200); res.end('fast');
  });
  try {
    const net = createNet({ allowLoopback: true });
    const base = `http://127.0.0.1:${srv.port}`;
    await assert.rejects(net.fetchGuarded(`${base}/big`, { maxBytes: 1024 * 1024 }), (e) => e.code === 'ERR_TOO_LARGE');
    await assert.rejects(net.fetchGuarded(`${base}/big-declared`, { maxBytes: 1024 * 1024 }), (e) => e.code === 'ERR_TOO_LARGE');
    assert.equal((await net.fetchGuarded(`${base}/small`, { maxBytes: 1024 * 1024 })).body.length, 500 * 1024, 'positive control: under the cap');
    const t0 = Date.now();
    await assert.rejects(net.fetchGuarded(`${base}/slow`, { timeoutMs: 400 }), (e) => e.code === 'ERR_TIMEOUT');
    assert.ok(Date.now() - t0 < 2000, 'the total deadline cuts a body that never ends');
    assert.equal((await net.fetchGuarded(`${base}/fast`, { timeoutMs: 400 })).body.toString(), 'fast', 'positive control');
  } finally { await srv.close(); }
});

test('at most 2 requests at once per host and 8 overall', async () => {
  const gate = createGate();
  const order = [];
  await gate.acquire('a'); await gate.acquire('a');
  const third = gate.acquire('a').then(() => order.push('a3'));
  await gate.acquire('b');
  order.push('b1');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['b1'], 'the third request to one host waits; another host does not');
  gate.release('a');
  await third;
  assert.deepEqual(order, ['b1', 'a3']);
  const g8 = createGate();
  for (let i = 0; i < 8; i++) await g8.acquire(`h${i}`);
  let ninth = false;
  const p = g8.acquire('h9').then(() => { ninth = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ninth, false, 'the ninth waits');
  g8.release('h0');
  await p;
  assert.equal(ninth, true);
});

test('an AP fetch reads only an AP content type, and an actor with an inbox on another host is refused', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol', 'dora'] });
  try {
    const inbox = `${h.base}/users/ana/inbox`;
    const handles = () => h.ctx.follows.load('ana').followers.map((f) => f.handle);
    // The actor served as an HTML page: never parsed, the signature cannot verify.
    m.actorContentType('text/html; charset=utf-8');
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'bob' }), { name: 'bob' })).status, 401);
    await assert.rejects(h.ctx.federation.actors.getDoc(m.actor('bob')), /content type/);
    m.actorContentType('application/ld+json; profile="https://www.w3.org/ns/activitystreams"');
    pastNegativeCache();
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'bob' }), { name: 'bob' })).status, 202, 'positive control: ld+json is an AP type');

    // An inbox, a shared inbox or a key on another host: refused, nothing lands.
    m.patchActor((d, name) => (name === 'carol' ? { ...d, inbox: 'http://127.0.0.1:1/steal' } : d));
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'carol' }), { name: 'carol' })).status, 401);
    m.patchActor((d, name) => (name === 'carol' ? { ...d, endpoints: { sharedInbox: 'http://127.0.0.1:1/steal' } } : d));
    pastNegativeCache();
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'carol' }), { name: 'carol' })).status, 401);
    // An actor whose WebFinger names someone else: the handle cannot bind.
    m.patchActor((d, name) => (name === 'dora' ? { ...d, preferredUsername: 'bob' } : d));
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'dora' }), { name: 'dora' })).status, 401);
    // ... or whose WebFinger answers with another actor (carol's handle is bound to nobody yet).
    assert.equal(h.ctx.federation.actors.idOf(`carol@${m.host}`), '');
    m.patchActor((d, name) => (name === 'dora' ? { ...d, preferredUsername: 'carol' } : d));
    pastNegativeCache();
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'dora' }), { name: 'dora' })).status, 401);
    assert.deepEqual(handles(), [`bob@${m.host}`]);
    m.patchActor((d) => d);
    pastNegativeCache();
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'carol' }), { name: 'carol' })).status, 202, 'positive control: the same actor, inbox at home');
    assert.deepEqual(handles().sort(), [`bob@${m.host}`, `carol@${m.host}`]);
  } finally { await m.close(); await h.close(); }
});

test('a delivery POST never follows a redirect: the job ends, nothing reaches the target', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const { remoteFollow } = require('./helpers/fediverse');
    await remoteFollow(h, c, m);
    m.answer(() => ({ status: 307, headers: { location: `${m.base}/landed` } }));
    await c.ana.post('/api/posts', { kind: 'note', note: 'redirected' });
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.filter((d) => d.body?.type === 'Create').length, 1, 'one POST, the 307 answered');
    assert.ok(!m.gets.some((g) => g.path === '/landed'), 'never followed');
    assert.equal(h.ctx.federation.queue.depth(), 0);
    assert.ok(h.ctx.audit.read().some((r) => r.event === 'delivery_dropped' && r.reason === 'redirect'));
  } finally { await m.close(); await h.close(); }
});
