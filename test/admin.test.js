'use strict';
/* admin (spec 6.2, 6.3, 10.11, 11.1, 16.3; P8), on one server with
 * FEDERATION=off (the federated half is test/moderation.test.js):
 *   every /api/admin/* route and /admin refuse anyone but an active admin
 *     (401 signed out, 403 a member), and a cross-site request even from one;
 *   the last admin can neither step down nor be suspended; step_down is one's
 *     own; make_admin then step_down works;
 *   a local suspension: no sign-in (403 suspended), the session is no session,
 *     the wall is the unknown name's 404; lifting it restores all;
 *   a member's report: of a post they can see (never one they cannot, never
 *     their own), of a comment; the admin's remove_post deletes it through the
 *     one delete and its author is told in Inbox; dismiss and resolve;
 *   the signup door's counts and release, the admin's only;
 *   BLOCKED_DOMAINS is a seed: imported into the list at boot, and a removal
 *     in /admin is not overruled at the next boot.
 * Each refusal has its positive control. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, joinAdmin, joinInvited, PASSWORD } = require('./helpers/harness');
const { crowd, ring } = require('./helpers/social');

const ROUTES = [
  ['get', '/api/admin/reports'], ['post', '/api/admin/reports/rep_00000000'],
  ['get', '/api/admin/domain-blocks'], ['post', '/api/admin/domain-blocks'], ['del', '/api/admin/domain-blocks/x.example'],
  ['get', '/api/admin/actor-blocks'], ['post', '/api/admin/actor-blocks'], ['del', '/api/admin/actor-blocks/a%40x.example'],
  ['get', '/api/admin/members'], ['post', '/api/admin/members/ana'],
  ['get', '/api/admin/federation'], ['post', '/api/admin/federation/hosts/x.example/clear'],
  ['get', '/api/admin/signups'], ['post', '/api/admin/signups'],
];
const call = (c, [m, p], extra) => (m === 'get' ? c.get(p, extra) : m === 'del' ? c.del(p, undefined, extra) : c.post(p, {}, extra));

test('every admin route and /admin: 401 signed out, 403 for a member, cross-site refused; the admin passes', async () => {
  const { h, c } = await crowd(['ada', 'ana']);
  try {
    for (const r of ROUTES) {
      assert.equal((await call(h.client(), r)).status, 401, `${r[1]} signed out`);
      const m = await call(c.ana, r);
      assert.equal(m.status, 403, `${r[1]} for a member`);
      assert.equal(m.body.error, 'forbidden');
      const a = await call(c.ada, r);
      assert.ok(a.status !== 401 && a.status !== 403, `${r[1]}: the admin passes (${a.status})`);
    }
    // CSRF holds for the admin as for anyone (the one middleware, 10.10).
    const x = await c.ada.post('/api/admin/domain-blocks', { host: 'x.example' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(x.status, 403);
    assert.equal(x.body.error, 'csrf');
    assert.equal((await c.ada.get('/api/admin/domain-blocks')).body.blocks.length, 0, 'nothing was added');
    // The page.
    let p = await h.client().get('/admin');
    assert.equal(p.status, 302);
    assert.match(p.headers.get('location'), /^\/login\?next=%2Fadmin/);
    p = await c.ana.get('/admin');
    assert.equal(p.status, 403);
    assert.match(p.headers.get('x-robots-tag') || '', /noindex/);
    p = await c.ada.get('/admin');
    assert.equal(p.status, 200);
    assert.match(p.headers.get('x-robots-tag'), /noindex/);
    assert.match(p.headers.get('cache-control'), /no-store/);
    assert.match(p.text, /<div id="root">/);
    // A suspended admin is no admin.
    assert.equal((await c.ada.post('/api/admin/members/ana', { action: 'make_admin' })).status, 200);
    assert.equal((await c.ana.post('/api/admin/members/ada', { action: 'suspend' })).status, 200);
    assert.equal((await c.ada.get('/api/admin/reports')).status, 401, 'the suspended admin is signed out');
  } finally { await h.close(); }
});

test('admins: the last cannot step down or be suspended; step_down is one\'s own; make_admin then step_down', async () => {
  const { h, c } = await crowd(['ada', 'ana']);
  try {
    let r = await c.ada.post('/api/admin/members/ada', { action: 'step_down' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'last_admin');
    r = await c.ada.post('/api/admin/members/ada', { action: 'suspend' });
    assert.equal(r.status, 400, 'not oneself');
    assert.equal((await c.ada.post('/api/admin/members/ana', { action: 'make_admin' })).status, 200);
    r = await c.ana.post('/api/admin/members/ada', { action: 'step_down' });
    assert.equal(r.status, 403, 'only one\'s own');
    r = await c.ada.post('/api/admin/members/ada', { action: 'step_down' });
    assert.equal(r.status, 200, 'positive control: another admin exists');
    assert.equal(r.body.member.role, 'member');
    r = await c.ana.post('/api/admin/members/ana', { action: 'step_down' });
    assert.equal(r.status, 409, 'and now ana is the last');
    const list = (await c.ana.get('/api/admin/members')).body.members;
    assert.deepEqual(list.map((m) => [m.name, m.role, m.status]), [['ada', 'member', 'active'], ['ana', 'admin', 'active']]);
  } finally { await h.close(); }
});

test('a local suspension: no sign-in, the session ends, the wall 404s; lifting restores', async () => {
  const { h, c } = await crowd(['ada', 'ana']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await c.ana.post('/api/posts', { kind: 'note', note: 'hello' });
    assert.equal((await h.client().get('/api/pages/ana')).status, 200);
    assert.equal((await c.ada.post('/api/admin/members/ana', { action: 'suspend' })).status, 200);
    assert.equal((await c.ana.get('/api/me')).status, 401);
    const login = await h.client().post('/api/login', { email: 'ana@example.test', password: PASSWORD });
    assert.equal(login.status, 403);
    assert.equal(login.body.error, 'suspended');
    assert.equal((await h.client().get('/api/pages/ana')).status, 404);
    assert.equal((await h.client().get('/@ana')).status, 404);
    assert.equal((await c.ada.post('/api/admin/members/ana', { action: 'unsuspend' })).status, 200);
    assert.equal((await h.client().post('/api/login', { email: 'ana@example.test', password: PASSWORD })).status, 200);
    assert.equal((await h.client().get('/api/pages/ana')).status, 200, 'the wall is back');
  } finally { await h.close(); }
});

test('reports: a visible post, never an unseen or one\'s own; a comment; remove_post through the one delete, its author told in Inbox; dismiss', async () => {
  const { h, c } = await crowd(['ada', 'ana', 'bo', 'cy']);
  try {
    for (const n of ['ana', 'bo']) await c[n].put('/api/me/page', { enabled: true });
    const pub = (await c.bo.post('/api/posts', { kind: 'note', note: 'rude' })).body;
    const pubUrl = `${h.base}/users/bo/posts/${pub.id}`;
    // A room post cy cannot see.
    const { id: ringId } = await ring(c, 'bo', ['ana'], 'Club');
    const room = (await c.bo.post('/api/posts', { kind: 'note', note: 'room', audience: ringId })).body;
    let r = await c.cy.post('/api/reports', { kind: 'post', url: `${h.base}/users/bo/posts/${room.id}` });
    assert.equal(r.status, 404, 'a post the reporter cannot see is the unknown one');
    r = await c.ana.post('/api/reports', { kind: 'post', url: `${h.base}/users/bo/posts/${room.id}`, comment: 'in the room' });
    assert.equal(r.status, 201, 'a ring-mate can');
    r = await c.bo.post('/api/reports', { kind: 'post', url: pubUrl });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'own_post');
    r = await c.ana.post('/api/reports', { kind: 'person', handle: 'ana' });
    assert.equal(r.body.error, 'own_handle');
    r = await c.cy.post('/api/reports', { kind: 'post', url: pubUrl, comment: 'please‮ look' });
    assert.equal(r.status, 201, r.text);
    const id = r.body.id;
    // A comment on ana's post.
    await c.ana.post('/api/friends', { handle: 'bo' });
    await c.bo.post('/api/friends/ana/confirm');
    const ap = (await c.ana.post('/api/posts', { kind: 'note', note: 'mine' })).body;
    const cm = await c.bo.post(`/api/pages/ana/posts/${ap.id}/comment`, { body: 'ugh' });
    assert.equal(cm.status, 200, cm.text);
    r = await c.ana.post('/api/reports', { kind: 'comment', owner: 'ana', post_id: ap.id, id: cm.body.comments[0].id });
    assert.equal(r.status, 201, r.text);
    const q = (await c.ada.get('/api/admin/reports')).body.reports;
    assert.equal(q.length, 3);
    const mine = q.find((x) => x.id === id);
    assert.equal(mine.from, 'cy');
    assert.equal(mine.target, 'bo');
    assert.equal(mine.comment, 'please look', 'one plain line');
    assert.deepEqual(mine.objects, [`${h.base}/users/bo`, pubUrl]);
    assert.equal(mine.target_view.local, true);
    // remove_post: the post goes, bo is told, the report closes.
    r = await c.ada.post(`/api/admin/reports/${id}`, { action: 'remove_post', note: 'removed' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.report.state, 'resolved');
    assert.equal(r.body.report.resolved_by, 'ada');
    assert.equal((await c.bo.get('/api/me/page')).body.posts.some((p) => p.id === pub.id), false, 'the post is gone');
    const inbox = (await c.bo.get('/api/inbox')).body;
    assert.equal(inbox.notices.length, 1);
    assert.equal(inbox.notices[0].kind, 'post_removed');
    assert.ok(!JSON.stringify(inbox.notices).includes('cy'), 'the notice names no reporter');
    assert.ok((await c.bo.get('/api/me')).body.unseen >= 1);
    await c.bo.post('/api/inbox/seen');
    assert.equal((await c.bo.get('/api/inbox')).body.notices[0].seen, true);
    assert.equal((await c.ada.post(`/api/admin/reports/${id}`, { action: 'remove_post' })).status, 409, 'nothing left to remove');
    // dismiss
    const other = q.find((x) => x.kind === 'comment').id;
    r = await c.ada.post(`/api/admin/reports/${other}`, { action: 'dismiss', note: 'fine' });
    assert.equal(r.body.report.state, 'dismissed');
    assert.equal(r.body.report.note, 'fine');
    // A local target cannot be domain-blocked or forwarded.
    const roomRep = q.find((x) => x.comment === 'in the room').id;
    assert.equal((await c.ada.post(`/api/admin/reports/${roomRep}`, { action: 'block_domain' })).status, 400);
    assert.equal((await c.ada.post(`/api/admin/reports/${roomRep}`, { action: 'forward' })).status, 400);
    assert.equal((await c.ada.post(`/api/admin/reports/${roomRep}`, { action: 'suspend' })).status, 200);
    assert.equal((await c.bo.get('/api/me')).status, 401, 'suspended from the report');
  } finally { await h.close(); }
});

test('the signup door: counts that name no one, release and clear, the admin\'s only', async () => {
  const h = await boot({ env: { SIGNUP: 'open' } });
  try {
    const ada = await joinAdmin(h, 'ada');
    for (let i = 0; i < 3; i++) await h.client().post('/api/signup', { email: `p${i}@example.test`, password: PASSWORD, slug: `p${i}` });
    let s = (await ada.get('/api/admin/signups')).body;
    assert.equal(s.pending, 3);
    assert.equal(s.cap, 10_000);
    assert.ok(!JSON.stringify(s).includes('@'), 'no address in the counts');
    let r = await ada.post('/api/admin/signups', { action: 'release', email: 'p1@example.test' });
    assert.equal(r.status, 200);
    assert.equal(r.body.pending, 2);
    const same = await ada.post('/api/admin/signups', { action: 'release', email: 'nobody@example.test' });
    assert.deepEqual(Object.keys(same.body), Object.keys(r.body), 'the same answer whether anything was held');
    r = await ada.post('/api/admin/signups', { action: 'clear' });
    assert.equal(r.body.pending, 0);
    const bo = await joinInvited(h, ada, { slug: 'bo' });
    assert.equal((await bo.post('/api/admin/signups', { action: 'clear' })).status, 403);
  } finally { await h.close(); }
});

test('BLOCKED_DOMAINS is a seed: imported at boot, an admin\'s removal stands at the next boot, a new host is added', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-seed-'));
  try {
    let h = await boot({ dataDir: dir, env: { BLOCKED_DOMAINS: 'bad.example,worse.example' } });
    const ada = await joinAdmin(h, 'ada');
    let list = (await ada.get('/api/admin/domain-blocks')).body.blocks.map((b) => b.host).sort();
    assert.deepEqual(list, ['bad.example', 'worse.example']);
    assert.equal(h.ctx.moderation.hostBlocked('sub.bad.example'), true, 'subdomains too');
    assert.equal(h.ctx.moderation.hostBlocked('notbad.example'), false, 'a suffix that is not a label is not');
    assert.equal((await ada.del('/api/admin/domain-blocks/bad.example')).status, 200);
    await h.close({ keepData: true });
    h = await boot({ dataDir: dir, env: { BLOCKED_DOMAINS: 'bad.example,worse.example,new.example' } });
    const again = h.client();
    assert.equal((await again.post('/api/login', { email: 'admin@example.test', password: PASSWORD })).status, 200);
    list = (await again.get('/api/admin/domain-blocks')).body.blocks.map((b) => b.host).sort();
    assert.deepEqual(list, ['new.example', 'worse.example'], 'the removal stands; the new host is added');
    await h.close({ keepData: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
