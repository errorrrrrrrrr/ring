'use strict';
/* Gate: the wall, /@name (spec 8.4, 10.2, 10.12, 13.2, 3.7). The shell carries
 * the head (title, description, canonical, og:*, the RSS alternate) and the
 * owner's `rel="me"` links; no inline script, CSP self-only; `noindex` (header
 * and meta) unless indexable. A page that is off, a suspended member, an
 * unknown name and a malformed one answer ONE 404, the site's own, byte for
 * byte and header for header (Date aside), its images too. The owner's own wall
 * is the public wall plus an edit link. Room and archived posts never reach it.
 * The befriend sticker's state rides the shell. Stamps and notes on the wall go
 * through the app's own routes under the tier rules, and the shelf page.js
 * offers is exactly what the server accepts. The odometer counts anonymous API
 * reads only, never the shell. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { crowd, befriend, ring, note, enc } = require('./helpers/social');
const { png } = require('./helpers/images');
const wall = require('../public/assets/page.js');
const palette = require('../lib/palette');

/* Self-only: every directive that can load script names this origin alone. */
function assertSelfOnly(r, where) {
  const csp = r.headers.get('content-security-policy') || '';
  const dir = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '';
  assert.equal(dir('default-src'), "default-src 'self'", where);
  assert.equal(dir('script-src'), "script-src 'self'", where);
  assert.equal(dir('img-src'), "img-src 'self'", where);
  assert.equal(dir('object-src'), "object-src 'none'", where);
  assert.equal(dir('frame-ancestors'), "frame-ancestors 'none'", where);
}

/* No <script> without src, no data block, no inline handler, no javascript: URL. */
function assertNoInlineScript(html, where) {
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(scripts.length >= 1, `${where}: the page script`);
  for (const s of scripts) assert.match(s, /^<script src="\/assets\/[a-z.]+\.js" defer>$/, `${where}: inline or off-origin script ${s}`);
  assert.ok(!/<script\b[^>]*>[^<\s]/i.test(html), `${where}: a script with a body`);
  assert.ok(!/\son[a-z]+\s*=/i.test(html), `${where}: an inline event handler`);
  assert.ok(!/javascript:/i.test(html), `${where}: a javascript: URL`);
}

const meta = (html, attr, key) => new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(html)?.[1];
const linkRel = (html, rel) => new RegExp(`<link rel="${rel}"[^>]*href="([^"]*)"`).exec(html)?.[1];

/* Everything a response says, minus the clock. */
const shape = async (r) => ({
  status: r.status,
  body: r.text,
  // Date and the rolling session cookie's Expires tick with the clock between two
  // requests; neither tells one absent page from another, so both are levelled.
  headers: [...r.headers].filter(([k]) => k !== 'date' && k !== 'keep-alive' && k !== 'connection')
    .map(([k, v]) => (k === 'set-cookie' ? [k, v.replace(/; Expires=[^;]+/i, '; Expires=<rolling>')] : [k, v])),
});

test('the shell: head tags, rel="me", the RSS alternate, CSP self-only, no inline script, noindex unless indexable', async () => {
  const { h, c } = await crowd(['ana', 'bea']);
  try {
    const up = await c.ana.upload(await png(80, 80), { filename: 'me.png', type: 'image/png' });
    assert.equal(up.status, 201, up.text);
    await c.ana.patch('/api/me', { display_name: 'Ana <b>Tester</b>' });
    const put = await c.ana.put('/api/me/page', {
      enabled: true, avatar_key: up.body.key,
      bio: 'Prints & **plates** <script>alert(1)</script> [site](https://ana.example)',
      links: [{ label: 'Mastodon', href: 'https://masto.example/@ana' }, { label: '', href: 'https://ana.example/' }],
    });
    assert.equal(put.status, 200, put.text);
    await note(c.ana, 'first light');

    const anon = h.client();
    const r = await anon.get('/@ana');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/html/);
    assert.equal(r.headers.get('cache-control'), 'private, no-cache');
    assertSelfOnly(r, '/@ana');
    assertNoInlineScript(r.text, '/@ana');
    assert.match(r.text, /<script src="\/assets\/page\.js" defer>/);
    assert.match(r.text, /<link rel="stylesheet" href="\/assets\/page\.css">/);

    // Head: title, description, canonical, og:*, the RSS alternate (tag and header).
    assert.match(r.text, /<title>Ana &lt;b&gt;Tester&lt;\/b&gt; \(@ana\)<\/title>/);
    assert.equal(meta(r.text, 'name', 'description'), 'Prints &amp; plates &lt;script&gt;alert(1)&lt;/script&gt; site');
    assert.equal(linkRel(r.text, 'canonical'), `${h.base}/@ana`);
    assert.equal(meta(r.text, 'property', 'og:type'), 'profile');
    assert.equal(meta(r.text, 'property', 'og:title'), 'Ana &lt;b&gt;Tester&lt;/b&gt;');
    assert.equal(meta(r.text, 'property', 'og:url'), `${h.base}/@ana`);
    assert.equal(meta(r.text, 'property', 'og:image'), `${h.base}/api/images/${up.body.key}/web`);
    assert.ok(meta(r.text, 'property', 'og:description'));
    assert.match(r.text, /<link rel="alternate" type="application\/rss\+xml" title="[^"]+" href="\/@ana\.rss">/);
    assert.equal(r.headers.get('link'), '</@ana.rss>; rel="alternate"; type="application/rss+xml"');

    // Body: the name tag, the avatar, the bio through the inline renderer, rel="me" links.
    assert.match(r.text, /<img class="wall-avatar" src="\/api\/images\/img_[0-9a-f_]+\/thumb"/);
    assert.match(r.text, /<div class="wall-bio">Prints &amp; <strong>plates<\/strong> &lt;script&gt;alert\(1\)&lt;\/script&gt; <a href="https:\/\/ana\.example" target="_blank" rel="nofollow noopener ugc">site<\/a><\/div>/);
    assert.match(r.text, /<a href="https:\/\/masto\.example\/@ana" rel="me nofollow noopener">Mastodon<\/a>/);
    assert.match(r.text, /<a href="https:\/\/ana\.example\/" rel="me nofollow noopener">https:\/\/ana\.example\/<\/a>/, 'an unlabelled link shows its address');
    assert.ok(!/<script>alert/.test(r.text), 'the pasted script is text');
    assert.match(r.text, /data-name="ana" data-viewer="" data-relation=""/, 'signed out: no viewer');
    assert.ok(!r.text.includes('first light'), 'the posts come from the API, not the shell');
    const img = await anon.bytes(`/api/images/${up.body.key}/web`);
    assert.equal(img.status, 200, 'og:image serves to anyone while the page is on');

    // noindex, both ways, until the owner opts in.
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.match(r.text, /<meta name="robots" content="noindex">/);
    await c.ana.put('/api/me/page', { indexable: true });
    const open = await anon.get('/@ana');
    assert.equal(open.headers.get('x-robots-tag'), null, 'indexable: no header');
    assert.ok(!/name="robots"/.test(open.text), 'indexable: no meta');
    assert.equal((await anon.get('/@ana.rss')).headers.get('x-robots-tag'), null, 'nor on the feed');
    await c.ana.put('/api/me/page', { indexable: false });
    assert.equal((await anon.get('/@ana')).headers.get('x-robots-tag'), 'noindex', 'and back');

    // HEAD answers the same headers, no body.
    const head = await anon.raw('HEAD', '/@ana');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('x-robots-tag'), 'noindex');

    // The page script and its words are served from this origin, self-only.
    for (const a of ['/assets/page.js', '/assets/page.css', '/assets/strings.en.json']) {
      const got = await anon.get(a);
      assert.equal(got.status, 200, a);
      assertSelfOnly(got, a);
    }
  } finally { await h.close(); }
});

test('absent is absent: page off, suspended, unknown and malformed names answer one 404, body and headers, images too', async () => {
  const { h, c } = await crowd(['ana', 'bea', 'cy']);
  try {
    const up = await c.ana.upload(await png(), { filename: 'a.png', type: 'image/png' });
    await c.ana.put('/api/me/page', { enabled: true, avatar_key: up.body.key, bio: 'here', links: [{ label: 'm', href: 'https://m.example/@ana' }] });
    await c.cy.put('/api/me/page', { enabled: true });
    await note(c.ana, 'out in the open');
    const unknownKey = 'img_1760000000000_0123456789abcdef';

    for (const who of ['anon', 'ana', 'bea']) {
      const cl = who === 'anon' ? h.client() : c[who];
      const base = await shape(await cl.get('/@nobody'));
      assert.equal(base.status, 404);
      assert.match(base.body, /Not found/);
      assert.ok(!/og:|rel="me"|ana|odometer/.test(base.body), 'the 404 names nothing');
      // Positive control: the comparator sees a page that is on.
      assert.notDeepEqual(await shape(await cl.get('/@ana')), base, `${who}: control, a live page differs`);

      await c.ana.put('/api/me/page', { enabled: false });
      h.ctx.members.update('cy', { status: 'suspended' });
      const paths = ['/@ana', '/@ana.rss', '/@cy', '/@cy.rss', '/@nobody.rss', '/@Ana', '/@%E0%A4%A', '/@', '/@ana/', '/no-such-page'];
      for (const p of paths) assert.deepEqual(await shape(await cl.get(p)), base, `${who} ${p}`);
      // Its images: the same 404 as a key that never existed, the author's own read aside.
      const gone = await cl.bytes(`/api/images/${up.body.key}/web`);
      const never = await cl.bytes(`/api/images/${unknownKey}/web`);
      if (who === 'ana') assert.equal(gone.status, 200, 'the author still reads her own image');
      else {
        assert.equal(gone.status, 404, `${who}: the avatar of an off page`);
        assert.deepEqual(gone.bytes, never.bytes);
        assert.deepEqual([...gone.headers].filter(([k]) => k !== 'date'), [...never.headers].filter(([k]) => k !== 'date'));
      }
      // The API answers its own one 404 alike too.
      assert.equal((await cl.get('/api/pages/ana')).text, (await cl.get('/api/pages/nobody')).text);
      await c.ana.put('/api/me/page', { enabled: true });
      h.ctx.members.update('cy', { status: 'active' });
    }
  } finally { await h.close(); }
});

test('my own wall is the public wall plus an edit link: no room post, no archive, no settings', async () => {
  const { h, c } = await crowd(['ana', 'bea']);
  try {
    await c.ana.put('/api/me/page', { enabled: true, bio: 'mine', stamps_off: false });
    await note(c.ana, 'public words');
    const { id } = await ring(c, 'ana', ['bea']);
    const room = await note(c.ana, 'ROOM-ONLY-SECRET', id);
    assert.equal(room.status, 201, room.text);
    const shelved = h.ctx.pages.load('ana');
    shelved.posts.push({ id: 'pshelvedshelved0', kind: 'note', note: 'SHELF-ONLY-SECRET', created_at: new Date().toISOString(), audience: 'archive', archived_from: id });
    h.ctx.pages.save('ana', shelved);

    const anon = (await h.client().get('/@ana')).text;
    const mine = (await c.ana.get('/@ana')).text;
    assert.match(mine, /data-viewer="ana" data-relation="self"/);
    assert.match(mine, /<a class="wall-corner wall-edit" href="\/app">edit in the app ✎<\/a>/);
    const neutral = (s) => s.replace(/ data-viewer="[^"]*" data-relation="[^"]*"/, '').replace(/<a class="wall-corner wall-edit"[^\n]*<\/a>/, '');
    assert.equal(neutral(mine), neutral(anon), 'the same wall as a stranger reads, but the edit link');
    for (const html of [anon, mine]) assert.ok(!/ROOM-ONLY|SHELF-ONLY|blocked|open_follows/.test(html));
    // The data the wall fetches: the same for the owner as for a stranger (the odometer aside).
    const strip = (b) => { const x = { ...b }; delete x.visits; return JSON.stringify(x); };
    const asOwner = (await c.ana.get('/api/pages/ana')).body;
    assert.equal(strip(asOwner), strip((await h.client().get('/api/pages/ana')).body));
    assert.ok(!JSON.stringify(asOwner).includes('SECRET'));
    assert.ok(JSON.stringify(asOwner).includes('public words'), 'positive control: the public post is there');
    // A ring-mate on the wall: the room post is not on the wall either.
    assert.ok(!JSON.stringify((await c.bea.get('/api/pages/ana')).body).includes('ROOM-ONLY'));
    assert.ok(JSON.stringify((await c.bea.get(`/api/rings/${id}/feed`)).body).includes('ROOM-ONLY'), 'control: the room has it');
  } finally { await h.close(); }
});

test('the befriend sticker: none, pending, asked and friends ride the shell; nobody signed out gets one', async () => {
  const { h, c } = await crowd(['ana', 'bea', 'cy']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await c.bea.put('/api/me/page', { enabled: true });
    const rel = async (cl, who) => /data-relation="([^"]*)"/.exec((await cl.get(`/@${who}`)).text)[1];
    assert.equal(await rel(h.client(), 'ana'), '');
    assert.equal(await rel(c.bea, 'ana'), 'none');
    assert.equal(await rel(c.ana, 'ana'), 'self');
    const ask = await c.bea.post('/api/friends', { handle: 'ana' });   // what the sticker sends
    assert.equal(ask.status, 200, ask.text);
    assert.equal(await rel(c.bea, 'ana'), 'pending');
    assert.equal(await rel(c.ana, 'bea'), 'asked', 'the one asked sees "say yes" on the asker\'s wall');
    const yes = await c.ana.post('/api/friends/bea/confirm');          // what "say yes" sends
    assert.equal(yes.body.status, 'friends');
    assert.equal(await rel(c.bea, 'ana'), 'friends');
    assert.equal(await rel(c.ana, 'bea'), 'friends');
    assert.equal(await rel(c.cy, 'ana'), 'none', 'a third member is not told about it');
  } finally { await h.close(); }
});

test('stamps and notes on the wall: the tiers page.js offers are the ones the server keeps; signed out reads only', async () => {
  const { h, c } = await crowd(['ana', 'bea', 'cy']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const p = await note(c.ana, 'stamp me');
    assert.equal(p.status, 201);
    await befriend(c, 'cy', 'ana');
    const path = `/api/pages/ana/posts/${enc(p.body.id)}`;
    const view = (await h.client().get('/api/pages/ana')).body;
    const post = { ...view.posts.find((x) => x.id === p.body.id), author: { handle: 'ana' } };
    const faces = (shelf) => shelf.styles.flatMap((s) => s.groups.flatMap((g) => g.faces));

    // bea, a member who is no friend: the nice shelf, no notes slip.
    const beaShelf = wall.stampShelf(view.palette, post, { viewer: 'bea', friends: new Set() });
    assert.equal(beaShelf.tier, 'nice');
    assert.equal(faces(beaShelf).length, 30);
    assert.equal(wall.canComment(post, { viewer: 'bea', friends: new Set() }), false);
    for (const f of faces(beaShelf).slice(0, 3)) assert.equal((await c.bea.post(`${path}/stamp`, { kaomoji: f })).status, 200, `offered ${f}`);
    const withheld = palette.FACES.find((f) => !faces(beaShelf).includes(f));
    const refused = await c.bea.post(`${path}/stamp`, { kaomoji: withheld });
    assert.equal(refused.status, 403, 'a face the wall does not offer her is one the server refuses');
    assert.equal(refused.body.error, 'friends_only');
    assert.equal((await c.bea.post(`${path}/comment`, { body: 'hi' })).body.error, 'comments_friends_only');

    // cy, a confirmed friend (the shell says relation "friends"): every face, and notes.
    const cyCtx = { viewer: 'cy', friends: new Set(['ana']) };
    assert.equal(faces(wall.stampShelf(view.palette, post, cyCtx)).length, 56);
    assert.equal(wall.canComment(post, cyCtx), true);
    const cyStamp = await c.cy.post(`${path}/stamp`, { kaomoji: withheld });
    assert.equal(cyStamp.status, 200, cyStamp.text);
    assert.equal(cyStamp.body.mine, withheld);
    const cyNote = await c.cy.post(`${path}/comment`, { body: 'lovely <b>plate</b>' });
    assert.equal(cyNote.status, 200, cyNote.text);

    // The owner on her own wall: no tray, no slip (she moderates in the app).
    assert.equal(wall.stampShelf(view.palette, post, { viewer: 'ana', friends: new Set(['cy']) }).tier, 'none');
    assert.equal((await c.ana.post(`${path}/stamp`, { kaomoji: '✿' })).body.error, 'own_post');

    // Signed out: the faces and notes are there to read, every write is refused.
    const anon = h.client();
    const after = (await anon.get('/api/pages/ana')).body.posts.find((x) => x.id === p.body.id);
    assert.equal(after.stamps.length, 2, 'one face per sender: bea\'s last press and cy\'s');
    assert.ok(after.stamps.every((s) => s.author.url.startsWith(`${h.base}/@`)), 'a stamp signs with a link to its sender\'s wall');
    assert.equal(after.comments[0].body, 'lovely <b>plate</b>', 'stored raw, escaped by the wall');
    assert.equal(after.comments[0].author.name, 'Cy T.', 'Firstname L.');
    assert.equal((await anon.post(`${path}/stamp`, { kaomoji: '✿' })).status, 401);
    assert.equal((await anon.post(`${path}/comment`, { body: 'x' })).status, 401);

    // Take back: the author's own stamp and note go; another member's cannot be touched.
    const sid = after.stamps.find((s) => s.author.handle === 'bea').id;
    assert.equal((await c.cy.del(`${path}/stamp/${sid}`)).status, 404, 'opaque to a third party');
    assert.equal((await c.bea.del(`${path}/stamp/${sid}`)).status, 200);
    assert.equal((await c.cy.del(`${path}/comment/${after.comments[0].id}`)).status, 200);

    // A stamps-off post: the wall offers no tray, the server agrees.
    await c.ana.patch(`/api/posts/${p.body.id}`, { stamps_off: true });
    const shut = { ...(await anon.get('/api/pages/ana')).body.posts.find((x) => x.id === p.body.id), author: { handle: 'ana' } };
    assert.equal(wall.stampShelf(view.palette, shut, cyCtx).tier, 'none');
    assert.equal((await c.cy.post(`${path}/stamp`, { kaomoji: '✿' })).body.error, 'stamps_closed');
  } finally { await h.close(); }
});

test('the odometer counts anonymous API reads; the shell, members and the owner never count', async () => {
  const { h, c } = await crowd(['ana', 'bea']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const anon = h.client();
    const v0 = (await anon.get('/api/pages/ana')).body.visits;
    for (let i = 0; i < 3; i++) assert.equal((await anon.get('/@ana')).status, 200);
    await c.bea.get('/@ana');
    await c.ana.get('/@ana');
    assert.equal((await c.bea.get('/api/pages/ana')).body.visits, v0, 'shell loads and member reads count nothing');
    assert.equal((await c.ana.get('/api/pages/ana')).body.visits, v0, 'nor the owner');
    assert.equal((await anon.get('/api/pages/ana')).body.visits, v0 + 1, 'the next anonymous read does');
    assert.equal((await anon.get('/@ana.rss')).status, 200);
    assert.equal((await c.bea.get('/api/pages/ana')).body.visits, v0 + 1, 'a feed read is not a visit');
    await c.ana.put('/api/me/page', { enabled: false });
    assert.equal((await anon.get('/api/pages/ana')).status, 404);
    await c.ana.put('/api/me/page', { enabled: true });
    assert.equal((await c.bea.get('/api/pages/ana')).body.visits, v0 + 1, 'a read of an absent page counts nothing');
  } finally { await h.close(); }
});
