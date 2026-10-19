'use strict';
/* THE host normalizer (P8 review F4; spec 5.6, 6.1, 6.3, 6.5, 16.3):
 * lib/handles.js canonHost is the one spelling of a host (lowercase, ONE
 * trailing dot stripped, IDN to ASCII, IP literals in URL's form, empty labels
 * refused), and every door reads a host through it before it compares or
 * fetches: the admin's domain blocks (hostBlocked), a member's (blocksHandle),
 * the federation and actor code's hostOf, the fetcher's refuse check and
 * BLOCKED_DOMAINS. Here the block is spelled with a trailing dot, in capitals
 * and in Unicode, and the remote is reached as `localhost.` (a trailing dot)
 * and as `bücher.localhost` (punycode), at every door: the signed GET, the
 * inbox POST before any key fetch, the lookup, the media cache and delivery;
 * for a member's domain block the signed GET, the inbox, the lookup and
 * delivery (a member's block has no media door: the cache is the server's).
 * The proof that a block is what refused: the fake's own request log (`gets`,
 * `deliveries`), counted before and after; and the same door open without
 * the block (each positive control). */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/handles');
const { suffixes } = require('../lib/moderation');
const { loadConfig } = require('../lib/config');
const { normalizePage } = require('../lib/ring');
const { createNet } = require('../lib/net');
const { fedRing, fakeMastodon, activityFrom, followFrom, remoteFollow, noteFrom } = require('./helpers/fediverse');
const images = require('./helpers/images');

const IDN = 'xn--bcher-kva.localhost';   // bücher.localhost: loopback under the test hook
const enc = encodeURIComponent;

test('canonHost: case, one trailing dot, IDN, IP literal forms; empty labels and junk refused', () => {
  const t = {
    'Evil.Example.': 'evil.example', 'evil.example:8443': 'evil.example:8443', 'EVIL.example.:8443': 'evil.example:8443',
    'BÜCHER.localhost.': IDN, 'bücher.example': 'xn--bcher-kva.example', '0x7f.1': '127.0.0.1', '1.2.3.4.': '1.2.3.4',
    '2001:DB8::1': '[2001:db8::1]', '[2001:db8:0:0::1]:443': '[2001:db8::1]:443',
    'evil.example..': '', 'a..b': '', '.a.b': '', '*.x.example': '', 'a b.example': '', 'x.example:99999': '', 'a.123': '', '': '',
  };
  for (const [raw, want] of Object.entries(t)) assert.equal(H.canonHost(raw), want, raw);
  assert.equal(H.hostOfUrl('https://Evil.Example.:8443/x'), 'evil.example:8443');
  assert.equal(H.hostUnder('s1.EVIL.example.', 'Evil.Example.'), true);
  assert.equal(H.hostUnder('notevil.example', 'evil.example'), false, 'a suffix that is not a label');
  assert.equal(H.toHandle('bob@Evil.Example.', 'ring.example'), 'bob@evil.example', 'a handle is spelled the one way');
  assert.deepEqual(suffixes('A.Evil.Example.'), ['a.evil.example', 'evil.example', 'example']);
  assert.deepEqual(suffixes('192.0.2.7:80'), ['192.0.2.7:80', '192.0.2.7'], 'an IP literal is only itself');
  // BLOCKED_DOMAINS takes the same spellings (and an address).
  const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(40), BLOCKED_DOMAINS: 'Evil.Example.,BÜCHER.example,192.0.2.7', DATA_DIR: '/nonexistent-ring-test' });
  assert.deepEqual([...cfg.blockedDomains], ['evil.example', 'xn--bcher-kva.example', '192.0.2.7']);
  // A member's list, hand-edited, is read the one way too (what it refuses is dropped).
  assert.deepEqual(normalizePage({ blocked_domains: ['Evil.Example.', 'BÜCHER.example', 'a..b', '2001:DB8::1'] }).blocked_domains, ['evil.example', 'xn--bcher-kva.example', '[2001:db8::1]']);
});

test('an admin block spelled `LocalHost.` refuses `localhost.` at every door, before anything is asked of it', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const dotted = await fakeMastodon({ users: ['bob'], hostname: 'localhost.', instanceActor: true, keyIndex: 3 });
  try {
    const outbox = `${h.base}/users/ana/outbox`;
    // Positive control: unblocked, a signed GET from it makes this server ask it for the key.
    let before = dotted.gets.length;
    await dotted.get(outbox, { instance: true });
    assert.ok(dotted.gets.length > before, 'unblocked, it is asked');
    assert.ok(dotted.gets.slice(before).every((g) => g.headers.host === dotted.host.replace('.:', ':')), 'by the name without its dot: the name checked is the name asked');
    // The fetcher's own check sees THE normalizer's name (a refuse rule that
    // knows only `localhost:<port>` refuses `LOCALHOST.:<port>`), and a host
    // with an empty label is never asked.
    const port = dotted.host.split(':')[1];
    const strict = createNet({ allowLoopback: true, refuseHost: (x) => x === `localhost:${port}` });
    before = dotted.gets.length;
    await assert.rejects(strict.fetchGuarded(`http://LOCALHOST.:${port}/users/bob`), (e) => e.code === 'ERR_BLOCKED');
    await assert.rejects(strict.fetchGuarded(`http://localhost..:${port}/users/bob`), (e) => e.code === 'ERR_PUBLIC_URL_REQUIRED');
    assert.equal(dotted.gets.length, before, 'neither was asked');
    const blk = await c.ada.post('/api/admin/domain-blocks', { host: 'LocalHost.', reason: 'spelled oddly' });
    assert.equal(blk.status, 201, blk.text);
    assert.equal(blk.body.host, 'localhost');
    assert.equal(h.ctx.moderation.hostBlocked(dotted.host), true);
    // the signed GET
    before = dotted.gets.length;
    const g = await dotted.get(outbox, { instance: true });
    assert.equal(g.status, 403);
    // the inbox POST, before any key fetch
    const p = await dotted.post(`${h.base}/inbox`, activityFrom(dotted, 'Flag', { object: [`${h.base}/users/ana`] }));
    assert.equal(p.status, 403);
    // the lookup, by URL and by handle
    const l1 = await c.ana.get(`/api/lookup?q=${enc(`${dotted.base}/users/bob`)}`);
    const l2 = await c.ana.get(`/api/lookup?q=${enc(`bob@${dotted.host}`)}`);
    assert.equal(l1.status, 404);
    assert.equal(l2.status, 404);
    // the media cache
    dotted.serve('/img.png', await images.png(), { type: 'image/png' });
    const id = h.ctx.federation.media.want(`${dotted.base}/img.png`);
    assert.equal((await c.ana.get(`/media/${id}/web`)).status, 404);
    assert.equal(dotted.gets.length, before, 'nothing was asked of it at any of those doors');
    // delivery: the fetcher refuses the socket
    await assert.rejects(h.ctx.federation.net.fetchGuarded(`${dotted.base}/inbox`, { method: 'POST', body: '{}' }), (e) => e.code === 'ERR_BLOCKED');
    assert.equal(dotted.deliveries.length, 0);
    assert.equal(h.ctx.federation.queue.list().length, 0);
  } finally { await dotted.close(); await h.close(); }
});

test('an admin block spelled in Unicode capitals (`BÜCHER.LOCALHOST.`) refuses its punycode host at every door; unblocked, each door is open', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const m = await fakeMastodon({ users: ['bob'], hostname: IDN, keyIndex: 5 });
  try {
    const outbox = `${h.base}/users/ana/outbox`;
    m.serve('/img.png', await images.png(), { type: 'image/png' });
    // Positive controls, unblocked: each door is open.
    assert.equal((await m.get(outbox)).status, 200, 'the signed GET');
    await remoteFollow(h, c, m, 'ana');   // the inbox, and a follower to deliver to
    assert.equal((await c.ana.get(`/api/lookup?q=${enc(`bob@${m.host}`)}`)).status, 200, 'the lookup');
    const id = h.ctx.federation.media.want(`${m.base}/img.png`);
    assert.equal((await c.ana.get(`/media/${id}/web`)).status, 200, 'the media cache');
    const p1 = (await c.ana.post('/api/posts', { kind: 'note', note: 'before the block' })).body;
    await h.ctx.federation.queue.drain();
    assert.ok(m.deliveries.some((d) => d.raw.includes(p1.id)), 'delivery');

    const blk = await c.ada.post('/api/admin/domain-blocks', { host: 'BÜCHER.LOCALHOST.' });
    assert.equal(blk.status, 201, blk.text);
    assert.equal(blk.body.host, IDN, 'stored in punycode');
    const gets = m.gets.length;
    const dels = m.deliveries.length;
    assert.equal((await m.get(outbox)).status, 403, 'the signed GET');
    const f = followFrom(m, `${h.base}/users/ana`);
    assert.equal((await m.post(`${h.base}/users/ana/inbox`, f)).status, 403, 'the inbox, before any key fetch');
    assert.equal((await c.ana.get(`/api/lookup?q=${enc(`bob@${m.host}`)}`)).status, 404, 'the lookup');
    const id2 = h.ctx.federation.media.want(`${m.base}/img.png?again`);
    assert.equal((await c.ana.get(`/media/${id2}/web`)).status, 404, 'the media cache');
    assert.equal((await c.ana.get(`/media/${id}/web`)).status, 404, 'its cached media went with the block');
    const p2 = (await c.ana.post('/api/posts', { kind: 'note', note: 'after the block' })).body;
    await h.ctx.federation.queue.drain();
    assert.ok(!m.deliveries.slice(dels).some((d) => d.raw.includes(p2.id)), 'delivery');
    assert.equal(m.gets.length, gets, 'nothing was asked of it');
    assert.equal(m.deliveries.length, dels, 'nothing was sent to it');
  } finally { await m.close(); await h.close(); }
});

test('a member\'s domain block spelled `LOCALHOST.` or `Bücher.Localhost.` holds at their doors: signed GET, inbox, lookup, delivery', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const plain = await fakeMastodon({ users: ['bob'], hostname: 'localhost', keyIndex: 7 });
  const idn = await fakeMastodon({ users: ['eve'], hostname: IDN, keyIndex: 9 });
  try {
    const outboxOf = (n) => `${h.base}/users/${n}/outbox`;
    // Positive controls before ana's blocks: both read her outbox, follow her, and get her posts.
    for (const [fake, as] of [[plain, 'bob'], [idn, 'eve']]) {
      assert.equal((await fake.get(outboxOf('ana'), { name: as })).status, 200);
      await remoteFollow(h, c, fake, 'ana', { as });
    }
    const p1 = (await c.ana.post('/api/posts', { kind: 'note', note: 'before her blocks' })).body;
    await h.ctx.federation.queue.drain();
    for (const fake of [plain, idn]) assert.ok(fake.deliveries.some((d) => d.raw.includes(p1.id)), `delivered to ${fake.host}`);

    for (const d of ['LOCALHOST.', 'Bücher.Localhost.']) {
      const r = await c.ana.put('/api/me/page', { block_domain: d });
      assert.equal(r.status, 200, r.text);
    }
    assert.deepEqual(h.ctx.pages.settings('ana').blocked_domains, ['localhost', IDN], 'stored the one way');
    for (const [fake, as] of [[plain, 'bob'], [idn, 'eve']]) {
      // signed GET: the stranger's 404 for ana, while ada's stays open
      assert.equal((await fake.get(outboxOf('ana'), { name: as })).status, 404, `${fake.host}: ana's outbox`);
      assert.equal((await fake.get(outboxOf('ada'), { name: as })).status, 200, `${fake.host}: ada's (positive control)`);
      // inbox: a Follow of ana is dropped silently, ada's lands
      await fake.post(`${h.base}/users/ana/inbox`, followFrom(fake, `${h.base}/users/ana`, { name: as }), { name: as });
      await fake.post(`${h.base}/users/ada/inbox`, followFrom(fake, `${h.base}/users/ada`, { name: as }), { name: as });
      assert.equal((await c.ana.get('/api/followers')).body.requests.some((x) => x.handle === `${as}@${fake.host}`), false, `${fake.host}: no request for ana`);
      assert.equal((await c.ada.get('/api/followers')).body.requests.some((x) => x.handle === `${as}@${fake.host}`), true, `${fake.host}: ada's request (positive control)`);
      // lookup: ana's 404 asks the host nothing, ada's finds them
      const before = fake.gets.length;
      assert.equal((await c.ana.get(`/api/lookup?q=${enc(fake.actor(as))}`)).status, 404, `${fake.host}: ana's lookup`);
      assert.equal(fake.gets.length, before, `${fake.host}: nothing asked for ana's lookup`);
      assert.equal((await c.ada.get(`/api/lookup?q=${enc(fake.actor(as))}`)).status, 200, `${fake.host}: ada's lookup (positive control)`);
    }
    // delivery: nothing of ana's reaches either
    const dels = [plain.deliveries.length, idn.deliveries.length];
    const p2 = (await c.ana.post('/api/posts', { kind: 'note', note: 'after her blocks' })).body;
    await h.ctx.federation.queue.drain();
    assert.ok(!plain.deliveries.slice(dels[0]).some((d) => d.raw.includes(p2.id)));
    assert.ok(!idn.deliveries.slice(dels[1]).some((d) => d.raw.includes(p2.id)));
    // A note from either on ana's post: refused or dropped, never kept.
    const { create } = noteFrom(plain, { text: 'hi ana', inReplyTo: `${h.base}/users/ana/posts/${p1.id}` });
    await plain.post(`${h.base}/users/ana/inbox`, create);
    assert.equal(h.ctx.reactions.loadComments('ana').length, 0);
  } finally { await plain.close(); await idn.close(); await h.close(); }
});
