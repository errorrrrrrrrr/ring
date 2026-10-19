'use strict';
/* Gate: named rings (spec 16.2 "rings", 3.6, 4.7). The caps (3 per member, 6
 * counting requests, the joiner's cap at ask and at approval); the link mints
 * with expiry, asks, rotates, closes, drops requests; opaque 404s, no peephole;
 * THE LEAK TEST (a room post never reaches Public, the square or another room,
 * not even by edit); ring-mates stamp unpublished room posts; the image half
 * (mate 200, outsider 404, kicked member 404 at once); kick, creator handoff,
 * delete, dissolve. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { crowd, ring, note, codeOf, befriend } = require('./helpers/social');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

test('create: signed in only, a name, whitespace collapsed, 3 per member; a link and a Group shape come with it', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    assert.equal((await h.client().post('/api/rings', { name: 'X' })).status, 401);
    let r = await c.ana.post('/api/rings', { name: '  Print   Club  ' });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'Print Club');
    assert.equal(r.body.mine, true);
    assert.match(r.body.id, /^ring_[0-9a-f]{20}$/);
    assert.deepEqual(r.body.members.map((m) => m.handle), ['ana']);
    assert.match(r.body.join.url, new RegExp(`^${h.base}/rings/join/[A-Za-z0-9_-]{27}$`));
    assert.ok(Date.parse(r.body.join.expires_at) > Date.now() + 13 * 86400_000, 'the link expires on its own, in 14 days');
    const row = h.ctx.ringStore.get(r.body.id);
    assert.equal(row.ap_id, `${h.base}/rings/${r.body.id}`, 'a home row is shaped like its Group');
    assert.equal(row.home, true);
    assert.equal(row.rev, 1);
    assert.equal((await c.ana.post('/api/rings', { name: '   ' })).body.error, 'ring_name_required');
    await c.ana.post('/api/rings', { name: 'Second' });
    await c.ana.post('/api/rings', { name: 'Third' });
    r = await c.ana.post('/api/rings', { name: 'Fourth' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ring_limit', 'a fourth is refused: 3 per member, hard');
    const mine = (await c.ana.get('/api/rings')).body;
    assert.equal(mine.rings.length, 3);
    assert.equal(mine.max_members, 6);
    for (const x of mine.rings.filter((x) => x.name !== 'Print Club')) assert.equal((await c.ana.del(`/api/rings/${x.id}`)).status, 200);
    assert.equal((await c.ana.get('/api/rings')).body.rings.length, 1);
  } finally { await h.close(); }
});

test('the join link asks, never admits; opaque to outsiders; no peephole', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    const made = (await c.ana.post('/api/rings', { name: 'Print Club' })).body;
    const id = made.id;
    const code = codeOf(made);
    assert.equal((await c.bram.post(`/api/rings/${id}/link`)).status, 404, 'a non-member cannot mint a link');
    assert.equal((await c.bram.get(`/api/rings/${id}/feed`)).status, 404, 'nor read the feed');
    assert.equal((await c.bram.patch(`/api/rings/${id}`, { name: 'Mine' })).status, 404, 'nor rename');
    assert.equal((await c.bram.get('/api/rings')).body.rings.length, 0, 'holding a link lists nothing');
    assert.equal((await h.client().get(`/api/rings/join/${code}`)).status, 401);
    assert.equal((await c.bram.get('/api/rings/join/not-a-real-code')).status, 404);

    let r = await c.bram.get(`/api/rings/join/${code}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Print Club');
    assert.equal(r.body.offered_by, 'Ana Tester');
    assert.equal(r.body.members, 1);
    assert.equal(r.body.already_member, false);
    assert.equal(r.body.full, false);
    assert.equal(r.body.at_my_cap, false);
    assert.ok(!JSON.stringify(r.body).includes('"ana"'), 'a count, never the membership');

    r = await c.bram.post(`/api/rings/join/${code}`);
    assert.deepEqual(r.body, { requested: true, name: 'Print Club' }, 'a request, not a seat');
    assert.equal((await c.bram.get(`/api/rings/${id}/feed`)).status, 404, 'a pending requester sees nothing');
    assert.deepEqual((await c.bram.post(`/api/rings/join/${code}`)).body, { requested: true, name: 'Print Club' }, 'asking twice is idempotent');
    assert.equal(h.ctx.ringStore.get(id).requests.length, 1);
    r = await c.ana.get('/api/rings');
    assert.deepEqual(r.body.rings[0].requests.map((q) => q.handle), ['bram'], 'members see who asks');
    r = await c.ana.get('/api/inbox');
    assert.deepEqual(r.body.join_requests.map((q) => [q.ring.name, q.handle]), [['Print Club', 'bram']], 'and so does their inbox');
    assert.equal(r.body.unseen, 1, 'counted');
    assert.equal((await c.dora.post(`/api/rings/${id}/requests/bram`, { approve: true })).status, 404, 'a non-member approves nobody');
    r = await c.ana.post(`/api/rings/${id}/requests/bram`, { approve: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members.map((m) => m.handle), ['ana', 'bram']);
    assert.equal(r.body.requests.length, 0, 'the request is spent');
    assert.equal(h.ctx.ringStore.get(id).rev, 3, 'each change bumps rev: create 1, the ask 2, the approval 3');
    await c.coco.post(`/api/rings/join/${code}`);
    r = await c.bram.post(`/api/rings/${id}/requests/coco`, { approve: false });
    assert.equal(r.status, 200);
    assert.ok(!r.body.members.some((m) => m.handle === 'coco'), 'declining admits nobody');
    await c.coco.post(`/api/rings/join/${code}`);
    r = await c.ana.post(`/api/rings/${id}/requests/coco`, { approve: true });
    assert.ok(r.body.members.some((m) => m.handle === 'coco'), 'asking again after a decline works');
    assert.equal((await c.ana.post(`/api/rings/${id}/requests/nobody`, { approve: true })).status, 404);
    // A pasted link asks the same way.
    r = await c.dora.post('/api/rings/join', { url: `${h.base}/rings/join/${code}` });
    assert.deepEqual(r.body, { requested: true, name: 'Print Club' });
    assert.equal((await c.dora.post('/api/rings/join', { url: 'https://elsewhere.example/rings/join/abc' })).status, 404, 'P7: another server\'s link');
  } finally { await h.close(); }
});

test('rotate and close: any member; the old code dies; both drop the queue; reopen', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    const { id, code } = await ring(c, 'ana', ['bram']);
    let r = await c.bram.post(`/api/rings/${id}/link`);
    assert.equal(r.status, 200);
    const code2 = codeOf(r.body);
    assert.notEqual(code2, code, 'any member rotates');
    assert.equal((await c.dora.get(`/api/rings/join/${code}`)).status, 404, 'the old code dies at once');
    r = await c.ana.del(`/api/rings/${id}/link`);
    assert.equal(r.body.join, null, 'switched off: the ring stays, the door closes');
    assert.equal((await c.dora.post(`/api/rings/join/${code2}`)).status, 404);
    r = await c.ana.post(`/api/rings/${id}/link`);
    const code3 = codeOf(r.body);
    await c.dora.post(`/api/rings/join/${code3}`);
    assert.equal(h.ctx.ringStore.get(id).requests.length, 1);
    r = await c.ana.post(`/api/rings/${id}/link`);
    assert.equal(r.body.requests.length, 0, 'rotating drops the requests the old code let in');
    await c.dora.post(`/api/rings/join/${codeOf(r.body)}`);
    r = await c.ana.del(`/api/rings/${id}/link`);
    assert.equal(r.body.requests.length, 0, 'switching off clears the queue too');
  } finally { await h.close(); }
});

test('the 6 cap counts requests; the joiner\'s 3-ring cap bites at ask and at approval', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora', 'edda', 'finn', 'gus']);
  try {
    const { id, code } = await ring(c, 'ana', ['bram', 'coco', 'dora', 'edda']);
    await c.finn.post(`/api/rings/join/${code}`);   // the sixth seat, held by a request
    let r = await c.gus.get(`/api/rings/join/${code}`);
    assert.equal(r.body.full, true, 'the preview says full');
    r = await c.gus.post(`/api/rings/join/${code}`);
    assert.equal(r.body.error, 'ring_full', 'a seventh cannot even ask: the request holds the seat');
    await c.ana.post(`/api/rings/${id}/requests/finn`, { approve: true });
    assert.equal(h.ctx.ringStore.get(id).members.length, 6);
    assert.equal((await c.ana.post(`/api/rings/${id}/link`)).body.error, 'ring_full', 'a full ring mints no link');
    assert.equal((await c.ana.del(`/api/rings/${id}/members/edda`)).status, 200, 'the creator frees a seat');
    const fresh = codeOf((await c.ana.post(`/api/rings/${id}/link`)).body);

    for (const n of ['G1', 'G2', 'G3']) await c.gus.post('/api/rings', { name: n });
    r = await c.gus.get(`/api/rings/join/${fresh}`);
    assert.equal(r.body.at_my_cap, true, 'the preview warns gus');
    assert.equal((await c.gus.post(`/api/rings/join/${fresh}`)).body.error, 'ring_limit', 'his own server refuses to ask');
    const gusRings = (await c.gus.get('/api/rings')).body.rings;
    await c.gus.del(`/api/rings/${gusRings[0].id}`);
    assert.equal((await c.gus.post(`/api/rings/join/${fresh}`)).body.requested, true, 'below the cap, the same link works');
    // He fills his third seat while the request waits: approval re-checks, his server leaves at once.
    await c.gus.post('/api/rings', { name: 'G4' });
    r = await c.ana.post(`/api/rings/${id}/requests/gus`, { approve: true });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'ring_limit_them');
    const row = h.ctx.ringStore.get(id);
    assert.ok(!row.members.some((m) => m.handle === 'gus') && !row.requests.some((q) => q.handle === 'gus'), 'not a member, and the request is spent');
  } finally { await h.close(); }
});

test('an approval after the link expired is refused and spends the request; housekeeping closes expired links', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    const made = (await c.ana.post('/api/rings', { name: 'Print Club' })).body;
    await c.bram.post(`/api/rings/join/${codeOf(made)}`);
    clock.advance(15 * 86400_000);
    let r = await c.ana.post(`/api/rings/${made.id}/requests/bram`, { approve: true });
    assert.equal(r.body.error, 'join_expired');
    assert.equal(h.ctx.ringStore.get(made.id).requests.length, 0);
    assert.equal((await c.bram.get(`/api/rings/join/${codeOf(made)}`)).status, 404, 'an expired code opens nothing');
    const out = h.ctx.housekeeping.run();
    assert.equal(out.join_codes, 1);
    assert.equal(h.ctx.ringStore.get(made.id).join, null);
    r = await c.ana.post(`/api/rings/${made.id}/link`);
    assert.ok(r.body.join, 'a fresh link opens the door again');
  } finally { await h.close(); }
});

test('the room: only what was posted into it, no public page needed; THE LEAK TEST', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'finn']);
  try {
    const { id } = await ring(c, 'ana', ['bram', 'coco']);
    const other = (await c.ana.post('/api/rings', { name: 'Other' })).body.id;
    await befriend(c, 'finn', 'ana');
    await befriend(c, 'finn', 'bram');
    await note(c.ana, 'ana was here', id);
    await note(c.bram, 'bram in the studio', id);
    const roomPost = (await note(c.ana, 'room secret', id)).body;
    assert.equal(roomPost.audience, id);
    await c.ana.put('/api/me/page', { enabled: true });
    await note(c.ana, 'square hello');

    let r = await c.coco.get(`/api/rings/${id}/feed`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ring, { id, name: 'Print Club' });
    let blob = JSON.stringify(r.body.posts);
    assert.ok(blob.includes('ana was here') && blob.includes('bram in the studio') && blob.includes('room secret'), 'room posts ride with no page on');
    assert.ok(!blob.includes('square hello'), 'a public post never mirrors into a room');
    assert.ok(r.body.posts.every((p) => p.audience === id && p.author.handle && p.author.name && p.expires_at));
    assert.equal(r.body.ends, true);
    assert.ok(!('next_cursor' in r.body));
    assert.ok(JSON.stringify((await c.ana.get(`/api/rings/${id}/feed`)).body.posts).includes('ana was here'), 'your own room posts too: one board');

    // THE LEAK TEST: the wall, the square, Friends, another room, the AP-shaped URL in the payload.
    blob = JSON.stringify((await h.client().get('/api/pages/ana')).body);
    assert.ok(blob.includes('square hello') && !blob.includes('room secret'), 'the wall: Public only');
    blob = JSON.stringify((await c.finn.get('/api/feed')).body);
    assert.ok(blob.includes('square hello') && !blob.includes('room secret') && !blob.includes('bram in the studio'), 'the square: never a room post');
    blob = JSON.stringify((await c.finn.get('/api/feed/friends')).body);
    assert.ok(!blob.includes('room secret') && !blob.includes('bram in the studio'), 'Friends stays permission-free');
    blob = JSON.stringify((await c.ana.get(`/api/rings/${other}/feed`)).body);
    assert.ok(!blob.includes('room secret'), 'no other room sees it');
    // Not even by edit.
    r = await c.ana.patch(`/api/posts/${roomPost.id}`, { audience: 'public', note: 'moved?' });
    assert.equal(r.body.audience, id, 'an edit cannot move a post out of its room');
    assert.ok(!JSON.stringify((await h.client().get('/api/pages/ana')).body).includes('moved?'));
    // Addressing.
    assert.equal((await c.finn.post('/api/posts', { kind: 'note', note: 'x', audience: id })).body.error, 'not_in_ring', 'a ring you are not in');
    assert.equal((await c.ana.post('/api/posts', { kind: 'note', note: 'x', audience: 'ring_somewhere_else' })).body.error, 'not_in_ring', 'the audience shape is checked');
    assert.equal((await c.ana.post('/api/posts', { kind: 'note', note: 'x', audience: 'ring_0123456789abcdef0123' })).body.error, 'not_in_ring', 'a well-shaped id of no ring');
    assert.equal((await c.ana.post('/api/posts', { kind: 'note', note: 'x', audience: 'archive' })).body.error, 'archive_refused');
    // Out of the room, out of the view.
    await c.ana.del(`/api/rings/${id}/members/coco`);
    assert.equal((await c.coco.get(`/api/rings/${id}/feed`)).status, 404, 'a kicked member: opaque at once');
  } finally { await h.close(); }
});

test('reacting to what the room shows: mates stamp unpublished room posts; outsiders 404; the owner still outranks', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'finn']);
  try {
    const { id } = await ring(c, 'ana', ['coco']);
    const p = (await note(c.ana, 'room note', id)).body.id;
    const path = `/api/pages/ana/posts/${p}`;
    let r = await c.coco.post(`${path}/stamp`, { kaomoji: 'ᕕ( ᐛ )ᕗ' });
    assert.equal(r.status, 200, 'a ring-mate stamps an UNPUBLISHED room post');
    r = await c.coco.get(`/api/rings/${id}/feed`);
    assert.ok(r.body.posts[0].stamps.some((s) => s.kaomoji === 'ᕕ( ᐛ )ᕗ'), 'it lands on the board');
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: '(⊙_⊙)' })).body.action, 'changed', 'the full palette in the room, friends or not');
    assert.equal((await c.finn.post(`${path}/stamp`, { kaomoji: '(⌒‿⌒)' })).status, 404, 'an outsider cannot stamp what they cannot see');
    assert.equal((await c.coco.post(`${path}/comment`, { body: 'hi' })).body.error, 'comments_friends_only', 'membership implies nothing pairwise');
    await befriend(c, 'coco', 'ana');
    assert.equal((await c.coco.post(`${path}/comment`, { body: 'hi' })).status, 200, 'a friend in the room comments');
    await c.ana.put('/api/me/page', { stamps_off: true });
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: '＼(^o^)／' })).body.error, 'stamps_closed', 'stamps off still refuses a mate');
    await c.ana.put('/api/me/page', { stamps_off: false, block: 'coco' });
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: '＼(^o^)／' })).body.error, 'stamps_closed', 'a blocked mate is refused, opaquely');
    assert.equal((await c.ana.get(`/api/rings/${id}/feed`)).body.posts[0].stamps.length, 0, 'and their stamps are gone from the board');
  } finally { await h.close(); }
});

test('Keep: refused while the page is off (the room keeps it); then to Public, the author\'s verb alone', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    const { id } = await ring(c, 'ana', ['bram']);
    const p = (await note(c.ana, 'keep guard', id)).body.id;
    let r = await c.ana.post(`/api/posts/${p}/keep`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'page_off');
    r = await c.ana.get(`/api/rings/${id}/feed`);
    assert.equal(r.body.me_page_off, true);
    assert.ok(r.body.posts.some((x) => x.id === p), 'the refused post is still in the room');
    assert.equal((await c.bram.post(`/api/posts/${p}/keep`)).status, 404, 'Keep is the author\'s alone');
    await c.ana.put('/api/me/page', { enabled: true });
    r = await c.ana.post(`/api/posts/${p}/keep`);
    assert.equal(r.status, 200);
    assert.equal(r.body.audience, 'public');
    assert.ok(!(await c.bram.get(`/api/rings/${id}/feed`)).body.posts.some((x) => x.id === p), 'it left the room');
    assert.ok((await h.client().get('/api/pages/ana')).body.posts.some((x) => x.id === p), 'and is on the wall');
    assert.equal((await c.ana.post(`/api/posts/${p}/keep`)).status, 200, 'idempotent');
  } finally { await h.close(); }
});

test('the image half of the grant: mate 200, outsider 404, a non-room image 404, kicked 404 at once; no-store', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'finn']);
  try {
    const { id } = await ring(c, 'ana', ['bram', 'coco']);
    const roomImg = (await c.bram.upload(await png())).body.key;
    const loose = (await c.bram.upload(await png())).body.key;
    await c.bram.put('/api/me/page', { enabled: true });
    let r = await c.bram.post('/api/posts', { kind: 'image', media: { key: roomImg, alt: 'a room image' }, audience: id });
    assert.equal(r.status, 201);
    r = await c.coco.get(`/api/rings/${id}/feed`);
    const card = r.body.posts.find((x) => x.image_key === roomImg);
    assert.ok(card?.image_url.startsWith('/api/images/'), 'same-origin: the viewer\'s session rides along');
    const ok = await c.coco.bytes(`/api/images/${roomImg}/web`);
    assert.equal(ok.status, 200, 'a ring-mate loads a room image of a page that is on');
    assert.equal(ok.headers.get('cache-control'), 'private, no-store', 'room images are never cached');
    assert.equal((await c.coco.bytes(`/api/images/${roomImg}/thumb`)).status, 200);
    assert.equal((await c.coco.get(`/api/images/${loose}/web`)).status, 404, 'his other images stay 404: the grant is the room');
    assert.equal((await c.finn.get(`/api/images/${roomImg}/web`)).status, 404, 'an outsider gets nothing, though his page is on');
    assert.equal((await h.client().get(`/api/images/${roomImg}/web`)).status, 404, 'nor a stranger');
    await c.bram.put('/api/me/page', { enabled: false });
    assert.equal((await c.coco.bytes(`/api/images/${roomImg}/web`)).status, 200, 'page off: the room still sees it');
    await c.ana.del(`/api/rings/${id}/members/coco`);
    assert.equal((await c.coco.get(`/api/images/${roomImg}/web`)).status, 404, 'a kicked member: 404 at once');
  } finally { await h.close(); }
});

test('rename, leave, kick, creator handoff, delete, dissolve', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora', 'gus']);
  try {
    const { id } = await ring(c, 'ana', ['bram', 'coco', 'dora']);
    let r = await c.coco.patch(`/api/rings/${id}`, { name: 'Print  Club II' });
    assert.equal(r.body.name, 'Print Club II', 'any member renames');
    assert.equal((await c.coco.patch(`/api/rings/${id}`, { name: ' ' })).body.error, 'ring_name_required');
    assert.equal((await c.coco.del(`/api/rings/${id}/members/dora`)).body.error, 'ring_creator_only', 'a non-creator cannot kick');
    assert.equal((await c.ana.del(`/api/rings/${id}/members/ana`)).body.error, 'leave_instead');
    assert.equal((await c.ana.del(`/api/rings/${id}/members/gus`)).status, 404, 'not a member');
    r = await c.ana.del(`/api/rings/${id}/members/dora`);
    assert.ok(!r.body.members.some((m) => m.handle === 'dora'));
    assert.ok(!(await c.dora.get('/api/rings')).body.rings.some((x) => x.id === id), 'the removed member no longer sees it');
    r = await c.ana.post(`/api/rings/${id}/leave`);
    assert.deepEqual(r.body, { ok: true, dissolved: false });
    const after = (await c.bram.get('/api/rings')).body.rings.find((x) => x.id === id);
    assert.equal(after.created_by, 'bram', 'the role passes to the oldest remaining member');
    assert.equal(after.mine, true);
    assert.equal((await c.coco.del(`/api/rings/${id}`)).body.error, 'ring_creator_only');
    assert.equal((await c.bram.del(`/api/rings/${id}`)).status, 200);
    assert.equal((await c.coco.get('/api/rings')).body.rings.length, 0, 'gone for everyone');
    assert.equal((await c.coco.get(`/api/rings/${id}/feed`)).status, 404);
    r = await c.gus.post('/api/rings', { name: 'Solo' });
    assert.deepEqual((await c.gus.post(`/api/rings/${r.body.id}/leave`)).body, { ok: true, dissolved: true }, 'the last to leave dissolves it');
    assert.equal(h.ctx.ringStore.get(r.body.id), null);
  } finally { await h.close(); }
});

test('rings.json: a bad id, a bad handle and a duplicate never survive a read', async () => {
  const { h } = await crowd(['ana']);
  try {
    const fs = require('node:fs');
    fs.writeFileSync(h.ctx.paths.rings, JSON.stringify([
      { id: 'ring_bad', members: [{ handle: 'ana' }] },
      { id: 'ring_0123456789abcdef0123', name: 'ok', members: [{ handle: 'ana' }, { handle: 'NOT A HANDLE' }], requests: [{ handle: 'ana' }] },
      { id: 'ring_0123456789abcdef0123', members: [{ handle: 'ana' }] },
      { id: 'ring_0123456789abcdef0124', members: [] },
    ]));
    const rings = h.ctx.ringStore.load();
    assert.equal(rings.length, 1);
    assert.deepEqual(rings[0].members.map((m) => m.handle), ['ana']);
    assert.equal(rings[0].requests.length, 0, 'never a member and a requester at once');
  } finally { await h.close(); }
});
