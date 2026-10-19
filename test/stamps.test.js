'use strict';
/* Gate: stamps and comments (spec 16.2 "stamps", "comments"; 3.7): the tiers,
 * comments, the render-time block, the deleted post's crowd, against
 * /api/pages/:name/posts/:id/stamp|comment. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { STAMP_STYLES, FACES, NICE_FACES } = require('../lib/palette');
const { crowd, befriend, note } = require('./helpers/social');

const NICE = '(⌒‿⌒)';
const FULL = '(⊙_⊙)';   // a friend-tier face

async function stage() {
  const s = await crowd(['ana', 'bram', 'coco']);   // bram is ana's friend, coco a stranger
  try {
    await s.c.ana.put('/api/me/page', { enabled: true });
    await befriend(s.c, 'bram', 'ana');
    s.post = (await note(s.c.ana, 'a public note')).body.id;
    s.path = `/api/pages/ana/posts/${s.post}`;
    return s;
  } catch (e) { await s.h.close(); throw e; }
}

const wallPost = async (h, id) => (await h.client().get('/api/pages/ana')).body.posts.find((p) => p.id === id);

test('the palette: 56 faces, 4 styles, 30 nice; no face outside the declared styles', () => {
  assert.equal(FACES.length, 56);
  assert.deepEqual(STAMP_STYLES.map((s) => s.style), ['kaomoji', 'emoji', 'ascii', 'symbols']);
  assert.equal(NICE_FACES.length, 30);
  const declared = STAMP_STYLES.flatMap((s) => s.groups.flatMap((g) => g.faces));
  assert.deepEqual(FACES, declared, 'every face belongs to one of the four styles');
  assert.ok(FACES.every((f) => !/^[a-z]+:[a-z_]+$/.test(f)), 'a face is text, never a named picture (decision 4)');
});

test('who may stamp: signed in, not on their own post, a palette face on Public; signed, no counts, no seen', async () => {
  const { h, c, path } = await stage();
  try {
    assert.equal((await h.client().post(`${path}/stamp`, { kaomoji: NICE })).status, 401, 'anonymous cannot stamp');
    assert.equal((await c.ana.post(`${path}/stamp`, { kaomoji: NICE })).body.error, 'own_post');
    for (const bad of ['mascot:camera', 'mascot:wave']) {
      const r = await c.bram.post(`${path}/stamp`, { kaomoji: bad });
      assert.equal(r.status, 403, `${bad}: a non-palette body on Public is a custom face, and those live in rings`);
    }
    assert.equal((await c.bram.post(`${path}/stamp`, { kaomoji: '   ' })).body.error, 'stamp_invalid');
    assert.equal((await c.bram.post('/api/pages/ana/posts/pzzzzzzzzzzzzzzzz/stamp', { kaomoji: NICE })).status, 404, 'no such post');
    assert.equal((await c.bram.post('/api/pages/nobody/posts/pzzzzzzzzzzzzzzzz/stamp', { kaomoji: NICE })).status, 404);

    let r = await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    assert.equal(r.status, 200);
    assert.equal(r.body.action, 'added');
    const mine = r.body.stamps.find((s) => s.author.handle === 'bram');
    assert.equal(mine.author.name, 'Bram T.', '"Firstname L." on someone else\'s wall');
    assert.equal(mine.author.url, `${h.base}/@bram`, 'signed with a return address');
    r = await c.coco.post(`${path}/stamp`, { kaomoji: NICE });
    assert.equal(r.body.action, 'added', 'a stranger stamps too: never friend-gated');
    const p = await wallPost(h, path.split('/').pop());
    assert.equal(p.stamps.length, 2, 'the faces themselves, no count');
    assert.ok(!JSON.stringify(p).includes('"seen"'), 'seen never leaks');
    assert.ok(!('count' in p) && !JSON.stringify(p).includes('total'), 'nothing counted');
    assert.equal(p.stamps_off, false);
  } finally { await h.close(); }
});

test('tiers: strangers the nice shelf, friends the full palette; toggle and replace, one face per sender', async () => {
  const { h, c, path } = await stage();
  try {
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: FULL })).body.error, 'friends_only', 'a stranger pressing a friend-tier face');
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: NICE })).status, 200, 'the nice shelf works');
    let r = await c.bram.post(`${path}/stamp`, { kaomoji: FULL });
    assert.equal(r.body.action, 'added', 'a friend gets the full palette');
    r = await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    assert.equal(r.body.action, 'changed', 'a different face replaces');
    assert.equal(r.body.stamps.filter((s) => s.author.handle === 'bram').length, 1, 'one face per sender');
    r = await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    assert.equal(r.body.action, 'removed', 'the same face toggles off');
    assert.equal(r.body.mine, '');
    r = await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    assert.equal(r.body.action, 'added', 'and on again');
    // An emoji face with or without U+FE0F is the same face.
    r = await c.coco.post(`${path}/stamp`, { kaomoji: '🌞️' });
    assert.equal(r.body.action, 'changed');
    assert.equal(r.body.mine, '🌞');
  } finally { await h.close(); }
});

test('inbox: received stamps and comments, one unseen count; mark seen; only your own', async () => {
  const { h, c, path } = await stage();
  try {
    await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    await c.bram.post(`${path}/comment`, { body: 'lovely' });
    let r = await c.ana.get('/api/inbox');
    assert.equal(r.body.stamps.length, 1);
    assert.equal(r.body.comments.length, 1);
    assert.equal(r.body.unseen, 2);
    assert.ok(r.body.stamps.every((s) => s.post_id && s.kaomoji && s.author.handle === 'bram' && s.seen === false));
    assert.equal((await c.ana.get('/api/me')).body.unseen, 2, 'GET /api/me says the same number');
    assert.equal((await c.bram.get('/api/inbox')).body.stamps.length, 0, 'you only receive on your own posts');
    r = await c.ana.post('/api/inbox/seen');
    assert.equal(r.body.marked, 2);
    assert.equal((await c.ana.get('/api/inbox')).body.unseen, 0);
    assert.equal((await h.client().get('/api/inbox')).status, 401);
  } finally { await h.close(); }
});

test('removing a stamp: the author takes it back, the owner moderates, a third party gets the opaque 404', async () => {
  const { h, c, path } = await stage();
  try {
    const b = (await c.bram.post(`${path}/stamp`, { kaomoji: NICE })).body.stamps.find((s) => s.author.handle === 'bram');
    const k = (await c.coco.post(`${path}/stamp`, { kaomoji: NICE })).body.stamps.find((s) => s.author.handle === 'coco');
    assert.equal((await h.client().del(`${path}/stamp/${b.id}`)).status, 401);
    assert.equal((await c.coco.del(`${path}/stamp/${b.id}`)).status, 404, 'not theirs: opaque');
    assert.equal((await c.bram.del(`${path}/stamp/${b.id}`)).status, 200, 'the author takes it back');
    assert.equal((await c.ana.del(`${path}/stamp/${k.id}`)).status, 200, 'the owner removes any stamp');
    assert.equal((await wallPost(h, path.split('/').pop())).stamps.length, 0);
  } finally { await h.close(); }
});

test('the owner outranks: per post and page switches, a block (opaque, retroactive, enforced at render)', async () => {
  const { h, c, path, post } = await stage();
  try {
    await c.coco.post(`${path}/stamp`, { kaomoji: NICE });
    // Per post.
    await c.ana.patch(`/api/posts/${post}`, { stamps_off: true });
    let r = await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'stamps_closed');
    assert.equal((await wallPost(h, post)).stamps_off, true, 'the wall says so (the client hides the palette)');
    await c.ana.patch(`/api/posts/${post}`, { stamps_off: false });
    // Page-wide.
    await c.ana.put('/api/me/page', { stamps_off: true });
    assert.equal((await c.bram.post(`${path}/stamp`, { kaomoji: NICE })).body.error, 'stamps_closed');
    await c.ana.put('/api/me/page', { stamps_off: false });
    // A block: the same 403 as closed, and coco's stamp is gone from the wall.
    await c.ana.put('/api/me/page', { block: 'coco' });
    r = await c.coco.post(`${path}/stamp`, { kaomoji: NICE });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'stamps_closed', 'indistinguishable from closed');
    assert.ok(!JSON.stringify(await wallPost(h, post)).includes('"coco"'), 'retroactive');
    // Enforced at RENDER: a row written by any other path never shows while the block stands.
    const file = h.ctx.paths.memberFile('ana', 'log-stamps.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    rows.push({ id: 'stmp_mfakefakefake1', post_id: post, author: 'coco', kaomoji: NICE, activity_id: 'x', at: new Date().toISOString(), seen: false });
    fs.writeFileSync(file, JSON.stringify(rows));
    h.ctx.projection.invalidate('ana');
    assert.ok(!JSON.stringify(await wallPost(h, post)).includes('"coco"'), 'a row on disk from a blocked author never renders');
    assert.ok(!JSON.stringify((await c.ana.get('/api/inbox')).body).includes('"coco"'), 'nor in the inbox');
    await c.ana.put('/api/me/page', { unblock: 'coco' });
    assert.ok(JSON.stringify(await wallPost(h, post)).includes('"coco"'), 'positive control: unblocked, the row renders');
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: '✿' })).status, 200, 'and coco may stamp again');
    // Page off: the wall is gone, and so is the post to a stranger.
    await c.ana.put('/api/me/page', { enabled: false });
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: NICE })).status, 404);
  } finally { await h.close(); }
});

test('the sender\'s theme tints the ticket; no theme, plain paper; a rename shows on the wall at once', async () => {
  const { h, c, path, post } = await stage();
  try {
    await c.bram.put('/api/me/page', { theme: { bg: '#000000' } });
    await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    await c.coco.post(`${path}/stamp`, { kaomoji: NICE });
    let p = await wallPost(h, post);
    assert.equal(p.stamps.find((s) => s.author.handle === 'bram').tint, '#d1d1d1');
    assert.ok(!('tint' in p.stamps.find((s) => s.author.handle === 'coco')));
    await c.bram.patch('/api/me', { display_name: 'Bram Vandenberg' });
    await c.bram.put('/api/me/page', { theme: { bg: '#ffffff' } });
    p = await wallPost(h, post);
    const b = p.stamps.find((s) => s.author.handle === 'bram');
    assert.equal(b.author.name, 'Bram V.', 'a sender\'s new name shows on others\' walls');
    assert.equal(b.tint, '#ffffff', 'and a new theme');
  } finally { await h.close(); }
});

test('comments: friends only, signed, plain text, 280; author retracts, owner moderates, switches and blocks', async () => {
  const { h, c, path, post } = await stage();
  try {
    assert.equal((await h.client().post(`${path}/comment`, { body: 'x' })).status, 401);
    assert.equal((await c.coco.post(`${path}/comment`, { body: 'hi' })).body.error, 'comments_friends_only', 'a non-friend cannot comment');
    assert.equal((await c.ana.post(`${path}/comment`, { body: 'hi' })).body.error, 'own_post');
    assert.equal((await c.bram.post(`${path}/comment`, { body: '   ' })).body.error, 'comment_empty');
    let r = await c.bram.post(`${path}/comment`, { body: 'that  stubborn blue <script>alert(1)</script>\n is worth it' });
    assert.equal(r.status, 200);
    const cm = r.body.comments[0];
    assert.equal(cm.body, 'that stubborn blue <script>alert(1)</script> is worth it', 'plain text, whitespace collapsed (escaping is the renderer\'s)');
    assert.equal(cm.author.name, 'Bram T.');
    assert.equal(cm.author.url, `${h.base}/@bram`);
    assert.ok(!('seen' in cm));
    r = await c.bram.post(`${path}/comment`, { body: 'x'.repeat(400) });
    assert.equal(r.body.comments[1].body.length, 280, '280, a decision');
    const p = await wallPost(h, post);
    assert.equal(p.comments.length, 2);
    assert.equal(p.comments_off, false);

    assert.equal((await c.coco.del(`${path}/comment/${cm.id}`)).status, 404, 'a third party: opaque');
    assert.equal((await c.bram.del(`${path}/comment/${cm.id}`)).status, 200, 'the author takes it back');
    assert.equal((await c.ana.del(`${path}/comment/${r.body.comments[1].id}`)).status, 200, 'the owner moderates');
    assert.equal((await wallPost(h, post)).comments.length, 0);

    await c.ana.patch(`/api/posts/${post}`, { comments_off: true });
    assert.equal((await c.bram.post(`${path}/comment`, { body: 'hi' })).body.error, 'comments_closed');
    await c.ana.patch(`/api/posts/${post}`, { comments_off: false });
    await c.ana.put('/api/me/page', { comments_off: true });
    assert.equal((await c.bram.post(`${path}/comment`, { body: 'hi' })).body.error, 'comments_closed');
    await c.ana.put('/api/me/page', { comments_off: false });
    await c.bram.post(`${path}/comment`, { body: 'one more note' });
    // A block severs the friendship; a comment row left on disk still never renders.
    await c.ana.put('/api/me/page', { block: 'bram' });
    assert.ok(!JSON.stringify(await wallPost(h, post)).includes('one more note'), 'retroactive');
    r = await c.bram.post(`${path}/comment`, { body: 'again' });
    assert.equal(r.status, 403, 'a blocked (once) friend is refused');
  } finally { await h.close(); }
});

test('a blocked FRIEND is refused opaquely (the block alone, the friendship standing)', async () => {
  const { h, c, path } = await stage();
  try {
    // Write the block straight into the store, as a hand edit would: no sever ran.
    const store = h.ctx.pages.load('ana');
    store.blocked.push('bram');
    h.ctx.pages.save('ana', store);
    assert.equal((await c.bram.get('/api/friends/with/ana')).body.status, 'friends', 'still friends');
    assert.equal((await c.bram.post(`${path}/comment`, { body: 'hi' })).body.error, 'comments_closed', 'refused as closed');
    assert.equal((await c.bram.post(`${path}/stamp`, { kaomoji: FULL })).body.error, 'stamps_closed');
  } finally { await h.close(); }
});

test('a deleted post takes its crowd; other posts keep theirs', async () => {
  const { h, c, path, post } = await stage();
  try {
    const keeper = (await note(c.ana, 'stays')).body.id;
    await c.bram.post(`${path}/stamp`, { kaomoji: NICE });
    await c.bram.post(`${path}/comment`, { body: 'doomed' });
    await c.bram.post(`/api/pages/ana/posts/${keeper}/stamp`, { kaomoji: NICE });
    await c.bram.post(`/api/pages/ana/posts/${keeper}/comment`, { body: 'kept' });
    assert.equal((await c.ana.del(`/api/posts/${post}`)).status, 200);
    const s = h.ctx.reactions.loadStamps('ana');
    const cm = h.ctx.reactions.loadComments('ana');
    assert.deepEqual(s.map((x) => x.post_id), [keeper]);
    assert.deepEqual(cm.map((x) => x.post_id), [keeper]);
    assert.equal((await c.bram.post(`${path}/stamp`, { kaomoji: NICE })).status, 404);
  } finally { await h.close(); }
});
