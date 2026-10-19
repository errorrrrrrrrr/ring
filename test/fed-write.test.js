'use strict';
/* The rest of P6's write side (spec 4.8, 4.9, 3.10, 5.9, 7, 11.2): what a
 * member sends to other servers and what this server keeps of them, and how
 * long.
 *   a comment on a remote friend's post: an unlisted reply to the author's own
 *     inbox, its Note served at /users/<name>/comments/<id> to signers the
 *     member does not block; taken back, a Delete to the same inbox
 *   a deleted post's Delete reaches the servers of everyone who reacted
 *   a profile change reaches the remote accounts the member follows too
 *   housekeeping: From elsewhere past 30 days, walls no friendship holds and
 *     posts past 90 days, media no store names
 *   the lookup budget (30 a minute per member) */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { crowd } = require('./helpers/social');
const { fedRing, fakeMastodon, befriendRemote, activityFrom, noteFrom } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());
const enc = encodeURIComponent;

test('a comment on a remote friend\'s post: an unlisted reply to their inbox, served to signers, taken back with a Delete', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    const { note, create } = noteFrom(m, { text: 'new plates' });
    await m.post(`${h.base}/inbox`, create);
    // Not a friend's post: refused.
    const { note: carols } = noteFrom(m, { name: 'carol', text: 'hers' });
    assert.equal((await c.ana.post('/api/remote/comment', { object: carols.id, body: 'hi' })).status, 403);
    let r = await c.ana.post('/api/remote/comment', { object: note.id, body: '  lovely   plates  ' });
    assert.equal(r.status, 200, r.text);
    await h.ctx.federation.queue.drain();
    const d = m.deliveries.at(-1);
    assert.equal(d.path, '/users/bob/inbox', 'the author\'s own inbox');
    assert.equal(d.body.type, 'Create');
    const reply = d.body.object;
    assert.equal(reply.inReplyTo, note.id);
    assert.deepEqual(reply.to, [m.actor()]);
    assert.deepEqual(reply.cc, ['https://www.w3.org/ns/activitystreams#Public'], 'unlisted');
    assert.equal(reply.content, '<p>lovely plates</p>');
    assert.deepEqual(reply.tag, [{ type: 'Mention', href: m.actor(), name: `@${bob}` }]);
    assert.equal(d.verified, true);
    // The Note at its id: to a signer; not unsigned; not to a blocked signer.
    const got = await m.get(reply.id);
    assert.equal(got.status, 200, got.text);
    assert.equal(got.body.id, reply.id);
    assert.equal((await m.get(reply.id, { unsigned: true })).status, 401);
    assert.equal((await m.get(`${h.base}/users/ana/comments/lc_aaaaaaaaaaaaaaaa`)).status, 404);
    await c.ana.put('/api/me/page', { block: `carol@${m.host}` });
    assert.equal((await m.get(reply.id, { name: 'carol' })).status, 404, 'a blocked signer gets the stranger\'s 404');
    // The Friends feed shows it as the member's own.
    const card = (await c.ana.get('/api/feed/friends')).body.posts.find((p) => p.id === note.id);
    assert.deepEqual(card.comments.map((x) => x.body), ['lovely plates']);
    // Taken back: a Delete of exactly that Note, to the same inbox.
    r = await c.ana.del(`/api/remote/comment/${enc(card.comments[0].id)}`);
    assert.equal(r.status, 200);
    await h.ctx.federation.queue.drain();
    const del = m.deliveries.at(-1);
    assert.equal(del.body.type, 'Delete');
    assert.equal(del.body.object.id, reply.id);
    assert.equal(del.path, '/users/bob/inbox');
    assert.equal((await m.get(reply.id)).status, 404, 'its URL is gone with it');
  } finally { await m.close(); await h.close(); }
});

test('a deleted post\'s Delete reaches every server that reacted; a profile change reaches the accounts the member follows', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  const k = await fakeMastodon({ users: ['kim'], keyIndex: 4 });
  try {
    await befriendRemote(h, c, k, 'ana', { as: 'kim' });
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'react to me' })).body;
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: `${h.base}/users/ana/posts/${p.id}` }));
    await h.ctx.federation.queue.drain();
    const n = m.deliveries.length;
    assert.equal((await c.ana.del(`/api/posts/${p.id}`)).status, 200);
    await h.ctx.federation.queue.drain();
    const del = m.deliveries.slice(n).find((d) => d.body.type === 'Delete');
    assert.ok(del, 'bob never followed, but he stamped: his server gets the Delete');
    assert.equal(del.body.object.type, 'Tombstone');
    // A profile change: to kim (a follow either way).
    const before = k.deliveries.length;
    await c.ana.patch('/api/me', { display_name: 'Ana Lima' });
    await h.ctx.federation.queue.drain();
    const upd = k.deliveries.slice(before).find((d) => d.body.type === 'Update');
    assert.equal(upd.body.object.name, 'Ana Lima');
  } finally { await m.close(); await k.close(); await h.close(); }
});

test('housekeeping: From elsewhere past 30 days, walls without a friendship and posts past 90 days, media no store names', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'zed'] });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'x' })).body;
    await m.post(`${h.base}/inbox`, noteFrom(m, { name: 'zed', inReplyTo: `${h.base}/users/ana/posts/${p.id}`, text: 'hi from afar' }).create, { name: 'zed' });
    assert.equal(h.ctx.elsewhere.load('ana').length, 1);
    const bob = await befriendRemote(h, c, m, 'ana');
    await m.post(`${h.base}/inbox`, noteFrom(m, { text: 'on the wall' }).create);
    assert.equal(h.ctx.walls.list(bob).length, 1);
    const orphan = h.ctx.federation.media.want(`${m.base}/nothing.png`);
    clock.advance(29 * 24 * 3600_000);
    let out = h.ctx.housekeeping.run();
    assert.equal(h.ctx.elsewhere.load('ana').length, 1, 'not yet');
    assert.equal(out.remote_media >= 1, true, 'a media row no store names goes after its hour');
    assert.equal(h.ctx.federation.media.row(orphan), null);
    clock.advance(2 * 24 * 3600_000);
    out = h.ctx.housekeeping.run();
    assert.equal(out.elsewhere, 1);
    assert.equal(h.ctx.elsewhere.load('ana').length, 0);
    clock.advance(60 * 24 * 3600_000);
    h.ctx.housekeeping.run();
    assert.equal(h.ctx.walls.list(bob).length, 0, 'a post past 90 days goes');
    // A wall no friendship holds (left behind by a crash): swept.
    await m.post(`${h.base}/inbox`, noteFrom(m, { text: 'fresh' }).create);
    assert.equal(h.ctx.walls.list(bob).length, 1);
    h.ctx.follows.dropHandle('ana', bob);
    h.ctx.walls.add(bob, m.actor(), { id: `${m.actor()}/statuses/9`, type: 'Note', actor: m.actor(), url: `${m.actor()}/statuses/9`, published: new Date(clock.now()).toISOString(), attachments: [], tree: ['x'], summary: '' });
    out = h.ctx.housekeeping.run();
    assert.ok(out.remote_walls >= 1);
    assert.equal(h.ctx.walls.list(bob).length, 0);
    assert.equal(out.failed.length, 0, out.failed.join(','));
  } finally { await m.close(); await h.close(); }
});

test('the lookup budget: 30 a minute per member', async () => {
  const { h, c } = await crowd(['ana'], { federated: true, limitScale: 1 });
  try {
    const st = [];
    for (let i = 0; i < 31; i++) st.push((await c.ana.get(`/api/lookup?q=${enc('ana')}`)).status);
    assert.equal(st.filter((s) => s === 200).length, 30);
    assert.equal(st.at(-1), 429);
  } finally { await h.close(); }
});

test('with FEDERATION=off the remote doors are absent', async () => {
  const { h, c } = await crowd(['ana']);
  try {
    assert.equal((await c.ana.post('/api/remote/stamp', { object: 'https://m.example/p/1', face: '✿' })).status, 404);
    assert.equal((await c.ana.post('/api/remote/comment', { object: 'https://m.example/p/1', body: 'x' })).status, 404);
    assert.equal((await c.ana.get('/media/m_00000000000000000000000000000000/web')).status, 404);
    assert.equal((await c.ana.raw('GET', '/authorize_interaction?uri=x')).status, 404);
    assert.equal((await c.ana.get(`/api/lookup?q=${enc('bob@m.example')}`)).status, 404);
    assert.equal((await c.ana.get('/api/lookup?q=ana')).status, 200, 'positive control: a local lookup answers');
    assert.equal((await c.ana.post('/api/friends', { handle: 'bob@m.example' })).status, 404);
  } finally { await h.close(); }
});
