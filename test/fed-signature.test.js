'use strict';
/* Gate: fed-signature (spec 5.1, 5.2, 16.3). An inbox POST is processed only
 * when its draft-cavage signature verifies against the key of the activity's
 * own actor, fetched and checked through the actor cache. Every refusal sits
 * beside its positive control: the same request, made right, lands.
 *
 * The remote is a fake Mastodon on loopback (test/helpers/fediverse.js) that
 * signs with its OWN signer (not lib/http-sig.js) the way Mastodon 4.x does:
 * (request-target) host date digest content-type, re-signed at test time from
 * the recorded Follow fixture with a fresh key and Date. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const clock = require('../lib/clock');
const { signHeaders, verifyRequest, parseSignature, createReplayGuard } = require('../lib/http-sig');
const { fedRing, fakeMastodon, followFrom, keypair } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());

const followers = (h, name = 'ana') => h.ctx.follows.load(name).followers;

test('a valid Mastodon-style signed Follow is accepted; unsigned, tampered, undigested and mis-dated ones are refused', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    const inbox = `${h.base}/users/ana/inbox`;
    const fresh = () => followFrom(m, `${h.base}/users/ana`);

    // Positive control first: the fixture, re-signed, lands as a follow request.
    let r = await m.post(inbox, fresh());
    assert.equal(r.status, 202, r.text);
    assert.equal(followers(h).length, 1);
    assert.equal(followers(h)[0].handle, `bob@${m.host}`);
    assert.equal(followers(h)[0].state, 'pending');

    const refusedAs = async (opts, why, status = 401) => {
      const f = followFrom(m, `${h.base}/users/ana`, { name: 'carol' });
      const res = await m.post(inbox, opts.activity || f, { name: 'carol', ...opts });
      assert.equal(res.status, status, `${why}: ${res.text}`);
      assert.ok(!followers(h).some((x) => x.handle === `carol@${m.host}`), `${why}: nothing landed`);
    };

    await refusedAs({ unsigned: true }, 'an unsigned POST');
    // A tampered body: the signature and Digest cover one body, another arrives.
    const signedFor = JSON.stringify(followFrom(m, `${h.base}/users/ana`, { name: 'carol' }));
    await refusedAs({ signBody: signedFor }, 'a tampered body (digest mismatch)');
    await refusedAs({ drop: ['digest'] }, 'a missing Digest');
    await refusedAs({ signed: ['host', 'date', 'digest', 'content-type'] }, 'no (request-target) in the signed headers');
    await refusedAs({ signed: ['(request-target)', 'date', 'digest'] }, 'no host in the signed headers');
    await refusedAs({ signed: ['(request-target)', 'host', 'digest'] }, 'no date in the signed headers');
    await refusedAs({ signed: ['(request-target)', 'host', 'date'] }, 'no digest in the signed headers on a POST');
    await refusedAs({ dateMs: clock.now() - 61 * 60_000 }, 'a Date older than an hour');
    await refusedAs({ dateMs: clock.now() + 61 * 60_000 }, 'a Date more than an hour ahead');
    await refusedAs({ privateKey: keypair(5).privateKey }, 'a signature by another key');
    await refusedAs({ headers: { host: 'evil.example' }, signed: ['(request-target)', 'host', 'date', 'digest'] }, 'signed for another host');

    // Positive control for the window edges: 59 minutes either way is accepted.
    r = await m.post(inbox, followFrom(m, `${h.base}/users/ana`, { name: 'carol' }), { name: 'carol', dateMs: clock.now() - 59 * 60_000 });
    assert.equal(r.status, 202, 'a Date 59 minutes old is inside the window');
    assert.ok(followers(h).some((x) => x.handle === `carol@${m.host}`));
  } finally { await m.close(); await h.close(); }
});

test('an unknown algorithm is refused; hs2019 with an RSA key is accepted', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const inbox = `${h.base}/users/ana/inbox`;
    const send = async (algorithm) => {
      const f = followFrom(m, `${h.base}/users/ana`);
      const body = JSON.stringify(f);
      const { sign } = require('./helpers/fediverse');
      const hd = sign({ method: 'POST', url: inbox, body, keyId: m.keyId(), privateKey: m.keys.bob.privateKey, headers: { 'content-type': 'application/activity+json' } });
      hd.signature = hd.signature.replace('algorithm="rsa-sha256"', `algorithm="${algorithm}"`);
      delete hd.host;
      return (await fetch(inbox, { method: 'POST', headers: hd, body })).status;
    };
    assert.equal(await send('hmac-sha256'), 401, 'an unknown algorithm');
    assert.equal(followers(h).length, 0);
    assert.equal(await send('hs2019'), 202, 'positive control: hs2019 over an RSA key');
    assert.equal(followers(h).length, 1);
  } finally { await m.close(); await h.close(); }
});

test('a replayed signature inside the window is refused; the same activity re-signed applies once', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const inbox = `${h.base}/users/ana/inbox`;
    const f = followFrom(m, `${h.base}/users/ana`);
    const body = JSON.stringify(f);
    const { sign } = require('./helpers/fediverse');
    const hd = sign({ method: 'POST', url: inbox, body, keyId: m.keyId(), privateKey: m.keys.bob.privateKey, headers: { 'content-type': 'application/activity+json' } });
    delete hd.host;
    assert.equal((await fetch(inbox, { method: 'POST', headers: hd, body })).status, 202);
    assert.equal((await fetch(inbox, { method: 'POST', headers: hd, body })).status, 401, 'the very same signature again');
    // The same activity, freshly signed (a sender's retry): 202, applied once.
    h.ctx.follows.load('ana');
    const before = JSON.stringify(followers(h));
    const again = await m.post(inbox, f, { dateMs: clock.now() + 1000 });
    assert.equal(again.status, 202);
    assert.equal(JSON.stringify(followers(h)), before, 'deduplicated by activity id');
    assert.equal(h.ctx.federation.seen.has(f.id), true);
  } finally { await m.close(); await h.close(); }
});

test('the actor must be the key owner: a forwarded activity is processed only from its origin fetch', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    const inbox = `${h.base}/users/ana/inbox`;
    // bob signs a Follow whose actor is carol: the body is never trusted, and its
    // id answers nothing on carol's host, so nothing lands.
    const forged = followFrom(m, `${h.base}/users/ana`, { name: 'carol' });
    let r = await m.post(inbox, forged, { name: 'bob' });
    assert.equal(r.status, 202);
    assert.equal(followers(h).length, 0, 'a key owner that is not the actor: nothing processed');

    // Positive control: the same forward, but carol's server serves the activity
    // at its id. That copy, fetched from its own host, is what lands.
    const real = followFrom(m, `${h.base}/users/ana`, { name: 'carol' });
    m.serve(new URL(real.id).pathname, real);
    r = await m.post(inbox, { ...real, object: `${h.base}/users/nobody` }, { name: 'bob' });
    assert.equal(r.status, 202);
    assert.deepEqual(followers(h).map((x) => x.handle), [`carol@${m.host}`], 'the origin copy (to ana), not the forwarded body');
  } finally { await m.close(); await h.close(); }
});

test('a rotated key: one refetch, then accepted; a second rotation inside 10 minutes waits', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const inbox = `${h.base}/users/ana/inbox`;
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`))).status, 202);
    const cachedPem = h.ctx.federation.actors.get(m.actor()).key_pem;
    m.rotateKey('bob', 8);
    const r = await m.post(inbox, followFrom(m, `${h.base}/users/ana`));
    assert.equal(r.status, 202, 'the cached key fails, the actor is refetched once, the new key verifies');
    assert.notEqual(h.ctx.federation.actors.get(m.actor()).key_pem, cachedPem);
    m.rotateKey('bob', 9);
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`))).status, 401, 'a second refetch inside 10 minutes is not made');
    clock.advance(11 * 60_000);
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`))).status, 202, 'positive control: after 10 minutes it is');
  } finally { await m.close(); await h.close(); }
});

test('signed GETs (authorized fetch): unsigned 401, signed 200, tampered 401', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const url = `${h.base}/users/ana/outbox`;
    assert.equal((await m.get(url, { unsigned: true })).status, 401);
    const ok = await m.get(url);
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.headers.get('cache-control'), /private/, 'a signed answer is private');
    const { sign } = require('./helpers/fediverse');
    const hd = sign({ method: 'GET', url: `${h.base}/users/ana/featured`, keyId: m.keyId(), privateKey: m.keys.bob.privateKey, headers: { accept: 'application/activity+json' } });
    delete hd.host;
    assert.equal((await fetch(url, { headers: hd })).status, 401, 'a signature for another path');
    // Two honest fetches of one URL in one second carry the same (deterministic
    // RSA) signature: a GET is not refused as a replay.
    const { sign: s2 } = require('./helpers/fediverse');
    const same = s2({ method: 'GET', url, keyId: m.keyId(), privateKey: m.keys.bob.privateKey, headers: { accept: 'application/activity+json' } });
    delete same.host;
    assert.equal((await fetch(url, { headers: same })).status, 200);
    assert.equal((await fetch(url, { headers: same })).status, 200, 'the same signed GET twice');
  } finally { await m.close(); await h.close(); }
});

test('lib/http-sig.js on its own: what it signs, it verifies; each signed part matters', async () => {
  const { publicKey, privateKey } = keypair(0);
  const url = new URL('https://ring.example/users/ana/inbox');
  const body = '{"type":"Follow"}';
  const t = Date.parse('2026-10-15T12:00:00Z');
  const add = signHeaders({ method: 'POST', url, headers: { 'content-type': 'application/activity+json' }, body, keyId: 'https://m.example/users/bob#main-key', privateKey, nowMs: t });
  assert.deepEqual(parseSignature(add.signature).headers, ['(request-target)', 'host', 'date', 'digest']);
  const headers = { ...add, 'content-type': 'application/activity+json' };
  const getKey = async () => ({ pem: publicKey, owner: 'https://m.example/users/bob' });
  const req = (over = {}) => ({ method: 'POST', path: '/users/ana/inbox', headers, body: Buffer.from(body), ...over });
  const ok = await verifyRequest(req(), { host: 'ring.example', getKey, nowMs: t });
  assert.equal(ok.ok, true, 'positive control');
  assert.equal((await verifyRequest(req({ path: '/users/bram/inbox' }), { host: 'ring.example', getKey, nowMs: t })).reason, 'signature');
  assert.equal((await verifyRequest(req({ body: Buffer.from(`${body} `) }), { host: 'ring.example', getKey, nowMs: t })).reason, 'digest');
  assert.equal((await verifyRequest(req(), { host: 'other.example', getKey, nowMs: t })).reason, 'host');
  assert.equal((await verifyRequest(req(), { host: 'ring.example', getKey, nowMs: t + 3601_000 })).reason, 'date');
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.equal((await verifyRequest(req(), { host: 'ring.example', getKey: async () => ({ pem: other.publicKey, owner: 'x' }), nowMs: t })).reason, 'key', 'only an RSA key');
  const replay = createReplayGuard({ now: () => t });
  assert.equal((await verifyRequest(req(), { host: 'ring.example', getKey, replay, nowMs: t })).ok, true);
  assert.equal((await verifyRequest(req(), { host: 'ring.example', getKey, replay, nowMs: t })).reason, 'replay');
});

test('the inbox door: content type, the 256 KB cap, an unknown member, and the budgets of 5.9', async () => {
  const { crowd } = require('./helpers/social');
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1 });
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const inbox = `${h.base}/users/ana/inbox`;
    let r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 400, 'not an activity media type');
    r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: 'x'.repeat(257 * 1024) });
    assert.equal(r.status, 413, 'over 256 KB');
    r = await m.post(`${h.base}/users/nobody/inbox`, followFrom(m, `${h.base}/users/nobody`));
    assert.equal(r.status, 404, 'no such member');
    // Inbox POSTs: 120 a minute per remote host (the VERIFIED signer's host).
    let last = null;
    for (let i = 0; i < 121; i++) last = await m.post(inbox, followFrom(m, `${h.base}/users/ana`));
    assert.equal(last.status, 429, 'the 121st POST from one host in a minute');
    clock.advance(61_000);
    assert.equal((await m.post(inbox, followFrom(m, `${h.base}/users/ana`))).status, 202, 'positive control: a minute later');
    // Unsigned GETs (actor, WebFinger, NodeInfo): 60 a minute per client.
    let g = null;
    for (let i = 0; i < 61; i++) g = await fetch(`${h.base}/users/ana`, { headers: { accept: 'application/activity+json' } });
    assert.equal(g.status, 429);
    assert.ok(Number(g.headers.get('retry-after')) > 0);
  } finally { await m.close(); await h.close(); }
});
