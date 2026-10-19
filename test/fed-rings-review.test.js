'use strict';
/* fed-rings-review (spec 16.3; the P7 review, F1 to F7): each finding's proof,
 * kept as a gate. A Ring server under test (in this process) and loopback
 * fakes: a HOSTILE home (a fake that answers as a Ring server and serves a
 * Group with its own key), a hostile member server, a foreign image host.
 *   F1  a home names no one here by itself: a member here who never asked is
 *       never seated (nor made to Leave), seats capped at 6
 *   F2  the authority takes no reaction on the Group's word: an Announced Like
 *       "by" a ring-mate changes nothing on the post's own server; the same
 *       Like signed by its reactor and sent to the author lands
 *   F3  a join link's hosts are host names only (6, 255 chars), a members
 *       view's join link is http(s) at the join path, and an ask row is small
 *   F4  the block wins wherever this server answers: a blocked ring-mate's
 *       signed GET of the room image and the room post is a 404 under both
 *       AUTHORIZED_FETCH modes, and the Group sends the author's room posts
 *       to no server whose ring members the author all blocks (but does to
 *       one that also holds an unblocked member: the documented limit)
 *   F5  the test IPC hook exists only on a loopback test server, and a clock
 *       move is a finite number within a year
 *   F6  a copy's image: from its author's host only, an id of its ring, the
 *       fetch signed as a member of THAT ring while a copy there names it
 *   F7  the room store: one file per copy, a stamp or a find reads one file,
 *       mediaIds reads none (counted, never timed); per-author caps
 * Each rule's positive control (the rule broken, this suite red, the file
 * restored byte for byte) is listed in docs/SPEC.md 16.3. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clock = require('../lib/clock');
const { fedRing, fakeMastodon, keypair, until } = require('./helpers/fediverse');
const { png } = require('./helpers/images');
const { freePort, SECRET } = require('./helpers/harness');

const enc = encodeURIComponent;
const AS = 'https://www.w3.org/ns/activitystreams';
const WEEK = 7 * 24 * 3600_000;
const ringNodeinfo = { version: '2.0', software: { name: 'ring', version: '0.1.0' }, protocols: ['activitypub'], services: { inbound: [], outbound: [] }, openRegistrations: false, usage: { users: {} }, metadata: { ringProtocol: 1 } };

test.afterEach(() => clock.reset());

/* A hostile HOME: a fake that declares ringProtocol and serves a Group (its
 * own key) at a join link and at its id, and posts as that Group. */
async function evilHome({ users = ['mallory'], keyIndex = 0, hosts } = {}) {
  const M = await fakeMastodon({ users, keyIndex });
  M.serve('/nodeinfo/2.0', ringNodeinfo);
  const gid = `ring_${crypto.randomBytes(10).toString('hex')}`;
  const G = `${M.base}/rings/${gid}`;
  const gkey = keypair(keyIndex + users.length + 1);
  const code = crypto.randomBytes(20).toString('base64url');
  const joinUrl = `${M.base}/rings/join/${code}`;
  let rev = 1;
  const state = { members: [{ actor: M.actor(users[0]), joined_at: new Date(clock.now()).toISOString() }], requests: [], extra: {} };
  const doc = (view) => {
    const g = {
      '@context': [AS, 'https://w3id.org/security/v1'], id: G, type: 'Group', name: 'Evil ring', attributedTo: M.actor(users[0]),
      inbox: `${M.base}/inbox`, outbox: `${G}/outbox`, followers: `${G}/members`,
      publicKey: { id: `${G}#main-key`, owner: G, publicKeyPem: gkey.publicKey },
      ring: { v: 1, rev, capacity: 6, hosts: hosts || [M.host] },
    };
    if (view === 'members') Object.assign(g.ring, { members: state.members, requests: state.requests }, state.extra);
    return g;
  };
  const refresh = () => { M.serve(`/rings/join/${code}`, doc('asker')); M.serve(`/rings/${gid}`, doc('members')); };
  refresh();
  let n = 0;
  return {
    M, G, gid, code, joinUrl, state, doc,
    setRev(v) { rev = v; refresh(); },
    nextId: () => `${G}/activities/${crypto.randomBytes(6).toString('hex')}-${++n}`,
    gpost: (url, activity) => M.post(url, { '@context': AS, ...activity }, { keyId: `${G}#main-key`, privateKey: gkey.privateKey }),
  };
}

/* `who` (a member of T) asks by E's link, and E admits them. -> their replica. */
async function admitAt(T, client, who, E) {
  const r = await client.post('/api/rings/join', { url: E.joinUrl });
  assert.equal(r.status, 200, r.text);
  const ask = await until(() => T.ctx.ringFed.loadAsks().find((a) => a.member === who && a.group === E.G), { what: `${who}'s ask` });
  const actor = `${T.base}/users/${who}`;
  E.state.members.push({ actor, joined_at: new Date(clock.now()).toISOString() });
  E.setRev(E.doc('members').ring.rev + 1);
  const a = await E.gpost(`${T.base}/users/${who}/inbox`, { id: E.nextId(), type: 'Accept', actor: E.G, to: [actor], object: { id: ask.join_id, type: 'Join', actor, object: E.G } });
  assert.equal(a.status, 202);
  return until(async () => (await client.get('/api/rings')).body.rings.find((x) => !x.home), { what: `${who}'s replica` });
}

test('F1, F2: a home names no one here by itself, and the post\'s own server takes no reaction on the Group\'s word', { timeout: 60_000 }, async () => {
  const { h: T, c } = await fedRing(['alice', 'bob', 'carol']);
  const E = await evilHome({ users: ['mallory', 'sam', 'm3', 'm4', 'm5', 'm6'] });
  try {
    const actor = (n) => `${T.base}/users/${n}`;
    const onRing = await admitAt(T, c.alice, 'alice', E);
    assert.ok(onRing.members.some((m) => m.handle === 'alice'), 'positive control: one who asked is seated');
    // carol is at her own cap (3 rings) and never asked this Group.
    for (const n of ['one', 'two', 'three']) assert.equal((await c.carol.post('/api/rings', { name: n })).status, 201);
    // ── F1: an Update{Group} listing bob and carol (never asked) and 5 more
    //    remote members than seats ──
    E.state.members.push(
      { actor: actor('bob'), joined_at: new Date(clock.now()).toISOString() },
      { actor: actor('carol'), joined_at: new Date(clock.now()).toISOString() },
      ...['sam', 'm3', 'm4', 'm5', 'm6'].map((u) => ({ actor: E.M.actor(u), joined_at: new Date(clock.now()).toISOString() })),
    );
    E.state.requests.push({ actor: actor('bob'), asked_at: new Date(clock.now()).toISOString(), join: `${T.base}/users/bob/activities/x` });
    E.setRev(10);
    assert.equal((await E.gpost(`${T.base}/users/alice/inbox`, { id: E.nextId(), type: 'Update', actor: E.G, to: [actor('alice')], object: E.doc('members') })).status, 202);
    const replica = await until(async () => {
      const x = (await c.alice.get('/api/rings')).body.rings.find((y) => !y.home);
      return x?.rev === 10 ? x : null;
    }, { what: 'the rev 10 replica' });
    const handles = replica.members.map((m) => m.handle);
    assert.ok(handles.includes('alice'), 'alice stays: she was in it');
    assert.ok(!handles.includes('bob') && !replica.requests.some((q) => q.handle === 'bob'), 'bob never asked: never seated, never asking');
    assert.ok(!handles.includes('carol'), 'nor carol');
    assert.ok(handles.length <= 6, `six seats at most (${handles.length})`);
    assert.equal((await c.bob.get('/api/rings')).body.rings.length, 0, 'bob sees no ring');
    assert.equal((await c.carol.get('/api/rings')).body.rings.length, 3, 'carol keeps her three');
    await T.ctx.federation.queue.drain();
    assert.ok(!E.M.deliveries.some((d) => d.body?.type === 'Leave'), 'nobody here was made to Leave');

    // ── F2: alice's room post; the Group Announces a Like "by" sam, a member ──
    let r = await c.alice.post('/api/posts', { kind: 'note', note: 'for the room', audience: replica.id });
    assert.equal(r.status, 201, r.text);
    const postUrl = `${T.base}/users/alice/posts/${r.body.id}`;
    const samActor = E.M.actor('sam');
    const like = (face) => ({ id: `${samActor}/stamps/stmp_${crypto.randomBytes(5).toString('hex')}`, type: 'Like', actor: samActor, object: postUrl, to: [E.G], audience: E.G, content: face, ring: { v: 1, face, custom: true } });
    r = await E.gpost(`${T.base}/users/alice/inbox`, { id: E.nextId(), type: 'Announce', actor: E.G, to: [actor('alice')], audience: E.G, object: like('FORGED') });
    assert.equal(r.status, 202);
    assert.deepEqual(T.ctx.reactions.loadStamps('alice'), [], 'an Announced reaction never lands on the authority');
    // Positive control: the same Like signed by sam and sent to alice lands.
    r = await E.M.post(`${T.base}/users/alice/inbox`, { '@context': AS, ...like('by sam') }, { name: 'sam' });
    assert.equal(r.status, 202);
    const stamps = await until(() => { const s = T.ctx.reactions.loadStamps('alice'); return s.length ? s : null; }, { what: 'sam\'s own Like' });
    assert.deepEqual(stamps.map((s) => [s.author, s.kaomoji]), [[`sam@${E.M.host}`, 'by sam']]);
  } finally {
    await E.M.close();
    await T.close();
  }
});

test('F3: a join link\'s hosts are host names, its members view\'s link is a join link, and an ask row stays small', { timeout: 60_000 }, async () => {
  const { h: T, c } = await fedRing(['alice']);
  const big = 'h'.repeat(150_000);
  const E = await evilHome({ hosts: ['mastodon.social', 'your-own-server.example (verified)', '<img src=x onerror=alert(1)>', `${big}1`, `${'a'.repeat(250)}.example`, 'MASTODON.social', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example', 'g.example'] });
  try {
    let r = await c.alice.get(`/api/lookup?q=${enc(E.joinUrl)}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.hosts, ['mastodon.social', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example'], 'host names only, at most six');
    const replica = await admitAt(T, c.alice, 'alice', E);
    assert.ok(replica);
    // The ask row was small while it lived (read back from the file).
    r = await c.alice.post('/api/rings', { name: 'mine' });
    const E2 = await evilHome({ keyIndex: 3, hosts: [`${big}x`, `${big}y`] });
    try {
      assert.equal((await c.alice.get(`/api/lookup?q=${enc(E2.joinUrl)}`)).body.hosts.join(), E2.M.host, 'nothing usable: the link\'s own host');
      assert.equal((await c.alice.post('/api/rings/join', { url: E2.joinUrl })).status, 200);
      const bytes = fs.statSync(T.ctx.paths.fedRingAsks).size;
      assert.ok(bytes < 2000, `an ask row is a few hundred bytes (${bytes})`);
      // A hand-written oversized row is settled away, never served whole.
      const rows = JSON.parse(fs.readFileSync(T.ctx.paths.fedRingAsks, 'utf8'));
      rows.push({ ...rows[0], group: `${E2.G}x`, join_id: `${E2.G}/j`, hosts: [big, 'ok.example'], name: big });
      fs.writeFileSync(T.ctx.paths.fedRingAsks, JSON.stringify(rows));
      const settled = T.ctx.ringFed.loadAsks().find((a) => a.group === `${E2.G}x`);
      assert.deepEqual(settled.hosts, ['ok.example']);
      assert.ok(settled.name.length <= 60, 'the name is a ring name');
    } finally { await E2.M.close(); }
    // ── a members view's join link: http(s), the Group's host, the join path ──
    const actor = `${T.base}/users/alice`;
    const update = async (rev, joinUrl) => {
      E.state.extra = { join_url: joinUrl, join_expires: new Date(clock.now() + WEEK).toISOString() };
      E.setRev(rev);
      assert.equal((await E.gpost(`${actor}/inbox`, { id: E.nextId(), type: 'Update', actor: E.G, to: [actor], object: E.doc('members') })).status, 202);
      return until(async () => {
        const x = (await c.alice.get('/api/rings')).body.rings.find((y) => !y.home);
        return x?.rev === rev ? T.ctx.ringStore.get(x.id) : null;
      }, { what: `rev ${rev}` });
    };
    for (const [rev, bad] of [[20, `javascript:alert(1)//${E.M.host}/rings/join/abcdefghij`], [21, `${E.M.base}/rings/join/abcdefghij?x=<b>`], [22, `${E.M.base}/elsewhere/abcdefghij`], [23, `https://other.example/rings/join/abcdefghij`]]) {
      assert.equal((await update(rev, bad)).join_url, '', `refused: ${bad}`);
    }
    assert.equal((await update(24, `${E.M.base}/rings/join/abcdefghijk`)).join_url, `${E.M.base}/rings/join/abcdefghijk`, 'positive control: a join link is kept');
  } finally {
    await E.M.close();
    await T.close();
  }
});

for (const AF of ['1', '0']) {
  test(`F4: the block wins wherever this server answers (AUTHORIZED_FETCH=${AF})`, { timeout: 60_000 }, async () => {
    const { h: A, c } = await fedRing(['alice'], { env: { AUTHORIZED_FETCH: AF } });
    const M = await fakeMastodon({ users: ['mallory', 'mo'] });
    M.serve('/nodeinfo/2.0', ringNodeinfo);
    try {
      let r = await c.alice.post('/api/rings', { name: 'Room' });
      const ringId = r.body.id;
      const code = r.body.join.code;
      const G = `${A.base}/rings/${ringId}`;
      const admit = async (name) => {
        r = await M.post(`${G}/inbox`, { '@context': AS, id: `${M.base}/activities/j${crypto.randomBytes(4).toString('hex')}`, type: 'Join', actor: M.actor(name), object: G, to: [G], ring: { v: 1, code } }, { name });
        assert.equal(r.status, 202);
        const handle = `${name}@${M.host}`;
        await until(async () => (await c.alice.get('/api/rings')).body.rings[0].requests.some((q) => q.handle === handle), { what: `${name}'s request` });
        assert.equal((await c.alice.post(`/api/rings/${ringId}/requests/${enc(handle)}`, { approve: true })).status, 200);
        return handle;
      };
      const mallory = await admit('mallory');
      const roomPost = async (note) => {
        const up = await c.alice.upload(await png(40, 30), { filename: 'x.png', type: 'image/png' });
        const p = await c.alice.post('/api/posts', { kind: 'image', note, audience: ringId, media: { key: up.body.key, alt: 'a' } });
        assert.equal(p.status, 201, p.text);
        await A.ctx.federation.queue.drain();
        return { id: p.body.id, key: up.body.key };
      };
      const announced = (id) => M.deliveries.filter((d) => d.body?.type === 'Announce' && d.raw.includes(id)).length;
      // Positive control: before the block, she reads the room and gets its posts.
      const before = await roomPost('before the block');
      assert.equal(announced(before.id), 1, 'a member\'s server gets the room post');
      assert.equal((await M.get(`${A.base}/api/images/${before.key}/web`, { name: 'mallory' })).status, 200);
      assert.equal((await M.get(`${A.base}/users/alice/posts/${before.id}`, { name: 'mallory' })).status, 200);
      // alice blocks mallory, her ring-mate.
      assert.equal((await c.alice.put('/api/me/page', { block: mallory })).status, 200);
      const after = await roomPost('after the block');
      assert.equal(announced(after.id), 0, 'the Group sends the author\'s posts to no server whose members she all blocks');
      assert.equal((await M.get(`${A.base}/api/images/${after.key}/web`, { name: 'mallory' })).status, 404, 'the room image: 404 to the blocked');
      assert.equal((await M.get(`${A.base}/api/images/${before.key}/web`, { name: 'mallory' })).status, 404, 'an older one too');
      assert.equal((await M.get(`${A.base}/users/alice/posts/${after.id}`, { name: 'mallory' })).status, 404, 'the room post: 404 to the blocked');
      // The Group's outbox, read by her server: nothing of alice's.
      assert.equal((await M.get(`${G}/outbox`, { name: 'mallory' })).body?.orderedItems?.length ?? 0, 0);
      // The documented limit (spec 6.1): a server that also holds a member she
      // does not block still gets her room posts.
      await admit('mo');
      const third = await roomPost('a server with mo too');
      assert.equal(announced(third.id), 1, 'one delivery to a server with an unblocked member');
      assert.equal((await M.get(`${A.base}/users/alice/posts/${third.id}`, { name: 'mo' })).status, 200, 'mo reads it');
      assert.equal((await M.get(`${A.base}/users/alice/posts/${third.id}`, { name: 'mallory' })).status, 404, 'mallory still does not, by her own key');
    } finally {
      await M.close();
      await A.close();
    }
  });
}

test('F5: the test IPC hook exists only on a loopback test server, and moves the clock by a finite amount', { timeout: 60_000 }, async () => {
  const { testIpcAllowed, advanceMs } = require('../lib/test-ipc');
  const testCfg = { production: false, fedTestLoopback: true, publicOrigin: 'http://127.0.0.1:4000' };
  const env = { RING_TEST_IPC: '1' };
  assert.equal(testIpcAllowed({ env, cfg: testCfg, channel: true }), true, 'positive control: a loopback test server');
  assert.equal(testIpcAllowed({ env, cfg: { ...testCfg, fedTestLoopback: false, publicOrigin: 'https://ring.example.org' }, channel: true }), false, 'a real origin, no test hook');
  assert.equal(testIpcAllowed({ env, cfg: { ...testCfg, production: true }, channel: true }), false);
  assert.equal(testIpcAllowed({ env, cfg: testCfg, channel: false }), false);
  assert.equal(testIpcAllowed({ env: {}, cfg: testCfg, channel: true }), false);
  for (const bad of ['Infinity', Infinity, -Infinity, Number.NaN, '1000', null, -400 * 24 * 3600_000, 400 * 24 * 3600_000]) assert.equal(advanceMs(bad), null, String(bad));
  assert.equal(advanceMs(WEEK), WEEK);
  assert.equal(advanceMs(-WEEK), -WEEK);

  // The real server.js, as a process manager would run it.
  async function run(extraEnv, msgs) {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-ipc-'));
    const childEnv = { PATH: process.env.PATH, SESSION_SECRET: SECRET, ADMIN_EMAIL: 'a@example.test', DATA_DIR: dir, PORT: String(port), MAIL_PROVIDER: 'log', TRUST_PROXY: 'loopback', RING_TEST_IPC: '1', ...extraEnv };
    for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const replies = [];
    child.on('message', (m) => replies.push(m));
    try {
      await until(() => out.includes('listening on') || child.exitCode !== null, { ms: 15_000, what: 'the server to listen' });
      assert.ok(out.includes('listening on'), out.slice(0, 400));
      const hook = out.includes('RING_TEST_IPC: the test hook is on');
      for (const m of msgs) child.send(m);
      // A last message with a known answer when the hook is on: every earlier one has been answered by then.
      if (hook) { child.send({ id: 99, type: 'sweep' }); await until(() => replies.some((x) => x.id === 99), { what: 'the hook\'s answers' }); }
      return { hook, replies };
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const real = await run({ PUBLIC_ORIGIN: 'https://ring.example.org', NODE_ENV: undefined }, [{ id: 1, type: 'advance', ms: 1000 }]);
  assert.equal(real.hook, false, 'a real origin with an IPC channel: no hook');
  const typo = await run({ PUBLIC_ORIGIN: 'https://ring.example.org', NODE_ENV: 'prod' }, []);
  assert.equal(typo.hook, false, 'NODE_ENV=prod (a typo), a real origin: no hook');
  const port = await freePort();
  const local = await run({ PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, NODE_ENV: 'test', FEDERATION: 'on', FED_TEST_LOOPBACK: '1' }, [
    { id: 1, type: 'advance', ms: 'Infinity' }, { id: 2, type: 'advance', ms: -315360000000 }, { id: 3, type: 'advance', ms: 1000 },
  ]);
  assert.equal(local.hook, true, 'positive control: the loopback test server has it');
  const answer = (id) => local.replies.find((x) => x.id === id);
  assert.equal(answer(1)?.ok, false, 'Infinity refused');
  assert.equal(answer(2)?.ok, false, 'ten years back refused');
  assert.equal(answer(3)?.ok, true, 'a second forward is fine');
});

test('F6: a copy\'s image comes from its author\'s host only, as an id of its ring, fetched as a member of that ring', { timeout: 60_000 }, async () => {
  const { h: T, c } = await fedRing(['ana', 'abe']);
  const M = await fakeMastodon({ users: ['cy'] });
  const X = await fakeMastodon({ users: ['nobody'], keyIndex: 2 });
  try {
    const img = await png(32, 24);
    M.serve('/img/a.png', img, { type: 'image/png' });
    X.serve('/img/b.png', img, { type: 'image/png' });
    const { newRingId } = require('../lib/ids');
    const cy = `cy@${M.host}`;
    const r1 = newRingId();
    const r2 = newRingId();
    const g1 = `${M.base}/rings/${r1}`;
    const g2 = `${M.base}/rings/${r2}`;
    T.ctx.ringStore.update((rings) => {
      const now = new Date(clock.now()).toISOString();
      rings.push({ id: r1, ap_id: g1, home: false, name: 'One', created_by: cy, created_at: now, members: [{ handle: cy, joined_at: now }, { handle: 'ana', joined_at: now }], requests: [], rev: 1 });
      rings.push({ id: r2, ap_id: g2, home: false, name: 'Two', created_by: cy, created_at: now, members: [{ handle: cy, joined_at: now }, { handle: 'abe', joined_at: now }], requests: [], rev: 1 });
      return rings;
    });
    const note = (g, tag, attachment, extra = {}) => ({
      id: `${M.actor('cy')}/posts/p${tag}`, type: 'Note', attributedTo: M.actor('cy'), to: [g], audience: g, content: `<p>${tag}</p>`,
      source: { content: tag, mediaType: 'text/markdown' }, published: new Date(clock.now()).toISOString(),
      ring: { v: 1, kind: 'image', room: g, expires: new Date(clock.now() + WEEK).toISOString() },
      attachment: attachment.map((url) => ({ type: 'Image', mediaType: 'image/png', url, name: 'a print' })), ...extra,
    });
    const store = (rid, n) => T.ctx.ringFed.storeCopy(T.ctx.ringStore.get(rid), { type: 'Create', actor: M.actor('cy') }, cy, { note: n });
    assert.equal(store(r1, note(g1, 'one', [`${M.base}/img/a.png`, `${X.base}/img/b.png`])), 'added');
    assert.equal(store(r2, note(g2, 'two', [`${M.base}/img/a.png`])), 'added');
    // Not a Ring post (a node tree, no markdown source): no copy (F7's half).
    assert.equal(store(r1, note(g1, 'tree', [], { source: undefined })), 'refused');
    const one = T.ctx.rooms.find(`${M.actor('cy')}/posts/pone`).post;
    const two = T.ctx.rooms.find(`${M.actor('cy')}/posts/ptwo`).post;
    assert.ok(one.attachments[0].media, 'the author\'s host: fetched');
    assert.equal(one.attachments[1].media, undefined, 'another host: never fetched');
    assert.notEqual(one.attachments[0].media, two.attachments[0].media, 'one URL, two rings, two ids');
    await T.ctx.federation.media.idle();
    await until(() => M.gets.filter((g) => g.path === '/img/a.png').length >= 2, { what: 'both fetches' });
    assert.ok(!X.gets.some((g) => g.path === '/img/b.png'), 'the foreign host was never asked');
    const signers = M.gets.filter((g) => g.path === '/img/a.png').map((g) => /keyId="([^"]+)"/.exec(g.headers.signature || '')?.[1]).sort();
    assert.deepEqual(signers, [`${T.base}/users/abe#main-key`, `${T.base}/users/ana#main-key`], 'each signed as a member of ITS ring');
    // Served to the members here of that ring only, by its own id.
    assert.equal((await c.ana.get(`/media/${one.attachments[0].media}/web`)).status, 200);
    assert.equal((await c.abe.get(`/media/${one.attachments[0].media}/web`)).status, 404, 'abe\'s ring holds the same URL, not this id');
    assert.equal((await c.abe.get(`/media/${two.attachments[0].media}/web`)).status, 200);
    // The signer is asked at every fetch: a row no copy of its ring names signs nothing.
    const row = T.ctx.federation.media.row(one.attachments[0].media);
    assert.equal(T.ctx.ringFed.roomSigner(row, one.attachments[0].media).length, 1, 'positive control: named, one member to sign as');
    assert.equal(T.ctx.ringFed.roomSigner({ ...row, url: `${X.base}/img/b.png` }, one.attachments[0].media).length, 0, 'another host than the copy\'s author');
    assert.equal(T.ctx.ringFed.roomSigner({ ...row, ring: r2 }, one.attachments[0].media).length, 0, 'another ring');
    T.ctx.rooms.remove(r1, one.id, cy);
    assert.equal(T.ctx.ringFed.roomSigner(row, one.attachments[0].media).length, 0, 'the copy gone: nothing to sign for');
  } finally {
    await M.close();
    await X.close();
    await T.close();
  }
});

test('F7: one file per copy; a stamp, a find and a comment read one file, mediaIds none (counted); per-author caps', { timeout: 60_000 }, () => {
  const { createRooms, MAX_PER_AUTHOR, MAX_COMMENTS_PER_AUTHOR, MAX_COPY_BYTES } = require('../lib/rooms');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-rooms-'));
  const quiet = { log() {}, error() {} };
  try {
    const rooms = createRooms({ paths: { fedRoomsDir: dir }, logger: quiet });
    const ringId = `ring_${'b'.repeat(20)}`;
    const now = clock.now();
    const entry = (author, i, extra = {}) => ({
      id: `https://${author.split('@')[1]}/users/${author.split('@')[0]}/posts/p${i}`, type: 'Note', actor: `https://${author.split('@')[1]}/users/${author.split('@')[0]}`,
      published: new Date(now - 1000 * i).toISOString(), visibility: 'private', attachments: [{ kind: 'image', url: `https://${author.split('@')[1]}/i/${i}.png`, alt: '', media: `m_${crypto.createHash('sha256').update(`${author}${i}`).digest('hex').slice(0, 32)}` }],
      ring: { v: 1 }, source: `post ${i}`, author, expires: new Date(now + WEEK).toISOString(), ...extra,
    });
    // Two authors at their caps, a third with a few.
    for (let i = 0; i < MAX_PER_AUTHOR + 5; i++) assert.equal(rooms.put(ringId, entry('m@a.example', i)), i < MAX_PER_AUTHOR ? 'added' : 'refused', `a ${i}`);
    for (let i = 0; i < 10; i++) assert.equal(rooms.put(ringId, entry('n@b.example', i)), 'added');
    const live = rooms.list(ringId);
    assert.equal(live.filter((p) => p.author === 'm@a.example').length, MAX_PER_AUTHOR, 'an author holds at most 200 live copies of a ring');
    // A newer one pushes the author's own oldest out, nobody else's.
    assert.equal(rooms.put(ringId, entry('m@a.example', -1)), 'added');
    assert.equal(rooms.list(ringId).filter((p) => p.author === 'n@b.example').length, 10, 'another author keeps theirs');
    // One copy file each, on disk.
    assert.equal(fs.readdirSync(path.join(dir, ringId)).length, MAX_PER_AUTHOR + 10);
    // A copy over MAX_COPY_BYTES is refused.
    assert.equal(rooms.put(ringId, entry('n@b.example', 99, { source: 'x'.repeat(5000), summary: 'y', attachments: Array.from({ length: 4 }, (_, k) => ({ kind: 'image', url: `https://b.example/${'z'.repeat(1990)}${k}`, alt: '\u{1F600}'.repeat(1500) })) })), 'added', 'positive control: a big but legitimate copy fits');
    const huge = entry('n@b.example', 98, { tree: Array.from({ length: 40 }, () => ({ t: 'p', c: ['w'.repeat(2000)] })) });
    assert.equal(rooms.put(ringId, huge), 'refused', `over the cap (${MAX_COPY_BYTES} bytes)`);

    // ── a fresh process: the index is built once, then every act reads ONE file ──
    const fresh = createRooms({ paths: { fedRoomsDir: dir }, logger: quiet });
    const target = entry('n@b.example', 3).id;
    assert.ok(fresh.find(target), 'found');
    const built = fresh.stats();
    assert.equal(built.filesRead, built.copies + 1, 'the index read each copy once, then the one found');
    const delta = (fn) => { const a = fresh.stats(); fn(); const b = fresh.stats(); return { read: b.filesRead - a.filesRead, written: b.filesWritten - a.filesWritten, bytes: b.bytesRead - a.bytesRead }; };
    const fileBytes = fs.statSync(path.join(dir, ringId, `${require('../lib/rooms').keyOf(target)}.json`)).size;
    assert.deepEqual(delta(() => fresh.find(target)), { read: 1, written: 0, bytes: fileBytes }, 'a find reads one file');
    assert.deepEqual((({ read, written }) => ({ read, written }))(delta(() => assert.ok(fresh.stamp(ringId, target, { id: 'https://x.example/s/1', author: 'a@x.example', face: '(⌒‿⌒)' })))), { read: 1, written: 1 }, 'a stamp reads one file and writes one');
    assert.deepEqual(delta(() => fresh.mediaIds()), { read: 0, written: 0, bytes: 0 }, 'mediaIds reads nothing');
    assert.equal(fresh.mediaIds().size, MAX_PER_AUTHOR + 10, 'every copy\'s image, from the index');
    const mediaId = fresh.find(target).post.attachments[0].media;
    assert.deepEqual(delta(() => assert.deepEqual(fresh.mediaRings(mediaId, [ringId]), [ringId])), { read: 0, written: 0, bytes: 0 }, 'mediaRings reads nothing');
    assert.deepEqual(delta(() => fresh.sweep(() => true)), { read: 0, written: 0, bytes: 0 }, 'a sweep with nothing to expire reads nothing');
    // Comments: 20 an author a copy, the 21st refused; findComment reads one file.
    for (let k = 0; k < MAX_COMMENTS_PER_AUTHOR; k++) assert.ok(fresh.comment(ringId, target, { id: `https://x.example/c/${k}`, author: 'a@x.example', body: `c ${k}` }), `comment ${k}`);
    assert.equal(fresh.comment(ringId, target, { id: 'https://x.example/c/extra', author: 'a@x.example', body: 'one more' }), false, 'the 21st is refused');
    assert.ok(fresh.comment(ringId, target, { id: 'https://y.example/c/1', author: 'b@y.example', body: 'another author' }), 'another author still writes');
    assert.equal(delta(() => assert.ok(fresh.findComment(ringId, 'https://x.example/c/5'))).read, 1, 'findComment reads one file');
    // Expiry: a week on, nothing is listed, and the sweep removes every file without reading one.
    clock.advance(WEEK + 1000);
    assert.equal(fresh.list(ringId).length, 0);
    const swept = delta(() => fresh.sweep(() => true));
    assert.equal(swept.read, 0, 'the sweep decides from the index');
    assert.ok(!fs.existsSync(path.join(dir, ringId)), 'every file gone');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
