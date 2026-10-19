'use strict';
/* Gate: fed-write-r2 (spec 3.10, 4.8, 4.10, 5.3, 5.7, 5.8, 6.1, 6.4, 8.5). The P6
 * review's findings, each turned from its proof script into the behaviour it
 * now has. Work is measured by COUNTERS (parser steps, parses, file reads,
 * fetches, gate slots), never by a wall clock:
 *   F1  the remote-HTML parse is linear in its input; an inbound object is
 *       parsed once per activity however many members it names; an Update of
 *       an id nothing holds is never parsed; Update{Person} parses its bio once
 *   F2  From elsewhere keeps a preview and a byte budget; the unseen count
 *       reads no rows
 *   F3  an Update or Delete of a remote Note reads only the members holding it
 *   F4  /authorize_interaction/remote: GET renders the form only; POST from
 *       this site only; its fetch runs on its own gate under a global budget
 *   F5  a remote comment's Update keeps the comment rules; an Update to
 *       followers-only takes a wall post off the wall
 *   F6  an unbound key is held to the member's domain blocks
 *   F7  avatars: named actors only, the actor's host or a recorded media host,
 *       one new avatar an hour, their own row cap
 *   F8  a /media miss waits in the media line; a member's misses have a budget
 *   F9  the visitor gets a page naming their server, https only, no redirect
 *   F10 another server's markdown links are http(s) only
 *   F11 a wall entry is never taken over; an id in another actor's path is
 *       never theirs
 *   F12 names lose invisible and filler characters; an empty one falls back
 *   N1  a transient WebFinger failure never unbinds a bound actor
 * Nothing leaves loopback: every remote is a fake in this process. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const clock = require('../lib/clock');
const { parseRemoteHtml, parseCount, treeText, MAX_INPUT } = require('../lib/remote-html');
const { settleObject, renderParts, idUnderActor } = require('../lib/remote-note');
const { plainLine } = require('../lib/ring');
const { createMedia, MAX_AVATAR_ROWS } = require('../lib/remote-media');
const { MAX_BYTES, PREVIEW_TEXT, PREVIEW_NODES } = require('../lib/elsewhere');
const { AVATAR_CHANGE_MS } = require('../lib/actors');
const { interactTarget } = require('../routes/remote');
const { fedRing, fakeMastodon, befriendRemote, activityFrom, noteFrom, until } = require('./helpers/fediverse');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const enc = encodeURIComponent;
const quiet = { log() {}, warn() {}, error() {} };
const nodesOf = (tree) => { let n = 0; const walk = (l) => { for (const x of l) { n++; if (x && typeof x === 'object' && x.c) walk(x.c); } }; walk(tree); return n; };

/* Count the reads of member files named `names` while `fn` runs. */
async function readsDuring(names, fn) {
  const real = fs.readFileSync;
  const seen = [];
  fs.readFileSync = function spy(file, ...rest) {
    if (typeof file === 'string' && names.includes(path.basename(file))) seen.push(file);
    return real.call(this, file, ...rest);
  };
  try { await fn(); } finally { fs.readFileSync = real; }
  return seen;
}
const memberOf = (file) => path.basename(path.dirname(file));

// \u2500\u2500 F1 \u2500\u2500

test('F1 the remote-HTML parse is linear: a 60 KB adversarial input costs a bounded number of steps per byte', () => {
  const SHAPES = {
    'nested <b>': '<b>',
    'unwrapped <x>': '<x>',
    '<b>a': '<b>a',
    'a<x>': 'a<x>',
    '<x>&amp;': '<x>&amp;',
    '<script></script>': '<script></script>',
    'nested <svg> (dropped with content)': '<svg>',
    '<b></i> (closers matching nothing)': '<b></i>',
    'a tag that never closes': '<ab',
    'unclosed attribute quotes': '<a x="',
    'ellipsis spans': '<span class="ellipsis">a',
    'comments': '<!--x-->',
  };
  for (const [name, unit] of Object.entries(SHAPES)) {
    const at = (bytes) => {
      const s = unit.repeat(Math.max(1, Math.floor(bytes / Buffer.byteLength(unit))));
      const stats = {};
      const p = parseRemoteHtml(s, { stats });
      assert.ok(p, `${name}: parsed`);
      return { bytes: Buffer.byteLength(s), steps: stats.steps };
    };
    const small = at(MAX_INPUT / 4 - 64);
    const big = at(MAX_INPUT - 64);
    assert.ok(Number.isInteger(big.steps) && big.steps > 0, `${name}: the counter runs`);
    assert.ok(big.steps <= 32 * big.bytes, `${name}: ${big.steps} steps for ${big.bytes} bytes`);
    assert.ok(big.steps <= 5 * small.steps + 1000, `${name}: 4x the input took ${(big.steps / small.steps).toFixed(1)}x the steps`);
  }
  // The emitter's rules still hold on what the caps cut.
  const deep = parseRemoteHtml(`${'<b>'.repeat(200)}x${'</b>'.repeat(200)} after`);
  assert.equal(treeText(deep.tree), 'x after');
});

test('F1 an inbound object is parsed once per activity, an Update of an id nothing holds never, a Person bio once', async () => {
  const names = ['ana', 'ben', 'cy', 'dee', 'eve', 'fin', 'gus', 'hal'];
  const { h } = await fedRing(names);
  const m = await fakeMastodon({ users: ['mallory'] });
  try {
    const actor = m.actor('mallory');
    assert.equal((await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: `${h.base}/users/ana/posts/nope` }, { name: 'mallory' }), { name: 'mallory' })).status, 202);
    const big = '<b>'.repeat(Math.floor((MAX_INPUT - 64) / 3));
    const tag = names.map((n) => ({ type: 'Mention', href: `${h.base}/users/${n}` }));
    let n0 = parseCount();
    const create = activityFrom(m, 'Create', { object: { id: `${actor}/statuses/1`, type: 'Note', attributedTo: actor, to: [PUBLIC], content: big, tag } }, { name: 'mallory' });
    assert.equal((await m.post(`${h.base}/inbox`, create, { name: 'mallory' })).status, 202);
    assert.deepEqual(names.map((n) => h.ctx.elsewhere.load(n).length), names.map(() => 1), 'every member named got the row');
    assert.equal(parseCount() - n0, 1, 'one parse for eight members');
    n0 = parseCount();
    const upd = activityFrom(m, 'Update', { object: { id: `${actor}/statuses/999`, type: 'Note', attributedTo: actor, to: [PUBLIC], content: big } }, { name: 'mallory' });
    assert.equal((await m.post(`${h.base}/inbox`, upd, { name: 'mallory' })).status, 202);
    assert.equal(parseCount() - n0, 0, 'an Update of an id nothing here holds is never parsed');
    n0 = parseCount();
    const doc = { ...m.actorDoc('mallory'), summary: big };
    assert.equal((await m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object: doc }, { name: 'mallory' }), { name: 'mallory' })).status, 202);
    assert.equal(parseCount() - n0, 1, 'Update{Person}: the bio is parsed once');
  } finally { await m.close(); await h.close(); }
});

// \u2500\u2500 F2 \u2500\u2500

test('F2 From elsewhere keeps a preview (2000 characters, 200 nodes, a link to the source) inside a 1 MB budget; the unseen count reads no rows', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['mallory'] });
  try {
    const actor = m.actor('mallory');
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: `${h.base}/users/ana/posts/nope` }, { name: 'mallory' }), { name: 'mallory' });
    const handle = h.ctx.federation.actors.handleOf(actor);
    const content = `<p>${'<b>words </b>'.repeat(1500)}</p>`;
    // A bloated file as an older build would have left it: 499 rows of full trees.
    const fat = settleObject({ id: `${actor}/s/0`, type: 'Note', attributedTo: actor, to: [PUBLIC], content }, { actor });
    assert.ok(nodesOf(fat.tree) > 1000);
    const rows = [];
    for (let i = 1; i < 500; i++) rows.push({ id: `el_${i.toString(16).padStart(16, '0')}`, kind: 'mention', object: `${actor}/s/${i}`, author: handle, tree: fat.tree, summary: '', url: `${actor}/s/${i}`, published: clock.iso(), at: clock.iso(), seen: false });
    fs.writeFileSync(h.ctx.paths.memberFile('ana', 'elsewhere.json'), JSON.stringify(rows));
    // One real mention: the one writer clips every row and keeps the budget.
    const note = { id: `${actor}/statuses/500`, type: 'Note', attributedTo: actor, to: [PUBLIC], content, tag: [{ type: 'Mention', href: `${h.base}/users/ana` }] };
    assert.equal((await m.post(`${h.base}/inbox`, activityFrom(m, 'Create', { object: note }, { name: 'mallory' }), { name: 'mallory' })).status, 202);
    const size = fs.statSync(h.ctx.paths.memberFile('ana', 'elsewhere.json')).size;
    assert.ok(size <= MAX_BYTES, `elsewhere.json is ${size} bytes`);
    // The unseen count: from the kept tally, no read of the rows.
    let me;
    const reads = await readsDuring(['elsewhere.json'], async () => {
      for (let i = 0; i < 3; i++) me = await c.ana.get('/api/me');
    });
    assert.deepEqual(reads, [], 'GET /api/me read no From elsewhere row');
    const inbox = (await c.ana.get('/api/inbox')).body;
    assert.ok(inbox.elsewhere.length > 0 && inbox.elsewhere.length < 500, `${inbox.elsewhere.length} rows fit the budget`);
    assert.equal(me.body.unseen, inbox.elsewhere.filter((r) => !r.seen).length);
    const newest = inbox.elsewhere.find((r) => r.url === note.id);
    assert.ok(newest, 'the newest row kept');
    for (const r of inbox.elsewhere) {
      assert.ok(Array.from(treeText(r.tree)).length <= PREVIEW_TEXT, 'a preview of the text');
      assert.ok(nodesOf(r.tree) <= PREVIEW_NODES, 'a preview of the nodes');
      assert.equal(r.cut, true, 'cut, so the Inbox links "more at source"');
    }
    assert.ok(Buffer.byteLength(JSON.stringify(inbox)) <= MAX_BYTES + 64 * 1024, 'the Inbox read is bounded by the budget');
    // A block hides the author's rows from the dot, still without reading them.
    assert.equal((await c.ana.put('/api/me/page', { block: handle })).status, 200);
    const reads2 = await readsDuring(['elsewhere.json'], async () => { me = await c.ana.get('/api/me'); });
    assert.equal(me.body.unseen, 0);
    assert.ok(reads2.length <= 1, 'at most one read, when the block rewrote the file');
  } finally { await m.close(); await h.close(); }
});

// \u2500\u2500 F3 \u2500\u2500

test('F3 an Update or Delete of a remote Note reads only the members whose rows hold it', async () => {
  const names = ['ana', 'ben', 'cy', 'dee', 'eve', 'fin'];
  const { h } = await fedRing(names);
  const m = await fakeMastodon({ users: ['mallory'] });
  try {
    const actor = m.actor('mallory');
    const send = (type, object) => m.post(`${h.base}/inbox`, activityFrom(m, type, { object }, { name: 'mallory' }), { name: 'mallory' });
    const note = { id: `${actor}/statuses/7`, type: 'Note', attributedTo: actor, to: [PUBLIC], content: '<p>hi @ana</p>', tag: [{ type: 'Mention', href: `${h.base}/users/ana` }] };
    assert.equal((await send('Create', note)).status, 202);
    assert.equal(h.ctx.elsewhere.load('ana').length, 1);
    await send('Delete', `${actor}/statuses/warm`);   // the index is built once, here
    const FILES = ['elsewhere.json', 'log-comments.json'];
    let reads = await readsDuring(FILES, () => send('Delete', `${actor}/statuses/${Math.random()}`));
    assert.deepEqual(reads, [], 'a Delete of an id nobody holds reads no member file');
    reads = await readsDuring(FILES, () => send('Update', { ...note, content: '<p>edited @ana</p>' }));
    assert.ok(reads.length > 0 && reads.every((f) => memberOf(f) === 'ana'), `an Update reads only the holder's files: ${reads.map(memberOf)}`);
    assert.equal(treeText(h.ctx.elsewhere.load('ana')[0].tree), 'edited @ana');
    reads = await readsDuring(FILES, () => send('Delete', note.id));
    assert.ok(reads.every((f) => memberOf(f) === 'ana'));
    assert.equal(h.ctx.elsewhere.load('ana').length, 0, 'the Delete reached the holder');
  } finally { await m.close(); await h.close(); }
});

// \u2500\u2500 F4, F9 \u2500\u2500

const formPost = (h, handle, uri, headers = { 'sec-fetch-site': 'same-origin' }) => h.client().raw('POST', '/authorize_interaction/remote', {
  body: new URLSearchParams({ handle, uri }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
});

test('F4 F9 /authorize_interaction/remote: the GET renders a form, the POST is this site\'s own, the answer names the host and never redirects', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const uri = `${h.base}/users/ana`;
    const wf = () => m.gets.filter((g) => g.path.startsWith('/.well-known/webfinger')).length;
    const before = wf();
    let r = await h.client().raw('GET', `/authorize_interaction/remote?handle=${enc(`bob@${m.host}`)}&uri=${enc(uri)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('location'), null);
    assert.match(await r.text(), /method="post"/);
    for (const headers of [{}, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) {
      r = await formPost(h, `bob@${m.host}`, uri, headers);
      assert.equal(r.status, 403, `refused: ${JSON.stringify(headers)}`);
    }
    assert.equal(wf(), before, 'nothing refused and no GET reached their server');
    r = await formPost(h, `bob@${m.host}`, uri, { origin: h.base });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('location'), null, 'an interstitial, never a redirect');
    const page = await r.text();
    assert.ok(page.includes(`Continue on ${m.host}`), 'the page names their host');
    assert.ok(page.includes(`href="${m.base}/authorize_interaction?uri=${enc(uri)}"`));
  } finally { await m.close(); await h.close(); }
});

test('F9 the visitor\'s target: their own host, https (http only on a loopback test host), no credentials', () => {
  const uri = 'https://ring.example/users/ana';
  assert.equal(interactTarget('https://mas.to/authorize_interaction?uri={uri}', uri, 'mas.to').href, `https://mas.to/authorize_interaction?uri=${enc(uri)}`);
  assert.equal(interactTarget('http://mas.to/authorize_interaction?uri={uri}', uri, 'mas.to'), null, 'plain http');
  assert.equal(interactTarget('https://evil.example/x?uri={uri}', uri, 'mas.to'), null, 'another host');
  assert.equal(interactTarget('https://u:p@mas.to/x?uri={uri}', uri, 'mas.to'), null, 'credentials');
  assert.equal(interactTarget('javascript:alert(1)//{uri}', uri, 'mas.to'), null);
  assert.equal(interactTarget('http://127.0.0.1:9/x?uri={uri}', uri, '127.0.0.1:9', { loopbackHttp: true }).protocol, 'http:');
  assert.equal(interactTarget('http://127.0.0.1:9/x?uri={uri}', uri, '127.0.0.1:9'), null);
});

test('F4 a visitor\'s WebFinger read holds only its own gate (deliveries go on) and every visitor shares one budget', async () => {
  const { h, c } = await fedRing(['ana'], { limitScale: 1 });
  const m = await fakeMastodon({ users: ['bob'] });
  const sockets = new Set();
  const pits = [];
  for (let i = 0; i < 2; i++) {
    const pit = http.createServer(() => { /* never answers */ });
    pit.on('connection', (k) => sockets.add(k));
    await new Promise((r) => pit.listen(0, '127.0.0.1', r));
    pits.push(pit);
  }
  try {
    await befriendRemote(h, c, m, 'ana');
    const uri = `${h.base}/users/ana`;
    const fed = h.ctx.federation;
    // Two visitors per silent host: one slot per host, two in all, no line.
    const answers = ['x0', 'x1', 'x2', 'x3'].map((u, i) => formPost(h, `${u}@127.0.0.1:${pits[i % 2].address().port}`, uri).then((r) => r.status));
    await until(() => fed.anonGate.stats().total === 2, { what: 'the anonymous gate full' });
    // While both anonymous slots hang, a member's post reaches their remote friend.
    const before = m.deliveries.length;
    assert.equal((await c.ana.post('/api/posts', { kind: 'note', note: 'hello' })).status, 201);
    await fed.queue.drain();
    assert.ok(m.deliveries.slice(before).some((d) => d.body?.type === 'Create'), 'the delivery went');
    assert.equal(fed.anonGate.stats().total, 2, '...while the visitors still held their gate');
    const statuses = (await Promise.all(answers)).sort();
    assert.deepEqual(statuses, [404, 404, 429, 429], 'two held then given up; two refused at once (no line)');
    // One budget for every visitor together: past it, nothing is fetched.
    const wf = () => m.gets.filter((g) => g.path.startsWith('/.well-known/webfinger')).length;
    const start = wf();
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      try { await fed.visitorTemplate(`nobody${i}@${m.host}`); } catch (e) { if (e.status === 429) refused++; }
    }
    assert.ok(refused >= 10, `${refused} refused`);
    assert.ok(wf() - start <= 30, `${wf() - start} WebFinger reads for 40 asks`);
  } finally {
    for (const k of sockets) k.destroy();
    for (const pit of pits) pit.close();
    await m.close();
    await h.close();
  }
});

// \u2500\u2500 F5 \u2500\u2500

test('F5 a remote comment\'s Update keeps the comment rules; an Update to followers-only takes a wall post off the wall', async () => {
  const { h, c } = await fedRing(['ana', 'ben']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'my plates' })).body;
    const postUrl = `${h.base}/users/ana/posts/${p.id}`;
    const bob = await befriendRemote(h, c, m, 'ana');
    const wallComments = async () => (await c.ben.get('/api/pages/ana')).body.posts.find((x) => x.id === p.id)?.comments.map((x) => x.body);
    const { create, note } = noteFrom(m, { text: 'nice plates', inReplyTo: postUrl });
    assert.equal((await m.post(`${h.base}/inbox`, create)).status, 202);
    const update = (content, extra = {}) => m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object: { ...note, content, ...extra } }));
    // A friend, comments open: the edit lands.
    await update('<p>nicer plates</p>');
    assert.deepEqual(await wallComments(), ['nicer plates']);
    // Comments off: the edit changes nothing.
    await c.ana.put('/api/me/page', { comments_off: true });
    await update('<p>edited while closed</p>');
    await c.ana.put('/api/me/page', { comments_off: false });
    assert.deepEqual(await wallComments(), ['nicer plates']);
    // No longer friends: nothing either.
    assert.equal((await c.ana.del(`/api/friends/${enc(bob)}`)).status, 200);
    await update('<p>BUY CHEAP PILLS</p>');
    assert.deepEqual(await wallComments(), ['nicer plates']);
    // Made followers-only: the comment goes (a private reply never shows).
    await update('<p>private now</p>', { to: [`${m.actor()}/followers`], cc: [] });
    assert.deepEqual(await wallComments(), []);

    // The wall: befriend again, a public post lands, then goes followers-only.
    await befriendRemote(h, c, m, 'ana');
    const post = noteFrom(m, { text: 'on my wall' });
    assert.equal((await m.post(`${h.base}/inbox`, post.create)).status, 202);
    assert.equal(h.ctx.walls.holderOf(post.note.id), bob);
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object: { ...post.note, to: [`${m.actor()}/followers`], cc: [] } }));
    assert.equal(h.ctx.walls.holderOf(post.note.id), '', 'off the wall');
    assert.equal(h.ctx.walls.list(bob).some((x) => x.id === post.note.id), false);
  } finally { await m.close(); await h.close(); }
});

// \u2500\u2500 F6 \u2500\u2500

test('F6 a member\'s domain block holds against that domain\'s unbound instance-actor key', async () => {
  const { h, c } = await fedRing(['ana']);
  const ak = await fakeMastodon({ users: ['cat'], software: 'akkoma', instanceActor: true, keyIndex: 2 });
  try {
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'not for that server' })).body;
    const urls = [`${h.base}/users/ana/outbox`, `${h.base}/users/ana/posts/${p.id}`];
    for (const u of urls) assert.equal((await ak.get(u, { instance: true })).status, 200, `before the block: ${u}`);
    assert.equal((await c.ana.put('/api/me/page', { block_domain: ak.host })).status, 200);
    for (const u of urls) {
      assert.equal((await ak.get(u, { name: 'cat' })).status, 404);
      const r = await ak.get(u, { instance: true });
      assert.equal(r.status, 404, `the unbound key: ${u}`);
      assert.ok(!r.text.includes('not for that server'));
    }
  } finally { await ak.close(); await h.close(); }
});

// \u2500\u2500 F7 \u2500\u2500

test('F7 avatars: never a stranger\'s, only from the actor\'s host or a recorded media host, one new avatar an hour', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 's1', 's2', 's3'] });
  const cdn = await fakeMastodon({ users: ['nobody'] });
  try {
    const img = await png(40, 40);
    let icon = (name) => `${m.base}/av/${name}.png`;
    m.patchActor((d, name) => ({ ...d, icon: { type: 'Image', mediaType: 'image/png', url: icon(name) } }));
    const serve = (srv, p) => srv.serve(p, img, { type: 'image/png' });
    for (const u of ['bob', 's1', 's2', 's3']) serve(m, `/av/${u}.png`);
    const avGets = (srv, prefix = '/av/') => srv.gets.filter((g) => g.path.startsWith(prefix)).length;
    const fed = h.ctx.federation;
    // Strangers whose activities land nowhere: no avatar fetched, no row.
    for (const u of ['s1', 's2', 's3']) await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: `${h.base}/users/ana/posts/nope` }, { name: u }), { name: u });
    await fed.media.idle();
    assert.equal(avGets(m), 0, 'no stranger avatar fetched');
    assert.equal(fed.media.stats().rows.avatar, 0);
    // A friend's avatar (named by the follow) on their own host: fetched.
    const bob = await befriendRemote(h, c, m, 'ana');
    await fed.media.idle();
    assert.equal(avGets(m), 1);
    assert.ok(fed.actors.get(m.actor('bob')).avatar);
    // Ten new avatar URLs inside the hour: none fetched.
    const updatePerson = () => m.post(`${h.base}/inbox`, activityFrom(m, 'Update', { object: { ...m.actorDoc('bob'), icon: { type: 'Image', mediaType: 'image/png', url: icon('bob') } } }));
    for (let i = 0; i < 10; i++) {
      icon = () => `${m.base}/av/bob-${i}.png`;
      serve(m, `/av/bob-${i}.png`);
      assert.equal((await updatePerson()).status, 202);
    }
    await fed.media.idle();
    assert.equal(avGets(m), 1, 'one new avatar an hour');
    clock.advance(AVATAR_CHANGE_MS + 1000);
    assert.equal((await updatePerson()).status, 202);
    await fed.media.idle();
    assert.equal(avGets(m), 2, 'an hour later, the newest');
    // Another host: refused until this host's posts are seen carrying images there.
    clock.advance(AVATAR_CHANGE_MS + 1000);
    serve(cdn, '/files/bob.png');
    icon = () => `${cdn.base}/files/bob.png`;
    await updatePerson();
    await fed.media.idle();
    assert.equal(avGets(cdn, '/files/'), 0, 'a host the actor\'s server was never seen using');
    assert.equal(fed.actors.get(m.actor('bob')).avatar, '');
    serve(cdn, '/files/post.png');
    const post = noteFrom(m, { text: 'with a picture', attachment: [{ type: 'Document', mediaType: 'image/png', url: `${cdn.base}/files/post.png`, name: 'a print' }] });
    assert.equal((await m.post(`${h.base}/inbox`, post.create)).status, 202);
    assert.equal(h.ctx.walls.holderOf(post.note.id), bob);
    await updatePerson();
    await fed.media.idle();
    assert.equal(avGets(cdn, '/files/bob.png'), 1, 'a recorded media host');
  } finally { await cdn.close(); await m.close(); await h.close(); }
});

test('F7 avatars have their own row cap: a flood of them never blinds a wall', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-media-'));
  try {
    const media = createMedia({ paths: { fedMediaDir: path.join(dir, 'media'), fedMediaIndex: path.join(dir, 'media.json') }, net: { fetchGuarded: () => new Promise(() => {}) }, logger: quiet, debounceMs: 1e9 });
    let n = 0;
    for (let i = 0; i < MAX_AVATAR_ROWS + 50; i++) if (media.want(`https://a${i % 50}.example/avatar/${i}.png`, { kind: 'avatar' })) n++;
    assert.equal(n, MAX_AVATAR_ROWS, 'avatars stop at their own cap');
    assert.match(media.want('https://friend.example/new-post.jpg'), /^m_[0-9a-f]{32}$/, 'a friend\'s image still gets a row');
    assert.deepEqual(media.stats().rows, { image: 1, avatar: MAX_AVATAR_ROWS });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// \u2500\u2500 F8 \u2500\u2500

test('F8 a /media miss waits in the media line (never past 4 fetches at once) and a member\'s misses have a budget', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-media-'));
  try {
    let now = 0;
    let peak = 0;
    const release = [];
    const net = { fetchGuarded: () => new Promise((resolve) => { now++; peak = Math.max(peak, now); release.push(() => { now--; resolve({ status: 404, headers: {}, body: Buffer.alloc(0) }); }); }) };
    const media = createMedia({ paths: { fedMediaDir: path.join(dir, 'media'), fedMediaIndex: path.join(dir, 'media.json') }, net, logger: quiet, debounceMs: 10 });
    const ids = [];
    for (let i = 0; i < 600; i++) ids.push(media.want(`https://cdn.example/${i}.png`));
    await new Promise((r) => setImmediate(r));
    assert.equal(now, 4, '4 fetches run');
    assert.equal(media.stats().waiting, 496, '500 queued (4 of them now running), 100 left pending');
    const tick = () => new Promise((r) => setImmediate(r));
    // A refused start answers null at once and queues nothing.
    let refused = 'pending';
    media.ensure(ids[599], { mayStart: () => false }).then((v) => { refused = v; });
    await tick();
    assert.equal(refused, null, 'answered at once');
    assert.equal(now, 4);
    assert.equal(media.stats().waiting, 496);
    // 96 concurrent misses on never-queued ids: they JOIN the line (4 fit), the
    // rest answer null at once; none starts a fetch of its own.
    let done = 0;
    const misses = [];
    for (let i = 500; i < 596; i++) misses.push(media.ensure(ids[i]).then(() => { done++; }));
    await new Promise((r) => setImmediate(r));
    assert.equal(media.stats().waiting, 500);
    assert.equal(now, 4, 'still 4 fetches at once');
    assert.equal(done, 92, 'a full line refuses at once');
    // Drain: the 4 that joined are answered when their turn comes (a bounded
    // number of turns: one release each).
    for (let k = 0; k < 2000 && (done < misses.length || release.length); k++) {
      if (release.length) release.shift()();
      await tick();
    }
    assert.equal(done, 96, 'every miss answered');
    assert.ok(peak <= 4, `at most 4 fetches at once (peak ${peak})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // The route: a member's misses that would start a fetch spend their own budget.
  const { h, c } = await fedRing(['ana'], { limitScale: 1 });
  try {
    const media = h.ctx.federation.media;
    const real = media.ensure;
    const allowed = [];
    media.ensure = async (id, opts) => { allowed.push(opts.mayStart()); return null; };
    try {
      for (let i = 0; i < 31; i++) await c.ana.raw('GET', `/media/m_${i.toString(16).padStart(32, '0')}/web`);
    } finally { media.ensure = real; }
    assert.deepEqual(allowed, [...Array(30).fill(true), false]);
  } finally { await h.close(); }
});

// \u2500\u2500 F10 \u2500\u2500

test('F10 another Ring server\'s markdown renders http(s) links only', () => {
  const actor = 'https://evil.example/users/x';
  const doc = { id: 'https://evil.example/notes/1', type: 'Note', attributedTo: actor, to: [PUBLIC], content: '',
    ring: { v: 1, kind: 'note' }, source: { mediaType: 'text/markdown', content: 'see [logout](/logout), [api](/api/me), [mail](mailto:a@b.c), [js](javascript:alert(1)), [pr](//evil.example/x) and [ok](https://ok.example/x)' } };
  const html = renderParts(settleObject(doc, { actor })).html;
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(hrefs, ['https://ok.example/x']);
  assert.ok(html.includes('logout') && html.includes('mail'), 'the link text stays as text');
});

// \u2500\u2500 F11 \u2500\u2500

test('F11 an id in another actor\'s path is never theirs, and a wall entry is never taken over', async () => {
  // The path rule, pure.
  assert.equal(idUnderActor('https://h.example/users/bob/statuses/1', 'https://h.example/users/bob'), true);
  assert.equal(idUnderActor('https://h.example/users/bob/statuses/1', 'https://h.example/users/mallory'), false);
  assert.equal(idUnderActor('https://h.example/objects/9f2c', 'https://h.example/users/bob'), true, 'Pleroma and Akkoma');
  assert.equal(idUnderActor('https://h.example/notes/9xk2', 'https://h.example/users/9abc'), true, 'Misskey');
  assert.equal(idUnderActor('https://other.example/users/bob/1', 'https://h.example/users/bob'), false);

  const { h, c } = await fedRing(['ana', 'ben']);
  const m = await fakeMastodon({ users: ['bob', 'mallory'] });
  try {
    const bob = await befriendRemote(h, c, m, 'ana', { as: 'bob' });
    const mallory = await befriendRemote(h, c, m, 'ben', { as: 'mallory' });
    // Squatting bob's status id from the same host.
    const real = noteFrom(m, { text: 'bob real post' });
    const squat = (id) => activityFrom(m, 'Create', { object: { id, type: 'Note', attributedTo: m.actor('mallory'), to: [PUBLIC], content: '<p>squat</p>' } }, { name: 'mallory' });
    assert.equal((await m.post(`${h.base}/inbox`, squat(real.note.id), { name: 'mallory' })).status, 202);
    assert.equal(h.ctx.walls.holderOf(real.note.id), '', 'refused before the real post even came');
    assert.equal((await m.post(`${h.base}/inbox`, real.create)).status, 202);
    assert.equal(h.ctx.walls.holderOf(real.note.id), bob);
    // An id outside every actor path (Pleroma's shape): the first holder keeps it.
    const objId = `${m.base}/objects/0f4c2a3e`;
    const first = activityFrom(m, 'Create', { object: { id: objId, type: 'Note', attributedTo: m.actor('bob'), to: [PUBLIC], content: '<p>first</p>' } });
    assert.equal((await m.post(`${h.base}/inbox`, first)).status, 202);
    assert.equal((await m.post(`${h.base}/inbox`, squat(objId), { name: 'mallory' })).status, 202);
    assert.equal(h.ctx.walls.holderOf(objId), bob, 'never taken over');
    assert.ok(!h.ctx.walls.list(mallory).some((p) => p.id === objId));
    // A stamp on bob's post goes to bob.
    assert.equal((await c.ana.post('/api/remote/stamp', { object: real.note.id, face: '♥' })).status, 200);
    await h.ctx.federation.queue.drain();
    const like = m.deliveries.findLast((d) => d.body?.type === 'Like' || d.body?.type === 'EmojiReact');
    assert.equal(like.path, '/users/bob/inbox');
    assert.equal(like.body.object, real.note.id);
  } finally { await m.close(); await h.close(); }
});

// \u2500\u2500 F12 \u2500\u2500

test('F12 names lose invisible and filler characters; a name with nothing visible falls back to the handle', async () => {
  const INVISIBLE = ['\u200B', '\u200E', '\u200F', '\u061C', '\u2060', '\u2061', '\u2064', '\u2065', '\u206A', '\u206F', '\u3164', '\u2800', '\u00AD', '\uFEFF', '\u115F', '\u1160', '\uFFA0', '\u180E', '\u202E', '\u2067'];
  for (const ch of INVISIBLE) {
    const out = plainLine(`a${ch}b`, 60);
    assert.ok(!out.includes(ch), `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} kept`);
  }
  for (const ch of INVISIBLE) assert.equal(plainLine(`${ch}${ch}${ch}`, 60), '', `U+${ch.codePointAt(0).toString(16)} alone is no name`);
  assert.equal(plainLine('\u3164 \u2800 \u200B', 60), '');
  // What still draws stays: an emoji ZWJ sequence, a ZWNJ inside a word, a tag flag.
  assert.equal(plainLine('\u{1F469}\u200D\u{1F3A8} Ana', 60), '\u{1F469}\u200D\u{1F3A8} Ana');
  assert.equal(plainLine('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645', 60), '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645');
  assert.equal(plainLine('\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 60), '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}');
  // The source carries no literal invisible character: every one is a \u escape.
  for (const f of ['lib/ring.js', 'test/fed-write-r2.test.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/u.test(src), `${f} spells every invisible character as an escape`);
  }
  // A remote actor whose name is all filler is shown by its handle.
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    m.patchActor((d) => ({ ...d, name: '\u3164\u3164\u200B' }));
    await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: `${h.base}/users/ana/posts/nope` }));
    const handle = h.ctx.federation.actors.handleOf(m.actor('bob'));
    assert.equal(h.ctx.federation.actors.view(handle).name, 'bob');
  } finally { await m.close(); await h.close(); }
});

// \u2500\u2500 N1 \u2500\u2500

test('N1 a transient WebFinger failure on a refetch keeps a bound actor bound; an answer that disagrees unbinds it', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bot'] });
  try {
    m.patchActor((d) => ({ ...d, type: 'Service' }));   // a bot: a server type, which may sign unbound
    const id = m.actor('bot');
    const actors = h.ctx.federation.actors;
    await actors.fetchActor(id, { allowUnbound: true });
    const handle = `bot@${m.host}`;
    assert.equal(actors.get(id).handle, handle);
    // WebFinger down (a 503): the refetch keeps the binding, and the actor still acts.
    m.serve('/.well-known/webfinger', 'down', { status: 503, type: 'text/plain' });
    await actors.fetchActor(id, { allowUnbound: true });
    assert.equal(actors.get(id).handle, handle);
    assert.notEqual(actors.get(id).unbound, true);
    const r = await m.post(`${h.base}/inbox`, activityFrom(m, 'Like', { object: `${h.base}/users/ana/posts/nope` }, { name: 'bot' }), { name: 'bot' });
    assert.equal(r.status, 202, 'never the unbound 401');
    // WebFinger ANSWERS that no such account exists: now it is unbound.
    m.serve('/.well-known/webfinger', '', { status: 404, type: 'text/plain' });
    await actors.fetchActor(id, { allowUnbound: true });
    assert.equal(actors.get(id).unbound, true);
  } finally { await m.close(); await h.close(); }
});
