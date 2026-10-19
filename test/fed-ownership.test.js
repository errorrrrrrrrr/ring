'use strict';
/* fed-ownership (spec 5.4, 16.3; P6): a remote server writes only about its own
 * objects and people, only as itself, and only about what its sender may see.
 *   an Update or Delete of an object on another host is refused (403), and so
 *   is an Update of a Note whose attributedTo is not the actor; an Undo of
 *   someone else's Like is refused; a Delete{Person} by another actor is
 *   refused; an Accept{Follow} from someone other than the followee is refused;
 *   an Announce from a non-Group is dropped; a Like or a reply on a post the
 *   sender cannot see changes nothing; a comment's Delete by anyone but its
 *   author removes nothing; an Update{Person} moves no handle.
 * Also here, the rest of P6's security rules: Delete{Person} makes an actor GONE
 * (its rows go, its key never verifies again, its handle stays bound);
 * BLOCKED_DOMAINS refuses inbound (403), delivery, fetches, befriending and
 * lookups; an instance actor WebFinger does not answer for (Pleroma, Akkoma)
 * may sign a READ but never a POST; the 90-day actor prune; the media cache's
 * door (members only, the sniff, the size cap, least recently used out).
 * Each refusal has its positive control: the same activity, legitimate, lands. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../lib/clock');
const { fedRing, fakeMastodon, remoteFollow, befriendRemote, activityFrom, noteFrom, followFrom } = require('./helpers/fediverse');
const images = require('./helpers/images');

test.afterEach(() => clock.reset());
const enc = encodeURIComponent;

test('Update and Delete: only of the sender\'s own objects, on its own host; an Update of someone else\'s Note is refused', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  const other = await fakeMastodon({ users: ['dan'], keyIndex: 4 });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    const { create, note } = noteFrom(m, { text: 'original' });
    await m.post(`${h.base}/inbox`, create);
    assert.equal(h.ctx.walls.list(bob).length, 1);
    const text = () => JSON.stringify(h.ctx.walls.list(bob)[0].tree);

    // dan (another host) updates bob's Note: the object is on another host.
    const forged = activityFrom(other, 'Update', { object: { ...note, attributedTo: other.actor('dan'), content: '<p>forged</p>' } }, { name: 'dan' });
    let r = await other.post(`${h.base}/inbox`, forged, { name: 'dan' });
    assert.equal(r.status, 403, r.text);
    // carol (same host) updates bob's Note: attributedTo is not her.
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object: { ...note, content: '<p>forged</p>' } }, { name: 'carol' }), { name: 'carol' });
    assert.equal(r.status, 403, r.text);
    // carol claims to be the author.
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object: { ...note, attributedTo: m.actor('carol'), content: '<p>forged</p>' } }, { name: 'carol' }), { name: 'carol' });
    assert.equal(r.status, 202, 'her own claim passes the door...');
    assert.ok(text().includes('original'), '...and moves nothing: the stored author is bob');
    // dan deletes it: another host's object.
    r = await other.post(`${h.base}/inbox`, activityFrom(other, 'Delete', { object: note.id }, { name: 'dan' }), { name: 'dan' });
    assert.equal(r.status, 403);
    // carol deletes it (same host, not hers): nothing moves.
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Delete', { object: { id: note.id, type: 'Tombstone' } }, { name: 'carol' }), { name: 'carol' });
    assert.equal(h.ctx.walls.list(bob).length, 1);
    // A Create whose object lives on another host.
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Create', { object: { ...note, id: `${other.base}/users/dan/statuses/1` } }));
    assert.equal(r.status, 403);
    // Positive controls: bob's own Update, then his own Delete.
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object: { ...note, content: '<p>edited by bob</p>' } }));
    assert.equal(r.status, 202);
    assert.ok(text().includes('edited by bob'));
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Delete', { object: { id: note.id, type: 'Tombstone' } }));
    assert.equal(h.ctx.walls.list(bob).length, 0);
  } finally { await m.close(); await other.close(); await h.close(); }
});

test('an Undo of someone else\'s Like, a comment Delete by another, an Accept from someone not followed, an Announce from a non-Group: refused or dropped', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'x' })).body;
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    const like = activityFrom(m, 'Like', { object: postUrl });
    await m.post(`${h.base}/inbox`, like);
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1);
    // carol undoes bob's Like (her own Undo, embedding his Like).
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Undo', { object: like }, { name: 'carol' }), { name: 'carol' });
    // carol's Undo naming herself as the Like's actor: the stored author is bob.
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Undo', { object: { ...like, actor: m.actor('carol') } }, { name: 'carol' }), { name: 'carol' });
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1, 'still there');
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Undo', { object: like }));
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 0, 'positive control: bob\'s own Undo');

    // A friend's comment, deleted by someone else: stays.
    await befriendRemote(h, c, m, 'ana');
    const { create, note } = noteFrom(m, { text: 'nice', inReplyTo: postUrl });
    await m.post(`${h.base}/inbox`, create);
    assert.equal(h.ctx.reactions.loadComments('ana').length, 1);
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Delete', { object: { id: note.id, type: 'Tombstone' } }, { name: 'carol' }), { name: 'carol' });
    assert.equal(h.ctx.reactions.loadComments('ana').length, 1, 'carol cannot delete bob\'s comment');

    // An Accept{Follow} from someone ana never asked: her rows do not move.
    const before = JSON.stringify(h.ctx.follows.load('ana'));
    const ask = (await c.ana.post('/api/friends', { handle: `carol@${m.host}` }));
    assert.equal(ask.status, 200);
    await h.ctx.federation.queue.drain();
    const follow = m.deliveries.findLast((d) => d.body?.type === 'Follow' && d.body.object === m.actor('carol')).body;
    // bob answers carol's request: refused (only the followee answers).
    await m.post(`${h.base}/users/ana/inbox`, activityFrom(m, 'Accept', { object: { ...follow } }));
    assert.equal(h.ctx.follows.load('ana').following.find((r) => r.handle === `carol@${m.host}`).state, 'pending');
    // ... nor by naming the Follow's id alone.
    await m.post(`${h.base}/users/ana/inbox`, activityFrom(m, 'Accept', { object: follow.id }));
    assert.equal(h.ctx.follows.load('ana').following.find((r) => r.handle === `carol@${m.host}`).state, 'pending');
    // Positive control: carol's own Accept, by the id alone (other software's way).
    await m.post(`${h.base}/users/ana/inbox`, activityFrom(m, 'Accept', { object: follow.id }, { name: 'carol' }), { name: 'carol' });
    assert.equal(h.ctx.follows.load('ana').following.find((r) => r.handle === `carol@${m.host}`).state, 'accepted');
    assert.notEqual(JSON.stringify(h.ctx.follows.load('ana')), before);

    // An Announce from a Person (a boost): dropped, records nothing.
    const s0 = h.ctx.federation.seen.size();
    assert.equal((await m.post(`${h.base}/inbox`, activityFrom(m, 'Announce', { object: postUrl }))).status, 202);
    assert.equal(h.ctx.federation.seen.size(), s0);
  } finally { await m.close(); await h.close(); }
});

test('a Like or a reply on a post the sender cannot see lands nowhere: page off, archive, a room', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    await befriendRemote(h, c, m, 'ana');
    const ring = (await c.ana.post('/api/rings', { name: 'Thursday' })).body;
    const room = (await c.ana.post('/api/posts', { kind: 'note', note: 'room', audience: ring.id })).body;
    const pub = (await c.ana.post('/api/posts', { kind: 'note', note: 'public' })).body;
    const url = (p) => `${h.base}/users/ana/posts/${p.id}`;
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: url(room) }));
    await m.post(`${h.base}/inbox`, noteFrom(m, { inReplyTo: url(room), text: 'room reply' }).create);
    assert.deepEqual(h.ctx.reactions.loadStamps('ana'), []);
    assert.deepEqual(h.ctx.reactions.loadComments('ana'), []);
    assert.deepEqual(h.ctx.elsewhere.load('ana'), [], 'not even From elsewhere: the room post is not theirs to see');
    await c.ana.put('/api/me/page', { enabled: false });
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: url(pub) }));
    assert.deepEqual(h.ctx.reactions.loadStamps('ana'), [], 'page off: the post is absent');
    await c.ana.put('/api/me/page', { enabled: true });
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: url(pub) }));
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1, 'positive control: page on');
  } finally { await m.close(); await h.close(); }
});

test('Delete{Person}: only by the actor itself; then it is gone: rows go, its key never verifies again, its handle stays bound', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'x' })).body;
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl, content: '🔥' }));
    await m.post(`${h.base}/inbox`, noteFrom(m, { inReplyTo: postUrl, text: 'hi' }).create);
    await m.post(`${h.base}/inbox`, noteFrom(m, { text: 'on my wall' }).create);
    await remoteFollow(h, c, m, 'bram', { accept: false });
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1);
    assert.equal(h.ctx.walls.list(bob).length, 1);
    const del = m.p6('p6-mastodon-delete-person.json', 'body', {});
    // carol deletes bob: refused.
    let r = await m.post(`${h.base}/inbox`, { ...del, id: `${m.actor('carol')}#delete`, actor: m.actor('carol') }, { name: 'carol' });
    assert.equal(r.status, 403);
    assert.ok(!h.ctx.federation.actors.get(m.actor()).gone_at);
    // bob deletes himself.
    r = await m.post(`${h.base}/inbox`, del);
    assert.equal(r.status, 202);
    const rec = h.ctx.federation.actors.get(m.actor());
    assert.ok(rec.gone_at);
    assert.deepEqual(Object.keys(rec).sort(), ['gone_at', 'handle', 'id']);
    assert.deepEqual(h.ctx.reactions.loadStamps('ana'), []);
    assert.deepEqual(h.ctx.reactions.loadComments('ana'), []);
    assert.deepEqual(h.ctx.follows.load('ana').following, []);
    assert.deepEqual(h.ctx.follows.load('bram').followers, []);
    assert.equal(h.ctx.walls.list(bob).length, 0);
    assert.equal((await c.ana.get('/api/friends')).body.friends.length, 0);
    // Its key never verifies again: a signed POST from bob is refused.
    r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: postUrl }));
    assert.equal(r.status, 401);
    assert.deepEqual(h.ctx.reactions.loadStamps('ana'), []);
    // The handle stays bound: a new actor document claiming bob is refused.
    await assert.rejects(h.ctx.federation.actors.fetchActor(m.actor()), /gone|bound|refused/);
    // A 410 for a known actor is gone too (5.3).
    const c2 = await fakeMastodon({ users: ['zed'], keyIndex: 6 });
    try {
      await remoteFollow(h, c, c2, 'ana', { as: 'zed', accept: false });
      c2.serve('/users/zed', { gone: true }, { status: 410 });
      await assert.rejects(h.ctx.federation.actors.fetchActor(c2.actor('zed')));
      assert.ok(h.ctx.federation.actors.get(c2.actor('zed')).gone_at);
      assert.deepEqual(h.ctx.follows.load('ana').followers.filter((f) => f.handle.startsWith('zed@')), []);
    } finally { await c2.close(); }
  } finally { await m.close(); await h.close(); }
});

test('Update{Person}: only of itself, the same checks, and a handle never moves', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await befriendRemote(h, c, m, 'ana');
    const doc = m.actorDoc('bob');
    const send = (object, name = 'bob') => m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object }, { name }), { name });
    assert.equal((await send({ ...doc, name: 'Robert' }, 'carol')).status, 403, 'carol updates bob');
    assert.equal(h.ctx.federation.actors.get(m.actor()).name, 'Bob Remote');
    await send({ ...doc, preferredUsername: 'robert', name: 'Robert' });
    assert.equal(h.ctx.federation.actors.get(m.actor()).name, 'Bob Remote', 'a new preferredUsername is refused');
    await send({ ...doc, inbox: 'https://elsewhere.example/inbox', name: 'Robert' });
    assert.equal(h.ctx.federation.actors.get(m.actor()).inbox, `${m.base}/users/bob/inbox`, 'an inbox on another host is refused');
    await send({ ...doc, name: 'Robert <b>R</b>\u202E', summary: '<p>new <script>x</script>bio</p>' });
    const rec = h.ctx.federation.actors.get(m.actor());
    assert.equal(rec.name, 'Robert <b>R</b>', 'positive control: his own Update; the name plain, bidi out');
    assert.deepEqual(rec.bio, [{ t: 'p', c: ['new bio'] }]);
    const friends = (await c.ana.get('/api/friends')).body.friends;
    assert.equal(friends[0].name, 'Robert <b>R</b>');
  } finally { await m.close(); await h.close(); }
});

test('BLOCKED_DOMAINS: inbound 403, nothing delivered or fetched, no befriending or lookup; another host unaffected', async () => {
  const blocked = await fakeMastodon({ users: ['bob'], hostname: 'localhost' });
  const fine = await fakeMastodon({ users: ['carol'], keyIndex: 4 });
  const { h, c } = await fedRing(['ana'], { env: { BLOCKED_DOMAINS: 'localhost' } });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'x' })).body;
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    let r = await blocked.post(`${h.base}/inbox`, activityFrom(blocked, 'Like', { object: postUrl }));
    assert.equal(r.status, 403);
    assert.equal(blocked.gets.length, 0, 'not even its key was fetched');
    r = await blocked.post(`${h.base}/users/ana/inbox`, followFrom(blocked, `${h.base}/users/ana`));
    assert.equal(r.status, 403);
    r = await blocked.get(`${h.base}/users/ana/outbox`);
    assert.equal(r.status, 403, 'a signed read too');
    assert.equal((await c.ana.post('/api/friends', { handle: `bob@${blocked.host}` })).status, 404);
    assert.equal((await c.ana.get(`/api/lookup?q=${enc(`bob@${blocked.host}`)}`)).status, 404);
    assert.equal((await c.ana.get(`/api/lookup?q=${enc(blocked.actor())}`)).status, 404);
    assert.equal(blocked.gets.length, 0, 'nothing fetched from it');
    await assert.rejects(h.ctx.federation.net.fetchGuarded(`${blocked.base}/x`), /blocked/);
    // Delivery: a job for it is dropped, never attempted.
    h.ctx.federation.queue.enqueue({ id: `${h.base}/users/ana/activities/x1`, type: 'Follow', actor: `${h.base}/users/ana`, object: blocked.actor() }, [blocked.actor()], { signer: 'ana' });
    await h.ctx.federation.queue.drain();
    assert.equal(blocked.deliveries.length, 0);
    // Positive control: another host is untouched.
    r = await fine.post(`${h.base}/inbox`, activityFrom(fine, 'Like', { object: postUrl }, { name: 'carol' }), { name: 'carol' });
    assert.equal(r.status, 202);
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 1);
    assert.equal((await c.ana.get(`/api/lookup?q=${enc(`carol@${fine.host}`)}`)).status, 200);
  } finally { await blocked.close(); await fine.close(); await h.close(); }
});

test('an Akkoma-style instance actor WebFinger does not answer for: it may sign a read, never a POST', async () => {
  const { h } = await fedRing(['ana']);
  const ak = await fakeMastodon({ users: ['cat'], software: 'akkoma', instanceActor: true, keyIndex: 2 });
  try {
    let r = await ak.get(`${h.base}/users/ana/outbox`, { instance: true });
    assert.equal(r.status, 200, r.text);
    const rec = h.ctx.federation.actors.get(`${ak.base}/internal/fetch`);
    assert.equal(rec.unbound, true);
    assert.equal(rec.handle, '');
    // Its POST: refused, whatever it says.
    const body = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ak.base}/activities/1`, type: 'Follow', actor: `${ak.base}/internal/fetch`, object: `${h.base}/users/ana` });
    const { sign } = require('./helpers/fediverse');
    const hdr = sign({ method: 'POST', url: `${h.base}/inbox`, body, keyId: `${ak.base}/internal/fetch#main-key`, privateKey: require('./helpers/fediverse').keypair(3).privateKey, headers: { 'content-type': 'application/activity+json' } });
    delete hdr.host;
    r = await fetch(`${h.base}/inbox`, { method: 'POST', headers: hdr, body });
    assert.equal(r.status, 401);
    assert.deepEqual(h.ctx.follows.load('ana').followers, []);
    // Positive control: a Person on the same server (WebFinger answers) may post.
    r = await ak.post(`${h.base}/inbox`, followFrom(ak, `${h.base}/users/ana`, { name: 'cat' }), { name: 'cat' });
    assert.equal(r.status, 202);
    assert.equal(h.ctx.follows.load('ana').followers.length, 1);
  } finally { await ak.close(); await h.close(); }
});

test('the actor cache: an actor unused for 90 days and named by no row goes; a named one and a gone one stay', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol', 'dan'] });
  try {
    const actors = h.ctx.federation.actors;
    await remoteFollow(h, c, m, 'ana', { as: 'bob' });   // named by a follow row
    await actors.resolve(m.actor('carol'));               // named by nothing
    await actors.resolve(m.actor('dan'));
    actors.markGone(m.actor('dan'));
    clock.advance(89 * 24 * 3600_000);
    h.ctx.housekeeping.run();
    assert.ok(actors.get(m.actor('carol')), 'not yet');
    clock.advance(2 * 24 * 3600_000);
    const out = h.ctx.housekeeping.run();
    assert.equal(out.actor_cache, 1);
    assert.equal(actors.get(m.actor('carol')), null, 'unused and unnamed: gone from the cache');
    assert.ok(actors.get(m.actor('bob')), 'named by a follow row: kept');
    assert.ok(actors.get(m.actor('dan')).gone_at, 'a gone record keeps the handle bound');
    const files = fs.readdirSync(path.join(h.dir, 'fed', 'actors')).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    assert.equal(files.length, 2, 'its file is gone too');
  } finally { await m.close(); await h.close(); }
});

test('the media cache: members only, the sniff and the cap, a re-encode never the original, least recently used out', async () => {
  const { h, c } = await fedRing(['ana'], { env: { REMOTE_MEDIA_MB: '1' } });
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const media = h.ctx.federation.media;
    const gps = await images.gpsJpeg();
    m.serve('/a.jpg', gps, { type: 'image/jpeg' });
    m.serve('/svg.jpg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { type: 'image/jpeg' });
    m.serve('/page.png', Buffer.from('<html>no</html>'), { type: 'text/html' });
    const good = media.want(`${m.base}/a.jpg`);
    const svg = media.want(`${m.base}/svg.jpg`);
    const html = media.want(`${m.base}/page.png`);
    await media.idle();
    assert.equal(media.row(good).state, 'ready');
    assert.equal(media.row(svg).state, 'failed', 'an SVG renamed .jpg is refused by the sniff');
    assert.equal(media.row(html).state, 'failed', 'a non-image type is refused');
    const web = fs.readFileSync(media.file(good, 'web'));
    const { sharp } = images;
    const meta = await sharp(web).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.exif, undefined, 'no EXIF, no GPS');
    assert.equal((await h.client().bytes(`/media/${good}/web`)).status, 401);
    assert.equal((await c.ana.bytes(`/media/${good}/web`)).status, 200);
    assert.equal((await c.ana.bytes(`/media/${good}/original`)).status, 404, 'never the original');
    assert.equal((await c.ana.bytes('/media/m_00000000000000000000000000000000/web')).status, 404);
    // Over the cap: trimmed least recently used first, and a miss fetches again.
    assert.equal(h.ctx.cfg.remoteMediaBytes, 1024 * 1024, 'REMOTE_MEDIA_MB is read');
    for (let i = 0; i < 4; i++) m.serve(`/big${i}.png`, await sharp({ create: { width: 400, height: 400, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer(), { type: 'image/png' });
    const ids = [];
    for (let i = 0; i < 4; i++) { ids.push(media.want(`${m.base}/big${i}.png`)); await media.idle(); clock.advance(1000); }
    // A limit that holds the two newest (and the jpeg, used most recently below).
    media.file(good, 'web');
    const limit = [good, ids[2], ids[3]].reduce((n, id) => n + media.row(id).bytes, 0);
    const trimmed = media.trim(limit);
    assert.equal(trimmed, 2, `trimmed ${trimmed}`);
    assert.equal(media.row(ids[0]).state, 'trimmed', 'the least recently used goes first');
    assert.equal(media.row(ids[3]).state, 'ready');
    assert.equal((await c.ana.bytes(`/media/${ids[0]}/web`)).status, 200, 'a miss fetches it again');
  } finally { await m.close(); await h.close(); }
});
