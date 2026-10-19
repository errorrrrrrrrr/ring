'use strict';
/* Gate: own posts and the page (spec 16.2 "ring", the P1 part: stamps, comments,
 * friends and rings arrive in P2). Each kind persists with server ids, refusals,
 * edits, deletes, the sanitizer, the page settings, and GET /api/pages/:name. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../lib/clock');
const { STAMP_STYLES } = require('../lib/palette');
const { boot, joinAdmin, joinInvited } = require('./helpers/harness');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

/* A setup that fails closes what it booted: a signup regression is a red test,
 * never a hung file holding a server (tests-r1-harness-hang-on-setup-failure). */
async function setup() {
  const h = await boot();
  try {
    return { h, ana: await joinAdmin(h, 'ana') };
  } catch (e) {
    await h.close();
    throw e;
  }
}

test('the own store needs a session', async () => {
  const { h, ana } = await setup();
  try {
    assert.equal((await h.client().get('/api/me/page')).status, 401);
    assert.equal((await h.client().post('/api/posts', { kind: 'note', note: 'x' })).status, 401);
    assert.equal((await h.client().put('/api/me/page', { enabled: true })).status, 401);
    assert.equal((await ana.get('/api/me/page')).status, 200, 'positive control');
  } finally { await h.close(); }
});

test('each kind persists with a server id and a derived URL', async () => {
  const { h, ana } = await setup();
  try {
    const key = (await ana.upload(await png())).body.key;
    const bodies = [
      { kind: 'note', note: 'new prints *drying*' },
      { kind: 'image', media: { key, alt: 'three prints', href: 'https://ana.example/prints' }, note: 'caption' },
      { kind: 'link', media: { href: 'https://ana.example', label: 'my site', sub: 'a sub line', key } },
      { kind: 'link', media: { label: 'Untitled (2019)' } },
      { kind: 'embed', media: { url: 'https://youtu.be/dQw4w9WgXcQ' } },
      { kind: 'divider', media: { variant: 'stars' } },
    ];
    const made = [];
    for (const b of bodies) {
      const r = await ana.post('/api/posts', b);
      assert.equal(r.status, 201, `${b.kind}: ${r.text}`);
      assert.match(r.body.id, /^p[0-9a-z]{16}$/);
      assert.equal(r.body.url, `${h.base}/users/ana/posts/${r.body.id}`);
      assert.equal(r.body.audience, 'public');
      assert.ok(Date.parse(r.body.created_at));
      made.push(r.body);
    }
    const store = (await ana.get('/api/me/page')).body;
    assert.deepEqual(store.posts.map((p) => p.kind), bodies.map((b) => b.kind));
    assert.equal(store.posts[2].media.sub, 'a sub line');
    assert.equal(store.posts[2].media.key, key);
    assert.equal(new Set(made.map((p) => p.id)).size, made.length);
  } finally { await h.close(); }
});

test('unknown kinds, entity kinds, empty notes, husks, bad hrefs and bad embeds are refused', async () => {
  const { h, ana } = await setup();
  try {
    const refuse = async (body, error) => {
      const r = await ana.post('/api/posts', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, error, JSON.stringify(body));
    };
    for (const kind of ['artwork', 'exhibition', 'open_call', 'poll', '', undefined]) await refuse({ kind, ref_id: 'x', note: 'x' }, 'unknown_kind');
    await refuse({ kind: 'note', note: '' }, 'empty_post');
    await refuse({ kind: 'note', note: 42 }, 'empty_post');
    await refuse({ kind: 'image', media: { alt: 'no key' } }, 'empty_post');
    await refuse({ kind: 'link', media: {} }, 'empty_post');
    await refuse({ kind: 'embed', media: {} }, 'empty_post');
    await refuse({ kind: 'embed', media: { url: 'https://evil.example/player' } }, 'bad_embed');
    await refuse({ kind: 'link', media: { href: 'javascript:alert(1)', label: 'x' } }, 'bad_href');
    await refuse({ kind: 'link', media: { href: '//evil.example', label: 'x' } }, 'bad_href');
    await refuse({ kind: 'note', note: 'x', pinned: 'yes' }, 'invalid_field');
    await refuse({ kind: 'note', note: 'x', audience: 'archive' }, 'archive_refused');
    await refuse({ kind: 'note', note: 'x', audience: 'ring_0123456789abcdef0123' }, 'not_in_ring');
    assert.equal((await ana.post('/api/posts', { kind: 'note', note: 'fine' })).status, 201, 'positive control');
    assert.equal((await ana.get('/api/me/page')).body.posts.length, 1);
  } finally { await h.close(); }
});

test('PATCH sets pinned, kaomoji and cw; kind, audience and created_at are immutable', async () => {
  const { h, ana } = await setup();
  try {
    const p = (await ana.post('/api/posts', { kind: 'note', note: 'first' })).body;
    const r = await ana.patch(`/api/posts/${p.id}`, {
      pinned: true, kaomoji: '(´ ▽ ` )', cw: 'flash\nwarning', note: 'edited',
      kind: 'divider', audience: 'archive', created_at: '2000-01-01T00:00:00.000Z', id: 'pother',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, p.id);
    assert.equal(r.body.kind, 'note');
    assert.equal(r.body.audience, 'public');
    assert.equal(r.body.created_at, p.created_at);
    assert.equal(r.body.pinned, true);
    assert.equal(r.body.kaomoji, '(´ ▽ ` )');
    assert.equal(r.body.cw, 'flash warning', 'cw is one plain line');
    assert.equal(r.body.note, 'edited');
    assert.ok(r.body.updated_at);
    // Clearing.
    const c = await ana.patch(`/api/posts/${p.id}`, { pinned: false, kaomoji: '', cw: '' });
    assert.equal(c.body.pinned, undefined);
    assert.equal(c.body.kaomoji, undefined);
    assert.equal(c.body.cw, undefined);
    // An image edit keeps its key when only the alt changes.
    const key = (await ana.upload(await png())).body.key;
    const img = (await ana.post('/api/posts', { kind: 'image', media: { key, alt: 'a' } })).body;
    const e = await ana.patch(`/api/posts/${img.id}`, { media: { alt: 'better alt' } });
    assert.equal(e.body.media.key, key);
    assert.equal(e.body.media.alt, 'better alt');
    assert.equal((await ana.patch('/api/posts/pnope0000000000000', { note: 'x' })).status, 404);
  } finally { await h.close(); }
});

test('delete, then 404; the image goes with it unless something else holds it', async () => {
  const { h, ana } = await setup();
  try {
    await ana.put('/api/me/page', { enabled: true });
    const k1 = (await ana.upload(await png())).body.key;
    const k2 = (await ana.upload(await png())).body.key;
    const a = (await ana.post('/api/posts', { kind: 'image', media: { key: k1, alt: '' } })).body;
    const b = (await ana.post('/api/posts', { kind: 'image', media: { key: k2, alt: '' } })).body;
    await ana.put('/api/me/page', { avatar_key: k2 });
    assert.equal((await ana.del(`/api/posts/${a.id}`)).status, 200);
    assert.equal((await ana.del(`/api/posts/${a.id}`)).status, 404);
    assert.equal((await ana.patch(`/api/posts/${a.id}`, { note: 'x' })).status, 404);
    assert.ok(!(await h.client().get('/api/pages/ana')).body.posts.some((p) => p.id === a.id));
    assert.equal(h.ctx.images.row(k1), null, 'an image nothing else holds is deleted');
    assert.ok(!fs.existsSync(path.join(h.dir, 'images', k1)));
    assert.equal((await ana.del(`/api/posts/${b.id}`)).status, 200);
    assert.ok(h.ctx.images.row(k2), 'the avatar still holds it');
    // Someone else's post: an opaque 404.
    const c = (await ana.post('/api/posts', { kind: 'note', note: 'mine' })).body;
    const bob = await joinInvited(h, ana, { slug: 'bob' });
    assert.equal((await bob.del(`/api/posts/${c.id}`)).status, 404);
    assert.equal((await bob.patch(`/api/posts/${c.id}`, { note: 'hijack' })).status, 404);
  } finally { await h.close(); }
});

test('the sanitizer: pasted script is inert, links are checked, embeds canonical', async () => {
  const { h, ana } = await setup();
  try {
    await ana.put('/api/me/page', { enabled: true });
    await ana.post('/api/posts', { kind: 'note', note: '<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://ok.example) **b** <img src=x onerror=alert(1)>' });
    await ana.post('/api/posts', { kind: 'embed', media: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x' } });
    await ana.post('/api/posts', { kind: 'embed', media: { url: 'https://vimeo.com/123456789' } });
    const page = (await h.client().get('/api/pages/ana')).body;
    const note = page.posts.find((p) => p.kind === 'note');
    assert.ok(!note.html.includes('<script'));
    assert.ok(!note.html.includes('<img'));
    assert.match(note.html, /&lt;script&gt;/);
    assert.ok(!/href="javascript/i.test(note.html));
    assert.match(note.html, /<a href="https:\/\/ok\.example" target="_blank" rel="nofollow noopener ugc">ok<\/a>/);
    assert.match(note.html, /<strong>b<\/strong>/);
    const embeds = page.posts.filter((p) => p.kind === 'embed');
    assert.deepEqual(embeds.map((e) => e.src).sort(), ['https://player.vimeo.com/video/123456789', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']);
  } finally { await h.close(); }
});

test('page settings: switches, theme, bio, avatar and links, with refusals', async () => {
  const { h, ana } = await setup();
  try {
    const key = (await ana.upload(await png())).body.key;
    const r = await ana.put('/api/me/page', {
      enabled: true, indexable: true, open_follows: true, stamps_off: true, comments_off: false,
      theme: { bg: 'red; background:url(//evil)', font: 'serif', cursor: 'url(x)', marquee: 'hi', blink: true, bg_image_key: key },
      bio: 'paintings, *mostly* [site](https://ana.example) <b>bold</b>',
      avatar_key: key,
      links: [{ label: 'Mastodon', href: 'https://mastodon.example/@ana' }],
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.theme.bg, '', 'non-hex bg stripped');
    assert.equal(r.body.theme.cursor, '', 'cursor outside the enum dropped');
    assert.equal(r.body.theme.font, 'serif');
    assert.equal(r.body.open_follows, true);
    assert.equal((await ana.put('/api/me/page', { theme: { bg: '#ffeedd' } })).body.theme.bg, '#ffeedd');

    const refuse = async (body, error) => {
      const x = await ana.put('/api/me/page', body);
      assert.equal(x.status, 400, JSON.stringify(body));
      assert.equal(x.body.error, error, JSON.stringify(body));
    };
    await refuse({ enabled: 'true' }, 'invalid_field');
    await refuse({ links: [{ label: 'x', href: 'javascript:alert(1)' }] }, 'bad_href');
    await refuse({ links: [{ label: 'x', href: 'mailto:a@b.c' }] }, 'bad_href');
    await refuse({ links: Array.from({ length: 5 }, (_, i) => ({ label: `l${i}`, href: `https://l${i}.example` })) }, 'invalid_field');
    await refuse({ bio: 7 }, 'invalid_field');
    await refuse({ block: 'not a handle!' }, 'invalid_field');
    await refuse({ block: 'ana' }, 'invalid_field');

    const blocked = await ana.put('/api/me/page', { block: 'Bob@Other.Example', block_domain: 'Spam.Example' });
    assert.deepEqual(blocked.body.blocked, ['bob@other.example']);
    assert.deepEqual(blocked.body.blocked_domains, ['spam.example']);
    const unblocked = await ana.put('/api/me/page', { unblock: 'bob@other.example', unblock_domain: 'spam.example' });
    assert.deepEqual(unblocked.body.blocked, []);
    assert.deepEqual(unblocked.body.blocked_domains, []);

    const page = await h.client().get('/api/pages/ana');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), null, 'indexable: no noindex');
    assert.match(page.body.bio_html, /<em>mostly<\/em>/);
    assert.match(page.body.bio_html, /<a href="https:\/\/ana\.example"/);
    assert.match(page.body.bio_html, /&lt;b&gt;bold/);
    assert.equal(page.body.avatar.url, `/api/images/${key}/web`);
    assert.equal(page.body.theme.bg_image_url, `/api/images/${key}/web`);
    assert.deepEqual(page.body.links, [{ label: 'Mastodon', href: 'https://mastodon.example/@ana', rel: 'me nofollow noopener' }]);
    assert.equal(page.body.stamps_off, true);

    await ana.put('/api/me/page', { indexable: false });
    assert.equal((await h.client().get('/api/pages/ana')).headers.get('x-robots-tag'), 'noindex');
  } finally { await h.close(); }
});

test('GET /api/pages/:name: public posts only, pinned first then newest, the payload shape', async () => {
  const { h, ana } = await setup();
  try {
    clock.set(Date.parse('2026-10-01T10:00:00Z'));
    const old = (await ana.post('/api/posts', { kind: 'note', note: 'old, pinned', pinned: true })).body;
    clock.advance(60_000);
    const mid = (await ana.post('/api/posts', { kind: 'note', note: 'middle', cw: 'spoiler' })).body;
    clock.advance(60_000);
    const fresh = (await ana.post('/api/posts', { kind: 'note', note: 'newest' })).body;
    clock.advance(60_000);
    const div = (await ana.post('/api/posts', { kind: 'divider' })).body;
    // What the weekly sweep (P2) and import (P9) write: an archived post.
    const store = h.ctx.pages.load('ana');
    store.posts.push({ id: 'parchived00000000', kind: 'note', note: 'archived', created_at: clock.iso(), audience: 'archive', archived_from: 'ring_0123456789abcdef0123' });
    h.ctx.pages.save('ana', store);

    assert.equal((await h.client().get('/api/pages/ana')).status, 404, 'off by default');
    await ana.put('/api/me/page', { enabled: true, theme: { bg: '#112233', font: 'mono' } });
    const page = (await h.client().get('/api/pages/ana')).body;
    assert.deepEqual(page.posts.map((p) => p.id), [old.id, div.id, fresh.id, mid.id]);
    assert.ok(!page.posts.some((p) => p.id === 'parchived00000000'), 'the archive never shows');
    assert.equal(page.posts.find((p) => p.id === mid.id).cw, 'spoiler');
    assert.equal(page.posts[0].url, `${h.base}/users/ana/posts/${old.id}`);
    assert.deepEqual(page.friends, []);
    assert.deepEqual(page.posts[0].stamps, []);
    assert.deepEqual(page.posts[0].comments, []);
    assert.equal(page.palette.length, STAMP_STYLES.length);
    assert.equal(page.theme.bg, '#112233', 'the theme rides out');
    assert.equal(page.name, 'ana');
    assert.equal(page.actor, `${h.base}/users/ana`);
    assert.equal(page.page_url, `${h.base}/@ana`);
    assert.equal(page.imageKeys, undefined, 'the gate list is not served');
    for (const p of page.posts) assert.equal(p.note, undefined, 'raw markdown is not served, only rendered html');
  } finally { await h.close(); }
});

test('the odometer counts anonymous reads only', async () => {
  const { h, ana } = await setup();
  try {
    await ana.put('/api/me/page', { enabled: true });
    const anon = h.client();
    const v1 = (await anon.get('/api/pages/ana')).body.visits;
    const v2 = (await anon.get('/api/pages/ana')).body.visits;
    assert.equal(v2, v1 + 1);
    const v3 = (await ana.get('/api/pages/ana')).body.visits;
    assert.equal(v3, v2, 'a signed-in read does not count');
    h.ctx.visits.flush();
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'members', 'ana', 'log-visits.json'), 'utf8')).count, v2);
    assert.equal((await anon.get('/api/pages/ana')).body.visits, v2 + 1, 'stored plus buffered');
  } finally { await h.close(); }
});

test('page off empties the payload, on restores it live; the projection follows every write', async () => {
  const { h, ana } = await setup();
  try {
    await ana.put('/api/me/page', { enabled: true });
    await ana.post('/api/posts', { kind: 'note', note: 'one' });
    const anon = h.client();
    assert.equal((await anon.get('/api/pages/ana')).body.posts.length, 1);
    await ana.post('/api/posts', { kind: 'note', note: 'two' });
    assert.equal((await anon.get('/api/pages/ana')).body.posts.length, 2, 'the memo is dropped on write');
    await ana.patch('/api/me', { display_name: 'Ana Lima' });
    assert.equal((await anon.get('/api/pages/ana')).body.display_name, 'Ana Lima');
    await ana.put('/api/me/page', { enabled: false });
    const off = await anon.get('/api/pages/ana');
    const unknown = await anon.get('/api/pages/nobody-here');
    assert.equal(off.status, 404);
    assert.deepEqual(off.body, unknown.body);
    assert.equal(off.headers.get('x-robots-tag'), 'noindex');
    assert.equal((await ana.get('/api/pages/ana')).status, 404, 'the author too: they read /api/me/page');
    await ana.put('/api/me/page', { enabled: true });
    assert.equal((await anon.get('/api/pages/ana')).body.posts.length, 2);
  } finally { await h.close(); }
});

test('the post cap holds at 500, archive included', async () => {
  const { h, ana } = await setup();
  try {
    const store = h.ctx.pages.load('ana');
    for (let i = 0; i < 500; i++) store.posts.push({ id: `pfill${String(i).padStart(12, '0')}`, kind: 'note', note: `n${i}`, created_at: clock.iso(), audience: i % 2 ? 'archive' : 'public' });
    h.ctx.pages.save('ana', store);
    const r = await ana.post('/api/posts', { kind: 'note', note: 'one too many' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'posts_full');
    await ana.del('/api/posts/pfill000000000000');
    assert.equal((await ana.post('/api/posts', { kind: 'note', note: 'room now' })).status, 201, 'positive control');
  } finally { await h.close(); }
});

test('updated_at means "content edited": a pin, a switch or an empty PATCH leaves it alone', async () => {
  const { h, ana } = await setup();
  try {
    await ana.put('/api/me/page', { enabled: true });
    const p = (await ana.post('/api/posts', { kind: 'note', note: 'first' })).body;
    assert.equal(p.updated_at, undefined);
    const before = fs.readFileSync(path.join(h.dir, 'members', 'ana', 'log.json'));
    for (const body of [{ pinned: true }, { stamps_off: true }, { comments_off: true }, {}, { pinned: true }]) {
      const r = await ana.patch(`/api/posts/${p.id}`, body);
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(r.body.updated_at, undefined, `${JSON.stringify(body)} is not an edit`);
    }
    const stored = (await ana.get('/api/me/page')).body.posts[0];
    assert.equal(stored.pinned, true);
    assert.equal(stored.updated_at, undefined);
    const wall = await h.client().get('/api/pages/ana');
    assert.equal(wall.body.posts[0].pinned, true, 'positive control: the wall shows the post');
    assert.equal(wall.body.posts[0].updated_at, undefined);

    // A PATCH that changes nothing writes nothing.
    const mtime = fs.statSync(path.join(h.dir, 'members', 'ana', 'log.json')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await ana.patch(`/api/posts/${p.id}`, { pinned: true, note: 'first' })).status, 200);
    assert.equal(fs.statSync(path.join(h.dir, 'members', 'ana', 'log.json')).mtimeMs, mtime, 'no rewrite for a no-op');
    assert.ok(!before.equals(fs.readFileSync(path.join(h.dir, 'members', 'ana', 'log.json'))), 'positive control: the pin was written');

    // A content edit does stamp it (positive control), for each content field.
    clock.set(Date.parse('2026-10-15T10:00:00Z'));
    const e = await ana.patch(`/api/posts/${p.id}`, { note: 'second' });
    assert.equal(e.body.updated_at, '2026-10-15T10:00:00.000Z');
    clock.set(Date.parse('2026-10-15T11:00:00Z'));
    assert.equal((await ana.patch(`/api/posts/${p.id}`, { pinned: false })).body.updated_at, '2026-10-15T10:00:00.000Z', 'kept by an unpin');
    assert.equal((await ana.patch(`/api/posts/${p.id}`, { cw: 'spoilers' })).body.updated_at, '2026-10-15T11:00:00.000Z');
    clock.set(Date.parse('2026-10-15T12:00:00Z'));
    assert.equal((await ana.patch(`/api/posts/${p.id}`, { kaomoji: '(^_^)' })).body.updated_at, '2026-10-15T12:00:00.000Z');
    const key = (await ana.upload(await png())).body.key;
    const img = (await ana.post('/api/posts', { kind: 'image', media: { key, alt: 'a' } })).body;
    clock.set(Date.parse('2026-10-15T13:00:00Z'));
    assert.equal((await ana.patch(`/api/posts/${img.id}`, { media: { alt: 'b' } })).body.updated_at, '2026-10-15T13:00:00.000Z', 'media is content');
  } finally { await h.close(); }
});

test('a block list keeps a full-length remote handle whole, and drops what is not a handle', async () => {
  const { h, ana } = await setup();
  try {
    const name = 'n'.repeat(64);
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    assert.equal(host.length, 253);
    const handle = `${name}@${host}`;
    assert.equal(handle.length, 318);
    const r = await ana.put('/api/me/page', { block: handle });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.blocked, [handle], 'stored whole, not cut to 300');
    const u = await ana.put('/api/me/page', { unblock: handle });
    assert.deepEqual(u.body.blocked, [], 'and the unblock matches it');

    // A damaged or foreign-shaped entry in the file is dropped on read.
    const file = path.join(h.dir, 'members', 'ana', 'log.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.blocked = ['bob@other.example', 'Not A Handle', 'x@', `${'z'.repeat(400)}@a.example`, 42, 'carl'];
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual((await ana.get('/api/me/page')).body.blocked, ['bob@other.example', 'carl']);
  } finally { await h.close(); }
});

test('the image gate list is exactly the rendered page\'s, computed without rendering', async () => {
  const { h, ana } = await setup();
  try {
    const k = [];
    for (let i = 0; i < 5; i++) k.push((await ana.upload(await png())).body.key);
    await ana.post('/api/posts', { kind: 'image', media: { key: k[0], alt: '' } });
    await ana.post('/api/posts', { kind: 'link', media: { href: 'https://a.example', label: 'a', key: k[1] } });
    await ana.post('/api/posts', { kind: 'link', media: { label: 'just a label', key: k[2] } });
    await ana.put('/api/me/page', { enabled: true, avatar_key: k[3], theme: { bg_image_key: k[4] } });
    const keys = h.ctx.projection.publicImageKeys('ana');
    const built = h.ctx.projection.get('ana', h.base).imageKeys;
    assert.deepEqual([...keys].sort(), [...built].sort());
    assert.equal(keys.size, 5, 'positive control: every kind of reference is there');
    await ana.put('/api/me/page', { enabled: false });
    assert.equal(h.ctx.projection.publicImageKeys('ana').size, 0, 'page off: none');
  } finally { await h.close(); }
});

test('the wall read is limited per IP, and a cached body still carries a live odometer', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    const ana = await joinAdmin(h, 'ana');
    await ana.put('/api/me/page', { enabled: true });
    await ana.post('/api/posts', { kind: 'note', note: 'hi' });
    const anon = h.client();
    const counts = [];
    for (let i = 0; i < 3; i++) counts.push((await anon.get('/api/pages/ana')).body.visits);
    assert.deepEqual(counts, [1, 2, 3], 'the memoized body splices the current count');
    let last;
    for (let i = 3; i < 61; i++) last = await anon.get('/api/pages/ana');
    assert.equal(last.status, 429);
    assert.equal((await ana.get('/api/pages/ana')).status, 200, 'a signed-in reader has their own bucket');
  } finally { await h.close(); }
});
