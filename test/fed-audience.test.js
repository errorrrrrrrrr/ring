'use strict';
/* Gate: fed-audience, the public, archive and page-off halves, plus what P5
 * must already hold of the room half (spec 3.4, 4.5, 4.9, 10.1, 10.2, 16.3):
 * the leak test over federation. A room post, an archive post and a divider
 * never become a job, never appear in the outbox, `featured` or any collection,
 * and their URLs answer nothing; a page that is off delivers nothing new, empties
 * its outbox and `featured`, and 404s its public posts, while a Delete still
 * recalls what was delivered. Every refusal sits beside the public post that
 * does travel. A spy on the queue sees every job written. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const A = require('../lib/activities');
const { ring } = require('./helpers/social');
const { fedRing, fakeMastodon, remoteFollow } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());

/* Every activity the queue is handed, from now on. */
function spy(h) {
  const seen = [];
  const q = h.ctx.federation.queue;
  const orig = q.enqueue;
  q.enqueue = (activity, recipients, opts) => { seen.push(activity); return orig(activity, recipients, opts); };
  return { all: () => seen, mentions: (id) => seen.filter((a) => JSON.stringify(a).includes(id)) };
}

async function collectionIds(m, base, name = 'ana') {
  const out = [];
  const box = await m.get(`${base}/users/${name}/outbox`);
  assert.equal(box.status, 200, box.text);
  for (let page = box.body.first; page;) {
    const p = await m.get(page);
    out.push(...p.body.orderedItems.map((x) => x.object.id));
    page = p.body.next;
  }
  const featured = await m.get(`${base}/users/${name}/featured`);
  return { outbox: out, featured: featured.body.orderedItems.map((n) => n.id) };
}

test('a room post never leaves: no job, no delivery, not in the outbox or featured, its URL 404s; the public post beside it travels', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    const s = spy(h);
    const r = await ring(c, 'ana', ['bram'], 'Thursday');
    const room = (await c.ana.post('/api/posts', { kind: 'note', note: 'only for the room', audience: r.id })).body;
    const pub = (await c.ana.post('/api/posts', { kind: 'note', note: 'for everyone' })).body;
    await c.ana.patch(`/api/posts/${room.id}`, { note: 'only for the room, edited', pinned: true });
    await c.bram.post(`/api/pages/ana/posts/${room.id}/stamp`, { kaomoji: '✿' });
    await c.ana.patch(`/api/posts/${pub.id}`, { pinned: true });
    await h.ctx.federation.queue.drain();

    assert.deepEqual(s.mentions(room.id), [], 'no job ever names the room post');
    assert.ok(!m.deliveries.some((d) => d.raw.includes(room.id)), 'nothing delivered names it');
    assert.ok(!s.all().some((a) => JSON.stringify(a).includes(r.id)), 'nor the ring');
    assert.deepEqual(s.mentions(pub.id).map((a) => a.type), ['Create', 'Add'], 'positive control: the public post travels');
    assert.ok(m.deliveries.some((d) => d.body.type === 'Create' && d.body.object.id.endsWith(pub.id)));

    const ids = await collectionIds(m, h.base);
    assert.ok(!ids.outbox.some((u) => u.endsWith(room.id)) && !ids.featured.some((u) => u.endsWith(room.id)));
    assert.ok(ids.outbox.some((u) => u.endsWith(pub.id)) && ids.featured.some((u) => u.endsWith(pub.id)));
    assert.equal((await m.get(`${h.base}/users/ana/posts/${room.id}`)).status, 404, 'a follower\'s signed fetch');
    assert.equal((await m.get(`${h.base}/users/ana/posts/${pub.id}`)).status, 200);
    const html = await fetch(`${h.base}/users/ana/posts/${room.id}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(html.status, 404, 'no wall anchor for a room post');
    const rss = await (await fetch(`${h.base}/@ana.rss`)).text();
    assert.ok(!rss.includes(room.id) && rss.includes(pub.id));

    // Deleting the room post recalls nothing from other servers: none had it.
    await c.ana.del(`/api/posts/${room.id}`);
    await h.ctx.federation.queue.drain();
    assert.deepEqual(s.mentions(room.id), []);
    assert.equal((await m.get(`${h.base}/users/ana/posts/${room.id}`)).status, 404, 'a deleted room post is not a 410 either');

    // Keep: a room post re-addressed to Public is a Create for the followers, who never had it.
    const kept = (await c.ana.post('/api/posts', { kind: 'note', note: 'kept for all', audience: r.id })).body;
    assert.deepEqual(s.mentions(kept.id), []);
    assert.equal((await c.ana.post(`/api/posts/${kept.id}/keep`)).status, 200);
    await h.ctx.federation.queue.drain();
    assert.deepEqual(s.mentions(kept.id).map((a) => a.type), ['Create']);
    assert.deepEqual(s.mentions(kept.id)[0].object.to, ['https://www.w3.org/ns/activitystreams#Public']);
  } finally { await m.close(); await h.close(); }
});

test('archive never federates: a lapsed room post makes no job, is in no collection, and its URL 404s to everyone', async () => {
  const { h, c } = await fedRing(['ana', 'bram'], { env: { AUTHORIZED_FETCH: '0' } });
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    const s = spy(h);
    const r = await ring(c, 'ana', ['bram']);
    const room = (await c.ana.post('/api/posts', { kind: 'note', note: 'a week only', audience: r.id })).body;
    const pub = (await c.ana.post('/api/posts', { kind: 'note', note: 'public' })).body;
    clock.advance(8 * 24 * 3600_000);
    h.ctx.ringReset.run();
    assert.equal(h.ctx.pages.load('ana').posts.find((p) => p.id === room.id).audience, 'archive');
    await h.ctx.federation.queue.drain();
    assert.deepEqual(s.mentions(room.id), [], 'the sweep sends nothing to other servers');
    // Unsigned reads too (AUTHORIZED_FETCH=0): 404 for the archive post, 200 for the public one.
    assert.equal((await fetch(`${h.base}/users/ana/posts/${room.id}`, { headers: { accept: 'application/activity+json' } })).status, 404);
    assert.equal((await fetch(`${h.base}/users/ana/posts/${pub.id}`, { headers: { accept: 'application/activity+json' } })).status, 200, 'positive control');
    assert.equal((await m.get(`${h.base}/users/ana/posts/${room.id}`)).status, 404, 'signed as well');
    const ids = await collectionIds(m, h.base);
    assert.ok(!ids.outbox.some((u) => u.endsWith(room.id)));
    assert.ok(ids.outbox.some((u) => u.endsWith(pub.id)));
    await c.ana.del(`/api/posts/${room.id}`);
    await h.ctx.federation.queue.drain();
    assert.deepEqual(s.mentions(room.id), [], 'deleting an archive post sends nothing');
  } finally { await m.close(); await h.close(); }
});

test('a divider never federates', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    const s = spy(h);
    const d = (await c.ana.post('/api/posts', { kind: 'divider', media: { variant: 'stars' } })).body;
    await c.ana.patch(`/api/posts/${d.id}`, { pinned: true });
    await h.ctx.federation.queue.drain();
    assert.deepEqual(s.mentions(d.id), []);
    assert.equal((await m.get(`${h.base}/users/ana/posts/${d.id}`)).status, 404);
    const ids = await collectionIds(m, h.base);
    assert.ok(!ids.outbox.includes(`${h.base}/users/ana/posts/${d.id}`) && !ids.featured.length);
    await c.ana.del(`/api/posts/${d.id}`);
    assert.deepEqual(s.mentions(d.id), []);
  } finally { await m.close(); await h.close(); }
});

test('page off: nothing new delivered, outbox and featured empty, public URLs 404; a Delete still recalls; on again delivers nothing old', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    const before = (await c.ana.post('/api/posts', { kind: 'note', note: 'made while on' })).body;
    await c.ana.patch(`/api/posts/${before.id}`, { pinned: true });
    await h.ctx.federation.queue.drain();
    assert.equal((await m.get(`${h.base}/users/ana/posts/${before.id}`)).status, 200, 'positive control while on');
    const s = spy(h);
    await c.ana.put('/api/me/page', { enabled: false });
    const off = (await c.ana.post('/api/posts', { kind: 'note', note: 'made while off' })).body;
    await c.ana.patch(`/api/posts/${before.id}`, { note: 'edited while off' });
    await c.ana.patch(`/api/posts/${before.id}`, { pinned: false });
    await c.ana.put('/api/me/page', { bio: 'a bio nobody sees while off' });
    await h.ctx.federation.queue.drain();
    assert.deepEqual(s.mentions(off.id), [], 'nothing new');
    assert.deepEqual(s.mentions(before.id), [], 'no edit, no unpin');
    assert.deepEqual(s.all().map((a) => `${a.type}:${a.object.type}`), ['Update:Person'], 'only the Person, now minimal (a bio change while off shows nothing, so sends nothing)');
    assert.ok(!('summary' in s.all()[0].object) && !('icon' in s.all()[0].object));
    const box = await m.get(`${h.base}/users/ana/outbox`);
    assert.deepEqual(box.body.orderedItems, []);
    assert.equal(box.body.first, undefined);
    assert.deepEqual((await m.get(`${h.base}/users/ana/featured`)).body.orderedItems, []);
    assert.equal((await m.get(`${h.base}/users/ana/posts/${before.id}`)).status, 404);
    assert.equal((await fetch(`${h.base}/users/ana/posts/${before.id}`, { headers: { accept: 'text/html' }, redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${h.base}/users/ana`, { headers: { accept: 'application/activity+json' } })).status, 200, 'the actor stays');

    // The switch is not a recall, but a Delete is: it goes even with the page off.
    await c.ana.del(`/api/posts/${before.id}`);
    await h.ctx.federation.queue.drain();
    assert.ok(m.deliveries.some((d) => d.body.type === 'Delete' && d.body.object.id.endsWith(before.id)));
    assert.equal((await m.get(`${h.base}/users/ana/posts/${before.id}`)).status, 404, 'no 410 while off: nothing says it existed');

    await c.ana.put('/api/me/page', { enabled: true });
    await h.ctx.federation.queue.drain();
    assert.deepEqual(s.mentions(off.id), [], 'on again: nothing retroactive');
    const ids = await collectionIds(m, h.base);
    assert.ok(ids.outbox.some((u) => u.endsWith(off.id)), 'posts made while off are in the outbox');
    assert.equal((await m.get(`${h.base}/users/ana/posts/${before.id}`)).status, 410, 'and a deleted public post is a Tombstone again');
  } finally { await m.close(); await h.close(); }
});

test('the outgoing list: only what P5 and P6 send may leave, whatever an emit hands it', async () => {
  const { h } = await fedRing(['ana']);
  try {
    const o = h.base;
    const leave = (a) => h.ctx.federation.mayLeave(a);
    const post = { id: 'pabc', kind: 'note', note: 'x', audience: 'public', created_at: clock.iso() };
    const room = { ...post, audience: 'ring_0123456789abcdef0123' };
    const ctx = { origin: o, name: 'ana' };
    assert.equal(leave(A.createPost(post, ctx)), true, 'positive control: a public Create');
    assert.equal(leave(A.updatePost(post, ctx)), true);
    assert.equal(leave(A.deletePost(post, { ...ctx, deleted: clock.iso() })), true);
    assert.equal(leave(A.pinPost(post, { ...ctx, pinned: true })), true);
    assert.equal(leave(A.createPost(room, ctx)), false, 'a room Create');
    assert.equal(leave(A.updatePost(room, ctx)), false, 'a room Update');
    assert.equal(leave(A.deletePost(room, { ...ctx, deleted: clock.iso() })), false, 'a room Delete');
    const sneaky = A.createPost(post, ctx);
    sneaky.object.audience = `${o}/rings/ring_0123456789abcdef0123`;
    assert.equal(leave(sneaky), false, 'a public-looking Note with an audience');
    const roomTerm = A.createPost(post, ctx);
    roomTerm.object.ring.room = `${o}/rings/x`;
    assert.equal(leave(roomTerm), false, 'a Note carrying ring.room');
    const reply = A.createComment({ origin: o, name: 'ana', commentId: 'lc_x', postUrl: `${o}/users/bram/posts/p1`, postAuthor: `${o}/users/bram`, postAuthorHandle: 'bram', body: 'hi', published: clock.iso() });
    assert.equal(leave(reply), false, 'a comment on a post HERE never leaves');
    // P6: a stamp, a comment and a Follow aimed at another server leave; a room's never.
    assert.equal(leave(A.like({ origin: o, name: 'ana', stampId: 'stmp_x', postUrl: 'https://m.example/p/1', postAuthor: 'https://m.example/u', face: '✿' })), true, 'a stamp on a remote post (P6)');
    assert.equal(leave(A.like({ origin: o, name: 'ana', stampId: 'stmp_x', postUrl: 'https://m.example/p/1', postAuthor: 'https://m.example/u', face: '✿', group: `${o}/rings/ring_0123456789abcdef0123` })), false, 'a room stamp (P7)');
    assert.equal(leave(A.like({ origin: o, name: 'ana', stampId: 'stmp_x', postUrl: 'https://m.example/p/1', postAuthor: 'https://m.example/u', face: 'hi', custom: true })), false, 'a custom face (rooms only)');
    assert.equal(leave(A.like({ origin: o, name: 'ana', stampId: 'stmp_x', postUrl: `${o}/users/bram/posts/p1`, postAuthor: `${o}/users/bram`, face: '✿' })), false, 'a stamp on a post here never leaves');
    const remoteReply = A.createComment({ origin: o, name: 'ana', commentId: 'lc_x', postUrl: 'https://m.example/p/1', postAuthor: 'https://m.example/u', postAuthorHandle: 'u@m.example', body: 'hi', published: clock.iso() });
    assert.equal(leave(remoteReply), true, 'a comment on a remote post (P6)');
    const publicReply = A.createComment({ origin: o, name: 'ana', commentId: 'lc_x', postUrl: 'https://m.example/p/1', postAuthor: 'https://m.example/u', postAuthorHandle: 'u@m.example', body: 'hi', published: clock.iso() });
    publicReply.object.to = ['https://www.w3.org/ns/activitystreams#Public'];
    assert.equal(leave(publicReply), false, 'a comment addressed as a public post');
    assert.equal(leave(A.follow({ origin: o, name: 'ana', object: 'https://m.example/u' })), true, 'a Follow out (P6)');
    assert.equal(leave(A.follow({ origin: o, name: 'ana', object: `${o}/users/bram` })), false, 'a Follow of a member here never leaves');
    assert.equal(leave(A.deletePerson({ origin: o, name: 'ana' })), true, 'the farewell (P6)');
    const otherGone = A.deletePerson({ origin: o, name: 'ana' });
    otherGone.object = `${o}/users/bram`;
    assert.equal(leave(otherGone), false, 'a Delete of another Person');
    assert.equal(leave(A.joinGroup({ origin: o, name: 'ana', ringId: 'ring_x', code: 'c' })), false, 'a ring act (P7)');
    const notMine = A.createPost(post, { origin: o, name: 'bram' });
    notMine.actor = `${o}/users/ana`;
    assert.equal(leave(notMine), false, 'a Note attributed to someone else');
    const person = A.updatePerson({ origin: o, name: 'ana', person: { id: `${o}/users/bram`, type: 'Person' } });
    assert.equal(leave(person), false, 'an Update of another Person');

    // And the door itself: whatever an emit hands the remote part, only the slice becomes a job.
    const { fakeMastodon: fm } = require('./helpers/fediverse');
    const m = await fm();
    try {
      await h.ctx.federation.actors.resolve(m.actor());
      const q = h.ctx.federation.queue;
      assert.equal(h.ctx.federation.remote(A.createPost(room, ctx), [m.actor()]), null, 'a room Create handed to a remote actor');
      assert.equal(h.ctx.federation.remote(reply, [m.actor()]), null);
      assert.equal(h.ctx.federation.remote(A.like({ origin: o, name: 'ana', stampId: 'stmp_x', postUrl: `${o}/users/bram/posts/p1`, postAuthor: m.actor(), face: '✿' }), [m.actor()]), null, 'a stamp on a post here, handed to a remote actor');
      assert.equal(q.depth(), 0, 'no job written');
      assert.ok(h.ctx.federation.remote(A.createPost(post, ctx), [m.actor()]), 'positive control: a public Create');
      assert.equal(q.depth(), 1);
    } finally { await m.close(); }
  } finally { await h.close(); }
});

test('the room half (P7): a ring\'s activities leave only for its current members\' Ring servers; never a follower, never Mastodon, never a non-member', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'eve'], verify: false });
  try {
    // eve follows ana (a follower who must never get the room); bob is a ring
    // member on a server that declares itself a Ring server.
    await remoteFollow(h, c, m, 'ana', { as: 'eve' });
    await h.ctx.federation.actors.resolve(m.actor('bob'));
    h.ctx.federation.hosts.setSoftware(m.host, { software: 'ring', version: '0.1.0', ring_protocol: 1 });
    const r = await ring(c, 'ana', []);
    const bobAt = `bob@${m.host}`;
    h.ctx.ringStore.update((rings) => { rings.find((x) => x.id === r.id).members.push({ handle: bobAt, joined_at: clock.iso() }); return rings; });
    const s = spy(h);
    const before = m.deliveries.length;
    const room = (await c.ana.post('/api/posts', { kind: 'note', note: 'for the room', audience: r.id })).body;
    await h.ctx.federation.queue.drain();
    const got = m.deliveries.slice(before).filter((d) => d.raw.includes(room.id));
    assert.equal(got.length, 1, 'one delivery of the room post');
    assert.equal(got[0].body.type, 'Announce', 'the Group passes it on');
    assert.equal(got[0].body.actor, `${h.base}/rings/${r.id}`);
    assert.match(got[0].headers.signature, new RegExp(`keyId="${h.base}/rings/${r.id}#main-key"`), 'signed with the ring key');
    assert.ok(got[0].body.to.includes(m.actor('bob')) && !got[0].body.to.includes(m.actor('eve')), 'to the members, not the follower');
    assert.equal(got[0].path, '/inbox', 'once, to the member\'s server');
    assert.ok(!s.mentions(room.id).some((a) => JSON.stringify(a).includes('followers')), 'no followers collection anywhere');
    // An Announce of the room handed to a NON-member: no job (the outgoing gate).
    const before2 = s.all().length;
    const ann = A.announce({ origin: h.base, ringId: r.id, activity: A.createPost({ ...h.ctx.pages.post('ana', room.id) }, { origin: h.base, name: 'ana' }), to: [m.actor('eve')] });
    assert.equal(h.ctx.federation.remote(ann, [m.actor('eve')], { origin: h.base }), null, 'a non-member never gets the room');
    assert.notEqual(h.ctx.federation.remote(ann, [m.actor('bob')], { origin: h.base }), null, 'positive control: a member does');
    assert.equal(s.all().length, before2 + 1);
    // The member's server is no longer a Ring server (Mastodon): nothing goes.
    h.ctx.federation.hosts.setSoftware(m.host, { software: 'mastodon', version: '4.3.0' });
    const before3 = m.deliveries.length;
    const room2 = (await c.ana.post('/api/posts', { kind: 'note', note: 'second', audience: r.id })).body;
    await h.ctx.federation.queue.drain();
    assert.ok(!m.deliveries.slice(before3).some((d) => d.raw.includes(room2.id)), 'never to Mastodon');
  } finally { await m.close(); await h.close(); }
});
