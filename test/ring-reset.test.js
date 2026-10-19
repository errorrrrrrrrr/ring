'use strict';
/* Gate: the ring reset (spec 16.2 "ring-reset", 3.8). Part A drives
 * lib/ring-reset.js pure: the per-post week, the expiry-instant stamp,
 * idempotency, the deleted-ring case, the blast radius, and a crash between the
 * post write and the reaction write re-converging. Part B walks the product on
 * a real server with the clock moved: post to a room, Keep, age past the week,
 * read-time expiry before the sweep, sweep, the room sheds exactly it, the
 * archive holds it, reactions died with it, membership and the link survive,
 * Keep works from the archive. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { RING_POST_TTL_MS, isRoomAudience, ringPostExpiresAt, ringPostLive, sweepRingResets } = require('../lib/ring-reset');
const { crowd, ring, note } = require('./helpers/social');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

const DAY = 86400_000;
const RA = 'ring_aaaaaaaaaaaaaaaaaaaa';
const RG = 'ring_bbbbbbbbbbbbbbbbbbbb';

test('A: seven days exactly; what a room audience is; a post with no date has lapsed', () => {
  assert.equal(RING_POST_TTL_MS, 7 * DAY);
  assert.ok(isRoomAudience(RA) && !isRoomAudience('public') && !isRoomAudience('archive') && !isRoomAudience('') && !isRoomAudience(undefined));
  assert.equal(ringPostExpiresAt({ created_at: '2026-07-14T10:00:00Z' }), Date.parse('2026-07-21T10:00:00Z'));
  assert.equal(ringPostExpiresAt({ created_at: 'junk' }), 0);
  assert.equal(ringPostLive({ audience: RA, created_at: '2026-07-14T10:00:00Z' }, Date.parse('2026-07-21T09:59:59Z')), true);
  assert.equal(ringPostLive({ audience: RA, created_at: '2026-07-14T10:00:00Z' }, Date.parse('2026-07-21T10:00:00Z')), false, 'lapsed AT the instant');
});

function world(now) {
  const OLD = new Date(now - 8 * DAY).toISOString();
  const YOUNG = new Date(now - 6 * DAY).toISOString();
  const stores = {
    ana: { posts: [{ id: 'p1', audience: 'public', created_at: new Date(now - 90 * DAY).toISOString() }, { id: 'p2', audience: RA, created_at: OLD }, { id: 'p3', audience: RA, created_at: YOUNG }, { id: 'p7', audience: RG, created_at: OLD }] },
    bram: { posts: [{ id: 'p4', audience: RA, created_at: OLD }] },
    coco: { posts: [{ id: 'p5', audience: RA, created_at: OLD }] },   // an ex-member
    dora: { posts: [{ id: 'p6', audience: 'public', created_at: OLD }] },
  };
  const stamps = { ana: [{ id: 's1', post_id: 'p2' }, { id: 's2', post_id: 'p1' }, { id: 's3', post_id: 'p3' }], bram: [], coco: [], dora: [] };
  const comments = { ana: [{ id: 'c1', post_id: 'p2' }, { id: 'c2', post_id: 'p1' }], bram: [], coco: [], dora: [] };
  const rings = [{ id: RA, name: 'Print Club', members: [{ handle: 'ana' }, { handle: 'bram' }], join: { code: 'k' } }];
  const saved = [];
  const audits = [];
  const archived = [];
  const deps = {
    nowMs: now, rings, memberNames: Object.keys(stores),
    loadStore: (n) => JSON.parse(JSON.stringify(stores[n])),
    saveStore: (n, s) => { saved.push(n); stores[n] = s; },
    loadStamps: (n) => stamps[n].slice(), saveStamps: (n, r) => { stamps[n] = r; },
    loadComments: (n) => comments[n].slice(), saveComments: (n, r) => { comments[n] = r; },
    audit: (ev, actor, d) => audits.push({ ev, actor, ...d }),
    onArchived: (owner, post, ringId) => archived.push([owner, post.id, ringId]),
  };
  return { OLD, stores, stamps, comments, rings, saved, audits, archived, deps };
}

test('A: the sweep archives lapsed room posts, per post, and takes nothing else', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const w = world(now);
  const membersBefore = JSON.stringify(w.rings);
  const first = sweepRingResets(w.deps);
  assert.equal(first.changed, true);
  const p2 = w.stores.ana.posts.find((p) => p.id === 'p2');
  assert.equal(p2.audience, 'archive');
  assert.equal(p2.archived_from, RA);
  assert.equal(p2.archived_at, new Date(Date.parse(w.OLD) + RING_POST_TTL_MS).toISOString(), 'stamped TO THE EXPIRY INSTANT, not now');
  assert.equal(w.stores.ana.posts.find((p) => p.id === 'p3').audience, RA, 'a 6-day post in the same room stays');
  assert.equal(w.stores.bram.posts[0].audience, 'archive');
  assert.equal(w.stores.coco.posts[0].audience, 'archive', 'an ex-member\'s post moves too: the address counts');
  assert.equal(w.stores.ana.posts.find((p) => p.id === 'p1').audience, 'public', 'public posts are never touched');
  assert.ok(!w.saved.includes('dora'), 'an uninvolved store is not even written');
  const p7 = w.stores.ana.posts.find((p) => p.id === 'p7');
  assert.equal(p7.audience, 'archive');
  assert.equal(p7.archived_from, RG, 'a post of a deleted ring ages onto its author\'s shelf');
  assert.deepEqual(w.stamps.ana.map((s) => s.id), ['s2', 's3'], 'the lapsed post\'s stamp died with it; the rest live');
  assert.deepEqual(w.comments.ana.map((c) => c.id), ['c2']);
  assert.equal(JSON.stringify(w.rings), membersBefore, 'membership and the join link survive');
  const due = w.audits.find((a) => a.ring === RA);
  assert.equal(due.ev, 'ring.reset');
  assert.equal(due.actor, 'system');
  assert.equal(due.posts, 3);
  assert.equal(due.stamps, 1);
  assert.equal(due.comments, 1);
  assert.equal(w.archived.length, 4, 'one reset Delete per archived post (p2, p7, p4, p5)');
  const n = w.saved.length;
  const second = sweepRingResets(w.deps);
  assert.equal(second.changed, false, 'a second sweep does nothing');
  assert.equal(w.saved.length, n);
});

test('A: a crash after the post write re-converges: the next sweep clears the orphaned reactions', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const w = world(now);
  w.deps.saveStamps = () => { throw new Error('disk full'); };
  const lines = [];
  w.deps.log = (l) => lines.push(l);
  sweepRingResets(w.deps);
  assert.ok(lines.some((l) => /skipped ana: disk full/.test(l)), 'the owner is skipped and logged, the rest run');
  assert.equal(w.stores.ana.posts.find((p) => p.id === 'p2').audience, 'archive');
  assert.ok(w.stamps.ana.some((s) => s.id === 's1'), 'the stamp is still there');
  w.deps.saveStamps = (n, r) => { w.stamps[n] = r; };
  sweepRingResets(w.deps);
  assert.ok(!w.stamps.ana.some((s) => s.id === 's1'), 'cleared on the next run, though the post moved earlier');
});

test('B: post, Keep, age, read-time expiry before the sweep, sweep, archive, Keep from the archive', async () => {
  const t0 = Date.parse('2026-10-01T09:00:00Z');
  clock.set(t0);
  const { h, c } = await crowd(['ana', 'bram', 'finn']);
  try {
    const { id } = await ring(c, 'ana', ['bram']);
    await c.ana.put('/api/me/page', { enabled: true });
    const kept = (await note(c.ana, 'keep me', id)).body.id;
    assert.equal((await c.ana.post(`/api/posts/${kept}/keep`)).body.audience, 'public');
    assert.equal((await c.bram.post(`/api/posts/${kept}/keep`)).status, 404, 'Keep is the author\'s alone');
    const img = (await c.ana.upload(await png())).body.key;
    const roomId = (await c.ana.post('/api/posts', { kind: 'image', media: { key: img, alt: '' }, note: 'clears in a week', audience: id })).body.id;
    assert.equal((await c.bram.post(`/api/pages/ana/posts/${roomId}/stamp`, { kaomoji: '(⌒‿⌒)' })).status, 200);
    assert.equal((await c.ana.get('/api/inbox')).body.stamps.length, 1);
    clock.set(t0 + 2 * DAY);
    const youngId = (await note(c.ana, 'still fresh', id)).body.id;
    assert.equal(h.ctx.ringReset.run().changed, false, 'nothing is past its week yet');

    // The hour before the sweep: lapsed, unswept, and already gone to every reader.
    clock.set(t0 + 7 * DAY + 60_000);
    let feed = (await c.bram.get(`/api/rings/${id}/feed`)).body.posts;
    assert.deepEqual(feed.map((p) => p.id), [youngId], 'read-time expiry: the lapsed post is out of the room');
    assert.equal((await c.bram.post(`/api/pages/ana/posts/${roomId}/stamp`, { kaomoji: '✿' })).status, 404, 'nothing to stamp');
    assert.equal((await c.bram.get(`/api/images/${img}/web`)).status, 404, 'its image closes too');
    assert.ok((await c.ana.get('/api/archive')).body.posts.some((p) => p.id === roomId && p.archived_from === id), 'it is on the author\'s shelf already');
    assert.equal(h.ctx.pages.load('ana').posts.find((p) => p.id === roomId).audience, id, 'though the sweep has not run');

    const swept = h.ctx.ringReset.run();
    assert.equal(swept.changed, true);
    assert.deepEqual(swept.resets.map((r) => [r.ring, r.name, r.posts, r.stamps]), [[id, 'Print Club', 1, 1]]);
    assert.equal(h.ctx.ringReset.run().changed, false, 'idempotent on disk');
    feed = (await c.bram.get(`/api/rings/${id}/feed`)).body.posts;
    assert.deepEqual(feed.map((p) => p.id), [youngId], 'the room keeps the younger post');
    const row = h.ctx.ringStore.get(id);
    assert.equal(row.members.length, 2, 'membership survives');
    assert.ok(row.join, 'the join link survives');
    const shelf = (await c.ana.get('/api/archive')).body.posts;
    assert.equal(shelf.length, 1);
    assert.equal(shelf[0].id, roomId);
    assert.equal(shelf[0].archived_from_name, 'Print Club');
    assert.equal(shelf[0].archived_at, new Date(t0 + 7 * DAY).toISOString(), 'the expiry instant (the clock was frozen at t0 when it was posted)');
    assert.equal(shelf[0].stamps_off, true);
    assert.equal(shelf[0].comments_off, true);
    assert.equal((await c.bram.get('/api/archive')).body.posts.length, 0, 'the shelf is per author');
    assert.equal((await h.client().get('/api/archive')).status, 401);
    assert.equal((await c.ana.get('/api/inbox')).body.stamps.length, 0, 'the reaction died with it');
    assert.ok(!JSON.stringify((await c.finn.get('/api/feed')).body).includes(roomId), 'nothing leaked to the square');
    assert.equal((await c.bram.get(`/api/images/${img}/web`)).status, 404, 'archive images: the author\'s alone');
    assert.equal((await c.ana.bytes(`/api/images/${img}/web`)).status, 200);

    const r = await c.ana.post(`/api/posts/${roomId}/keep`);
    assert.equal(r.body.audience, 'public');
    assert.ok(!('archived_from' in r.body));
    assert.equal((await c.ana.get('/api/archive')).body.posts.length, 0, 'the shelf is empty again');
    assert.equal((await h.client().bytes(`/api/images/${img}/web`)).status, 200, 'kept: its image is public');
  } finally { await h.close(); }
});

test('B: the composer can never address the archive', async () => {
  const { h, c } = await crowd(['ana']);
  try {
    assert.equal((await c.ana.post('/api/posts', { kind: 'note', note: 'x', audience: 'archive' })).body.error, 'archive_refused');
  } finally { await h.close(); }
});
