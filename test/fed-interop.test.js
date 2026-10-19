'use strict';
/* fed-interop (spec 16.3, P6): what other software sends lands as Ring means it,
 * and what Ring sends is shaped for the software at the other end.
 *   Mastodon: a favourite is a plain ♥ stamp and its Undo takes it back; a
 *     reply from a non-friend lands in From elsewhere only; befriended, the same
 *     person's reply is a comment (plain text, the leading mention stripped,
 *     cut at 280 with the source linked); a boost and a followers-only Note are
 *     dropped; a friend's public post fills the Friends feed with its image
 *     re-encoded into the media cache, served to members only.
 *   Akkoma: an EmojiReact 🌞 lands as 🌞, 🍕 as ♥, a custom emoji as ♥ and its
 *     image is never fetched.
 *   Misskey: a Like with _misskey_reaction ✨ lands as ✨.
 *   Out: a stamp picks Like, EmojiReact or a Misskey reaction by the host's
 *     NodeInfo (read once, kept in hosts.json); taking it back is the Undo of it.
 *   Remote HTML only through the node-tree re-emitter (lib/remote-html.js).
 * Every remote here is an in-process fake on loopback (test/helpers/fediverse.js),
 * signing with its own keys and checking Ring's signatures with its own verifier.
 * Fixtures: test/fixtures/fediverse/p6-*.json, CONSTRUCTED from each software's
 * serializers (no recording reached a real server). */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { fedRing, fakeMastodon, befriendRemote, activityFrom, noteFrom, until } = require('./helpers/fediverse');
const { parseRemoteHtml, treeToHtml, treeText, settleTree } = require('../lib/remote-html');
const images = require('./helpers/images');

test.afterEach(() => clock.reset());
const enc = encodeURIComponent;
const PUB = 'https://www.w3.org/ns/activitystreams#Public';
const faces = (h, name = 'ana') => h.ctx.reactions.loadStamps(name).map((s) => [s.author, s.kaomoji]);

test('Mastodon: a favourite is a plain heart, its Undo takes it back; a non-friend\'s reply is From elsewhere; a friend\'s reply is a comment', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const bob = `bob@${m.host}`;
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'blue prints' })).body;
    const fx = (file, part) => m.p6(file, part, { ring: h.base, post: p.id });

    // A favourite (no content): ♥. Its Undo, by its own actor: gone.
    assert.equal((await m.post(`${h.base}/inbox`, fx('p6-mastodon-like.json', 'like'))).status, 202);
    assert.deepEqual(faces(h), [[bob, '♥']]);
    const wall = await c.ana.get('/api/pages/ana');
    assert.equal(wall.body.posts[0].stamps[0].author.name, `Bob R. · ${m.host}`, 'a remote name signs "Firstname L. · host"');
    assert.equal((await m.post(`${h.base}/inbox`, fx('p6-mastodon-like.json', 'undo'))).status, 202);
    assert.deepEqual(faces(h), []);

    // A reply from a NON-friend: From elsewhere, never the wall.
    const reply = fx('p6-mastodon-reply.json', 'body');
    assert.equal((await m.post(`${h.base}/inbox`, reply)).status, 202);
    assert.deepEqual(h.ctx.reactions.loadComments('ana'), []);
    const inbox = await c.ana.get('/api/inbox');
    assert.equal(inbox.body.elsewhere.length, 1);
    const el = inbox.body.elsewhere[0];
    assert.equal(el.kind, 'reply');
    assert.equal(el.post_id, p.id);
    assert.equal(el.author.handle, bob);
    assert.ok(treeText(el.tree).includes('lovely prints'), 'the text, as a tree');
    assert.ok(treeText(el.tree).includes('example.org/a/very/long/pat…'), 'the invisible spans dropped, the ellipsis kept');
    assert.ok(!JSON.stringify(el).includes('h-card'), 'no remote class survives');
    assert.equal(inbox.body.unseen, 1, 'From elsewhere counts until seen');
    assert.equal((await c.ana.get('/api/pages/ana')).body.posts[0].comments.length, 0, 'never on the wall');

    // Befriended, bob's next reply is a comment: plain text, the mention out, cut at 280.
    await befriendRemote(h, c, m, 'ana');
    const long = `<p><span class="h-card"><a href="${h.base}/@ana" class="u-url mention">@<span>ana</span></a></span> ${'all the blues '.repeat(30)}</p>`;
    const r2 = fx('p6-mastodon-reply.json', 'body');
    r2.id = `${r2.id}-2`;
    r2.object.id = `${r2.object.id}2`;
    r2.object.url = `${m.base}/@bob/2`;
    r2.object.content = long;
    assert.equal((await m.post(`${h.base}/inbox`, r2)).status, 202);
    const [cm] = h.ctx.reactions.loadComments('ana');
    assert.equal(cm.author, bob);
    assert.ok(cm.body.startsWith('all the blues'), `the leading mention is stripped: ${cm.body.slice(0, 30)}`);
    const len = Array.from(cm.body).length;
    assert.ok(len <= 280 && len >= 270, `cut at 280 (a trailing space trimmed): ${len}`);
    assert.equal(cm.truncated, true);
    assert.equal(cm.source_url, `${m.base}/@bob/2`);
    const shown = (await c.ana.get('/api/pages/ana')).body.posts[0].comments[0];
    assert.equal(shown.truncated, true);
    assert.equal(shown.source_url, `${m.base}/@bob/2`, 'the card links "more at source"');
    // The same Create again: one comment (5.5).
    await m.post(`${h.base}/inbox`, { ...r2, id: `${r2.id}-again` });
    assert.equal(h.ctx.reactions.loadComments('ana').length, 1);
    // Deleted by its author: gone.
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Delete', { object: { id: r2.object.id, type: 'Tombstone' } }));
    assert.deepEqual(h.ctx.reactions.loadComments('ana'), []);
  } finally { await m.close(); await h.close(); }
});

test('Akkoma and Misskey: EmojiReact and _misskey_reaction keep their face when in tier, else a heart; a custom emoji\'s image is never fetched', async () => {
  const { h, c } = await fedRing(['ana']);
  const ak = await fakeMastodon({ users: ['cat'], software: 'akkoma', keyIndex: 2 });
  const mk = await fakeMastodon({ users: ['mio'], software: 'misskey', keyIndex: 4 });
  const ms = await fakeMastodon({ users: ['bob'], keyIndex: 0 });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'faces' })).body;
    const q = (await c.ana.post('/api/posts', { kind: 'note', note: 'more faces' })).body;
    const r = (await c.ana.post('/api/posts', { kind: 'note', note: 'still more' })).body;
    const at = (fake, post) => (file, part, user) => fake.p6(file, part, { ring: h.base, post: post.id, user, name: user });

    // 🌞 (a nice emoji): itself.
    const sun = at(ak, p)('p6-akkoma-emojireact.json', 'unicode', 'cat');
    assert.equal((await ak.post(`${h.base}/inbox`, sun, { name: 'cat' })).status, 202);
    // 🍕 (no palette face): the heart, on another post.
    const pizza = { ...at(ak, q)('p6-akkoma-emojireact.json', 'unicode', 'cat'), id: `${ak.base}/activities/pizza`, content: '🍕' };
    await ak.post(`${h.base}/inbox`, pizza, { name: 'cat' });
    // A custom emoji with an Emoji tag: the heart, and its image never asked for.
    const blob = at(ak, r)('p6-akkoma-emojireact.json', 'custom', 'cat');
    await ak.post(`${h.base}/inbox`, blob, { name: 'cat' });
    const cat = `cat@${ak.host}`;
    const byPost = (id) => h.ctx.reactions.loadStamps('ana').filter((s) => s.post_id === id).map((s) => [s.author, s.kaomoji]);
    assert.deepEqual(byPost(p.id), [[cat, '🌞']]);
    assert.deepEqual(byPost(q.id), [[cat, '♥']]);
    assert.deepEqual(byPost(r.id), [[cat, '♥']]);
    assert.ok(!ak.gets.some((g) => g.path.includes('/emoji/')), 'the custom emoji image was never fetched');

    // Misskey: ✨ in content and _misskey_reaction; then _misskey_reaction alone.
    const like = mk.p6('p6-misskey-like.json', 'body', { ring: h.base, post: p.id, user: 'mio', name: 'mio' });
    assert.equal((await mk.post(`${h.base}/inbox`, like, { name: 'mio' })).status, 202);
    const mio = `mio@${mk.host}`;
    assert.deepEqual(byPost(p.id).filter(([a]) => a === mio), [[mio, '✨']]);
    const only = { ...like, id: `${mk.base}/likes/only`, object: `${h.base}/users/ana/posts/${q.id}` };
    delete only.content;
    only._misskey_reaction = '🌱';
    await mk.post(`${h.base}/inbox`, only, { name: 'mio' });
    assert.deepEqual(byPost(q.id).filter(([a]) => a === mio), [[mio, '🌱']], '_misskey_reaction when content is absent');

    // A non-friend's full-palette face (🔥, not nice) from Mastodon: the heart, never widened.
    await ms.post(`${h.base}/inbox`, activityFrom(ms, 'Like', { object: `${h.base}/users/ana/posts/${r.id}`, content: '🔥' }));
    assert.deepEqual(byPost(r.id).filter(([a]) => a === `bob@${ms.host}`), [[`bob@${ms.host}`, '♥']]);
    // The same face from a FRIEND keeps it.
    await befriendRemote(h, c, ms, 'ana');
    await ms.post(`${h.base}/inbox`, activityFrom(ms, 'Like', { object: `${h.base}/users/ana/posts/${q.id}`, content: '🔥' }));
    assert.deepEqual(byPost(q.id).filter(([a]) => a === `bob@${ms.host}`), [[`bob@${ms.host}`, '🔥']]);
    // A Like carrying the Ring term out of tier is REFUSED, not mapped (a Ring
    // server checks its own sender; one that sends this has a bug).
    const u = (await c.ana.post('/api/posts', { kind: 'note', note: 'one more' })).body;
    const before = h.ctx.reactions.loadStamps('ana').length;
    await ak.post(`${h.base}/inbox`, { ...activityFrom(ak, 'Like', { object: `${h.base}/users/ana/posts/${u.id}`, content: '🔥', ring: { v: 1, face: '🔥' } }, { name: 'cat' }) }, { name: 'cat' });
    assert.equal(h.ctx.reactions.loadStamps('ana').length, before);
    assert.deepEqual(byPost(u.id), [], 'refused: no heart either');
    // Positive control: the same Like without the Ring term is mapped to the heart.
    await ak.post(`${h.base}/inbox`, { ...activityFrom(ak, 'Like', { object: `${h.base}/users/ana/posts/${u.id}`, content: '🔥' }, { name: 'cat' }) }, { name: 'cat' });
    assert.deepEqual(byPost(u.id), [[cat, '♥']]);
  } finally { await ak.close(); await mk.close(); await ms.close(); await h.close(); }
});

test('stamps out: Like to Mastodon, EmojiReact to Akkoma, a Misskey reaction, by NodeInfo; a face out of tier is refused; Undo takes it back', async () => {
  const { h, c } = await fedRing(['ana']);
  const ms = await fakeMastodon({ users: ['bob'] });
  const ak = await fakeMastodon({ users: ['cat'], software: 'akkoma', keyIndex: 2 });
  const mk = await fakeMastodon({ users: ['mio'], software: 'misskey', keyIndex: 4 });
  try {
    const nb = noteFrom(ms, { text: 'a mastodon post' }).note;
    const nc = noteFrom(ak, { name: 'cat', text: 'an akkoma post' }).note;
    const nm = noteFrom(mk, { name: 'mio', text: 'a misskey note' }).note;
    const press = (object, face) => c.ana.post('/api/remote/stamp', { object, face });
    const last = (fake) => fake.deliveries.at(-1);

    let r = await press(nb.id, '🌞');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sent_as, 'Like');
    await h.ctx.federation.queue.drain();
    assert.equal(last(ms).body.type, 'Like');
    assert.equal(last(ms).body.object, nb.id);
    assert.equal(last(ms).verified, true, last(ms).why);
    assert.equal(last(ms).path, '/users/bob/inbox', 'a stamp goes to the author\'s own inbox');
    assert.equal(last(ms).body.ring, undefined, 'the Ring term only to a Ring server');

    r = await press(nc.id, '🌞');
    await h.ctx.federation.queue.drain();
    assert.equal(last(ak).body.type, 'EmojiReact');
    assert.equal(last(ak).body.content, '🌞');
    r = await press(nc.id, '✿');   // a symbol: not an emoji: a plain Like (the old one undone first)
    await h.ctx.federation.queue.drain();
    assert.deepEqual(ak.deliveries.slice(-2).map((d) => d.body.type).sort(), ['Like', 'Undo']);
    assert.equal(ak.deliveries.find((d) => d.body.type === 'Undo').body.object.type, 'EmojiReact');

    r = await press(nm.id, '🌞');
    await h.ctx.federation.queue.drain();
    assert.equal(last(mk).body.type, 'Like');
    assert.equal(last(mk).body._misskey_reaction, '🌞');
    assert.equal(last(mk).body.content, '🌞');

    // NodeInfo read once and kept.
    const row = h.ctx.federation.hosts.get(ak.host);
    assert.equal(row.software, 'akkoma');
    assert.ok(row.nodeinfo_at);
    assert.equal(h.ctx.federation.hosts.get(mk.host).software, 'misskey');
    assert.equal(h.ctx.federation.hosts.get(ms.host).software, 'mastodon');

    // Tiers hold out too: a non-friend presses the nice shelf only, never a custom face.
    assert.equal((await press(nb.id, '🔥')).status, 403);
    assert.equal((await press(nb.id, 'my own face')).status, 403);
    assert.equal((await press(`${h.base}/users/ana/posts/p0000000000000`, '🌞')).status, 404, 'a post here is not a remote post');

    // The same face again takes it back: the Undo of exactly what was sent.
    const n = ms.deliveries.length;
    r = await press(nb.id, '🌞');
    assert.equal(r.body.action, 'removed');
    await h.ctx.federation.queue.drain();
    const undo = ms.deliveries.slice(n).find((d) => d.body.type === 'Undo');
    assert.equal(undo.body.object.type, 'Like');
    assert.equal(undo.body.object.object, nb.id);
    assert.equal(undo.verified, true);
    assert.equal(h.ctx.sent.stampOn('ana', nb.id), null);
  } finally { await ms.close(); await ak.close(); await mk.close(); await h.close(); }
});

test('a friend\'s public post fills the Friends feed: its warning, its image re-encoded and served to members only; edits and deletes follow; a boost and a followers-only Note are dropped', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    const png = await images.png(64, 48, '#36a');
    m.serve('/system/media/1.png', png, { type: 'image/png' });
    const status = m.p6('p6-mastodon-status.json', 'body', { ring: h.base });
    const raw = JSON.stringify(status).split('MEDIA_URL').join(`${m.base}/system/media/1.png`);
    assert.equal((await m.post(`${h.base}/inbox`, JSON.parse(raw))).status, 202);
    await h.ctx.federation.media.idle();
    const feed = (await c.ana.get('/api/feed/friends')).body;
    const card = feed.posts.find((p) => p.author.handle === bob);
    assert.ok(card, 'the post is on the Friends feed');
    assert.equal(card.origin, 'remote');
    assert.equal(card.cw, 'studio mess');
    assert.equal(card.kind, 'image');
    assert.ok(treeText(card.tree).startsWith('new etching plates'));
    assert.equal(card.html, undefined, 'never another server\'s HTML');
    assert.match(card.image_url, /^\/media\/m_[0-9a-f]{32}\/web$/);
    assert.equal(card.alt, 'two copper plates on a table');
    // Served to a signed-in member only; webp, never the original bytes.
    const img = await c.ana.bytes(card.image_url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/webp');
    assert.notDeepEqual(img.bytes, png);
    assert.equal((await h.client().bytes(card.image_url)).status, 401, 'a visitor gets nothing');
    assert.equal((await c.bram.bytes(card.image_url)).status, 200, 'any member here may see it');
    // Not on any public surface.
    assert.ok(!(await c.ana.get('/@ana.rss')).text.includes('/media/'));

    // An edit by its author replaces it; a Delete removes it.
    const upd = JSON.parse(raw);
    upd.type = 'Update';
    upd.id = `${upd.object.id}#updates/1`;
    upd.object.content = '<p>the plates, inked</p>';
    upd.object.updated = new Date(clock.now()).toISOString();
    await m.post(`${h.base}/inbox`, upd);
    const edited = (await c.ana.get('/api/feed/friends')).body.posts.find((p) => p.author.handle === bob);
    assert.equal(treeText(edited.tree), 'the plates, inked');
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Delete', { object: { id: upd.object.id, type: 'Tombstone' } }));
    assert.equal((await c.ana.get('/api/feed/friends')).body.posts.filter((p) => p.author.handle === bob).length, 0);

    // A boost (Announce) and a followers-only Note: dropped.
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Announce', { object: `${m.base}/users/someone/statuses/1`, to: [PUB] }));
    const { create: fo } = noteFrom(m, { text: 'followers only', to: [`${m.actor()}/followers`], cc: [] });
    await m.post(`${h.base}/inbox`, fo);
    assert.equal(h.ctx.walls.list(bob).length, 0);
    // A public post again (positive control): it lands.
    const { create: pub } = noteFrom(m, { text: 'public again' });
    await m.post(`${h.base}/inbox`, pub);
    assert.equal(h.ctx.walls.list(bob).length, 1);
    // bram is no friend of bob: his Friends feed has none of it.
    assert.equal((await c.bram.get('/api/feed/friends')).body.posts.length, 0);
    // A non-friend's public post is no wall post either.
    const stranger = await fakeMastodon({ users: ['zed'], keyIndex: 6 });
    try {
      const { create } = noteFrom(stranger, { name: 'zed', text: 'hi all' });
      assert.equal((await stranger.post(`${h.base}/inbox`, create, { name: 'zed' })).status, 202);
      assert.equal(h.ctx.walls.list(`zed@${stranger.host}`).length, 0);
    } finally { await stranger.close(); }
  } finally { await m.close(); await h.close(); }
});

test('remote HTML: the re-emitter keeps a small allowlist, no attribute but a safe href, no script or style ever', () => {
  const evil = '<p class="x" style="color:red" onclick="alert(1)">hi <script>alert(1)</script><img src=x onerror=alert(1)>'
    + '<a href="javascript:alert(1)">js</a> <a href="https://ok.example/" style="x" target="_blank">ok</a>'
    + '<a href="/relative">rel</a><style>p{color:red}</style><iframe src="https://e.example"></iframe>'
    + '<svg><script>alert(2)</script><circle/></svg><math>x</math><template><b>t</b></template>'
    + '<span class="invisible">https://</span><span class="ellipsis">kept</span><!-- c --><b>bold</b><u>under</u></p>'
    + '<scr<script>ipt>alert(3)</script>&lt;script&gt;';
  const { tree } = parseRemoteHtml(evil);
  // The tree itself (what is stored and served), before any emitter re-checks it:
  // only allowed tags, `href` the only attribute, and only a safe one.
  const walk = (ns) => ns.forEach((n) => {
    if (typeof n === 'string') return;
    assert.ok(['p', 'br', 'a', 'strong', 'em', 'b', 'i', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li'].includes(n.t), `tag ${n.t}`);
    assert.deepEqual(Object.keys(n).filter((k) => !['t', 'c', 'href'].includes(k)), [], 'no other attribute');
    if (n.href !== undefined) assert.match(n.href, /^https?:\/\//, 'a safe href only');
    if (n.href !== undefined) assert.equal(n.t, 'a');
    walk(n.c || []);
  });
  walk(tree);
  for (const gone of ['alert(1)', 'alert(2)', 'p{color', 'https://</']) assert.ok(!treeText(tree).includes(gone), `${gone} is not even text`);
  const out = treeToHtml(tree);
  for (const bad of ['<script', 'onerror', 'onclick', 'javascript:', 'style', 'class=', '<img', '<iframe', '<svg', '<math', '<template', 'alert(2)', 'p{color', '<u>', 'target=', '"/relative"']) {
    assert.ok(!out.includes(bad), `${bad} survived: ${out}`);
  }
  assert.ok(out.includes('<a href="https://ok.example/" rel="nofollow noopener ugc">ok</a>'), out);
  assert.ok(out.includes('kept…'), 'the ellipsis');
  assert.ok(!out.includes('https://</'), 'the invisible span dropped');
  assert.ok(out.includes('<b>bold</b>') && out.includes('under'), 'allowed kept, the rest unwrapped to text');
  assert.ok(out.includes('&lt;script&gt;'), 'an entity is text, escaped again');
  // The tree read back is re-checked: a stored tree cannot widen.
  const forged = [{ t: 'script', c: ['x'] }, { t: 'a', href: 'javascript:x', c: ['y'] }, { t: 'p', c: [{ t: 'img', c: [] }, 'z'] }];
  assert.deepEqual(settleTree(forged), [{ t: 'a', c: ['y'] }, { t: 'p', c: ['z'] }]);
  // Over 60 KB is refused; the text is cut at its cap with `cut`.
  assert.equal(parseRemoteHtml('x'.repeat(61 * 1024)), null);
  const cut = parseRemoteHtml(`<p>${'a'.repeat(100)}</p>`, { maxText: 10 });
  assert.equal(cut.cut, true);
  assert.equal(treeText(cut.tree), 'a'.repeat(10));
});

test('a remote Note with script, onerror, javascript: and style reaches a member as a clean tree, everywhere it lands', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const bob = await befriendRemote(h, c, m, 'ana');
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'hi' })).body;
    const html = '<p style="x">look <script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)" class="c">here</a></p>';
    const { create } = noteFrom(m, { html });
    await m.post(`${h.base}/inbox`, create);
    const { create: mention } = noteFrom(m, { html, tag: [{ type: 'Mention', href: `${h.base}/users/ana`, name: '@ana' }], inReplyTo: `${m.base}/users/x/statuses/1` });
    await m.post(`${h.base}/inbox`, mention);
    const { create: reply } = noteFrom(m, { html, inReplyTo: `${h.base}/users/ana/posts/${p.id}` });
    await m.post(`${h.base}/inbox`, reply);
    const feed = JSON.stringify((await c.ana.get('/api/feed/friends')).body);
    const inbox = JSON.stringify((await c.ana.get('/api/inbox')).body);
    const wall = JSON.stringify((await c.ana.get('/api/pages/ana')).body);
    for (const [where, s] of [['feed', feed], ['inbox', inbox], ['wall', wall]]) {
      for (const bad of ['<script', 'onerror', 'javascript:', 'style=', 'alert']) assert.ok(!s.includes(bad), `${where}: ${bad}`);
    }
    assert.ok(feed.includes('look '), 'the text is there');
    assert.equal(h.ctx.walls.list(bob).length, 1);
    assert.equal(h.ctx.reactions.loadComments('ana')[0].body, 'look here');
  } finally { await m.close(); await h.close(); }
});

test('Flag stays dropped until P8; a Question, a Move and an Article from a stranger change nothing; a friend\'s Article is a titled link', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    for (const a of [
      activityFrom(m, 'Flag', { object: [`${h.base}/users/ana`] }),
      activityFrom(m, 'Move', { object: m.actor(), target: 'https://elsewhere.example/u' }),
      { ...noteFrom(m, { text: 'a poll' }).create, object: { ...noteFrom(m).note, type: 'Question' } },
    ]) assert.equal((await m.post(`${h.base}/inbox`, a)).status, 202);
    assert.equal(h.ctx.walls.handles().length, 0);
    const bob = await befriendRemote(h, c, m, 'ana');
    const { create } = noteFrom(m, { text: 'an essay', extra: { type: 'Article', name: 'On etching' } });
    await m.post(`${h.base}/inbox`, create);
    const card = (await c.ana.get('/api/feed/friends')).body.posts.find((p) => p.author.handle === bob);
    assert.equal(card.kind, 'link');
    assert.equal(card.label, 'On etching');
    assert.equal(card.href, create.object.id);
  } finally { await m.close(); await h.close(); }
});

test('a remote friend: befriend by handle, the Accept and the follow back make friends; their outbox is read once; sever ends it and drops their wall', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const { note: old } = noteFrom(m, { text: 'from before we met' });
    const page = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.actor()}/outbox?page=true`, type: 'OrderedCollectionPage', orderedItems: [{ id: `${old.id}/activity`, type: 'Create', actor: m.actor(), to: old.to, cc: old.cc, object: old }] };
    m.serve('/users/bob/outbox', { '@context': 'https://www.w3.org/ns/activitystreams', id: `${m.actor()}/outbox`, type: 'OrderedCollection', first: page });
    const bob = await befriendRemote(h, c, m, 'ana');
    const friends = (await c.ana.get('/api/friends')).body.friends;
    assert.deepEqual(friends.map((f) => [f.handle, f.host]), [[bob, m.host]]);
    await until(() => h.ctx.walls.list(bob).length === 1, { what: 'the outbox read' });
    assert.ok(h.ctx.walls.backfilledAt(bob));
    // The wall shows remote friends with their host.
    const wall = (await c.ana.get('/api/pages/ana')).body;
    assert.deepEqual(wall.friends.map((f) => [f.handle, f.host]), [[bob, m.host]]);
    // Sever: Undo of mine and Reject of theirs; the wall goes with the friendship.
    const n = m.deliveries.length;
    assert.equal((await c.ana.del(`/api/friends/${enc(bob)}`)).status, 200);
    await h.ctx.federation.queue.drain();
    assert.deepEqual(m.deliveries.slice(n).map((d) => d.body.type).sort(), ['Reject', 'Undo']);
    assert.equal(h.ctx.walls.list(bob).length, 0, 'dropped with the friendship');
  } finally { await m.close(); await h.close(); }
});

test('lookup: a handle, a profile URL, a post URL; this server\'s own; remote follow from a wall goes to the visitor\'s own server', async () => {
  const { h, c } = await fedRing(['ana', 'bram']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const look = (q) => c.ana.get(`/api/lookup?q=${enc(q)}`);
    let r = await look(`@bob@${m.host}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.type, 'person');
    assert.equal(r.body.handle, `bob@${m.host}`);
    assert.equal(r.body.status, 'none');
    r = await look(m.actor());
    assert.equal(r.body.handle, `bob@${m.host}`);
    const { note } = noteFrom(m, { text: 'look me up', attachment: [{ type: 'Document', mediaType: 'image/png', url: `${m.base}/img.png`, name: 'alt' }] });
    r = await look(note.id);
    assert.equal(r.body.type, 'post');
    assert.equal(r.body.post.origin, 'remote');
    assert.equal(treeText(r.body.post.tree), 'look me up');
    assert.deepEqual(r.body.post.links.map((l) => l.kind), ['image'], 'a lookup fetches no media: the image is a link to the source');
    assert.ok(!m.gets.some((g) => g.path === '/img.png'));
    // Stamp it straight from the lookup (the post is remembered: no refetch).
    const fetches = () => m.gets.filter((g) => g.path === new URL(note.id).pathname).length;
    const before = fetches();
    assert.equal((await c.ana.post('/api/remote/stamp', { object: note.id, face: '✿' })).status, 200);
    assert.equal(fetches(), before, 'no second fetch of the post');
    // This server's own.
    assert.equal((await look('bram')).body.local, true);
    assert.equal((await look(`${h.base}/@bram`)).body.handle, 'bram');
    const p = (await c.bram.post('/api/posts', { kind: 'note', note: 'mine' })).body;
    await c.bram.put('/api/me/page', { enabled: true });
    assert.equal((await look(`${h.base}/users/bram/posts/${p.id}`)).body.type, 'post');
    assert.equal((await look('nobody@unknown.invalid')).status, 404);
    // authorize_interaction: members to /app?open=, visitors to log in first.
    let a = await c.ana.raw('GET', `/authorize_interaction?uri=${enc(note.id)}`);
    assert.equal(a.status, 302);
    assert.equal(a.headers.get('location'), `/app?open=${enc(note.id)}`);
    a = await h.client().raw('GET', `/authorize_interaction?uri=${enc(note.id)}`);
    assert.match(a.headers.get('location'), /^\/login\?next=/);
    // A visitor from another server: the GET is the form only (nothing fetched),
    // the same-origin POST answers a page that names their server and links to
    // its own template, with OUR url (F4, F9: never a redirect).
    const form = (handle, uri, headers = { 'sec-fetch-site': 'same-origin' }) => h.client().raw('POST', '/authorize_interaction/remote', {
      body: new URLSearchParams({ handle, uri }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
    const wf = () => m.gets.filter((g) => g.path.startsWith('/.well-known/webfinger')).length;
    const wfBefore = wf();
    a = await h.client().raw('GET', `/authorize_interaction/remote?handle=${enc(`bob@${m.host}`)}&uri=${enc(`${h.base}/users/bram`)}`);
    assert.equal(a.status, 200);
    assert.match(await a.text(), /<form method="post" action="\/authorize_interaction\/remote">/);
    assert.equal(wf(), wfBefore, 'the GET fetches nothing');
    a = await form(`bob@${m.host}`, `${h.base}/users/bram`);
    assert.equal(a.status, 200);
    const page = await a.text();
    assert.ok(page.includes(`href="${m.base}/authorize_interaction?uri=${enc(`${h.base}/users/bram`)}"`), page);
    assert.ok(page.includes(m.host), 'the page names their host');
    // Never an open redirect: a URI that is not a person or post here.
    a = await form(`bob@${m.host}`, 'https://evil.example/');
    assert.equal(a.status, 404);
    // The lookup budget (5.9): 30 a minute per member.
  } finally { await m.close(); await h.close(); }
});
