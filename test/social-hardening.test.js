'use strict';
/* Gate: the P2 adversarial review, each finding held FIXED (R1 to R9, plus the
 * projection note). Each test carries the reviewer's reproduction turned round:
 * it asserts the fixed behaviour and, where one exists, a positive control in the
 * same test (the door still opens for whom it should).
 *   R1  a blocked member's Follow is dropped silently; a wall and the feeds say
 *       stamps_off/comments_off to the blocked viewer, as their stamp is answered
 *   R2  a blocked member's ring ask never reaches the blocker (inbox, dot, ring view)
 *   R3  a kick sticks: the link rotates, requests drop, only the creator re-admits
 *   R4  a deleted member's join code closes (rotates to the creator)
 *   R5  rename and link-off share the ringlink budget; approve/decline have one
 *   R6  the purge never half-runs: a damaged other member's file is skipped, the
 *       deleter's own damage refuses before anything, a crashed purge finishes on retry
 *   R7  Keep sheds every reaction made under the room grant
 *   R8  comments and ring names lose bidi overrides and control characters
 *   R9  every dropped request is answered with Reject; expiry sends Update{Group}
 *   projection: a signature change drops only the walls that render it */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const clock = require('../lib/clock');
const { PASSWORD } = require('./helpers/harness');
const { crowd, befriend, ring, note, codeOf } = require('./helpers/social');

test.afterEach(() => clock.reset());

/* Every activity emitted while `fn` runs: [{ type, to, object }]. */
async function tapped(h, fn) {
  const seen = [];
  const untap = h.ctx.outbox.tap(({ activity, to }) => seen.push({ type: activity.type, to, actor: activity.actor, object: activity.object }));
  try { await fn(); } finally { untap(); }
  return seen;
}
// By path: a timer (housekeeping) acts under the server's default origin, not the test's.
const isActor = (url, name) => new URL(url).pathname === `/users/${name}`;
const rejectsTo = (seen, name) => seen.filter((a) => a.type === 'Reject' && a.to.some((u) => isActor(u, name)));

test('R1 a blocked member\'s Follow is dropped silently: pending on their side, nothing on the blocker\'s', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await c.ana.put('/api/me/page', { block: 'bram' });
    const seen = await tapped(h, async () => {
      const blocked = await c.bram.post('/api/friends', { handle: 'ana' });
      assert.equal(blocked.status, 200);
      assert.equal(blocked.body.status, 'pending', 'the same answer an unblocked request gets');
    });
    assert.equal(rejectsTo(seen, 'bram').length, 0, 'never a Reject (the oracle)');
    assert.equal((await c.bram.get('/api/friends/with/ana')).body.status, 'pending', 'never none');
    assert.equal((await c.ana.get('/api/inbox')).body.follow_requests.length, 0, 'nothing in the blocker\'s inbox');
    const control = await c.coco.post('/api/friends', { handle: 'ana' });
    assert.equal(control.body.status, 'pending', 'positive control: an unblocked request');
    assert.deepEqual((await c.ana.get('/api/inbox')).body.follow_requests.map((r) => r.handle), ['coco'], 'and it lands');
  } finally { await h.close(); }
});

test('R1 the wall and the feeds tell a blocked viewer the switches are shut, as their stamp is answered', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const { id } = await ring(c, 'ana', ['bram', 'coco']);
    const pub = (await note(c.ana, 'pub')).body.id;
    const room = (await note(c.ana, 'room', id)).body.id;
    await c.ana.put('/api/me/page', { block: 'bram' });

    const wallOf = async (client) => (await client.get('/api/pages/ana')).body;
    const shut = await wallOf(c.bram);
    assert.equal(shut.stamps_off, true);
    assert.equal(shut.comments_off, true);
    assert.ok(shut.posts.every((p) => p.stamps_off === true && p.comments_off === true), 'every post shut for him');
    assert.equal((await c.bram.post(`/api/pages/ana/posts/${pub}/stamp`, { kaomoji: '(⌒‿⌒)' })).body.error, 'stamps_closed', 'the answer it predicts');
    const sq = (await c.bram.get('/api/feed')).body.posts.find((p) => p.id === pub);
    assert.equal(sq.stamps_off, true, 'the square too');
    const rf = (await c.bram.get(`/api/rings/${id}/feed`)).body.posts.find((p) => p.id === room);
    assert.equal(rf.stamps_off, true, 'the room too');
    assert.equal((await c.bram.post(`/api/pages/ana/posts/${room}/stamp`, { kaomoji: '(⌒‿⌒)' })).body.error, 'stamps_closed');

    // Positive control: everyone else reads the switches as they are.
    for (const client of [c.coco, h.client()]) {
      const w = await wallOf(client);
      assert.equal(w.stamps_off, false);
      assert.ok(w.posts.every((p) => p.stamps_off === false && p.comments_off === false));
    }
    assert.equal((await c.coco.get(`/api/rings/${id}/feed`)).body.posts.find((p) => p.id === room).stamps_off, false);
    assert.equal((await c.coco.post(`/api/pages/ana/posts/${pub}/stamp`, { kaomoji: '(⌒‿⌒)' })).status, 200);
    await c.ana.put('/api/me/page', { unblock: 'bram' });
    assert.equal((await wallOf(c.bram)).stamps_off, false, 'unblocked, the wall opens for him again');
  } finally { await h.close(); }
});

test('R2 a blocked member\'s ring ask never reaches the blocker: inbox, dot and ring view', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    const r = (await c.ana.post('/api/rings', { name: 'Ana only' })).body;
    await c.ana.put('/api/me/page', { block: 'bram' });
    const before = (await c.ana.get('/api/me')).body.unseen;
    const ask = await c.bram.post(`/api/rings/join/${codeOf(r)}`);
    assert.equal(ask.status, 200);
    assert.equal(ask.body.requested, true, 'his answer is the one anyone gets');
    assert.equal((await c.ana.get('/api/inbox')).body.join_requests.length, 0, 'no inbox row');
    assert.equal((await c.ana.get('/api/me')).body.unseen, before, 'no dot');
    assert.equal((await c.ana.get('/api/rings')).body.rings[0].requests.length, 0, 'not in her ring view');

    await c.coco.post(`/api/rings/join/${codeOf(r)}`);
    assert.deepEqual((await c.ana.get('/api/inbox')).body.join_requests.map((q) => q.handle), ['coco'], 'positive control: an unblocked ask lands');
    assert.equal((await c.ana.get('/api/me')).body.unseen, before + 1);
    assert.deepEqual((await c.ana.get('/api/rings')).body.rings[0].requests.map((q) => q.handle), ['coco']);
  } finally { await h.close(); }
});

test('R3 a kick sticks: the link rotates, requests drop with Reject, only the creator re-admits', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    const { id, code } = await ring(c, 'ana', ['bram', 'coco']);
    await c.dora.post(`/api/rings/join/${code}`);   // pending when the kick lands
    const seen = await tapped(h, async () => {
      assert.equal((await c.ana.del(`/api/rings/${id}/members/coco`)).status, 200);
    });
    const row = h.ctx.ringStore.get(id);
    assert.deepEqual(row.kicked, ['coco'], 'the ring remembers');
    assert.equal(row.requests.length, 0, 'the pending request dropped');
    assert.equal(rejectsTo(seen, 'dora').length, 1, 'and dora is answered');
    assert.notEqual(row.join.code, code, 'the link rotated');
    assert.equal((await c.coco.post(`/api/rings/join/${code}`)).status, 404, 'the old code opens nothing');

    const secret = (await note(c.ana, 'posted AFTER kicking coco', id)).body.id;
    const fresh = (await c.ana.get('/api/rings')).body.rings[0].join.code;
    assert.equal((await c.coco.post(`/api/rings/join/${fresh}`)).body.requested, true, 'the new code (shared again) lets her ask');
    assert.equal((await c.ana.get('/api/rings')).body.rings[0].requests[0].kicked, true, 'the view marks her');
    const no = await c.bram.post(`/api/rings/${id}/requests/coco`, { approve: true });
    assert.equal(no.status, 403);
    assert.equal(no.body.error, 'ring_creator_only', 'a non-creator approval of a kicked handle is refused');
    const feed = await c.coco.get(`/api/rings/${id}/feed`);
    assert.equal(feed.status, 404, 'she reads nothing');
    assert.ok(!JSON.stringify(feed.body).includes(secret));

    const yes = await c.ana.post(`/api/rings/${id}/requests/coco`, { approve: true });
    assert.equal(yes.status, 200, 'positive control: the creator re-admits');
    assert.ok(yes.body.members.some((m) => m.handle === 'coco'));
    assert.deepEqual(h.ctx.ringStore.get(id).kicked, [], 're-admitted, off the list');
    // A non-creator still approves anyone never kicked.
    const code2 = (await c.ana.get('/api/rings')).body.rings[0].join.code;
    await c.dora.post(`/api/rings/join/${code2}`);
    assert.equal((await c.bram.post(`/api/rings/${id}/requests/dora`, { approve: true })).status, 200);
  } finally { await h.close(); }
});

test('R4 a deleted member\'s join code closes: rotated to the creator, its requests answered', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    const { id } = await ring(c, 'ana', ['bram']);
    const code = codeOf((await c.bram.post(`/api/rings/${id}/link`)).body);   // bram mints the standing code
    await c.dora.post(`/api/rings/join/${code}`);
    const seen = await tapped(h, async () => {
      assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200);
    });
    const row = h.ctx.ringStore.get(id);
    assert.equal(row.join.created_by, 'ana', 'the code is the creator\'s now');
    assert.notEqual(row.join.code, code);
    assert.equal(row.requests.length, 0);
    assert.equal(rejectsTo(seen, 'dora').length, 1, 'the ask it filed is answered');
    assert.equal((await c.coco.get(`/api/rings/join/${code}`)).status, 404, 'his code opens nothing');
    const prev = await c.coco.get(`/api/rings/join/${row.join.code}`);
    assert.equal(prev.status, 200, 'positive control: the ring still has a door');
    assert.equal(prev.body.offered_by, 'Ana Tester', 'signed by someone who exists');
  } finally { await h.close(); }
});

test('R5 rename and link-off share the ringlink budget; approve and decline have their own', async () => {
  const { h, c } = await crowd(['ana'], { limitScale: 1 });
  try {
    const r = (await c.ana.post('/api/rings', { name: 'Spam' })).body;
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await c.ana.patch(`/api/rings/${r.id}`, { name: `Spam ${i}` })).status);
    assert.deepEqual([...new Set(statuses)], [200], 'positive control: ten renames a minute');
    assert.equal((await c.ana.patch(`/api/rings/${r.id}`, { name: 'Spam 11' })).status, 429, 'the eleventh waits');
    assert.equal((await c.ana.del(`/api/rings/${r.id}/link`)).status, 429, 'link-off spends the same budget');
    assert.equal((await c.ana.post(`/api/rings/${r.id}/link`)).status, 429, 'and rotate');
    clock.advance(61_000);
    assert.equal((await c.ana.del(`/api/rings/${r.id}/link`)).status, 200, 'a minute on, it opens');

    const answers = [];
    for (let i = 0; i < 31; i++) answers.push((await c.ana.post(`/api/rings/${r.id}/requests/nobody`, { approve: false })).status);
    assert.deepEqual([...new Set(answers.slice(0, 30))], [404], 'thirty answers a minute');
    assert.equal(answers[30], 429, 'the thirty-first waits');
  } finally { await h.close(); }
});

test('R6 a damaged OTHER member\'s file never blocks a deletion: skipped, logged, never written over', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await befriend(c, 'bram', 'coco');
    const { id } = await ring(c, 'bram', ['coco']);
    await c.ana.put('/api/me/page', { enabled: true });
    const stampsFile = h.ctx.paths.memberFile('ana', 'log-stamps.json');
    fs.writeFileSync(stampsFile, '{not json');
    const del = await c.bram.del('/api/me', { password: PASSWORD });
    assert.equal(del.status, 200);
    assert.equal(h.ctx.members.get('bram'), null, 'the account is gone');
    assert.deepEqual(h.ctx.ringStore.get(id).members.map((m) => m.handle), ['coco']);
    const f = h.ctx.follows.load('coco');
    assert.equal(f.followers.length + f.following.length, 0, 'the edges with a readable member went');
    assert.equal(fs.readFileSync(stampsFile, 'utf8'), '{not json', 'never written over');
    assert.ok(h.logs.some((l) => /\[purge\] bram: skipped ana/.test(l)), 'the skip is logged');
    assert.equal((await c.bram.get('/api/me')).status, 401, 'his sessions ended');
  } finally { await h.close(); }
});

test('R6 the deleter\'s own damaged file refuses the purge before anything changes', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await befriend(c, 'bram', 'coco');
    const { id } = await ring(c, 'bram', ['coco']);
    const own = h.ctx.paths.memberFile('bram', 'follows.json');
    const good = fs.readFileSync(own, 'utf8');
    fs.writeFileSync(own, '{not json');
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 500);
    assert.ok(h.ctx.members.get('bram'), 'the row stays');
    assert.equal((await c.bram.get('/api/rings')).status, 200, 'his session stays: he can retry');
    assert.deepEqual(h.ctx.ringStore.get(id).members.map((m) => m.handle), ['bram', 'coco'], 'nothing moved');
    assert.equal(h.ctx.follows.load('coco').followers.length, 1, 'coco\'s side untouched');
    fs.writeFileSync(own, good);
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200, 'positive control: restored, it runs');
    assert.equal(h.ctx.members.get('bram'), null);
  } finally { await h.close(); }
});

test('R6 a purge cut short (a crash mid-way) leaves a signed-in account whose retry finishes it', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await befriend(c, 'bram', 'coco');
    const { id } = await ring(c, 'bram', ['coco']);
    const remove = h.ctx.images.remove;
    h.ctx.images.remove = () => { throw new Error('disk gone'); };   // a crash past the social steps
    try {
      assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 500);
    } finally { h.ctx.images.remove = remove; }
    assert.ok(h.ctx.members.get('bram'), 'the row is still there');
    assert.equal((await c.bram.get('/api/me')).status, 200, 'sessions end only past the point of no return');
    // A sever cut short on the other side: a row naming bram left in coco's file.
    const cf = h.ctx.follows.load('coco');
    cf.followers.push({ handle: 'bram', state: 'accepted', follow_id: 'x', at: clock.iso(), accepted_at: clock.iso() });
    fs.writeFileSync(h.ctx.paths.memberFile('coco', 'follows.json'), JSON.stringify(cf));
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200, 'the retry runs');
    assert.equal(h.ctx.members.get('bram'), null);
    const f = h.ctx.follows.load('coco');
    assert.ok(![...f.following, ...f.followers].some((r) => r.handle === 'bram'), 'the leftover row was swept');
    assert.deepEqual(h.ctx.ringStore.get(id).members.map((m) => m.handle), ['coco']);
    assert.ok(!fs.existsSync(h.ctx.paths.memberDir('bram')));
  } finally { await h.close(); }
});

test('R7 Keep sheds every reaction made under the room grant; Public-tier stamps stay', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora', 'eli']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    const { id } = await ring(c, 'ana', ['bram', 'coco', 'dora', 'eli']);
    await befriend(c, 'bram', 'ana');
    const p = (await note(c.ana, 'room thought', id)).body.id;
    const path = `/api/pages/ana/posts/${p}`;
    assert.equal((await c.bram.post(`${path}/comment`, { body: 'only for the room' })).status, 200);
    assert.equal((await c.bram.post(`${path}/stamp`, { kaomoji: '(⊙_⊙)' })).status, 200, 'a friend\'s full-palette face');
    assert.equal((await c.coco.post(`${path}/stamp`, { kaomoji: '(⊙_⊙)' })).status, 200, 'a non-friend\'s full-palette face: the room grant');
    assert.equal((await c.dora.post(`${path}/stamp`, { kaomoji: '(⌒‿⌒)' })).status, 200, 'a nice face: anyone\'s');
    assert.equal((await c.eli.post(`${path}/stamp`, { kaomoji: 'ink!' })).status, 200, 'a custom face: the room only');
    assert.equal((await c.ana.post(`/api/posts/${p}/keep`)).status, 200);
    const wall = (await h.client().get('/api/pages/ana')).body.posts.find((x) => x.id === p);
    assert.deepEqual(wall.comments, [], 'every comment stays in the room');
    const faces = Object.fromEntries(wall.stamps.map((s) => [s.author.handle, s.kaomoji]));
    assert.deepEqual(faces, { bram: '(⊙_⊙)', dora: '(⌒‿⌒)' }, 'the friend\'s and the nice face stay; the room-only ones go');
    assert.equal(h.ctx.reactions.loadComments('ana').length, 0, 'gone from disk, not only hidden');
  } finally { await h.close(); }
});

test('R8 comments and ring names lose bidi overrides and control characters', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await befriend(c, 'bram', 'ana');
    const p = (await note(c.ana, 'hello')).body.id;
    const bidi = /[‪-‮⁦-⁩\u0000-\u001f\u007f]/;
    assert.equal((await c.bram.post(`/api/pages/ana/posts/${p}/comment`, { body: 'nice ‮gnp.exe‬ work' })).status, 200);
    const row = h.ctx.reactions.loadComments('ana')[0];
    assert.ok(!bidi.test(row.body), 'stored clean');
    assert.equal(row.body, 'nice gnp.exe work');
    const made = (await c.ana.post('/api/rings', { name: 'Print ⁧Club⁩\u0007' })).body;
    assert.equal(made.name, 'Print Club');
    const renamed = (await c.ana.patch(`/api/rings/${made.id}`, { name: 'Ink ‮Klub' })).body;
    assert.equal(renamed.name, 'Ink Klub');
    assert.ok(!bidi.test(h.ctx.ringStore.get(made.id).name));
  } finally { await h.close(); }
});

test('R9 every dropped request is answered with Reject; an expired link closes with Update{Group}', async () => {
  const t0 = Date.parse('2026-10-01T09:00:00Z');
  clock.set(t0);
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    const { id } = await ring(c, 'ana', ['bram']);
    const codeNow = async () => (await c.ana.get('/api/rings')).body.rings[0].join.code;
    // rotate
    await c.coco.post(`/api/rings/join/${await codeNow()}`);
    let seen = await tapped(h, () => c.bram.post(`/api/rings/${id}/link`));
    assert.equal(rejectsTo(seen, 'coco').length, 1, 'rotate answers the ask it dropped');
    // link off
    await c.coco.post(`/api/rings/join/${await codeNow()}`);
    seen = await tapped(h, () => c.bram.del(`/api/rings/${id}/link`));
    assert.equal(rejectsTo(seen, 'coco').length, 1, 'link-off too');
    // expiry
    await c.ana.post(`/api/rings/${id}/link`);
    await c.dora.post(`/api/rings/join/${await codeNow()}`);
    const rev0 = h.ctx.ringStore.get(id).rev;
    clock.set(t0 + 15 * 86400_000);
    seen = await tapped(h, () => h.ctx.housekeeping.run());
    const row = h.ctx.ringStore.get(id);
    assert.equal(row.join, null);
    assert.equal(row.rev, rev0 + 1);
    const updates = seen.filter((a) => a.type === 'Update' && a.object?.type === 'Group');
    assert.equal(updates.length, 1, 'the members are told');
    assert.deepEqual(updates[0].to.map((u) => new URL(u).pathname).sort(), ['/users/ana', '/users/bram']);
    assert.equal(updates[0].object.ring.rev, row.rev);
    assert.equal(rejectsTo(seen, 'dora').length, 1, 'the expired ask is answered');
    // Positive control: a run with nothing expired sends nothing.
    seen = await tapped(h, () => h.ctx.housekeeping.run());
    assert.equal(seen.length, 0);
  } finally { await h.close(); }
});

test('projection: a signature change drops only the walls that render it; any other setting drops none', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    for (const n of ['ana', 'coco']) await c[n].put('/api/me/page', { enabled: true });
    await c.bram.put('/api/me/page', { theme: { bg: '#000000' } });
    const p = (await note(c.ana, 'stamp me')).body.id;
    await note(c.coco, 'no bram here');
    await c.bram.post(`/api/pages/ana/posts/${p}/stamp`, { kaomoji: '(⌒‿⌒)' });
    const P = h.ctx.projection;
    const anaWall = P.get('ana', h.base);
    const cocoWall = P.get('coco', h.base);
    await c.bram.put('/api/me/page', { theme: { bg: '#000000', marquee: 'hello' } });
    assert.equal(P.get('ana', h.base), anaWall, 'a setting outside the signature drops no other wall');
    assert.equal(P.get('coco', h.base), cocoWall);
    await c.bram.put('/api/me/page', { theme: { bg: '#ffffff', marquee: 'hello' } });
    assert.notEqual(P.get('ana', h.base), anaWall, 'the tint changed: the wall that shows it is rebuilt');
    assert.equal(P.get('ana', h.base).posts[0].stamps[0].tint, '#ffffff');
    assert.equal(P.get('coco', h.base), cocoWall, 'a wall that never showed him is kept');
  } finally { await h.close(); }
});
