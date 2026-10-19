'use strict';
/* fed-rings (spec 16.3, 16.4 smoke 10; P7): ONE RING SPANNING THREE REAL RING
 * SERVERS, end to end, over loopback HTTP with real signatures. A runs in this
 * process (test/helpers/harness.js), B and C are their own `node server.js`
 * processes (test/helpers/ring-process.js, which also moves their clocks).
 * Nothing is faked between them: WebFinger, NodeInfo (ringProtocol 1), the
 * actors, the Group and its key, the signed deliveries and every queue are the
 * product's own.
 *   ana@A makes a ring; bo@B and cy@C ask by its link from their own servers
 *     (the asker's view: name and hosts); ana admits bo, and bo, from B (a
 *     third server), admits cy: the home decides; replicas on B and C
 *   an edit reaches every copy; a stamp taken back goes everywhere; a stamp
 *     the post's own server refuses is withdrawn everywhere by Remove; an
 *     Update{Group} with a lower rev changes nothing
 *   a room post from C reaches A's and B's members only (not a follower, not
 *     the square, not a non-member's signed fetch), with its image fetched
 *     under the ring's read grant and served to ring members here only
 *   stamps (a custom face too) and comments within the ring, on every server
 *   a forged Announce, signed by a server that is not the ring's home, is
 *     refused, and so is a genuine Group's Announce of a non-member's post
 *   the weekly reset: every server moves a week on and each server's copies
 *     are gone (each expires its own, the Delete through the Group or not)
 *   a kick (C's member) and a leave (B's member): their servers drop the ring
 *   the seat cap under a race: eight askers on two servers at once, never a
 *     seventh member
 *   the rules: the ring key (made with the ring, lazily before P7, gone with
 *     it after its last job), Ring servers only (a Mastodon Join refused and
 *     answered; asking a link on a Mastodon host refused), a member's own domain
 *     block, a block holding at approval, an account deletion leaving the ring,
 *     the joiner's 3-ring cap at Accept, a creator handoff to another server,
 *     a rename and the delete from there
 * Each rule's positive control (the rule broken, this suite red, the file
 * restored byte for byte) is listed in docs/SPEC.md 16.3. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const clock = require('../lib/clock');
const { fedRing, until, sign, fakeMastodon, followFrom } = require('./helpers/fediverse');
const { startRing } = require('./helpers/ring-process');
const { png } = require('./helpers/images');

const enc = encodeURIComponent;
const WEEK = 7 * 24 * 3600_000;

test.afterEach(() => clock.reset());

/* The three servers, a ring on A with bo@B and cy@C in it. */
async function threeServers() {
  const B = await startRing();
  const C = await startRing();
  const { h: A, c } = await fedRing(['ana', 'abe']);
  const bo = await B.member('bo', 'Bo Berg');
  const cy = await C.member('cy', 'Cy Chen');
  const s = {
    A, B, C, c, bo, cy,
    aHost: new URL(A.base).host,
    drainA: () => A.ctx.federation.queue.drain(),
    drainAll: async () => { await A.ctx.federation.queue.drain(); await B.drain(); await C.drain(); await A.ctx.federation.queue.drain(); },
    extra: null,
    async close() { await Promise.allSettled([B.stop(), C.stop(), s.extra?.close()]); await A.close(); },
  };
  return s;
}

async function admit(s, client, server, handle, ringId) {
  await until(async () => (await s.c.ana.get('/api/rings')).body.rings[0]?.requests.some((q) => q.handle === handle), { what: `${handle}'s request on A` });
  const r = await s.c.ana.post(`/api/rings/${ringId}/requests/${enc(handle)}`, { approve: true });
  assert.equal(r.status, 200, r.text);
  await s.drainA();
  await until(async () => (await client.get('/api/rings')).body.rings.some((x) => x.home === false && x.members.some((m) => m.handle === `ana@${s.aHost}`)), { what: `the replica on ${server.host}` });
}

test('one ring across three Ring servers: join by link, a room post from C reaches A and B only, stamps and comments, a forged Announce refused, the reset everywhere, a kick and a leave', { timeout: 180_000 }, async () => {
  const s = await threeServers();
  const { A, B, C, c, bo, cy, aHost } = s;
  try {
    const boAt = `bo@${B.host}`;
    const cyAt = `cy@${C.host}`;
    // A follower of cy on another server (a Mastodon), who must never see the room.
    assert.equal((await cy.put('/api/me/page', { enabled: true })).status, 200);
    const m = await fakeMastodon();
    s.extra = m;
    assert.equal((await m.post(`${C.origin}/users/cy/inbox`, followFrom(m, `${C.origin}/users/cy`))).status, 202);
    assert.equal((await cy.post(`/api/followers/${enc(`bob@${m.host}`)}/accept`)).status, 200);

    // ── ana makes a ring on A ──
    let r = await c.ana.post('/api/rings', { name: 'Thursday' });
    assert.equal(r.status, 201, r.text);
    const ringId = r.body.id;
    const link = r.body.join.url;
    assert.ok(A.ctx.keys.hasRing(ringId), 'the ring has its own key from its creation');

    // ── bo@B and cy@C look up the link, then ask from their own servers ──
    r = await bo.get(`/api/lookup?q=${enc(link)}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.type, 'join');
    assert.equal(r.body.name, 'Thursday');
    assert.deepEqual(r.body.hosts, [aHost], 'the asker sees where the room is held');
    assert.equal(r.body.members, undefined, 'never who is in it');
    r = await bo.post('/api/rings/join', { url: link });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.requested, true);
    await B.drain();
    await admit(s, bo, B, boAt, ringId);
    r = await cy.post('/api/rings/join', { url: link });
    assert.equal(r.status, 200, r.text);
    await C.drain();
    // cy is let in from a THIRD server: bo, a member on B, approves on B's
    // replica (Accept{Join} to the Group); the home decides.
    await s.drainA();
    const reqOnB = await until(async () => (await bo.get('/api/rings')).body.rings.find((x) => !x.home)?.requests.find((q) => q.handle === cyAt), { what: 'cy\'s request on B' });
    assert.equal(reqOnB.host, C.host, 'the asker\'s host, for the trust notice');
    const ringOnBid = (await bo.get('/api/rings')).body.rings.find((x) => !x.home).id;
    r = await bo.post(`/api/rings/${ringOnBid}/requests/${enc(cyAt)}`, { approve: true });
    assert.equal(r.status, 200, r.text);
    await B.drain();
    await until(() => A.ctx.ringStore.get(ringId).members.some((m) => m.handle === cyAt), { what: 'cy admitted at the home' });
    await s.drainA();
    await until(async () => (await cy.get('/api/rings')).body.rings.some((x) => x.home === false), { what: 'the replica on C' });
    await s.drainAll();
    const ringOnA = A.ctx.ringStore.get(ringId);
    assert.deepEqual(ringOnA.members.map((m) => m.handle), ['ana', boAt, cyAt]);
    const onB = await until(async () => {
      const x = (await bo.get('/api/rings')).body.rings.find((y) => !y.home);
      return x?.members.length === 3 ? x : null;
    }, { what: 'the full ring on B' });
    assert.equal(onB.name, 'Thursday');
    assert.deepEqual(onB.hosts, [aHost, B.host, C.host].sort(), 'every host that holds the room');
    assert.equal(onB.home_host, aHost);
    const onC = await until(async () => {
      const x = (await cy.get('/api/rings')).body.rings.find((y) => !y.home);
      return x?.members.length === 3 ? x : null;
    }, { what: 'the full ring on C' });

    // ── a room post from C, with an image, reaches A's and B's members only ──
    const up = await cy.upload(await png(64, 48), { filename: 'room.png', type: 'image/png' });
    assert.equal(up.status, 201, up.text);
    r = await cy.post('/api/posts', { kind: 'image', note: 'from C, for the room', audience: onC.id, media: { key: up.body.key, alt: 'a print' } });
    assert.equal(r.status, 201, r.text);
    const cPost = r.body;
    const cPostUrl = `${C.origin}/users/cy/posts/${cPost.id}`;
    await C.drain();
    await s.drainAll();
    const onAFeed = async () => (await c.ana.get(`/api/rings/${ringId}/feed`)).body.posts.find((p) => p.id === cPostUrl);
    const cardA = await until(onAFeed, { what: 'C\'s room post on A' });
    assert.equal(cardA.html, '<p>from C, for the room</p>');
    assert.equal(cardA.author.handle, cyAt);
    assert.ok(cardA.expires_at, 'a copy carries its own expiry');
    const cardB = await until(async () => (await bo.get(`/api/rings/${onB.id}/feed`)).body.posts.find((p) => p.id === cPostUrl), { what: 'C\'s room post on B' });
    assert.equal(cardB.audience, onB.id);
    // Never to cy's follower (a Mastodon): positive control, a public post is.
    const pub = (await cy.post('/api/posts', { kind: 'note', note: 'public from C' })).body;
    await C.drain();
    await until(() => m.deliveries.some((d) => d.raw.includes(pub.id)), { what: 'the public post at the follower' });
    assert.ok(!m.deliveries.some((d) => d.raw.includes(cPost.id)), 'the room post never reached a follower');
    // Its image: fetched under the ring's read grant, served to ring members here only.
    await A.ctx.federation.media.idle();
    const img = await until(async () => {
      const res = await c.ana.get(cardA.media[0].url);
      return res.status === 200 ? res : null;
    }, { what: 'the room image on A' });
    assert.equal(img.headers.get('content-type'), 'image/webp');
    assert.equal((await c.abe.get(cardA.media[0].url)).status, 404, 'abe@A is not in the ring: the copy\'s image is not his');
    assert.equal((await c.abe.get(`/api/rings/${ringId}/feed`)).status, 404, 'nor the room');
    assert.ok(!(await c.abe.get('/api/feed')).body.posts.some((p) => p.id === cPostUrl), 'not the square');
    // A non-member's signed fetch of the room post at its own server: 404.
    const abeKey = { keyId: `${A.base}/users/abe#main-key`, privateKey: A.ctx.keys.privateKey('abe') };
    const signedGet = async (url, as) => {
      const headers = sign({ method: 'GET', url, ...as, headers: { accept: 'application/activity+json' } });
      delete headers.host;
      return fetch(url, { headers });
    };
    assert.equal((await signedGet(cPostUrl, abeKey)).status, 404, 'a non-member signer reads nothing');
    assert.equal((await signedGet(cPostUrl, { keyId: `${A.base}/users/ana#main-key`, privateKey: A.ctx.keys.privateKey('ana') })).status, 200, 'positive control: a member signer reads it');

    // ── stamps and comments within the ring ──
    // ana and cy are friends (comments are for friends, in a room too).
    r = await c.ana.post('/api/friends', { handle: cyAt });
    assert.equal(r.status, 200, r.text);
    await s.drainAll();
    await until(async () => (await cy.get('/api/followers')).body.requests?.some((q) => q.handle === `ana@${aHost}`), { what: 'ana\'s request on C' });
    assert.equal((await cy.post(`/api/friends/${enc(`ana@${aHost}`)}/confirm`)).status, 200);
    await C.drain();
    await until(async () => (await c.ana.get(`/api/friends/with/${enc(cyAt)}`)).body.status === 'friends', { what: 'friends on A' });
    await s.drainAll();
    await until(async () => (await cy.get(`/api/friends/with/${enc(`ana@${aHost}`)}`)).body.status === 'friends', { what: 'friends on C' });
    // A custom face from bo@B on cy's post, and a comment from ana@A.
    r = await bo.post('/api/remote/stamp', { object: cPostUrl, face: 'print!' });
    assert.equal(r.status, 200, r.text);
    await B.drain();
    r = await c.ana.post('/api/remote/comment', { object: cPostUrl, body: 'lovely, from A' });
    assert.equal(r.status, 200, r.text);
    await s.drainAll();
    await s.drainAll();
    // On C (the authority): the stamp and the comment on cy's own post.
    const cyWallRoom = async () => (await cy.get(`/api/rings/${onC.id}/feed`)).body.posts.find((p) => p.id === cPost.id);
    await until(async () => {
      const p = await cyWallRoom();
      return p?.stamps.some((x) => x.author.handle === `bo@${B.host}` && x.kaomoji === 'print!') && p.comments.some((x) => x.body === 'lovely, from A');
    }, { what: 'the stamp and comment on C' });
    // On A and B (copies): both, from the Group.
    await until(async () => {
      const p = await onAFeed();
      return p?.stamps.some((x) => x.kaomoji === 'print!') && p.comments.some((x) => x.body === 'lovely, from A');
    }, { what: 'the stamp and comment on A' });
    await until(async () => {
      const p = (await bo.get(`/api/rings/${onB.id}/feed`)).body.posts.find((x) => x.id === cPostUrl);
      return p?.stamps.some((x) => x.kaomoji === 'print!') && p.comments.some((x) => x.body === 'lovely, from A');
    }, { what: 'the stamp and comment on B' });

    // ── an edit reaches every copy; a take-back too ──
    r = await cy.patch(`/api/posts/${cPost.id}`, { note: 'from C, edited' });
    assert.equal(r.status, 200, r.text);
    await C.drain();
    await s.drainAll();
    await until(async () => (await onAFeed())?.html === '<p>from C, edited</p>', { what: 'the edit on A' });
    await until(async () => (await bo.get(`/api/rings/${onB.id}/feed`)).body.posts.find((p) => p.id === cPostUrl)?.html === '<p>from C, edited</p>', { what: 'the edit on B' });
    const boStamp = (await onAFeed()).stamps.find((x) => x.author.handle === boAt);
    r = await bo.del(`/api/remote/stamp/${enc(boStamp.id.split('/').pop())}`);
    assert.equal(r.status, 200, r.text);
    await B.drain();
    await s.drainAll();
    await until(async () => !(await cyWallRoom()).stamps.some((x) => x.author.handle === boAt), { what: 'the take-back on C' });
    await until(async () => !(await onAFeed()).stamps.some((x) => x.author.handle === boAt), { what: 'the take-back on A' });
    // ── a reaction the post's own server refuses is withdrawn everywhere ──
    assert.equal((await cy.patch(`/api/posts/${cPost.id}`, { stamps_off: true })).status, 200);
    r = await bo.post('/api/remote/stamp', { object: cPostUrl, face: '✿' });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.stamps.some((x) => x.author.handle === 'bo'), 'B records it at once, for its members');
    await B.drain();
    await s.drainAll();
    await s.drainAll();
    assert.ok(!(await cyWallRoom()).stamps.some((x) => x.author.handle === boAt), 'C (the authority) refused it');
    await until(async () => !(await onAFeed()).stamps.some((x) => x.author.handle === boAt), { what: 'the Remove on A' });
    await until(async () => !(await bo.get(`/api/rings/${onB.id}/feed`)).body.posts.find((p) => p.id === cPostUrl).stamps.some((x) => x.author.handle === 'bo'), { what: 'the Remove on B' });
    // The image at its own server: a member's signed fetch only.
    const imgUrl = `${C.origin}/api/images/${up.body.key}/web`;
    assert.equal((await signedGet(imgUrl, abeKey)).status, 404, 'a non-member signer gets no room image');
    assert.equal((await signedGet(imgUrl, { keyId: `${A.base}/users/ana#main-key`, privateKey: A.ctx.keys.privateKey('ana') })).status, 200, 'positive control: a member does');
    assert.equal((await fetch(imgUrl)).status, 404, 'nor an unsigned stranger');

    // ── forged Announces: from a server that is not the ring's home, and the
    //    Group's own of what no current member wrote ──
    const group = `${A.base}/rings/${ringId}`;
    const bFeed = async () => (await bo.get(`/api/rings/${onB.id}/feed`)).body.posts;
    const roomNote = (actor, id, text, to = [group]) => ({
      id, type: 'Note', attributedTo: actor, to, audience: to[0], content: `<p>${text}</p>`,
      source: { content: text, mediaType: 'text/markdown' }, published: new Date(clock.now()).toISOString(),
      ring: { v: 1, kind: 'note', room: to[0], expires: new Date(clock.now() + WEEK).toISOString() },
    });
    const announceOf = (inner, actor = group) => ({
      '@context': 'https://www.w3.org/ns/activitystreams', id: `${actor}/activities/a${crypto.randomBytes(6).toString('hex')}`,
      type: 'Announce', actor, to: [`${B.origin}/users/bo`], audience: group, object: inner,
    });
    const createOf = (note) => ({ id: `${note.id}/activity`, type: 'Create', actor: note.attributedTo, to: note.to, audience: note.audience, object: note });
    const postTo = async (activity, keyId, privateKey) => {
      const body = JSON.stringify(activity);
      const hdr = sign({ method: 'POST', url: `${B.origin}/inbox`, body, keyId, privateKey, headers: { 'content-type': 'application/activity+json' } });
      delete hdr.host;
      return (await fetch(`${B.origin}/inbox`, { method: 'POST', headers: hdr, body })).status;
    };
    const fs = require('node:fs');
    const cyKey = crypto.createPrivateKey(fs.readFileSync(`${C.dir}/keys/cy.pem`, 'utf8'));
    const ringKey = A.ctx.keys.ringPrivateKey(ringId);
    const pid = () => `p${crypto.randomBytes(8).toString('hex')}`;
    // 1. C, a member's server but not the home, posing as the Group with its
    //    member's real key: the actor is not the key's owner, so the body is not
    //    trusted; its id is fetched from the Group's host, which never made it.
    const f1 = `${C.origin}/users/cy/posts/${pid()}`;
    assert.equal(await postTo(announceOf(createOf(roomNote(`${C.origin}/users/cy`, f1, 'FORGED BY C'))), `${C.origin}/users/cy#main-key`, cyKey), 202);
    // 2. the Group's key claimed by someone else's key: the signature fails.
    assert.equal(await postTo(announceOf(createOf(roomNote(`${C.origin}/users/cy`, f1, 'FORGED'))), `${group}#main-key`, A.ctx.keys.privateKey('abe')), 401);
    // 3. the Group's genuine key, but a post by abe@A, who is not in the ring.
    const f3 = `${A.base}/users/abe/posts/${pid()}`;
    assert.equal(await postTo(announceOf(createOf(roomNote(`${A.base}/users/abe`, f3, 'NOT A MEMBER'))), `${group}#main-key`, ringKey), 202);
    // 4. the Group's genuine key, a member, but addressed to another ring.
    const f4 = `${A.base}/users/ana/posts/${pid()}`;
    const elsewhereRing = `${A.base}/rings/ring_00000000000000000000`;
    assert.equal(await postTo(announceOf({ ...createOf(roomNote(`${A.base}/users/ana`, f4, 'ANOTHER RING', [elsewhereRing])), audience: elsewhereRing }), `${group}#main-key`, ringKey), 202);
    // 5. the Group's genuine key relaying a Note it says cy@C wrote: cy is on
    //    another host than the Group, so B fetches it from C, where it does not
    //    exist; the Group can relay another server's post, never write one.
    const f5 = `${C.origin}/users/cy/posts/${pid()}`;
    assert.equal(await postTo(announceOf(createOf(roomNote(`${C.origin}/users/cy`, f5, 'WRITTEN BY THE HOME'))), `${group}#main-key`, ringKey), 202);
    // 6. ANOTHER ring's Group, with its own genuine key (a ring cy made on C,
    //    whose link bo looked at, so B knows that Group's key): it is not the
    //    home of this ring, and B takes nothing from it about this ring.
    const other = (await cy.post('/api/rings', { name: 'Other' })).body;
    assert.equal((await bo.get(`/api/lookup?q=${enc(other.join.url)}`)).status, 200);
    const otherGroup = `${C.origin}/rings/${other.id}`;
    const otherKey = crypto.createPrivateKey(fs.readFileSync(`${C.dir}/keys/rings/${other.id}.pem`, 'utf8'));
    const f7 = `${C.origin}/users/cy/posts/${pid()}`;
    assert.equal(await postTo(announceOf(createOf(roomNote(`${C.origin}/users/cy`, f7, 'FROM ANOTHER GROUP')), otherGroup), `${otherGroup}#main-key`, otherKey), 202);
    // ... nor a reaction it relays for this ring (a stamp on a copy B holds).
    const likeOf = (face) => ({ id: `${C.origin}/users/cy/stamps/stmp_${crypto.randomBytes(5).toString('hex')}`, type: 'Like', actor: `${C.origin}/users/cy`, object: cPostUrl, to: [group], audience: group, content: face, ring: { v: 1, face } });
    assert.equal(await postTo(announceOf(likeOf('⚡'), otherGroup), `${otherGroup}#main-key`, otherKey), 202);
    // Positive control: the Group's genuine key, a member on its own host,
    // addressed to the ring: it lands.
    const f6 = `${A.base}/users/ana/posts/${pid()}`;
    assert.equal(await postTo(announceOf(createOf(roomNote(`${A.base}/users/ana`, f6, 'GENUINE'))), `${group}#main-key`, ringKey), 202);
    await until(async () => (await bFeed()).some((p) => p.id === f6), { what: 'the genuine Announce on B' });
    // What B keeps on disk, not only what its feed shows.
    // One file per copy (lib/rooms.js), every one of them read.
    const roomDir = (d, id) => `${d}/fed/rooms/${id}`;
    const roomFiles = (d, id) => { try { return fs.readdirSync(roomDir(d, id)); } catch { return []; } };
    const onDisk = roomFiles(B.dir, onB.id).map((f) => fs.readFileSync(`${roomDir(B.dir, onB.id)}/${f}`, 'utf8')).join('\n');
    // An Update{Group} with a LOWER rev changes nothing (reordering never rolls
    // membership back); the Group's own key, a ring without bo in it.
    const replicaRev = (await bo.get('/api/rings')).body.rings[0].rev;
    const stale = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${group}/activities/a${crypto.randomBytes(6).toString('hex')}`, type: 'Update', actor: group, to: [`${B.origin}/users/bo`],
      object: { id: group, type: 'Group', name: 'Rolled back', attributedTo: `${A.base}/users/ana`, inbox: `${group}/inbox`, ring: { v: 1, rev: 1, capacity: 6, members: [{ actor: `${A.base}/users/ana` }], requests: [] } } };
    assert.equal(await postTo(stale, `${group}#main-key`, ringKey), 202);
    await B.drain();
    const still = (await bo.get('/api/rings')).body.rings.find((x) => !x.home);
    assert.ok(still, 'the replica stays');
    assert.equal(still.name, 'Thursday', 'a lower rev is ignored');
    assert.equal(still.rev, replicaRev);
    await B.drain();
    assert.ok(!(await bFeed()).find((p) => p.id === cPostUrl).stamps.some((x) => x.kaomoji === '⚡'), 'nothing lands from another ring\'s Group, a reaction neither');
    const landed = [...(await bFeed()).map((p) => p.id), ...[f1, f3, f4, f5, f7].filter((id) => onDisk.includes(id))];
    for (const [id, what] of [[f1, 'C posing as the Group'], [f3, 'a non-member'], [f4, 'another ring'], [f5, 'a Note the home wrote for C'], [f7, 'another ring\'s Group']]) {
      assert.ok(!landed.includes(id), `nothing lands from ${what}`);
    }

    // ── the weekly reset: every server a week on; every copy gone ──
    clock.advance(WEEK + 3600_000);
    await Promise.all([B.advance(WEEK + 3600_000), C.advance(WEEK + 3600_000)]);
    // The copies are gone at read time already, sweep or not (local expiry).
    assert.ok(!(await onAFeed()), 'A: the copy expired by itself');
    assert.ok(!(await bo.get(`/api/rings/${onB.id}/feed`)).body.posts.some((p) => p.id === cPostUrl), 'B: the copy expired by itself');
    await C.sweep();
    A.ctx.ringReset.run();
    await B.sweep();
    await s.drainAll();
    assert.ok(!A.ctx.rooms.ringIds().includes(ringId), 'A: no copy left on disk');
    assert.equal(roomFiles(B.dir, onB.id).length, 0, 'B: no copy left on disk');
    const cyArchived = (await cy.get('/api/archive')).body.posts.find((p) => p.id === cPost.id);
    assert.ok(cyArchived, 'C: the post is on cy\'s shelf');

    // ── a kick (cy@C) and a leave (bo@B): their servers drop the ring, its
    //    copies and their cached images at once ──
    const up2 = await c.ana.upload(await png(40, 30), { filename: 'a.png', type: 'image/png' });
    const aPost = (await c.ana.post('/api/posts', { kind: 'image', note: 'week two', audience: ringId, media: { key: up2.body.key, alt: 'two' } })).body;
    await s.drainAll();
    const aPostUrl = `${A.base}/users/ana/posts/${aPost.id}`;
    const onCcard = await until(async () => (await cy.get(`/api/rings/${onC.id}/feed`)).body.posts.find((p) => p.id === aPostUrl), { what: 'ana\'s post on C' });
    assert.ok(roomFiles(C.dir, onC.id).length > 0, 'C holds a copy');
    await until(async () => (await cy.get(onCcard.media[0].url)).status === 200, { what: 'its image on C' });
    const mediaId = onCcard.media[0].url.split('/')[2];
    r = await c.ana.del(`/api/rings/${ringId}/members/${enc(cyAt)}`);
    assert.equal(r.status, 200, r.text);
    await s.drainAll();
    await until(async () => !(await cy.get('/api/rings')).body.rings.some((x) => !x.home), { what: 'the ring gone from C' });
    assert.equal(roomFiles(C.dir, onC.id).length, 0, 'C: the copies went with the ring');
    assert.equal((await cy.get(`/media/${mediaId}/web`)).status, 404, 'C: and their images');
    r = await bo.post(`/api/rings/${onB.id}/leave`);
    assert.equal(r.status, 200, r.text);
    assert.equal((await bo.get('/api/rings')).body.rings.length, 0, 'B drops it at once');
    await B.drain();
    await until(() => !A.ctx.ringStore.get(ringId).members.some((m) => m.handle === boAt), { what: 'bo out on A' });
    assert.deepEqual(A.ctx.ringStore.get(ringId).members.map((m) => m.handle), ['ana']);
    assert.deepEqual(A.ctx.ringStore.get(ringId).kicked, [cyAt]);
  } catch (e) {
    if (process.env.RING_DEBUG) {
      const fs = require('node:fs');
      const audit = (d) => { try { return fs.readFileSync(`${d}/audit.log`, 'utf8').split('\n').slice(-40).join('\n'); } catch { return ''; } };
      console.log('--- A', A.logs.join('\n').slice(-4000), audit(A.dir));
      console.log('--- B', B.log().slice(-4000), audit(B.dir));
      console.log('--- C', C.log().slice(-4000), audit(C.dir));
    }
    throw e;
  } finally { await s.close(); }
});

test('the seat cap holds at the home under a race: eight askers on two other servers at once, five seats, never a seventh member', { timeout: 180_000 }, async () => {
  const B = await startRing();
  const C = await startRing();
  const { h: A, c } = await fedRing(['ana']);
  try {
    const askers = [];
    for (const [srv, names] of [[B, ['b1', 'b2', 'b3', 'b4']], [C, ['c1', 'c2', 'c3', 'c4']]]) {
      for (const n of names) askers.push({ srv, n, client: await srv.member(n) });
    }
    const r = await c.ana.post('/api/rings', { name: 'Crowded' });
    assert.equal(r.status, 201, r.text);
    const ringId = r.body.id;
    const link = r.body.join.url;
    // Everyone asks at once, from two servers; both queues deliver at once.
    const asked = await Promise.all(askers.map((a) => a.client.post('/api/rings/join', { url: link })));
    for (const x of asked) assert.equal(x.status, 200, x.text);
    await Promise.all([B.drain(), C.drain()]);
    const ring = A.ctx.ringStore.get(ringId);
    assert.equal(ring.members.length + ring.requests.length, 6, 'five requests hold the five free seats');
    // The three turned away were told (Reject{Join}): their asks are gone.
    await A.ctx.federation.queue.drain();
    const asking = async () => {
      let n = 0;
      for (const a of askers) if ((await a.client.get(`/api/lookup?q=${enc(link)}`)).body.requested) n++;
      return n;
    };
    await until(async () => (await asking()) === 5, { what: 'the three refused asks answered' });
    // Every request approved at once, and a late ask: six members, never seven.
    const pending = A.ctx.ringStore.get(ringId).requests.map((q) => q.handle);
    const answers = await Promise.all(pending.map((h) => c.ana.post(`/api/rings/${ringId}/requests/${enc(h)}`, { approve: true })));
    for (const x of answers) assert.equal(x.status, 200, x.text);
    const late = askers.find((a) => !pending.includes(`${a.n}@${a.srv.host}`));
    assert.equal((await late.client.post('/api/rings/join', { url: link })).status, 200);
    await late.srv.drain();
    await A.ctx.federation.queue.drain();
    const full = A.ctx.ringStore.get(ringId);
    assert.equal(full.members.length, 6, 'six members');
    assert.equal(full.requests.length, 0, 'and no seventh asking');
    await until(async () => !(await late.client.get(`/api/lookup?q=${enc(link)}`)).body.requested, { what: 'the late ask answered' });
    // The five admitted hold replicas with six members.
    await Promise.all([B.drain(), C.drain()]);
    for (const a of askers.filter((x) => pending.includes(`${x.n}@${x.srv.host}`))) {
      await until(async () => (await a.client.get('/api/rings')).body.rings.find((x) => !x.home)?.members.length === 6, { what: `${a.n}'s replica` });
    }
  } finally {
    await Promise.allSettled([B.stop(), C.stop()]);
    await A.close();
  }
});

test('the ring rules across servers: the ring key, Ring servers only, a block holds at approval, a member\'s own domain block, an account deleted leaves the ring', { timeout: 180_000 }, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PASSWORD } = require('./helpers/harness');
  const B = await startRing();
  const { h: A, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    const bo = await B.member('bo', 'Bo Berg');
    const boAt = `bo@${B.host}`;
    const aHost = new URL(A.base).host;
    let r = await c.ana.post('/api/rings', { name: 'Rules' });
    const ringId = r.body.id;
    const link = r.body.join.url;
    const code = link.split('/').pop();
    const keyFile = path.join(A.dir, 'keys', 'rings', `${ringId}.pem`);
    assert.ok(fs.existsSync(keyFile), 'the ring key is made with the ring');
    assert.equal((fs.statSync(keyFile).mode & 0o777), 0o600);
    // A ring made before P7 had no key: one is made when it is first needed.
    fs.rmSync(keyFile);
    const signedGet = async (url, keyId, privateKey) => {
      const headers = sign({ method: 'GET', url, keyId, privateKey, headers: { accept: 'application/activity+json' } });
      delete headers.host;
      return fetch(url, { headers });
    };
    const joinDoc = await signedGet(link, m.keyId(), m.keys.bob.privateKey);
    assert.equal(joinDoc.status, 200, 'a live code holder reads the asker\'s view');
    const gd = await joinDoc.json();
    assert.equal(gd.type, 'Group');
    assert.equal(gd.publicKey.id, `${A.base}/rings/${ringId}#main-key`);
    assert.ok(fs.existsSync(keyFile), 'made lazily');
    assert.equal(gd.ring.members, undefined, 'no members in the asker\'s view');
    assert.equal((await signedGet(`${A.base}/rings/${ringId}`, m.keyId(), m.keys.bob.privateKey)).status, 404, 'the Group itself: members and askers only');
    assert.equal((await fetch(`${A.base}/rings/${ringId}`, { headers: { accept: 'application/activity+json' } })).status, 401, 'never unsigned');

    // ── Ring servers only (decision 7) ──
    // A Mastodon account with the live code: its Join is refused, never a request.
    const join = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.base}/activities/j1`, type: 'Join', actor: m.actor(), object: `${A.base}/rings/${ringId}`, to: [`${A.base}/rings/${ringId}`], ring: { v: 1, code } };
    assert.equal((await m.post(`${A.base}/rings/${ringId}/inbox`, join)).status, 202);
    assert.equal(A.ctx.ringStore.get(ringId).requests.length, 0, 'a Mastodon account never asks into a ring');
    await A.ctx.federation.queue.drain();
    assert.ok(m.deliveries.some((d) => d.body?.type === 'Reject' && d.body.object?.id === join.id), 'and is answered Reject{Join}');
    // A member asking by a link on a Mastodon host: refused before any Join.
    r = await bo.post('/api/rings/join', { url: `${m.base}/rings/join/abcdefghijk` });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ring_server_only');

    // ── a member's own domain block: no asking into a ring on that domain ──
    assert.equal((await bo.put('/api/me/page', { block_domain: aHost })).status, 200);
    assert.equal((await bo.post('/api/rings/join', { url: link })).status, 404);
    assert.equal((await bo.put('/api/me/page', { unblock_domain: aHost })).status, 200);

    // ── a block holds at approval: ana blocks bo, bo asks, the approval is refused ──
    assert.equal((await c.ana.put('/api/me/page', { block: boAt })).status, 200);
    r = await bo.post('/api/rings/join', { url: link });
    assert.equal(r.status, 200, r.text);
    await B.drain();
    await until(() => A.ctx.ringStore.get(ringId).requests.some((q) => q.handle === boAt), { what: 'bo\'s request' });
    assert.ok(!(await c.ana.get('/api/rings')).body.rings[0].requests.some((q) => q.handle === boAt), 'hidden from the blocker');
    r = await c.ana.post(`/api/rings/${ringId}/requests/${enc(boAt)}`, { approve: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ring_blocked');
    assert.ok(!A.ctx.ringStore.get(ringId).members.some((x) => x.handle === boAt), 'never a member');
    await A.ctx.federation.queue.drain();
    await until(async () => !(await bo.get(`/api/lookup?q=${enc(link)}`)).body.requested, { what: 'bo told (Reject)' });
    // Positive control: unblocked, the same ask is admitted.
    assert.equal((await c.ana.put('/api/me/page', { unblock: boAt })).status, 200);
    assert.equal((await bo.post('/api/rings/join', { url: link })).status, 200);
    await B.drain();
    await until(() => A.ctx.ringStore.get(ringId).requests.some((q) => q.handle === boAt), { what: 'bo\'s second request' });
    assert.equal((await c.ana.post(`/api/rings/${ringId}/requests/${enc(boAt)}`, { approve: true })).status, 200);
    await A.ctx.federation.queue.drain();
    await until(async () => (await bo.get('/api/rings')).body.rings.length === 1, { what: 'the replica on B' });

    // ── a member deletes their account: their server's farewell reaches the home ──
    const bix = await B.member('bix', 'Bix');
    const bixAt = `bix@${B.host}`;
    assert.equal((await bix.post('/api/rings/join', { url: link })).status, 200);
    await B.drain();
    await until(() => A.ctx.ringStore.get(ringId).requests.some((q) => q.handle === bixAt), { what: 'bix\'s request' });
    assert.equal((await c.ana.post(`/api/rings/${ringId}/requests/${enc(bixAt)}`, { approve: true })).status, 200);
    await A.ctx.federation.queue.drain();
    await until(async () => (await bix.get('/api/rings')).body.rings.length === 1, { what: 'bix\'s replica' });
    r = await bix.del('/api/me', { password: PASSWORD });
    assert.equal(r.status, 200, r.text);
    await B.drain();
    await until(() => !A.ctx.ringStore.get(ringId).members.some((x) => x.handle === bixAt), { what: 'bix gone from the ring on A' });

    // ── the joiner's own 3-ring cap at Accept (a race): bea asks at 2 rings,
    //    makes a third meanwhile, and is admitted: her server leaves at once ──
    const bea = await B.member('bea', 'Bea');
    const beaAt = `bea@${B.host}`;
    for (const n of ['one', 'two']) assert.equal((await bea.post('/api/rings', { name: n })).status, 201);
    assert.equal((await bea.post('/api/rings/join', { url: link })).status, 200);
    await B.drain();
    await until(() => A.ctx.ringStore.get(ringId).requests.some((q) => q.handle === beaAt), { what: 'bea\'s request' });
    assert.equal((await bea.post('/api/rings', { name: 'three' })).status, 201);
    assert.equal((await c.ana.post(`/api/rings/${ringId}/requests/${enc(beaAt)}`, { approve: true })).status, 200);
    await A.ctx.federation.queue.drain();
    await B.drain();
    await until(() => !A.ctx.ringStore.get(ringId).members.some((x) => x.handle === beaAt), { what: 'bea left at once' });
    assert.equal((await bea.get('/api/rings')).body.rings.length, 3, 'her three rings, not a fourth');

    // ── the creator leaves: the role passes to bo@B, the home stays on A ──
    assert.equal((await c.ana.post(`/api/rings/${ringId}/leave`)).status, 200);
    assert.equal(A.ctx.ringStore.get(ringId).created_by, boAt, 'the oldest member is the creator now');
    await A.ctx.federation.queue.drain();
    const mine = await until(async () => (await bo.get('/api/rings')).body.rings.find((x) => x.mine), { what: 'bo the creator on B' });
    assert.equal(mine.home_host, aHost, 'the home never moves');
    // bo renames it from B: the home applies it, and B shows what the home says.
    assert.equal((await bo.patch(`/api/rings/${mine.id}`, { name: 'Bo\'s now' })).status, 200);
    await B.drain();
    await until(() => A.ctx.ringStore.get(ringId)?.name === 'Bo\'s now', { what: 'the rename on A' });
    await A.ctx.federation.queue.drain();
    await until(async () => (await bo.get('/api/rings')).body.rings[0]?.name === 'Bo\'s now', { what: 'the rename on B' });
    // bo deletes it from B: gone on both, and its key goes after its last job.
    assert.equal((await bo.del(`/api/rings/${mine.id}`)).status, 200);
    assert.equal((await bo.get('/api/rings')).body.rings.length, 0, 'B drops it at once');
    await B.drain();
    await until(() => !A.ctx.ringStore.get(ringId), { what: 'the ring deleted on A' });
    await A.ctx.federation.queue.drain();
    await until(() => !fs.existsSync(keyFile), { what: 'the ring key removed' });
  } catch (e) {
    if (process.env.RING_DEBUG) {
      const audit = (d) => { try { return fs.readFileSync(`${d}/audit.log`, 'utf8').split('\n').slice(-30).join('\n'); } catch { return ''; } };
      console.log('--- A', audit(A.dir));
      console.log('--- B', B.log().slice(-3000), audit(B.dir));
    }
    throw e;
  } finally {
    await m.close();
    await B.stop();
    await A.close();
  }
});
