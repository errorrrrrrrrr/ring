'use strict';
/* Gate: privacy, the public half (spec 16.3 "privacy", 10.1 to 10.6, 10.10,
 * 10.12). A page that is off is absent, images included; the archive is the
 * author's alone; a post, theme or avatar holds only its author's images; CSRF;
 * headers; image key entropy; the miss budget. P2 adds the room half: a lapsed
 * room post is invisible before the sweep (room, verbs, image), room images are
 * `no-store`, a stored audience of no known shape reads as the archive, and zero
 * new access: a follower, a friend and a ring-mate read nothing a stranger does
 * not, outside the room itself. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { imageStamp, STAMP_RE } = require('../lib/image-stamp');
const { boot, joinAdmin, joinInvited } = require('./helpers/harness');
const { png } = require('./helpers/images');
const { crowd, befriend, ring, note } = require('./helpers/social');

test.afterEach(() => clock.reset());

test('a page that is off equals an unknown name, for the page and its images', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const post = (await ana.upload(await png())).body.key;
    const avatar = (await ana.upload(await png())).body.key;
    const bg = (await ana.upload(await png())).body.key;
    await ana.post('/api/posts', { kind: 'image', media: { key: post, alt: 'x' } });
    await ana.put('/api/me/page', { enabled: true, avatar_key: avatar, theme: { bg_image_key: bg } });
    const anon = h.client();
    for (const k of [post, avatar, bg]) {
      const r = await anon.bytes(`/api/images/${k}/web`);
      assert.equal(r.status, 200, 'positive control: public while on');
      assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000');
    }

    await ana.put('/api/me/page', { enabled: false });
    const unknownKey = `img_${imageStamp()}`;
    const unknownImg = await anon.get(`/api/images/${unknownKey}/web`);
    for (const k of [post, avatar, bg]) {
      for (const v of ['web', 'thumb']) {
        const r = await anon.get(`/api/images/${k}/${v}`);
        assert.equal(r.status, 404, `${k}/${v} with the page off`);
        assert.deepEqual(r.body, unknownImg.body);
      }
      const own = await ana.bytes(`/api/images/${k}/web`);
      assert.equal(own.status, 200, 'the author still sees their own');
      assert.equal(own.headers.get('cache-control'), 'private, no-store');
    }
    const page = await anon.get('/api/pages/ana');
    const nobody = await anon.get('/api/pages/zzz-nobody');
    assert.equal(page.status, 404);
    assert.deepEqual(page.body, nobody.body);
    assert.equal(page.headers.get('x-robots-tag'), nobody.headers.get('x-robots-tag'));

    // A signed-in member of this server is a stranger to an off page too.
    const bob = await joinInvited(h, ana, { slug: 'bob' });
    assert.equal((await bob.get(`/api/images/${post}/web`)).status, 404);
    assert.equal((await bob.get('/api/pages/ana')).status, 404);

    // A suspended member's page is absent as well.
    await ana.put('/api/me/page', { enabled: true });
    assert.equal((await anon.get('/api/pages/ana')).status, 200);
    h.ctx.members.update('ana', { status: 'suspended' });
    assert.equal((await anon.get('/api/pages/ana')).status, 404);
    assert.equal((await anon.get(`/api/images/${post}/web`)).status, 404);
  } finally { await h.close(); }
});

test('archive images are the author\'s alone; an unposted upload too', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    await ana.put('/api/me/page', { enabled: true });
    const kept = (await ana.upload(await png())).body.key;
    const shelved = (await ana.upload(await png())).body.key;
    const loose = (await ana.upload(await png())).body.key;
    await ana.post('/api/posts', { kind: 'image', media: { key: kept, alt: '' } });
    // The weekly sweep (P2) re-addresses a room post to the archive: written here as it would.
    const store = h.ctx.pages.load('ana');
    store.posts.push({ id: 'parchive000000000', kind: 'image', media: { key: shelved, alt: '' }, created_at: clock.iso(), audience: 'archive', archived_from: 'ring_0123456789abcdef0123', archived_at: clock.iso() });
    h.ctx.pages.save('ana', store);

    const anon = h.client();
    assert.equal((await anon.bytes(`/api/images/${kept}/web`)).status, 200, 'positive control');
    assert.equal((await anon.get(`/api/images/${shelved}/web`)).status, 404, 'archive: strangers 404');
    assert.equal((await anon.get(`/api/images/${loose}/web`)).status, 404, 'unposted: strangers 404');
    const own = await ana.bytes(`/api/images/${shelved}/thumb`);
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
    assert.ok(!(await anon.get('/api/pages/ana')).body.posts.some((p) => p.image_key === shelved));

    // Posting the loose one publishes it, live.
    await ana.post('/api/posts', { kind: 'image', media: { key: loose, alt: '' } });
    assert.equal((await anon.bytes(`/api/images/${loose}/web`)).status, 200);
  } finally { await h.close(); }
});

test('a foreign image key is refused in a post, a link, the theme and the avatar', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const bob = await joinInvited(h, ana, { slug: 'bob' });
    const anas = (await ana.upload(await png())).body.key;
    const refusals = [
      await bob.post('/api/posts', { kind: 'image', media: { key: anas, alt: '' } }),
      await bob.post('/api/posts', { kind: 'link', media: { href: 'https://x.example', label: 'x', key: anas } }),
      await bob.put('/api/me/page', { theme: { bg_image_key: anas } }),
      await bob.put('/api/me/page', { avatar_key: anas }),
      await bob.post('/api/posts', { kind: 'image', media: { key: `img_${imageStamp()}`, alt: '' } }),
    ];
    for (const r of refusals) {
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'foreign_image');
    }
    // An edit cannot smuggle a foreign key either: an image post and a link post of
    // bob's own, each PATCHed to point at ana's key (tests-r1-patch-foreign-key-vacuous).
    const bobs = (await bob.upload(await png())).body.key;
    const bobsLink = (await bob.upload(await png())).body.key;
    const imgPost = await bob.post('/api/posts', { kind: 'image', media: { key: bobs, alt: '' } });
    assert.equal(imgPost.status, 201, 'positive control');
    const linkPost = await bob.post('/api/posts', { kind: 'link', media: { href: 'https://bob.example', label: 'b', key: bobsLink } });
    assert.equal(linkPost.status, 201);
    for (const [post, own] of [[imgPost.body, bobs], [linkPost.body, bobsLink]]) {
      const edit = await bob.patch(`/api/posts/${post.id}`, { media: { key: anas } });
      assert.equal(edit.status, 400, `${post.kind}: ${edit.text}`);
      assert.equal(edit.body.error, 'foreign_image');
      const stored = (await bob.get('/api/me/page')).body.posts.find((p) => p.id === post.id);
      assert.equal(stored.media.key, own, `${post.kind}: the stored post still holds bob's own key`);
      assert.equal((await bob.patch(`/api/posts/${post.id}`, { media: { alt: 'ok' } })).status, 200, 'positive control: an honest edit passes');
    }
    for (const post of [imgPost.body, linkPost.body]) assert.equal((await bob.del(`/api/posts/${post.id}`)).status, 200);
    assert.ok(h.ctx.images.row(anas), "ana's image row survives bob's deletes");
    assert.equal((await ana.bytes(`/api/images/${anas}/web`)).status, 200, "and ana's bytes");
    assert.equal(h.ctx.images.row(bobs), null, "positive control: bob's own image went with his post");
    // Kind is immutable on an edit: a note PATCHed as an image stays a note, keyless.
    const mine = await bob.post('/api/posts', { kind: 'note', note: 'x' });
    const asImage = await bob.patch(`/api/posts/${mine.body.id}`, { kind: 'image', media: { key: anas } });
    assert.equal(asImage.body.kind, 'note');
    assert.equal(asImage.body.media?.key, undefined);
    const avatar = (await bob.upload(await png())).body.key;
    assert.equal((await bob.put('/api/me/page', { avatar_key: avatar })).status, 200);
  } finally { await h.close(); }
});

test('cross-site writes are refused; same-origin and non-browser clients pass', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const cross = await ana.post('/api/posts', { kind: 'note', note: 'x' }, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error, 'csrf');
    const evil = await ana.post('/api/posts', { kind: 'note', note: 'x' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const nul = await ana.put('/api/me/page', { enabled: true }, { headers: { origin: 'null' } });
    assert.equal(nul.status, 403);
    const upload = await ana.upload(await png(), { headers: { origin: 'https://evil.example' } });
    assert.equal(upload.status, 403, 'multipart too');
    const del = await ana.req('DELETE', '/api/me', { json: { password: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(del.status, 403);
    assert.equal((await ana.get('/api/me/page')).body.posts.length, 0, 'nothing landed');

    assert.equal((await ana.post('/api/posts', { kind: 'note', note: 'x' }, { headers: { origin: h.base, 'sec-fetch-site': 'same-origin' } })).status, 201);
    assert.equal((await ana.post('/api/posts', { kind: 'note', note: 'y' })).status, 201, 'no Origin: a non-browser client');
    assert.equal((await h.client().get('/api/pages/ana', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 404, 'a GET is never refused for CSRF');
  } finally { await h.close(); }
});

test('JSON only, 64 KB at most', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const form = await ana.req('POST', '/api/posts', { body: 'kind=note&note=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const text = await ana.req('POST', '/api/posts', { body: '{"kind":"note","note":"x"}', headers: { 'content-type': 'text/plain' } });
    assert.equal(text.status, 415, 'a cross-site form cannot dress JSON as text/plain');
    const big = await ana.post('/api/posts', { kind: 'note', note: 'x'.repeat(70 * 1024) });
    assert.equal(big.status, 413);
    const bad = await ana.req('POST', '/api/posts', { body: '{nope', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad_json');
    assert.equal((await ana.post('/api/posts', { kind: 'note', note: 'x'.repeat(6000) })).status, 201, 'positive control');
  } finally { await h.close(); }
});

test('security headers on every answer', async () => {
  const h = await boot();
  try {
    for (const p of ['/', '/api/health', '/api/pages/nobody', '/nowhere', '/assets/base.css']) {
      const r = await h.client().get(p);
      const csp = r.headers.get('content-security-policy') || '';
      assert.match(csp, /default-src 'self'/, p);
      assert.match(csp, /img-src 'self'(;|$)/, p);
      assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/player\.vimeo\.com https:\/\/w\.soundcloud\.com/, p);
      assert.ok(!/script-src[^;]*unsafe/.test(csp), p);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', p);
      assert.equal(r.headers.get('access-control-allow-origin'), null, p);
      assert.equal(r.headers.get('x-powered-by'), null, p);
    }
    const ana = await joinAdmin(h, 'ana');
    const cookie = (await ana.raw('POST', '/api/login', { json: { email: 'admin@example.test', password: 'correct horse battery staple' } })).headers.getSetCookie()[0];
    assert.match(cookie, /^ring\.sid=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.ok(!/Secure/i.test(cookie), 'not Secure outside production');
  } finally { await h.close(); }
});

test('image keys carry 64 CSPRNG bits', () => {
  const tails = new Set();
  for (let i = 0; i < 5000; i++) {
    const s = imageStamp();
    assert.match(s, STAMP_RE);
    tails.add(s.slice(14));
  }
  assert.equal(tails.size, 5000);
  const src = require('node:fs').readFileSync(require.resolve('../lib/image-stamp'), 'utf8');
  assert.match(src, /crypto\.randomBytes\(8\)/);
  assert.ok(!/Math\.random\(/.test(src));
});

test('the miss budget: 100 misses a minute per IP, then 429; hits are free', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    clock.set(Date.now());
    const ana = await joinAdmin(h, 'ana');
    await ana.put('/api/me/page', { enabled: true });
    const key = (await ana.upload(await png())).body.key;
    await ana.post('/api/posts', { kind: 'image', media: { key, alt: '' } });
    const anon = h.client();
    for (let i = 0; i < 120; i++) assert.equal((await anon.bytes(`/api/images/${key}/thumb`)).status, 200);
    for (let i = 0; i < 100; i++) assert.equal((await anon.bytes(`/api/images/img_${imageStamp()}/web`)).status, 404);
    const spent = await anon.get(`/api/images/img_${imageStamp()}/web`);
    assert.equal(spent.status, 429);
    assert.ok(Number(spent.headers.get('retry-after')) > 0);
    assert.equal((await anon.get(`/api/images/${key}/web`)).status, 429, 'refused before the gate, hit or not');
    clock.advance(61_000);
    assert.equal((await anon.bytes(`/api/images/${key}/web`)).status, 200);
  } finally { await h.close(); }
});

test('a lapsed room post is invisible before the sweep: the room, its verbs and its image', async () => {
  const t0 = Date.parse('2026-10-01T09:00:00Z');
  clock.set(t0);
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    const { id } = await ring(c, 'ana', ['bram']);
    await befriend(c, 'bram', 'ana');
    const key = (await c.ana.upload(await png())).body.key;
    const post = (await c.ana.post('/api/posts', { kind: 'image', media: { key, alt: '' }, audience: id })).body.id;
    const path = `/api/pages/ana/posts/${post}`;
    clock.set(t0 + 7 * 86400_000 - 1000);
    assert.ok((await c.bram.get(`/api/rings/${id}/feed`)).body.posts.some((p) => p.id === post), 'positive control: a second before, it is there');
    assert.equal((await c.bram.bytes(`/api/images/${key}/web`)).status, 200, 'and so is its image');
    clock.set(t0 + 7 * 86400_000);
    assert.equal(h.ctx.pages.load('ana').posts.find((p) => p.id === post).audience, id, 'not swept');
    assert.ok(!(await c.bram.get(`/api/rings/${id}/feed`)).body.posts.some((p) => p.id === post), 'out of the room at the instant');
    assert.equal((await c.bram.post(`${path}/stamp`, { kaomoji: '✿' })).status, 404);
    assert.equal((await c.bram.post(`${path}/comment`, { body: 'late' })).status, 404);
    assert.equal((await c.bram.get(`/api/images/${key}/web`)).status, 404, 'its image 404s to the room');
    const own = await c.ana.bytes(`/api/images/${key}/web`);
    assert.equal(own.status, 200, 'the author keeps it');
    assert.equal(own.headers.get('cache-control'), 'private, no-store');
  } finally { await h.close(); }
});

test('a stored audience of no known shape reads as the archive: never Public, never a room', async () => {
  const { h, c } = await crowd(['ana']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const store = h.ctx.pages.load('ana');
    store.posts.push({ id: 'pweirdaudience00', kind: 'note', note: 'odd address', created_at: new Date().toISOString(), audience: 'ring_oldshapeid' });
    h.ctx.pages.save('ana', store);
    assert.equal(h.ctx.pages.load('ana').posts.find((p) => p.id === 'pweirdaudience00').audience, 'archive');
    assert.ok(!JSON.stringify((await h.client().get('/api/pages/ana')).body).includes('odd address'));
    assert.ok((await c.ana.get('/api/archive')).body.posts.some((p) => p.id === 'pweirdaudience00'));
  } finally { await h.close(); }
});

test('zero new access: a follower, a friend and a ring-mate read nothing a stranger does not, outside the room', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await note(c.ana, 'out in the open');
    const { id } = await ring(c, 'ana', ['dora']);
    await note(c.ana, 'room only', id);
    await befriend(c, 'bram', 'ana');                       // a friend
    await c.coco.post('/api/friends', { handle: 'ana' });   // a follower
    await c.ana.post('/api/followers/coco/accept');
    const shelved = h.ctx.pages.load('ana');
    shelved.posts.push({ id: 'pshelvedshelved0', kind: 'note', note: 'on the shelf', created_at: new Date().toISOString(), audience: 'archive', archived_from: id });
    h.ctx.pages.save('ana', shelved);

    const strip = (b) => { const x = { ...b }; delete x.visits; return JSON.stringify(x); };
    const stranger = strip((await h.client().get('/api/pages/ana')).body);
    for (const n of ['bram', 'coco', 'dora']) {
      assert.equal(strip((await c[n].get('/api/pages/ana')).body), stranger, `${n} reads the wall a stranger reads`);
    }
    assert.ok(!stranger.includes('room only') && !stranger.includes('on the shelf'));
    for (const n of ['bram', 'coco']) {
      assert.ok(!JSON.stringify((await c[n].get('/api/feed')).body).includes('room only'), `${n}: no room post in the square`);
      assert.ok(!JSON.stringify((await c[n].get('/api/feed/friends')).body).includes('room only'), `${n}: none in Friends`);
    }
    assert.equal((await c.bram.get(`/api/rings/${id}/feed`)).status, 404, 'a friend who is not in the ring: the opaque 404');
    assert.ok(JSON.stringify((await c.dora.get(`/api/rings/${id}/feed`)).body).includes('room only'), 'positive control: the ring-mate reads the room');
    // Page off: the wall is absent for all four alike.
    await c.ana.put('/api/me/page', { enabled: false });
    for (const cl of [h.client(), c.bram, c.coco, c.dora]) assert.equal((await cl.get('/api/pages/ana')).status, 404);
    assert.ok(!JSON.stringify((await c.bram.get('/api/feed/friends')).body.posts).includes('out in the open'), 'nor in Friends');
  } finally { await h.close(); }
});
