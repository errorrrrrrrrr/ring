'use strict';
/* moderation (spec 6, 16.3; P8), against fake servers (test/helpers/fediverse.js)
 * and a second real Ring server in its own process (test/helpers/ring-process.js):
 *   an admin DOMAIN block refuses inbound (403, before any key fetch), stops
 *     delivery (the queued jobs go) and fetches, ends every follow both ways
 *     and sends NOTHING there, purges its walls, reactions, From elsewhere,
 *     cached actors and media, and its stamps leave the public wall; another
 *     host is untouched;
 *   an admin ACTOR block: that person's inbound 403 after the signature and
 *     nothing delivered to them; their neighbour on the same host is untouched;
 *   a Flag IN lands in the queue with its host, only our objects, its comment
 *     one plain line, budgeted per host; one naming nothing of ours is dropped;
 *   a report FORWARDED reaches the remote as a Flag from the instance actor,
 *     verified by the fake's own verifier, without the reporter's name;
 *   SUSPENSION: the actor 404s, every queued job the member signs is cancelled
 *     (Delete, Reject and Undo kept), inbound for them is dropped, and lifting
 *     it restores the actor;
 *   two real Ring servers: B's admin blocks A's domain: the friendship ends on
 *     B both ways, nothing is sent to A, A's deliveries are refused.
 * Each refusal has its positive control. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { fedRing, fakeMastodon, remoteFollow, befriendRemote, activityFrom, noteFrom, followFrom, until } = require('./helpers/fediverse');
const { startRing } = require('./helpers/ring-process');
const images = require('./helpers/images');

test.afterEach(() => clock.reset());
const enc = encodeURIComponent;

test('an admin domain block: inbound 403, follows ended both ways with nothing sent, walls, reactions, From elsewhere, actors and media purged; another host untouched', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'], hostname: 'localhost' });
  const fine = await fakeMastodon({ users: ['dan'], keyIndex: 4 });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    await remoteFollow(h, c, fine, 'ana', { as: 'dan' });
    // bob's wall post with an image, cached here.
    const png = await images.png(40, 30, '#a36');
    m.serve('/media/1.png', png, { type: 'image/png' });
    const { create } = noteFrom(m, { text: 'from bob', attachment: [{ type: 'Document', mediaType: 'image/png', url: `${m.base}/media/1.png`, name: 'alt' }] });
    assert.equal((await m.post(`${h.base}/inbox`, create)).status, 202);
    await h.ctx.federation.media.idle();
    assert.equal(h.ctx.walls.list(bob).length, 1);
    assert.ok(h.ctx.federation.media.size() >= 1, 'the image is cached');
    // bob stamps ana's post; carol (a stranger) replies: From elsewhere.
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'mine' })).body;
    await h.ctx.federation.queue.drain();
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    assert.equal((await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }))).status, 202);
    const reply = noteFrom(m, { name: 'carol', text: 'hi', inReplyTo: postUrl });
    assert.equal((await m.post(`${h.base}/inbox`, reply.create, { name: 'carol' })).status, 202);
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1);
    assert.equal(h.ctx.elsewhere.load('ana').length, 1);
    let wall = (await h.client().get('/api/pages/ana')).body;
    assert.equal(wall.posts.find((x) => x.id === p.id).stamps.length, 1, 'bob\'s stamp is on the wall');
    // A delivery to bob's server waits in the queue (its inbox is down).
    m.answer(() => 503);
    await c.ana.post('/api/posts', { kind: 'note', note: 'queued for bob' });
    await h.ctx.federation.queue.drain().catch(() => {});
    const queuedFor = () => h.ctx.federation.queue.list().filter((j) => j.host === m.host).length;
    assert.ok(queuedFor() >= 1, 'a job for the domain is queued');
    m.answer(() => 202);
    const sentBefore = m.deliveries.length;

    // ── the block ──
    let r = await c.ana.post('/api/admin/domain-blocks', { host: 'localhost', reason: 'spam' });
    assert.equal(r.status, 403, 'a member is not the admin');
    // Every activity the block emits, whatever the queue later does with it.
    const emitted = [];
    const emit = h.ctx.outbox.emit;
    h.ctx.outbox.emit = (a, to, o) => { emitted.push({ type: a.type, to }); return emit(a, to, o); };
    r = await c.ada.post('/api/admin/domain-blocks', { host: 'localhost', reason: 'spam' });
    h.ctx.outbox.emit = emit;
    assert.equal(r.status, 201, r.text);
    assert.equal(queuedFor(), 0, 'its queued jobs went at once');
    assert.deepEqual(emitted, [], 'no Undo or Reject was even emitted for it');
    const f = h.ctx.follows.load('ana');
    assert.deepEqual([...f.following, ...f.followers].map((x) => x.handle), [`dan@${fine.host}`], 'every follow with it ended, both ways');
    assert.equal(h.ctx.walls.list(bob).length, 0, 'its wall');
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 0, 'its stamps');
    assert.equal(h.ctx.elsewhere.load('ana').length, 0, 'its From elsewhere rows');
    assert.equal(h.ctx.federation.actors.get(m.actor('bob')), null, 'its cached actors');
    assert.equal(h.ctx.federation.media.size(), 0, 'its cached media');
    wall = (await h.client().get('/api/pages/ana')).body;
    assert.equal(wall.posts.find((x) => x.id === p.id).stamps.length, 0, 'its stamp left the public wall');
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.length, sentBefore, 'nothing was sent to it: no Undo, no Reject');

    // Inbound: 403 before any key fetch. Outbound: nothing, and no fetch.
    const gets = m.gets.length;
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }));
    assert.equal(r.status, 403);
    r = await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`));
    assert.equal(r.status, 403);
    assert.equal(m.gets.length, gets, 'not even a key was fetched');
    assert.equal((await c.ana.get(`/api/lookup?q=${enc(bob)}`)).status, 404);
    assert.equal((await c.ana.post('/api/friends', { handle: bob })).status, 404);
    await c.ana.post('/api/posts', { kind: 'note', note: 'after the block' });
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.length, sentBefore, 'a new post reaches it not');
    // The list: private, the admin's only.
    assert.equal((await c.ana.get('/api/admin/domain-blocks')).status, 403);
    assert.deepEqual((await c.ada.get('/api/admin/domain-blocks')).body.blocks.map((b) => [b.host, b.reason]), [['localhost', 'spam']]);

    // Positive control: another host is untouched, both ways.
    r = await fine.post(`${h.base}/inbox`, activityFrom(fine, 'Like', { object: postUrl }, { name: 'dan' }), { name: 'dan' });
    assert.equal(r.status, 202);
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1);
    assert.ok(fine.deliveries.some((d) => d.body?.type === 'Create' && d.body.object?.content?.includes('after the block')), 'the other host got the post');

    // Lifted: inbound is heard again; nothing comes back by itself.
    assert.equal((await c.ada.del('/api/admin/domain-blocks/localhost')).status, 200);
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }));
    assert.equal(r.status, 202);
    assert.equal(h.ctx.follows.load('ana').following.length, 0, 'the ended follows stay ended');
  } finally { await m.close(); await fine.close(); await h.close(); }
});

test('an admin actor block: that person 403s and gets nothing, their rows go; their neighbour on the same host is untouched', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await remoteFollow(h, c, m, 'ana', { as: 'bob' });
    await remoteFollow(h, c, m, 'ana', { as: 'carol' });
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'x' })).body;
    await h.ctx.federation.queue.drain();
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    assert.equal((await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }))).status, 202);
    let r = await c.ada.post('/api/admin/actor-blocks', { handle: `bob@${m.host}`, reason: 'harassment' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(h.ctx.follows.load('ana').followers.map((x) => x.handle), [`carol@${m.host}`]);
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 0);
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }));
    assert.equal(r.status, 403, 'bob is refused after the signature');
    r = await m.get(`${h.base}/users/ana/outbox`);
    assert.equal(r.status, 403, 'and his signed reads');
    // A job addressed to him by name is not sent: to his own inbox (a Follow),
    // nor to his server's shared inbox (an Update of ana's Person, fan-out's check).
    const before = m.deliveries.length;
    h.ctx.federation.queue.enqueue({ id: `${h.base}/users/ana/activities/zz1`, type: 'Follow', actor: `${h.base}/users/ana`, object: m.actor('bob') }, [m.actor('bob')], { signer: 'ana' });
    h.ctx.federation.queue.enqueue({ id: `${h.base}/users/ana/activities/zz2`, type: 'Update', actor: `${h.base}/users/ana`, object: { type: 'Person', id: `${h.base}/users/ana` } }, [m.actor('bob')], { signer: 'ana' });
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.filter((d) => /zz[12]$/.test(d.body?.id || '')).length, 0, 'nothing delivered to him');
    // Positive control: carol, on the same host, is heard and served.
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }, { name: 'carol' }), { name: 'carol' });
    assert.equal(r.status, 202);
    await c.ana.post('/api/posts', { kind: 'note', note: 'for carol' });
    await h.ctx.federation.queue.drain();
    assert.ok(m.deliveries.length > before, 'carol\'s server still gets the posts');
    assert.equal((await c.ada.del(`/api/admin/actor-blocks/${enc(`bob@${m.host}`)}`)).status, 200);
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }));
    assert.equal(r.status, 202, 'lifted');
  } finally { await m.close(); await h.close(); }
});

test('a Flag in: the queue holds the host, only our objects, one plain line; nothing of ours is dropped; budgeted per host', async () => {
  const { h, c } = await fedRing(['ada', 'ana'], { limitScale: 1 });
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'x' })).body;
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    const flag = (object, content = 'spam‮ here\nand <b>there</b>') => activityFrom(m, 'Flag', { object, content });
    let r = await m.post(`${h.base}/inbox`, flag([`${h.base}/users/ana`, postUrl, `${m.base}/users/bob/statuses/9`, 'https://elsewhere.example/x']));
    assert.equal(r.status, 202, r.text);
    const q = (await c.ada.get('/api/admin/reports')).body.reports;
    assert.equal(q.length, 1);
    assert.equal(q[0].remote, true);
    assert.equal(q[0].from, m.host);
    assert.equal(q[0].target, 'ana');
    assert.deepEqual(q[0].objects, [`${h.base}/users/ana`, postUrl], 'only our objects');
    assert.equal(q[0].comment, 'spam here and <b>there</b>', 'one plain line, bidi out, never markup');
    // Nothing of ours: dropped.
    r = await m.post(`${h.base}/inbox`, flag([`${m.base}/users/bob`]));
    assert.equal(r.status, 202);
    assert.equal((await c.ada.get('/api/admin/reports')).body.reports.length, 1);
    // The per-host budget: 10 an hour, then dropped.
    for (let i = 0; i < 12; i++) await m.post(`${h.base}/inbox`, flag([`${h.base}/users/ana`], `n${i}`));
    assert.equal((await c.ada.get('/api/admin/reports')).body.reports.length, 10, 'ten an hour from one host');
    // A member never sees the queue.
    assert.equal((await c.ana.get('/api/admin/reports')).status, 403);
  } finally { await m.close(); await h.close(); }
});

test('a report forwarded: the remote gets a Flag from the instance actor, verified, without the reporter\'s name; the admin forwards a later one', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    const { create, note } = noteFrom(m, { text: 'nasty' });
    await m.post(`${h.base}/inbox`, create);
    let r = await c.ana.post('/api/reports', { kind: 'post', url: note.id, comment: 'this is abuse', forward: true });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.forwarded, true);
    await h.ctx.federation.queue.drain();
    const flags = () => m.deliveries.filter((d) => d.body?.type === 'Flag');
    await until(() => flags().length === 1, { what: 'the Flag' });
    const fl = flags()[0];
    assert.equal(fl.verified, true, 'signed, checked by the fake\'s own verifier');
    assert.equal(fl.owner, `${h.base}/actor`, 'by the instance actor');
    assert.equal(fl.body.actor, `${h.base}/actor`);
    assert.deepEqual(fl.body.object, [m.actor('bob'), note.id]);
    assert.equal(fl.body.content, 'this is abuse');
    assert.ok(!/ana/i.test(fl.raw), 'the reporter\'s name never travels');
    // A report kept here first, forwarded later by the admin.
    r = await c.ana.post('/api/reports', { kind: 'person', handle: bob, comment: 'and again' });
    assert.equal(r.status, 201);
    assert.equal(r.body.forwarded, false);
    await h.ctx.federation.queue.drain();
    assert.equal(flags().length, 1, 'not forwarded unasked');
    r = await c.ana.post(`/api/admin/reports/${r.body.id}`, { action: 'forward' });
    assert.equal(r.status, 403, 'a member cannot');
    const id = (await c.ada.get('/api/admin/reports')).body.reports.find((x) => x.comment === 'and again').id;
    r = await c.ada.post(`/api/admin/reports/${id}`, { action: 'forward' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.report.forwarded, true);
    await h.ctx.federation.queue.drain();
    await until(() => flags().length === 2, { what: 'the second Flag' });
    assert.deepEqual(flags()[1].body.object, [m.actor('bob')]);
    assert.equal((await c.ada.post(`/api/admin/reports/${id}`, { action: 'forward' })).status, 409, 'once');
    // A report about a stranger's post nobody here can see: the unknown one's 404.
    assert.equal((await c.ana.post('/api/reports', { kind: 'post', url: `${m.base}/users/bob/statuses/nope` })).status, 404);
  } finally { await m.close(); await h.close(); }
});

test('suspension: the actor 404s, queued jobs are cancelled (Delete, Reject and Undo kept), inbound for them dropped; lifting restores the actor', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await remoteFollow(h, c, m, 'ana', { as: 'bob' });
    m.answer(() => 503);
    await c.ana.post('/api/posts', { kind: 'note', note: 'waits' });
    // A pending follower declined: its Reject is queued too, and essential.
    await remoteFollow(h, c, m, 'ana', { as: 'carol', accept: false });
    await c.ana.post(`/api/followers/${enc(`carol@${m.host}`)}/reject`);
    await h.ctx.federation.queue.drain().catch(() => {});
    const mine = () => h.ctx.federation.queue.list().filter((j) => j.signer === 'ana');
    assert.ok(mine().some((j) => j.activity_type === 'Create'), 'a Create waits');
    assert.ok(mine().some((j) => j.activity_type === 'Reject'), 'a Reject waits');
    let r = await c.ada.post('/api/admin/members/ana', { action: 'suspend' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.member.status, 'suspended');
    assert.deepEqual([...new Set(mine().map((j) => j.activity_type))], ['Reject'], 'only the essential job stays');
    r = await fetch(`${h.base}/users/ana`, { headers: { accept: 'application/activity+json' } });
    assert.equal(r.status, 404);
    assert.equal((await c.ana.get('/api/me')).status, 401, 'their session is no session');
    r = await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`, { name: 'carol' }), { name: 'carol' });
    assert.equal(r.status, 404, 'their personal inbox is the unknown name\'s');
    const held = followFrom(m, `${h.base}/users/ana`, { name: 'carol' });
    r = await m.post(`${h.base}/inbox`, held, { name: 'carol' });
    assert.equal(r.status, 202, 'the shared inbox takes it, and it is for no one');
    assert.equal(h.ctx.follows.load('ana').followers.filter((x) => x.handle === `carol@${m.host}`).length, 0, 'inbound for them is dropped');
    assert.equal((await c.ada.post('/api/admin/members/ana', { action: 'unsuspend' })).status, 200);
    r = await fetch(`${h.base}/users/ana`, { headers: { accept: 'application/activity+json' } });
    assert.equal(r.status, 200, 'lifted: the actor answers again');
    // What was for no one was never handled, so never spent: sent again, it lands.
    clock.advance(2000);   // a fresh Date, so a fresh signature (5.5)
    r = await m.post(`${h.base}/inbox`, held, { name: 'carol' });
    assert.equal(r.status, 202);
    assert.equal(h.ctx.follows.load('ana').followers.filter((x) => x.handle === `carol@${m.host}`).length, 1);
  } finally { await m.close(); await h.close(); }
});

test('two Ring servers: B\'s admin blocks A\'s domain; the friendship ends on B both ways, nothing is sent to A, A\'s deliveries are refused', { timeout: 120_000 }, async () => {
  const B = await startRing();
  const { h: A, c } = await fedRing(['ana']);
  try {
    const bo = await B.member('bo', 'Bo Berg');   // B's first member: its admin
    assert.equal((await bo.put('/api/me/page', { enabled: true })).status, 200);
    const aHost = new URL(A.base).host;
    const anaAtA = `ana@${aHost}`;
    const boAtB = `bo@${B.host}`;
    const status = async (client, handle) => (await client.get(`/api/friends/with/${enc(handle)}`)).body.status;
    assert.equal((await c.ana.post('/api/friends', { handle: boAtB })).status, 200);
    await A.ctx.federation.queue.drain();
    await until(async () => (await bo.get('/api/followers')).body.requests?.some((q) => q.handle === anaAtA), { what: 'the request on B' });
    assert.equal((await bo.post(`/api/friends/${enc(anaAtA)}/confirm`)).status, 200);
    await until(async () => (await status(c.ana, boAtB)) === 'friends', { what: 'friends on A' });
    await A.ctx.federation.queue.drain();
    await until(async () => (await status(bo, anaAtA)) === 'friends', { what: 'friends on B' });

    // ── B blocks A ──
    const r = await bo.post('/api/admin/domain-blocks', { host: aHost, reason: 'test' });
    assert.equal(r.status, 201, r.text);
    assert.equal(await status(bo, anaAtA), 'none', 'B: the friendship ended, both ways');
    assert.equal((await bo.get('/api/friends')).body.friends.length, 0);
    await B.drain();
    // Nothing went to A: ana still lists bo (inert on her side, refused from now on).
    assert.equal(await status(c.ana, boAtB), 'friends', 'A heard nothing: no Undo, no Reject');
    // A's post to bo's server is refused (403) and dropped, never retried.
    await c.ana.post('/api/posts', { kind: 'note', note: 'are you there' });
    await A.ctx.federation.queue.drain();
    const left = A.ctx.federation.queue.list().filter((j) => j.host === B.host);
    assert.equal(left.length, 0, 'the 403 ended the job');
    assert.equal((await bo.get('/api/feed/friends')).body.posts.length, 0, 'nothing of A reached bo');
    // Nothing is fetched from A either; positive control: lifted, it is.
    assert.equal((await bo.get(`/api/lookup?q=${enc(anaAtA)}`)).status, 404, 'B fetches nothing from A');
    assert.equal((await bo.del(`/api/admin/domain-blocks/${enc(aHost)}`)).status, 200);
    assert.equal((await bo.get(`/api/lookup?q=${enc(anaAtA)}`)).status, 200, 'lifted: A answers B again');
  } finally { await A.close(); await B.stop(); }
});

test('the render-time filters: a server-wide block hides a stamp, a friend tag and the Inbox row at once, before any purge; housekeeping then purges', async () => {
  const { h, c } = await fedRing(['ada', 'ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'x' })).body;
    await h.ctx.federation.queue.drain();
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: `${h.base}/users/ana/posts/${p.id}` }));
    const wall = async () => (await h.client().get('/api/pages/ana')).body;
    let w = await wall();
    assert.equal(w.posts.find((x) => x.id === p.id).stamps.length, 1);
    assert.deepEqual(w.friends.map((f) => f.handle), [bob]);
    assert.equal((await c.ana.get('/api/inbox')).body.stamps.length, 1);
    // The list alone, as a hand edit would leave it: no purge has run.
    h.ctx.moderation.addActor(bob, {});
    for (const n of ['ana']) h.ctx.projection.invalidate(n);
    w = await wall();
    assert.equal(w.posts.find((x) => x.id === p.id).stamps.length, 0, 'the stamp is hidden on the public wall');
    assert.deepEqual(w.friends, [], 'the friend tag is hidden');
    assert.equal((await c.ana.get('/api/inbox')).body.stamps.length, 0, 'and in the Inbox');
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1, 'the row is still there: the filter did it');
    // Positive control: lifted, it shows again.
    h.ctx.moderation.removeActor(bob);
    h.ctx.projection.invalidate('ana');
    assert.equal((await wall()).posts.find((x) => x.id === p.id).stamps.length, 1);
    // The housekeeping sweep re-applies the list to the rows.
    h.ctx.moderation.addActor(bob, {});
    const out = h.ctx.housekeeping.run();
    assert.ok(out.moderation >= 1, `the sweep purged (${JSON.stringify(out)})`);
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 0);
    assert.equal(h.ctx.follows.load('ana').following.length, 0);
  } finally { await m.close(); await h.close(); }
});

test('a Follow of a ring\'s Group is dropped, never answered (P8 decision: a Reject would be a peephole on a private ring)', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const ring = (await c.ana.post('/api/rings', { name: 'Club' })).body;
    const group = `${h.base}/rings/${ring.id}`;
    for (const path of [`/rings/${ring.id}/inbox`, '/inbox']) {
      const r = await m.post(`${h.base}${path}`, followFrom(m, group));
      assert.equal(r.status, 202, path);
    }
    await h.ctx.federation.queue.drain();
    assert.equal(m.deliveries.filter((d) => ['Reject', 'Accept'].includes(d.body?.type)).length, 0, 'no answer either way');
    assert.deepEqual(h.ctx.ringStore.get(ring.id).members.map((x) => x.handle), ['ana']);
    // Positive control: a Follow of a member here is answered (an Accept or a request row).
    await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`));
    assert.equal(h.ctx.follows.load('ana').followers.length, 1);
  } finally { await m.close(); await h.close(); }
});
