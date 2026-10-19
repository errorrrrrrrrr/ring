'use strict';
/* Following from another server (spec 3.5, 4.6, 4.10): a remote account
 * FOLLOWS a member, here through the same handlers a member's own Follow goes
 * through (lib/follows.js, behind lib/ap-inbound.js receive). In: Follow and
 * Undo{Follow}. Out: Accept and Reject. Befriending across servers (P6) has its
 * own suites (fed-two-servers, fed-interop); here, what a remote server may
 * change and what it may not, and the account deletion's farewell. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../lib/clock');
const { PASSWORD } = require('./helpers/harness');
const { fedRing, fakeMastodon, followFrom, undoFrom, remoteFollow } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());

const enc = encodeURIComponent;

test('follow, let follow, decline, remove, unfollow: the rows and the activities', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    const bob = `bob@${m.host}`;
    const carol = `carol@${m.host}`;
    const follow = await remoteFollow(h, c, m, 'ana', { as: 'bob', accept: false });
    const reqs = await c.ana.get('/api/followers');
    assert.deepEqual(reqs.body.requests.map((r) => [r.handle, r.name, r.host, r.url]), [[bob, 'Bob Remote', m.host, `${m.base}/@bob`]]);
    assert.equal((await c.ana.get('/api/me')).body.unseen, 1, 'a request waiting counts');
    assert.equal(m.deliveries.length, 0, 'nothing answered before the member decides');

    assert.equal((await c.ana.post(`/api/followers/${enc(bob)}/accept`)).status, 200);
    await h.ctx.federation.queue.drain();
    const accept = m.deliveries.at(-1);
    assert.equal(accept.body.type, 'Accept');
    assert.deepEqual(accept.body.object, { id: follow.id, type: 'Follow', actor: follow.actor, object: follow.object });
    assert.equal(accept.verified, true);
    const list = await c.ana.get('/api/followers');
    assert.deepEqual(list.body.followers.map((f) => f.handle), [bob]);

    // carol asks, ana declines: Reject{Follow}, no row.
    await remoteFollow(h, c, m, 'ana', { as: 'carol', accept: false });
    assert.equal((await c.ana.post(`/api/followers/${enc(carol)}/reject`)).status, 200);
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.at(-1).body.type, 'Reject');
    assert.equal(m.deliveries.at(-1).path, '/users/carol/inbox');
    assert.deepEqual(h.ctx.follows.load('ana').followers.map((f) => f.handle), [bob]);

    // bob unfollows: Undo{Follow} in, the row goes; ana sends nothing back (she never followed bob).
    const n = m.deliveries.length;
    const r = await m.post(`${h.base}/inbox`, undoFrom(m, follow));
    assert.equal(r.status, 202, 'through the shared inbox');
    assert.deepEqual(h.ctx.follows.load('ana').followers, []);
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.length, n);

    // A later follower removed by the member: Reject, as Mastodon reads "removed follower".
    await remoteFollow(h, c, m, 'ana', { as: 'bob' });
    assert.equal((await c.ana.post(`/api/followers/${enc(bob)}/reject`)).status, 200);
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.at(-1).body.type, 'Reject');
    assert.deepEqual(h.ctx.follows.load('ana').followers, []);
  } finally { await m.close(); await h.close(); }
});

test('open_follows accepts at once; a blocked handle or domain is dropped silently, never answered', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await c.ana.put('/api/me/page', { open_follows: true });
    await remoteFollow(h, c, m, 'ana', { as: 'bob', accept: false });
    await h.ctx.federation.queue.drain();
    assert.equal(h.ctx.follows.load('ana').followers[0].state, 'accepted');
    assert.equal(m.deliveries.at(-1).body.type, 'Accept', 'accepted without asking');

    await c.bram.put('/api/me/page', { block: `carol@${m.host}` });
    const before = m.deliveries.length;
    const r = await m.post(`${h.base}/users/bram/inbox`, followFrom(m, `${h.base}/users/bram`, { name: 'carol' }), { name: 'carol' });
    assert.equal(r.status, 202, 'the same answer as any Follow');
    await h.ctx.federation.queue.drain();
    assert.deepEqual(h.ctx.follows.load('bram').followers, [], 'no row');
    assert.equal(m.deliveries.length, before, 'no Reject: a block is opaque');
    await c.bram.put('/api/me/page', { block_domain: m.host.split(':')[0] });
    await m.post(`${h.base}/users/bram/inbox`, followFrom(m, `${h.base}/users/bram`, { name: 'bob' }));
    assert.deepEqual(h.ctx.follows.load('bram').followers, [], 'a blocked domain too');
    await c.bram.put('/api/me/page', { unblock_domain: m.host.split(':')[0], unblock: `carol@${m.host}` });
    await m.post(`${h.base}/users/bram/inbox`, followFrom(m, `${h.base}/users/bram`, { name: 'carol' }), { name: 'carol' });
    assert.deepEqual(h.ctx.follows.load('bram').followers.map((f) => f.handle), [`carol@${m.host}`], 'positive control: unblocked, it lands');
  } finally { await m.close(); await h.close(); }
});

test('what a remote server changes: a Like lands as a stamp; a private reply, a boost, a forged Accept, a Flag or a Move change nothing; a Delete of a post here is refused; a Follow of the instance actor is rejected', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'hello' })).body;
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    const send = (a) => m.post(`${h.base}/users/ana/inbox`, { '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.base}/${Math.random().toString(36).slice(2)}`, actor: m.actor(), ...a });
    for (const a of [
      { type: 'Like', object: postUrl },
      { type: 'EmojiReact', object: postUrl, content: '🌞' },
      { type: 'Create', object: { id: `${m.base}/n/1`, type: 'Note', attributedTo: m.actor(), inReplyTo: postUrl, content: '<p>hi</p>', to: [h.base + '/users/ana'] } },
      { type: 'Announce', object: postUrl },
      { type: 'Accept', object: { id: `${h.base}/users/ana/activities/x`, type: 'Follow', actor: `${h.base}/users/ana`, object: m.actor() } },
      { type: 'Flag', object: [postUrl] },
      { type: 'Move', object: m.actor(), target: 'https://elsewhere.example/u' },
    ]) {
      const r = await send(a);
      assert.equal(r.status, 202, `${a.type}: ${r.text}`);
    }
    // P6: a Like and an EmojiReact land (one stamp per sender and post: the
    // reaction replaced the favourite); the followers-only reply never does.
    assert.deepEqual(h.ctx.reactions.loadStamps('ana').map((x) => [x.author, x.kaomoji]), [[`bob@${m.host}`, '🌞']]);
    assert.deepEqual(h.ctx.reactions.loadComments('ana'), []);
    assert.deepEqual(h.ctx.elsewhere.load('ana'), [], 'a private reply is not From elsewhere either');
    // A Delete of a post here is another host's object: refused before any handler.
    const del = await send({ type: 'Delete', object: postUrl });
    assert.equal(del.status, 403, del.text);
    assert.ok(h.ctx.pages.load('ana').posts.some((x) => x.id === p.id), 'a remote Delete of a post here deletes nothing');
    assert.deepEqual(h.ctx.follows.load('ana').following, []);

    const r = await m.post(`${h.base}/actor/inbox`, followFrom(m, `${h.base}/actor`));
    assert.equal(r.status, 202);
    await h.ctx.federation.queue.drain();
    const reject = m.deliveries.at(-1);
    assert.equal(reject.body.type, 'Reject');
    assert.equal(reject.body.actor, `${h.base}/actor`);
    assert.equal(reject.verified, true, 'signed by the instance actor');
    // An Undo of someone else's Follow is refused at the handler.
    const follow = await remoteFollow(h, c, m, 'ana', { as: 'bob' });
    const forged = undoFrom(m, follow);
    forged.object.actor = `${m.base}/users/someone`;
    await m.post(`${h.base}/inbox`, forged);
    assert.equal(h.ctx.follows.load('ana').followers.length, 1, 'still following');
  } finally { await m.close(); await h.close(); }
});

test('a deleted member\'s key waits for their last delivery, then goes; housekeeping catches one left behind', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  const m = await fakeMastodon({ users: ['bob'], verify: false });
  try {
    await remoteFollow(h, c, m, 'bram');
    m.answer(() => 503);
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200);
    await h.ctx.federation.queue.drain();
    const keyFile = path.join(h.dir, 'keys', 'bram.pem');
    assert.ok(fs.existsSync(keyFile), 'the farewell\'s Delete{Person} still needs the key');
    assert.ok(h.ctx.federation.queue.hasSigner('bram'));
    h.ctx.housekeeping.run();
    assert.ok(fs.existsSync(keyFile), 'housekeeping leaves a key a job still needs');
    m.answer(() => 202);
    clock.advance(24 * 3600_000);
    await h.ctx.federation.queue.drain();
    // P6: a remote edge ends with the Delete{Person} alone (no Reject of its own).
    assert.equal(m.deliveries.at(-1).body.type, 'Delete');
    assert.equal(m.deliveries.at(-1).body.object, `${h.base}/users/bram`);
    assert.ok(!m.deliveries.some((d) => d.body?.type === 'Reject'), 'no sever Reject for a remote edge');
    assert.ok(!fs.existsSync(keyFile), 'gone with the last job');
    // A key left by a restart in between: housekeeping removes it.
    fs.copyFileSync(path.join(h.dir, 'keys', 'ana.pem'), keyFile);
    const out = h.ctx.housekeeping.run();
    assert.equal(out.retired_keys, 1);
    assert.ok(!fs.existsSync(keyFile));
    assert.ok(fs.existsSync(path.join(h.dir, 'keys', 'ana.pem')), 'positive control: a live member keeps theirs');
    // Activity ids are forgotten after 7 days.
    clock.advance(8 * 24 * 3600_000);
    assert.ok(h.ctx.housekeeping.run().seen_ids >= 1);
  } finally { await m.close(); await h.close(); }
});
