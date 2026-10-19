'use strict';
/* Gate: the composer's pure rules (spec 13.1, 3.7), no DOM, no browser. The
 * modules are TypeScript under app/ (ESM, app/package.json); node 24 strips
 * the types on import. What is held: the seeded chaos (the same lean on every
 * server), the stamp tiers the tray offers, the notes rule, the feed merge,
 * card patches, unread rooms, the age format, the composer's draft, the custom
 * face, the theme's style and the same-origin `next`. */
const test = require('node:test');
const assert = require('node:assert/strict');
const palette = require('../lib/palette');

const load = (m) => import(`../app/${m}`);

const post = (over = {}) => ({
  id: 'p1', kind: 'note', created_at: '2026-10-01T10:00:00.000Z', audience: 'public',
  url: 'https://ring.example/users/ana/posts/p1', author: { handle: 'ana', name: 'Ana T.', url: 'https://ring.example/@ana', host: 'ring.example' },
  stamps: [], comments: [], ...over,
});
const faces = (shelf) => shelf.styles.flatMap((s) => s.groups.flatMap((g) => g.faces));

test('the chaos is seeded from the object URL: the same card leans the same way anywhere', async () => {
  const { wallChaos, chaosSeed, wallHash } = await load('wall.ts');
  const p = post();
  assert.equal(chaosSeed(p), p.url);
  assert.equal(chaosSeed(post({ url: '' })), 'ana:p1');
  const a = wallChaos(chaosSeed(p));
  const b = wallChaos(chaosSeed(post({ stamps: [{ id: 's' }] })));
  for (const k of ['tilt', 'risoX', 'risoY', 'tape', 'tapeRot', 'sticky', 'w', 'xf', 'mt', 'z']) assert.equal(a[k], b[k], k);
  assert.ok(Math.abs(Number(a.tilt)) <= 3.5);
  assert.ok(a.w >= 46 && a.w <= 78);
  assert.ok(a.mt >= -8 && a.mt <= 32, 'the climb is capped: a neighbour never buries the controls');
  // FNV-1a, byte for byte: the wall (public/assets/page.js) holds the same.
  assert.equal(wallHash(''), 2166136261);
  assert.equal(wallHash('a'), 3826002220);
  assert.notEqual(wallChaos('x').tilt + wallChaos('x').tape, wallChaos('y').tilt + wallChaos('y').tape);
});

test('stamp tiers: nobody stamps their own post or the shelf; strangers get the nice shelf, friends every face, ring-mates a custom one too', async () => {
  const { stampShelf, stampTier } = await load('wall.ts');
  const S = palette.STAMP_STYLES;
  const ctx = { viewer: 'bea', friends: new Set(['cy']) };
  assert.equal(stampShelf(S, post({ author: { handle: 'bea', name: '', url: '', host: '' } }), ctx).tier, 'none', 'own post');
  assert.equal(stampShelf(S, post({ audience: 'archive' }), ctx).tier, 'none', 'the shelf');
  assert.equal(stampShelf(S, post(), { ...ctx, archive: true }).tier, 'none', 'the archive board');
  assert.equal(stampShelf(S, post({ stamps_off: true }), ctx).tier, 'none', 'stamps off (or a block) shuts the tray');

  const stranger = stampShelf(S, post(), ctx);
  assert.equal(stranger.tier, 'nice');
  assert.equal(faces(stranger).length, 30, 'the 30 nice faces');
  assert.ok(faces(stranger).every((f) => palette.NICE_FACES.includes(f)));
  assert.equal(stranger.custom, false);

  const friend = stampShelf(S, post({ author: { handle: 'cy', name: '', url: '', host: '' } }), ctx);
  assert.equal(friend.tier, 'full');
  assert.equal(faces(friend).length, 56, 'every face');
  assert.equal(friend.custom, false, 'a custom face lives in rooms only');

  const room = stampShelf(S, post({ audience: 'ring_0123456789abcdef0123' }), ctx);
  assert.equal(room.tier, 'full', 'a ring-mate on a room post');
  assert.equal(room.custom, true);
  assert.deepEqual(friend.styles.map((s) => s.style), ['kaomoji', 'emoji', 'ascii', 'symbols'], 'the four declared styles, no other (decision 4)');
  assert.ok(faces(friend).every((f) => palette.FACES.includes(f)), 'no face outside the declared palette (decision 4)');
  assert.equal(stampTier(post(), ctx), 'nice');
});

test('notes: confirmed friends only, never on your own post, never with notes off or on the shelf', async () => {
  const { canComment } = await load('wall.ts');
  const ctx = { viewer: 'bea', friends: new Set(['ana']) };
  assert.equal(canComment(post(), ctx), true);
  assert.equal(canComment(post(), { viewer: 'bea', friends: new Set() }), false, 'a stranger');
  assert.equal(canComment(post({ audience: 'ring_0123456789abcdef0123' }), { viewer: 'bea', friends: new Set() }), false, 'a ring-mate who is no friend');
  assert.equal(canComment(post({ comments_off: true }), ctx), false);
  assert.equal(canComment(post({ audience: 'archive' }), ctx), false);
  assert.equal(canComment(post(), { viewer: 'ana', friends: new Set(['ana']) }), false, 'own post');
});

test('the feed merge keeps one card per post and the order the server gave', async () => {
  const { mergeFeed, patchCard, cardKey, withoutStamp, withoutComment } = await load('wall.ts');
  const a = post({ id: 'a' });
  const b = post({ id: 'b' });
  const c = post({ id: 'c' });
  const bOther = post({ id: 'b', author: { handle: 'cy', name: '', url: '', host: '' } });
  const merged = mergeFeed([a, b], [b, c, bOther]);
  assert.deepEqual(merged.map(cardKey), ['ana:a', 'ana:b', 'ana:c', 'cy:b'], 'same id, other author: another card');
  assert.equal(mergeFeed([], []).length, 0);
  const patched = patchCard(merged, 'ana:b', { stamps: [{ id: 's1' }] });
  assert.equal(patched[1].stamps.length, 1);
  assert.equal(merged[1].stamps.length, 0, 'the old array is untouched');
  assert.deepEqual(withoutStamp([{ id: 's1' }, { id: 's2' }], 's1').map((s) => s.id), ['s2']);
  assert.deepEqual(withoutComment([{ id: 'c1' }], 'c1'), []);
});

test('unread rooms: a dot when the newest post is newer than this browser last looked', async () => {
  const { unreadRooms, waitingCount, initials, dividerGlyph, isRoom } = await load('wall.ts');
  const dots = unreadRooms({ r1: '2026-10-02', r2: '2026-10-01', r3: '' }, { r1: '2026-10-01', r2: '2026-10-01' });
  assert.deepEqual([...dots], ['r1']);
  assert.equal(waitingCount({ join_requests: [1, 2], follow_requests: [3] }), 3);
  assert.equal(waitingCount(null), 0);
  assert.equal(initials('print club'), 'PC');
  assert.equal(initials('   '), '·');
  assert.equal(initials('éclair'), 'É');
  assert.equal(dividerGlyph('stars'), '✦ ✦ ✦');
  assert.equal(dividerGlyph('nope'), dividerGlyph('line'));
  assert.equal(isRoom('ring_abc'), true);
  assert.equal(isRoom('public'), false);
});

test('fmtAge is coarse on purpose: today, days under three weeks, then weeks', async () => {
  const { fmtAge, fmtDay, fmtMB } = await load('datetime.ts');
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(fmtAge('2026-10-15T08:00:00Z', now), 'today');
  assert.equal(fmtAge('2026-10-12T12:00:00Z', now), '3d');
  assert.equal(fmtAge('2026-09-25T12:00:00Z', now), '20d');
  assert.equal(fmtAge('2026-09-17T12:00:00Z', now), '4w');
  assert.equal(fmtAge('2026-10-16T12:00:00Z', now), 'today', 'a clock a little ahead');
  assert.equal(fmtAge('', now), '');
  assert.equal(fmtAge('garbage', now), '');
  assert.match(fmtDay('2026-10-15T12:00:00Z'), /^1[45] Oct 2026$/);
  assert.equal(fmtMB(1_572_864), '1.5 MB');
});

test('the draft: what may be posted, and only the fields each kind carries', async () => {
  const { draftReady, draftBody, EMPTY_MEDIA } = await load('drafts.ts');
  const d = (over) => ({ kind: 'note', audience: 'public', note: '', cw: '', kaomoji: '', media: { ...EMPTY_MEDIA }, ...over });
  assert.equal(draftReady(d({ note: '   ' })), false);
  assert.equal(draftReady(d({ note: 'hi' })), true);
  assert.equal(draftReady(d({ kind: 'image' })), false, 'an image needs its uploaded key');
  assert.equal(draftReady(d({ kind: 'image', media: { key: 'img_1' } })), true);
  assert.equal(draftReady(d({ kind: 'link', media: { label: 'A show' } })), true, 'a title alone is a link post');
  assert.equal(draftReady(d({ kind: 'link', media: { href: ' ' } })), false);
  assert.equal(draftReady(d({ kind: 'embed', media: { url: 'https://youtu.be/abcdefgh' } })), true);
  assert.equal(draftReady(d({ kind: 'divider' })), true);

  const note = draftBody(d({ note: '  hi  ', cw: ' eyes ', kaomoji: '✿', media: { key: 'leftover' } }));
  assert.deepEqual(note, { kind: 'note', audience: 'public', note: 'hi', cw: 'eyes', kaomoji: '✿' }, 'a note sends no media');
  const link = draftBody(d({ kind: 'link', audience: 'ring_0123456789abcdef0123', note: 'see', media: { href: ' https://a.example ', label: 'A', key: 'img_2', sub: 'b', url: 'x', alt: 'y' } }));
  assert.deepEqual(link.media, { href: 'https://a.example', label: 'A', key: 'img_2', sub: 'b' });
  assert.equal(link.audience, 'ring_0123456789abcdef0123');
  const embed = draftBody(d({ kind: 'embed', note: 'dropped', media: { url: 'https://vimeo.com/1234567' } }));
  assert.deepEqual(embed.media, { url: 'https://vimeo.com/1234567' });
  assert.equal(embed.note, '');
  assert.deepEqual(draftBody(d({ kind: 'divider', media: { variant: 'wave' } })).media, { variant: 'wave' });
  assert.equal(draftBody(d({ cw: '' })).cw, '', 'an empty warning clears it on an edit');
});

test('a custom face is one line of 20 characters; the theme style takes hex only; next stays same-origin', async () => {
  const { customFace, themeStyle, safeNext, safeHex } = await load('wall.ts');
  assert.equal(customFace('  a‮b\n c  '), 'a b c');
  assert.equal(Array.from(customFace('🌱'.repeat(30))).length, 20);
  assert.equal(customFace('\u0000'), '');
  const theme = { bg: '#ffcc00', bg_image_key: '', font: 'serif', marquee: '', blink: false, cursor: 'crosshair' };
  const s = themeStyle(theme, (k) => `/api/images/${k}/web`);
  assert.equal(s.backgroundColor, '#ffcc00');
  assert.equal(s.backgroundImage, 'none');
  assert.match(s.fontFamily, /serif/);
  assert.equal(s.cursor, 'crosshair');
  const evil = themeStyle({ ...theme, bg: 'red;background:url(x)', font: 'x', cursor: 'url(x)' }, () => '');
  assert.deepEqual(evil, {}, 'nothing but a hex, a known font and a plain cursor word');
  assert.equal(themeStyle({ ...theme, bg: '', bg_image_key: 'img_9' }, (k) => `/api/images/${k}/web`).backgroundImage, 'url("/api/images/img_9/web")');
  assert.equal(safeHex(' #abc '), '#abc');
  assert.equal(safeNext('/app?ring=x'), '/app?ring=x');
  for (const bad of ['//evil.example', '/\\evil', 'https://evil.example', 'app', '/a\nb', '']) assert.equal(safeNext(bad), '', bad);
});
