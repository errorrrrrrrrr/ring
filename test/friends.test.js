'use strict';
/* Gate: friends and followers (spec 16.2 "friends", 3.5, 4.6). Recipient-only
 * confirm, a crossing request confirms, unfriend and re-request, no second row
 * on a repeat click, a friend's unfollow severs both ways; the Friends feed:
 * pending feeds nothing, dated posts only, no dividers; followers get no friend
 * rights. Follows: Let follow, Decline, open_follows, a blocked member's follow
 * dropped silently (never answered, so never an oracle), both files in one
 * tick. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const clock = require('../lib/clock');
const { crowd, befriend, note } = require('./helpers/social');

test.afterEach(() => clock.reset());

test('a request is confirmed by its recipient only; a repeat click makes no second row', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    assert.equal((await h.client().post('/api/friends', { handle: 'bram' })).status, 401, 'anonymous cannot ask');
    let r = await c.ana.post('/api/friends', { handle: 'bram' });
    assert.equal(r.body.status, 'pending');
    r = await c.ana.post('/api/friends', { handle: 'bram' });
    assert.equal(r.body.status, 'pending', 'a repeat click stays pending');
    assert.equal(h.ctx.follows.load('ana').following.length, 1, 'no second row');
    assert.equal(h.ctx.follows.load('bram').followers.length, 1, 'their side written in the same request');

    r = await c.bram.get('/api/friends');
    assert.deepEqual(r.body.pending_in.map((x) => x.handle), ['ana']);
    assert.equal(r.body.pending_in[0].name, 'Ana Tester');
    assert.equal((await c.ana.post('/api/friends/bram/confirm')).status, 404, 'the requester cannot confirm their own request');
    assert.equal((await c.bram.get('/api/friends/with/ana')).body.status, 'pending');
    r = await c.bram.post('/api/friends/ana/confirm');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'friends');
    assert.equal((await c.ana.get('/api/friends/with/bram')).body.status, 'friends');
    assert.deepEqual((await c.ana.get('/api/friends')).body.friends.map((x) => x.handle), ['bram']);
    // Friendship is two accepted follows, nothing else stored.
    for (const n of ['ana', 'bram']) {
      const f = h.ctx.follows.load(n);
      assert.equal(f.following.length, 1);
      assert.equal(f.followers.length, 1);
      assert.ok([...f.following, ...f.followers].every((x) => x.state === 'accepted'));
    }
  } finally { await h.close(); }
});

test('a crossing request confirms at once; unfriend and re-request', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await befriend(c, 'ana', 'bram');
    assert.equal((await c.ana.del('/api/friends/bram')).status, 200, 'ana unfriends');
    assert.equal((await c.bram.get('/api/friends/with/ana')).body.status, 'none', 'gone from both sides at once');
    assert.equal(h.ctx.follows.load('bram').following.length + h.ctx.follows.load('bram').followers.length, 0);
    let r = await c.ana.post('/api/friends', { handle: 'bram' });
    assert.equal(r.body.status, 'pending', 'ana asks again after unfriending');
    r = await c.bram.post('/api/friends', { handle: 'ana' });
    assert.equal(r.body.status, 'friends', 'a crossing request is mutual consent: friends at once');
    assert.equal((await c.ana.get('/api/friends/with/bram')).body.status, 'friends');
  } finally { await h.close(); }
});

test('a friend\'s unfollow severs both ways', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await befriend(c, 'ana', 'bram');
    const origin = h.base;
    // Bram's server sends only the Undo of his own follow (as Mastodon would).
    const f = h.ctx.follows.load('bram').following[0];
    const A = require('../lib/activities');
    h.ctx.outbox.emit(A.undoFollow({ origin, name: 'bram', follow: { id: f.follow_id, actor: `${origin}/users/bram`, object: `${origin}/users/ana` } }), [`${origin}/users/ana`], { origin });
    // Bram's own row is still his to drop (his server did not here): ana's side must have undone hers.
    assert.equal(h.ctx.follows.load('ana').following.length, 0, 'ana undid her own follow: severed');
    assert.equal(h.ctx.follows.load('ana').followers.length, 0);
    assert.equal(h.ctx.follows.load('bram').followers.length, 0, 'ana\'s Undo reached bram');
    assert.notEqual((await c.ana.get('/api/friends/with/bram')).body.status, 'friends');
  } finally { await h.close(); }
});

test('followers: Let follow, Decline, open_follows; a follower gets no friend rights', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const post = (await note(c.ana, 'hello')).body.id;
    await c.bram.post('/api/friends', { handle: 'ana' });
    let r = await c.ana.get('/api/followers');
    assert.deepEqual(r.body.requests.map((x) => x.handle), ['bram']);
    r = await c.ana.post('/api/followers/bram/accept');
    assert.equal(r.status, 200, 'Let follow');
    r = await c.ana.get('/api/followers');
    assert.deepEqual(r.body.followers.map((x) => x.handle), ['bram'], 'a one-way follower');
    assert.equal((await c.bram.get('/api/friends/with/ana')).body.status, 'pending', 'not friends: ana did not follow back');
    // No friend rights: the nice shelf only, no comments, no Friends feed.
    assert.equal((await c.bram.post(`/api/pages/ana/posts/${post}/stamp`, { kaomoji: '(⊙_⊙)' })).status, 403, 'a follower gets the nice shelf only');
    assert.equal((await c.bram.post(`/api/pages/ana/posts/${post}/comment`, { body: 'hi' })).status, 403, 'a follower cannot comment');
    assert.equal((await c.bram.get('/api/feed/friends')).body.posts.length, 0, 'a follower\'s Friends feed is empty');

    // Decline / remove.
    r = await c.ana.post('/api/followers/bram/reject');
    assert.equal(r.status, 200);
    assert.equal(h.ctx.follows.load('bram').following.length, 0, 'the Reject removed their follow on their side');
    assert.equal((await c.ana.post('/api/followers/bram/reject')).status, 404);

    // open_follows: accepted as a follower unasked; friendship still needs the follow back.
    await c.ana.put('/api/me/page', { open_follows: true });
    await c.coco.post('/api/friends', { handle: 'ana' });
    assert.equal(h.ctx.follows.load('coco').following[0].state, 'accepted');
    assert.equal(h.ctx.follows.load('ana').followers.find((x) => x.handle === 'coco').state, 'accepted');
    assert.equal((await c.coco.get('/api/friends/with/ana')).body.status, 'pending');
    r = await c.ana.post('/api/friends', { handle: 'coco' });
    assert.equal(r.body.status, 'friends', 'Befriend from a follower: the follow back makes friends');
  } finally { await h.close(); }
});

test('befriending: self, unknown, blocked; a blocked member\'s follow is dropped silently', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    assert.equal((await c.ana.post('/api/friends', { handle: 'ana' })).body.error, 'own_handle');
    assert.equal((await c.ana.post('/api/friends', { handle: 'nobody' })).status, 404);
    assert.equal((await c.ana.post('/api/friends', { handle: 'zed@elsewhere.example' })).status, 404, 'P2: a remote handle is not resolvable yet');
    assert.equal((await c.ana.post('/api/friends', {})).status, 400);
    await c.ana.put('/api/me/page', { block: 'bram' });
    assert.equal((await c.ana.post('/api/friends', { handle: 'bram' })).body.error, 'blocked_them');
    const seen = [];
    const untap = h.ctx.outbox.tap(({ activity }) => seen.push(activity.type));
    const r = await c.bram.post('/api/friends', { handle: 'ana' });
    untap();
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'pending', 'dropped silently: the answer a request to anyone gets (never none, which would tell)');
    assert.equal((await c.bram.get('/api/friends/with/ana')).body.status, 'pending', 'it stays a never-answered request on his side');
    assert.deepEqual(seen, ['Follow'], 'no Reject went back');
    assert.equal(h.ctx.follows.load('ana').followers.length, 0, 'nothing waits in ana\'s inbox');
    assert.equal((await c.ana.get('/api/inbox')).body.follow_requests.length, 0);
    assert.equal((await c.ana.get('/api/friends')).body.pending_in.length, 0);
    await c.ana.put('/api/me/page', { unblock: 'bram' });
    assert.equal((await c.bram.post('/api/friends', { handle: 'ana' })).body.status, 'pending', 'positive control: unblocked, the same request lands');
    assert.equal(h.ctx.follows.load('ana').followers.length, 1, 'and now waits in ana\'s inbox');
  } finally { await h.close(); }
});

test('a block severs the follows between them, both ways', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await befriend(c, 'ana', 'bram');
    await c.ana.put('/api/me/page', { block: 'bram' });
    for (const n of ['ana', 'bram']) {
      const f = h.ctx.follows.load(n);
      assert.equal(f.following.length + f.followers.length, 0, `${n}: no edge left`);
    }
  } finally { await h.close(); }
});

test('the Friends feed: friends only, public posts of enabled pages, dated, no dividers, newest first, muted', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    clock.set(Date.parse('2026-10-01T10:00:00Z'));
    await note(c.ana, 'first');
    clock.advance(60_000);
    await c.ana.post('/api/posts', { kind: 'divider', media: { variant: 'stars' } });
    clock.advance(60_000);
    await note(c.ana, 'second');
    clock.reset();
    assert.equal((await h.client().get('/api/feed/friends')).status, 401);
    let r = await c.bram.get('/api/feed/friends');
    assert.equal(r.body.posts.length, 0, 'nothing before any friendship');
    await c.bram.post('/api/friends', { handle: 'ana' });
    r = await c.bram.get('/api/feed/friends');
    assert.equal(r.body.posts.length, 0, 'a pending request feeds nothing');
    await c.ana.post('/api/friends/bram/confirm');
    r = await c.bram.get('/api/feed/friends');
    assert.deepEqual(r.body.posts.map((p) => p.html), ['<p>second</p>', '<p>first</p>'], 'newest first, no divider');
    assert.ok(r.body.posts.every((p) => p.author.handle === 'ana' && p.author.name === 'Ana T.'), 'signed "Firstname L."');
    assert.equal(r.body.ends, true);
    assert.ok(Array.isArray(r.body.palette));
    assert.equal(r.body.me_page_off, true, 'bram\'s own page is off');
    assert.equal((await c.ana.get('/api/feed/friends')).body.posts.length, 0, 'never your own posts');
    // Page off: the friend drops out, live, and is named in `muted`.
    await c.ana.put('/api/me/page', { enabled: false });
    r = await c.bram.get('/api/feed/friends');
    assert.equal(r.body.posts.length, 0);
    assert.deepEqual(r.body.muted.map((m) => [m.handle, m.reason]), [['ana', 'page_off']]);
    await c.ana.put('/api/me/page', { enabled: true });
    assert.equal((await c.bram.get('/api/feed/friends')).body.posts.length, 2, 'on again: restored, live');
  } finally { await h.close(); }
});

test('the wall carries friends { name, handle, url }, and a friendship change shows at once', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    assert.deepEqual((await h.client().get('/api/pages/ana')).body.friends, []);
    await befriend(c, 'bram', 'ana');
    let r = await h.client().get('/api/pages/ana');
    assert.deepEqual(r.body.friends, [{ name: 'Bram Tester', handle: 'bram', url: `${h.base}/@bram` }]);
    await c.bram.patch('/api/me', { display_name: 'Bram Vandenberg' });
    r = await h.client().get('/api/pages/ana');
    assert.equal(r.body.friends[0].name, 'Bram Vandenberg', 'a renamed friend shows renamed (the memo drops)');
    await c.bram.del('/api/friends/ana');
    assert.deepEqual((await h.client().get('/api/pages/ana')).body.friends, []);
  } finally { await h.close(); }
});

test('follows.json is shape-checked on read and never cut', async () => {
  const { h } = await crowd(['ana']);
  try {
    const file = h.ctx.paths.memberFile('ana', 'follows.json');
    fs.mkdirSync(h.ctx.paths.memberDir('ana'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      following: [{ handle: 'bram', state: 'accepted' }, { handle: 'BAD HANDLE', state: 'accepted' }, { handle: 'coco', state: 'weird' }, { handle: 'bram', state: 'pending' }],
      followers: [{ handle: `x@${'a'.repeat(300)}.example`, state: 'pending' }],
    }));
    const f = h.ctx.follows.load('ana');
    assert.deepEqual(f.following.map((x) => x.handle), ['bram'], 'bad shapes and duplicates dropped');
    assert.deepEqual(f.followers, [], 'an over-long handle is dropped, never cut');
  } finally { await h.close(); }
});
