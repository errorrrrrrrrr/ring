'use strict';
/* Gate: the wall (public/assets/page.js, vanilla) and the board (app/wall.ts,
 * app/datetime.ts) decide alike (spec 13.1, 13.2, 3.7, 3.3). The same post
 * leans, drifts, tapes and tints the same way on both, from its object URL; the
 * same viewer is offered the same faces and the same notes slip; the same theme
 * paints the same style, hex only and enums only; the same instant reads the
 * same age. page.js stays the vanilla register: `var`, no arrow functions, no
 * modules, and it loads in node without a DOM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const palette = require('../lib/palette');
const wall = require('../public/assets/page.js');

const load = (m) => import(`../app/${m}`);
const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'page.js'), 'utf8');

const SEEDS = [
  '', 'a', 'x', 'y',
  'https://ring.example/users/ana/posts/pmf3k2q9a7xd4e',
  'https://ring.example/users/ana/posts/p0123456789ab',
  'https://other.example:8443/users/bea-c/posts/pzzzzzzzzzzzzzzzzzzzzzzzz',
  'http://127.0.0.1:4100/users/a/posts/p000000000000',
  'ana:p1', 'ana@remote.example:p9',
  'ünïcødé 🌞 (´ ▽ ` )', 'x'.repeat(2000),
  ...Array.from({ length: 200 }, (_, i) => `https://h.example/users/m${i % 7}/posts/p${(i * 7919).toString(36).padStart(12, '0')}`),
];
const FIELDS = ['tilt', 'risoX', 'risoY', 'tape', 'tapeRot', 'sticky', 'w', 'xf', 'mt', 'z'];

test('the chaos: page.js and app/wall.ts give identical cards over the fixture set, the stamp draws included', async () => {
  const board = await load('wall.ts');
  assert.equal(wall.wallHash(''), 2166136261, 'FNV-1a offset basis (pinned in test/app-pure too)');
  assert.equal(wall.wallHash('a'), 3826002220);
  assert.deepEqual(wall.WALL_TAPE, board.WALL_TAPE);
  assert.deepEqual(wall.WALL_STICKY, board.WALL_STICKY);
  let distinct = new Set();
  for (const seed of SEEDS) {
    assert.equal(wall.wallHash(seed), board.wallHash(seed), `hash ${seed.slice(0, 40)}`);
    const a = wall.wallChaos(seed);
    const b = board.wallChaos(seed);
    for (const k of FIELDS) assert.equal(a[k], b[k], `${k} of ${seed.slice(0, 40)}`);
    // The board tilts each stamp ticket with the SAME stream after the card's draws.
    for (let i = 0; i < 6; i++) assert.equal(a.rng(), b.rng(), `stamp draw ${i} of ${seed.slice(0, 40)}`);
    distinct.add(`${a.tilt}|${a.tape}|${a.w}`);
  }
  assert.ok(distinct.size > 150, 'the fixture set spreads: a constant function would pass the equalities');
  distinct = null;

  const post = { id: 'p1', url: 'https://ring.example/users/ana/posts/p1', author: { handle: 'ana' } };
  assert.equal(wall.chaosSeed(post), board.chaosSeed(post));
  assert.equal(wall.chaosSeed({ ...post, url: '' }), board.chaosSeed({ ...post, url: '' }));
  for (const v of [undefined, '', 'line', 'dots', 'stars', 'wave', 'nope']) assert.equal(wall.dividerGlyph(v), board.dividerGlyph(v), String(v));
});

test('stamp tiers and the notes rule: the same shelf and the same slip for every viewer and post', async () => {
  const board = await load('wall.ts');
  const S = palette.STAMP_STYLES;
  const authors = ['ana', 'bea', 'cy'];
  const audiences = ['public', 'archive', 'ring_0123456789abcdef0123', undefined];
  const contexts = [
    { viewer: 'bea', friends: new Set() },
    { viewer: 'bea', friends: new Set(['ana']) },
    { viewer: 'ana', friends: new Set(['bea', 'cy']) },
    { viewer: 'cy', friends: new Set(['ana']), archive: true },
  ];
  let n = 0;
  const tiers = new Set();
  for (const handle of authors) for (const audience of audiences) for (const stamps_off of [false, true]) for (const comments_off of [false, true]) {
    const p = { author: { handle }, audience, stamps_off, comments_off };
    for (const ctx of contexts) {
      const a = wall.stampShelf(S, p, ctx);
      const b = board.stampShelf(S, p, ctx);
      assert.deepEqual(a, b, JSON.stringify({ p, viewer: ctx.viewer }));
      assert.equal(wall.stampTier(p, ctx), board.stampTier(p, ctx));
      assert.equal(wall.canComment(p, ctx), board.canComment(p, ctx));
      tiers.add(a.tier);
      n++;
    }
  }
  assert.equal(n, 192, "every author x audience x switch x viewer case");
  assert.deepEqual([...tiers].sort(), ['full', 'nice', 'none'], 'every tier is reached');
  for (const a of ['ring_x', 'public', '', undefined, null, 7]) assert.equal(wall.isRoom(a), board.isRoom(a), String(a));
});

test('the theme: the same style object, hex only and enums only, whatever the store holds', async () => {
  const board = await load('wall.ts');
  const img = (k) => `/api/images/${encodeURIComponent(k)}/web`;
  const themes = [
    null,
    { bg: '', bg_image_key: '', font: '', marquee: '', blink: false, cursor: '' },
    { bg: '#fff', bg_image_key: '', font: 'serif', marquee: 'hi', blink: true, cursor: 'crosshair' },
    { bg: '#11223344', bg_image_key: 'img_1760000000000_0123456789abcdef', font: 'mono', cursor: 'wait' },
    { bg: ' #ABC ', font: 'system', cursor: 'pointer' },
    // hostile values a tampered store or payload might carry
    { bg: 'red;background:url(//evil)', font: 'evil', cursor: 'url(x),auto' },
    { bg: '#fff;}', font: 'constructor', cursor: 'Pointer' },
    { bg: '#12', font: '__proto__', cursor: 'not-allowed' },
    { bg: 'javascript:alert(1)', font: 'toString', cursor: '' },
    { bg: '#0f0', bg_image_key: 'img_1") ;x', font: 'cursive' },
  ];
  for (const th of themes) assert.deepEqual(wall.themeStyle(th, img), board.themeStyle(th, img), JSON.stringify(th));
  const evil = wall.themeStyle(themes[5], img);
  assert.deepEqual(evil, {}, 'a non-hex colour, an unknown font and a cursor with punctuation all drop');
  assert.equal(wall.themeStyle(themes[6], img).fontFamily, undefined, 'a prototype key is no font');
  for (const c of ['#fff', '#ffff', '#ffffff', '#ffffffff', 'fff', '#ggg', '#fffffffff', ' #abc', 'red']) assert.equal(wall.safeHex(c), board.safeHex(c), c);
});

test('the age: the same narrow label for every instant', async () => {
  const { fmtAge } = await load('datetime.ts');
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  const DAY = 86_400_000;
  const cases = ['', 'nope', null, undefined, 7, new Date(now + 60_000).toISOString()];
  for (const d of [0, 0.5, 1, 2, 13, 20, 20.99, 21, 22, 49, 365, 4000]) cases.push(new Date(now - d * DAY).toISOString());
  for (const iso of cases) assert.equal(wall.fmtAge(iso, now), fmtAge(iso, now), String(iso));
});

test('page.js is the vanilla register: var, no arrows, no modules, no window.confirm; it loads without a DOM', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\b(let|const)\s/.test(code), 'var only');
  assert.ok(!code.includes('=>'), 'no arrow functions');
  assert.ok(!/\bimport\b|\bexport\b|\brequire\(/.test(code), 'no modules');
  assert.ok(!/\b(confirm|alert|prompt)\(/.test(code), 'no window dialogs');
  assert.ok(!/eval\(|new Function|document\.write/.test(code), 'no string code');
  assert.equal(typeof wall.start, 'function');
  // The URL checks the wall applies on top of the server's.
  assert.equal(wall.safeHref('javascript:alert(1)'), '');
  assert.equal(wall.safeHref('//evil.example'), '');
  assert.equal(wall.safeHref('/@bea'), '/@bea');
  assert.equal(wall.safeImage('/api/images/img_1_ab/web'), '/api/images/img_1_ab/web');
  assert.equal(wall.safeImage('https://evil.example/x.png'), '');
  assert.equal(wall.safeImage('/api/images/x/web"onerror=x'), '');
  assert.equal(wall.safeFrame('https://www.youtube-nocookie.com/embed/abc'), 'https://www.youtube-nocookie.com/embed/abc');
  assert.equal(wall.safeFrame('https://www.youtube-nocookie.com.evil.example/embed/abc'), '');
  assert.equal(wall.esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});
