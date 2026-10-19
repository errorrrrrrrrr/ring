'use strict';
/* Gate: the inbound registry (spec 4.10, 4.7 "checks at the home", 4.8 "stamps
 * in", 16.3 fed-ownership's local half). lib/ap-inbound.js receive() is the one
 * door every activity for a member or a ring here goes through; P5 puts the
 * signature in front of it. Driven directly, with a positive control beside each
 * refusal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const A = require('../lib/activities');
const { PERSON_KEYS, GROUP_KEYS } = require('../lib/ap-inbound');
const { crowd, befriend, ring, note } = require('./helpers/social');

test.afterEach(() => clock.reset());

const person = (name) => ({ kind: 'person', name });

test('a closed registry: exactly the listed keys, frozen; anything else is 202 and dropped', async () => {
  const { h } = await crowd(['ana']);
  try {
    const { HANDLERS, receive } = h.ctx.inbound;
    assert.deepEqual(Object.keys(HANDLERS.person).sort(), [...PERSON_KEYS].sort());
    assert.deepEqual(Object.keys(HANDLERS.group).sort(), [...GROUP_KEYS].sort());
    assert.ok(Object.isFrozen(HANDLERS.person) && Object.isFrozen(HANDLERS.group));
    const actor = `${h.base}/users/ana`;
    for (const type of ['Question', 'Move', 'Flag', 'Block', 'Add', 'Arrive']) {
      assert.deepEqual(receive({ type, actor, object: 'x' }, { inbox: person('ana'), origin: h.base, signer: actor }), { status: 202, dropped: true }, type);
    }
    assert.equal(receive({ type: 'Announce', actor, object: {} }, { inbox: person('ana'), origin: h.base, signer: actor }).dropped, true, 'a boost (an Announce not from a Group) is dropped');
    assert.equal(receive(null, { inbox: person('ana'), origin: h.base, signer: actor }).status, 400);
  } finally { await h.close(); }
});

test('the signer must be the actor: anything else is 401 and changes nothing', async () => {
  const { h } = await crowd(['ana', 'bram']);
  try {
    const follow = A.follow({ origin: h.base, name: 'bram', object: `${h.base}/users/ana` });
    let r = h.ctx.inbound.receive(follow, { inbox: person('ana'), origin: h.base, signer: `${h.base}/users/coco` });
    assert.equal(r.status, 401);
    assert.equal(h.ctx.follows.load('ana').followers.length, 0);
    r = h.ctx.inbound.receive(follow, { inbox: person('ana'), origin: h.base, signer: follow.actor });
    assert.equal(r.status, 202, 'positive control');
    assert.equal(h.ctx.follows.load('ana').followers.length, 1);
  } finally { await h.close(); }
});

test('ownership: an answer only from the followee, an Undo only by its actor, a comment only by its author', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    const o = h.base;
    const u = (n) => `${o}/users/${n}`;
    const rcv = (a, to) => h.ctx.inbound.receive(a, { inbox: person(to), origin: o, signer: a.actor });
    await c.ana.post('/api/friends', { handle: 'bram' });
    const f = h.ctx.follows.load('ana').following[0];
    // coco "accepts" ana's follow of bram.
    let r = rcv(A.acceptFollow({ origin: o, name: 'coco', follow: { id: f.follow_id, actor: u('ana'), object: u('bram') } }), 'ana');
    assert.equal(r.status, 403, 'an Accept from someone other than the followee');
    assert.equal(h.ctx.follows.load('ana').following[0].state, 'pending');
    r = rcv(A.acceptFollow({ origin: o, name: 'bram', follow: { id: f.follow_id, actor: u('ana'), object: u('bram') } }), 'ana');
    assert.equal(h.ctx.follows.load('ana').following[0].state, 'accepted', 'positive control: the followee\'s Accept');
    // coco undoes ana's follow (an Undo of someone else's activity).
    r = rcv({ ...A.undoFollow({ origin: o, name: 'coco', follow: { id: f.follow_id, actor: u('ana'), object: u('bram') } }) }, 'bram');
    assert.equal(r.status, 403, 'an Undo of someone else\'s Follow');

    // Stamps: an Undo of someone else's Like.
    await c.ana.put('/api/me/page', { enabled: true });
    const post = (await note(c.ana, 'hello')).body.id;
    await c.bram.post(`/api/pages/ana/posts/${post}/stamp`, { kaomoji: '✿' });
    const row = h.ctx.reactions.loadStamps('ana')[0];
    const like = { id: row.activity_id, type: 'Like', actor: u('bram'), object: `${u('ana')}/posts/${post}` };
    r = rcv(A.undo({ origin: o, name: 'coco', activity: like }), 'ana');
    assert.equal(r.status, 403, 'an Undo of someone else\'s Like');
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1);
    r = rcv(A.undo({ origin: o, name: 'bram', activity: like }), 'ana');
    assert.equal(r.status, 200, 'positive control: its own actor');
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 0);

    // Comments: friends only, at the authority itself; attributedTo must be the
    // actor; a Delete only by the author.
    const early = A.createComment({ origin: o, name: 'coco', commentId: 'lc_mzzzzzzzzzzzz0', postUrl: `${u('ana')}/posts/${post}`, postAuthor: u('ana'), postAuthorHandle: 'ana', body: 'hi', published: clock.iso() });
    assert.equal(rcv(early, 'ana').error, 'comments_friends_only', 'the post\'s own server refuses a non-friend');
    await befriend(c, 'coco', 'ana');
    const create = A.createComment({ origin: o, name: 'coco', commentId: 'lc_mzzzzzzzzzzzz1', postUrl: `${u('ana')}/posts/${post}`, postAuthor: u('ana'), postAuthorHandle: 'ana', body: 'hi', published: clock.iso() });
    r = rcv({ ...create, object: { ...create.object, attributedTo: u('bram') } }, 'ana');
    assert.equal(r.status, 403, 'a Note attributed to someone else');
    assert.equal(rcv(create, 'ana').status, 201, 'positive control');
    assert.equal(rcv(create, 'ana').action, 'unchanged', 'the same Note twice applies once');
    assert.equal(h.ctx.reactions.loadComments('ana').length, 1);
    const del = A.deleteComment({ origin: o, name: 'bram', objectId: create.object.id, to: [u('ana')], deleted: clock.iso() });
    assert.equal(rcv(del, 'ana').status, 403, 'bram cannot delete coco\'s comment');
    const own = A.deleteComment({ origin: o, name: 'coco', objectId: create.object.id, to: [u('ana')], deleted: clock.iso() });
    assert.equal(rcv(own, 'ana').status, 200);
    assert.equal(h.ctx.reactions.loadComments('ana').length, 0);
  } finally { await h.close(); }
});

test('stamps in from other software: out of tier, unknown or custom lands as the heart, never widened', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const post = (await note(c.ana, 'hello')).body.id;
    const o = h.base;
    const like = (content, extra = {}) => ({ '@context': A.CONTEXT, id: `${o}/users/bram/stamps/stmp_mxxxxxxxxxxxx${Math.random().toString(36).slice(2, 3)}`, type: 'Like', actor: `${o}/users/bram`, object: `${o}/users/ana/posts/${post}`, content, ...extra });
    const face = () => h.ctx.reactions.loadStamps('ana')[0]?.kaomoji;
    const rcv = (a) => h.ctx.inbound.receive(a, { inbox: person('ana'), origin: o, signer: a.actor });
    assert.equal(rcv(like('(⊙_⊙)')).status, 200);
    assert.equal(face(), '♥', 'a friend-tier face from a non-friend lands as ♥');
    rcv(like('🍕'));
    assert.equal(face(), '♥', 'a face not in the palette lands as ♥');
    rcv(like(':blobcat:', { tag: [{ type: 'Emoji', name: ':blobcat:', icon: { url: 'https://evil.example/x.png' } }] }));
    assert.equal(face(), '♥', 'an Emoji-tag reaction lands as ♥');
    rcv(like('🌞'));
    assert.equal(face(), '🌞', 'a nice face lands as itself');
    rcv({ ...like(''), type: 'EmojiReact', content: '✨' });
    assert.equal(face(), '✨', 'EmojiReact too');
    rcv(like(undefined, { _misskey_reaction: '⭐' }));
    assert.equal(face(), '⭐', 'and a Misskey reaction');
    // The same face from a Ring server out of tier is refused (its server checks first).
    assert.equal(rcv(like('(⊙_⊙)', { ring: { v: 1, face: '(⊙_⊙)' } })).error, 'friends_only');
  } finally { await h.close(); }
});

test('checks at the home: a member signs; a Join needs the live code; the creator kicks; a room Note keeps its week', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    const o = h.base;
    const { id, code } = await ring(c, 'ana', ['bram']);
    const g = { kind: 'group', id };
    const rcv = (a) => h.ctx.inbound.receive(a, { inbox: g, origin: o, signer: a.actor });
    assert.equal(rcv(A.leaveGroup({ origin: o, name: 'coco', ringId: id })).status, 404, 'a non-member: the opaque 404');
    assert.equal(rcv(A.renameGroup({ origin: o, name: 'coco', ringId: id, ringName: 'Mine' })).status, 404);
    assert.equal(rcv(A.joinGroup({ origin: o, name: 'coco', ringId: id, code: 'not-the-code' })).status, 404, 'a Join without the live code');
    assert.equal(rcv(A.joinGroup({ origin: o, name: 'coco', ringId: id, code })).requested, true, 'positive control');
    assert.equal(rcv(A.removeMember({ origin: o, name: 'bram', ringId: id, member: 'ana' })).status, 403, 'only the creator removes');
    assert.equal(rcv(A.deleteGroup({ origin: o, name: 'bram', ringId: id })).status, 403, 'only the creator deletes');

    const post = { id: 'proomnoteroomno1', kind: 'note', note: 'x', audience: id, created_at: clock.iso() };
    const create = A.createPost(post, { origin: o, name: 'bram' });
    assert.equal(rcv(create).status, 202, 'positive control: a member\'s room Note');
    const far = A.createPost({ ...post, created_at: clock.iso(clock.now() + 10 * 60_000) }, { origin: o, name: 'bram' });
    assert.equal(rcv(far).status, 400, 'published more than 5 minutes ahead');
    const long = A.createPost(post, { origin: o, name: 'bram' });
    long.object.ring.expires = clock.iso(clock.now() + 8 * 86400_000);
    assert.equal(rcv(long).status, 400, 'an expiry past published + 7 days');
    const forged = A.createPost(post, { origin: o, name: 'bram' });
    forged.object.attributedTo = `${o}/users/ana`;
    assert.equal(rcv(forged).status, 403, 'a Note by someone other than its signer');
  } finally { await h.close(); }
});

test('the authority checks the room itself: a non-member\'s Like sent straight to the author, not through the Group, is the 404', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    const o = h.base;
    const { id } = await ring(c, 'ana', ['bram']);
    await befriend(c, 'coco', 'ana');
    const post = (await note(c.ana, 'room only', id)).body.id;
    const postUrl = `${o}/users/ana/posts/${post}`;
    const rcv = (a) => h.ctx.inbound.receive(a, { inbox: person('ana'), origin: o, signer: a.actor });
    const like = (name) => A.like({ origin: o, name, stampId: 'stmp_mdirectdirect1', postUrl, postAuthor: `${o}/users/ana`, face: '✿' });
    assert.equal(rcv(like('coco')).status, 404, 'a friend outside the ring sees no room post');
    const reply = A.createComment({ origin: o, name: 'coco', commentId: 'lc_mdirectdirect1', postUrl, postAuthor: `${o}/users/ana`, postAuthorHandle: 'ana', body: 'hi', published: clock.iso() });
    assert.equal(rcv(reply).status, 404, 'nor comments on one');
    assert.equal(rcv(like('bram')).status, 200, 'positive control: a member');
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1);
  } finally { await h.close(); }
});
