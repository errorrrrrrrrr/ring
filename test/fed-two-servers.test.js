'use strict';
/* fed-two-servers (spec 16.3, P6): TWO REAL RING SERVERS befriend across
 * servers and react to each other, end to end, over loopback HTTP with real
 * signatures: A runs in this process (test/helpers/harness.js), B is its own
 * `node server.js` process (test/helpers/ring-process.js). Nothing is faked
 * between them: WebFinger, NodeInfo (ringProtocol 1), the actors, the signed
 * deliveries and both delivery queues are the product's own.
 *   ana@A befriends bo@B: Follow, the request on B, bo confirms (Accept and a
 *     Follow back), A accepts the crossing follow: friends on both sides;
 *   each one's public post reaches the other's Friends feed;
 *   stamps with exact faces both ways (Like with the Ring term, a non-nice face
 *     between friends); comments both ways; a take-back reaches the other side;
 *   an edit and a delete reach the other side;
 *   the same activity delivered twice applies once;
 *   bo's block ends it (Undo and Reject, his reactions from her gone), and,
 *     befriended again, ana's domain block ends it from her side;
 *   bo deletes his account: A gets Delete{Person}, signed by the key that
 *     waits for it, and forgets him (the smoke's item 13).
 * Room posts and the archive never federate in P6 (fed-audience holds that). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PASSWORD } = require('./helpers/harness');
const { fedRing, until, sign } = require('./helpers/fediverse');
const { startRing } = require('./helpers/ring-process');

const enc = encodeURIComponent;

test('two Ring servers: befriend, posts, exact stamps and comments both ways, edits and deletes; once only; a block and a domain block end it; a deleted account is forgotten', { timeout: 120_000 }, async () => {
  const B = await startRing();
  const { h: A, c } = await fedRing(['ana']);
  try {
    const bo = await B.member('bo', 'Bo Berg');
    assert.equal((await bo.put('/api/me/page', { enabled: true })).status, 200);
    const anaAtA = `ana@${new URL(A.base).host}`;
    const boAtB = `bo@${B.host}`;
    const drainA = () => A.ctx.federation.queue.drain();
    const status = async (client, handle) => (await client.get(`/api/friends/with/${enc(handle)}`)).body.status;

    // ── befriend across servers ──
    let r = await c.ana.post('/api/friends', { handle: boAtB });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.status, 'pending');
    await drainA();
    await until(async () => (await bo.get('/api/followers')).body.requests?.some((q) => q.handle === anaAtA), { what: 'the request on B' });
    const req = (await bo.get('/api/inbox')).body.follow_requests.find((q) => q.handle === anaAtA);
    assert.equal(req.name, 'Ana Tester');
    assert.equal(req.host, new URL(A.base).host);
    r = await bo.post(`/api/friends/${enc(anaAtA)}/confirm`);
    assert.equal(r.status, 200, r.text);
    await until(async () => (await status(c.ana, boAtB)) === 'friends', { what: 'friends on A' });
    await drainA();
    await until(async () => (await status(bo, anaAtA)) === 'friends', { what: 'friends on B' });
    assert.deepEqual((await c.ana.get('/api/friends')).body.friends.map((f) => [f.handle, f.name]), [[boAtB, 'Bo Berg']]);

    // ── posts reach each other's Friends feed ──
    const bp = (await bo.post('/api/posts', { kind: 'note', note: 'a **bold** print', kaomoji: '(^_^)' })).body;
    const boPostUrl = `${B.origin}/users/bo/posts/${bp.id}`;
    const onA = async () => (await c.ana.get('/api/feed/friends')).body.posts.find((p) => p.id === boPostUrl);
    const card = await until(onA, { what: 'bo\'s post on A' });
    assert.equal(card.origin, 'remote');
    assert.equal(card.html, '<p>a <strong>bold</strong> print</p>', 'a Ring post is rendered from its markdown source, by A\'s own renderer');
    assert.equal(card.kaomoji, '(^_^)');
    assert.equal(card.tree, undefined);
    const ap = (await c.ana.post('/api/posts', { kind: 'note', note: 'hello from A' })).body;
    const anaPostUrl = `${A.base}/users/ana/posts/${ap.id}`;
    await drainA();
    await until(async () => (await bo.get('/api/feed/friends')).body.posts.some((p) => p.id === anaPostUrl), { what: 'ana\'s post on B' });

    // ── stamps with exact faces, both ways ──
    r = await c.ana.post('/api/remote/stamp', { object: boPostUrl, face: '🔥' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sent_as, 'Like');
    assert.equal(A.ctx.federation.hosts.get(B.host).ring_protocol, 1, 'B is a Ring server by its NodeInfo');
    await drainA();
    const boWall = async () => (await bo.get('/api/pages/bo')).body.posts.find((p) => p.id === bp.id);
    const st = await until(async () => (await boWall()).stamps.find((s) => s.author.handle === anaAtA), { what: 'ana\'s stamp on B' });
    assert.equal(st.kaomoji, '🔥', 'the exact face, a non-nice one between friends');
    assert.equal(st.author.name, `Ana T. · ${new URL(A.base).host}`);
    r = await bo.post('/api/remote/stamp', { object: anaPostUrl, face: '⚡' });
    assert.equal(r.status, 200, r.text);
    const st2 = await until(() => A.ctx.reactions.loadStamps('ana').find((s) => s.author === boAtB), { what: 'bo\'s stamp on A' });
    assert.equal(st2.kaomoji, '⚡');

    // ── comments, both ways ──
    r = await c.ana.post('/api/remote/comment', { object: boPostUrl, body: 'the bold one, yes' });
    assert.equal(r.status, 200, r.text);
    await drainA();
    const cm = await until(async () => (await boWall()).comments.find((x) => x.author.handle === anaAtA), { what: 'ana\'s comment on B' });
    assert.equal(cm.body, 'the bold one, yes');
    r = await bo.post('/api/remote/comment', { object: anaPostUrl, body: 'hello back' });
    assert.equal(r.status, 200, r.text);
    const cm2 = await until(() => A.ctx.reactions.loadComments('ana').find((x) => x.author === boAtB), { what: 'bo\'s comment on A' });
    assert.equal(cm2.body, 'hello back');
    assert.equal(cm2.truncated, undefined);

    // ── the same activity delivered twice applies once ──
    const likeRow = A.ctx.sent.stampOn('ana', boPostUrl);
    const body = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', ...likeRow.activity });
    const hdr = sign({ method: 'POST', url: `${B.origin}/inbox`, body, keyId: `${A.base}/users/ana#main-key`, privateKey: A.ctx.keys.privateKey('ana'), headers: { 'content-type': 'application/activity+json' } });
    delete hdr.host;
    const again = await fetch(`${B.origin}/inbox`, { method: 'POST', headers: hdr, body });
    assert.equal(again.status, 202);
    assert.equal((await boWall()).stamps.filter((s) => s.author.handle === anaAtA).length, 1, 'one stamp, not two');

    // ── take-backs, an edit and a delete reach the other side ──
    r = await c.ana.del(`/api/remote/comment/${enc(A.ctx.sent.commentsOn('ana', boPostUrl)[0].id)}`);
    assert.equal(r.status, 200);
    await drainA();
    await until(async () => !(await boWall()).comments.some((x) => x.author.handle === anaAtA), { what: 'the comment taken back on B' });
    r = await bo.patch(`/api/posts/${bp.id}`, { note: 'a **bolder** print' });
    assert.equal(r.status, 200, r.text);
    await until(async () => (await onA())?.html === '<p>a <strong>bolder</strong> print</p>', { what: 'the edit on A' });
    assert.equal((await bo.del(`/api/posts/${bp.id}`)).status, 200);
    await until(async () => !(await onA()), { what: 'the delete on A' });

    // ── bo blocks ana: the follows end both ways; her reactions on his posts go ──
    const bp2 = (await bo.post('/api/posts', { kind: 'note', note: 'second' })).body;
    const bp2Url = `${B.origin}/users/bo/posts/${bp2.id}`;
    await until(() => A.ctx.walls.list(boAtB).some((p) => p.id === bp2Url), { what: 'the second post on A' });
    assert.equal((await c.ana.post('/api/remote/stamp', { object: bp2Url, face: '✿' })).status, 200);
    await drainA();
    await until(async () => (await bo.get('/api/pages/bo')).body.posts.find((p) => p.id === bp2.id)?.stamps.length === 1, { what: 'the stamp on B' });
    assert.equal((await bo.put('/api/me/page', { block: anaAtA })).status, 200);
    await until(async () => (await status(c.ana, boAtB)) === 'none', { what: 'the sever on A' });
    assert.equal(A.ctx.walls.list(boAtB).length, 0, 'his wall went with the friendship');
    assert.equal((await bo.get('/api/pages/bo')).body.posts.find((p) => p.id === bp2.id).stamps.length, 0, 'her stamp went with the block');
    // While blocked, her Follow is dropped silently: pending forever on her side.
    assert.equal((await c.ana.post('/api/friends', { handle: boAtB })).status, 200);
    await drainA();
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(!(await bo.get('/api/followers')).body.requests.some((q) => q.handle === anaAtA), 'never shown to him');
    assert.equal(await status(c.ana, boAtB), 'pending');

    // ── unblocked and befriended again; then ana's DOMAIN block ends it from her side ──
    assert.equal((await bo.put('/api/me/page', { unblock: anaAtA })).status, 200);
    assert.equal((await c.ana.post('/api/friends', { handle: boAtB })).status, 200, 'asking again sends the same Follow again');
    await drainA();
    await until(async () => (await bo.get('/api/followers')).body.requests?.some((q) => q.handle === anaAtA), { what: 'the request again' });
    assert.equal((await bo.post(`/api/friends/${enc(anaAtA)}/confirm`)).status, 200);
    await until(async () => (await status(c.ana, boAtB)) === 'friends', { what: 'friends again on A' });
    await drainA();
    await until(async () => (await status(bo, anaAtA)) === 'friends', { what: 'friends again on B' });
    assert.equal((await c.ana.put('/api/me/page', { block_domain: B.host })).status, 200);
    await drainA();
    await until(async () => (await status(bo, anaAtA)) === 'none', { what: 'the domain block reaching B' });
    assert.equal(await status(c.ana, boAtB), 'none');
    assert.equal((await c.ana.post('/api/friends', { handle: boAtB })).status, 409, 'befriending a blocked domain: blocked_them');

    // ── bo deletes his account: A gets Delete{Person} and forgets him ──
    assert.equal((await c.ana.put('/api/me/page', { unblock_domain: B.host })).status, 200);
    assert.equal((await c.ana.post('/api/friends', { handle: boAtB })).status, 200);
    await drainA();
    await until(async () => (await bo.get('/api/followers')).body.requests?.some((q) => q.handle === anaAtA), { what: 'a third request' });
    assert.equal((await bo.post(`/api/friends/${enc(anaAtA)}/confirm`)).status, 200);
    await until(async () => (await status(c.ana, boAtB)) === 'friends', { what: 'friends a third time' });
    const boActor = A.ctx.federation.actors.idOf(boAtB);
    assert.equal((await bo.del('/api/me', { password: PASSWORD })).status, 200);
    await until(() => A.ctx.federation.actors.get(boActor)?.gone_at, { what: 'bo gone on A' });
    assert.equal(await status(c.ana, boAtB), 'none');
    assert.deepEqual(A.ctx.follows.load('ana').following, []);
    assert.deepEqual(A.ctx.follows.load('ana').followers, []);
    assert.equal(A.ctx.reactions.loadStamps('ana').filter((s) => s.author === boAtB).length, 0, 'his stamp went with him');
    // B answers his actor with a Tombstone (410) now.
    assert.equal((await fetch(`${B.origin}/users/bo`, { headers: { accept: 'application/activity+json' } })).status, 410);
    assert.ok(!B.log().includes('Error:'), B.log().slice(-2000));
  } catch (e) {
    e.message += `\n--- B's log ---\n${B.log().slice(-4000)}\n--- A's log ---\n${A.logs.slice(-40).join('\n')}`;
    throw e;
  } finally {
    await A.close();
    await B.stop();
  }
});
