'use strict';
/* Gate: the social layer's lifecycle (spec 11.4, 16.3 "auth: deletion purges
 * every trace", "lifecycle"). Deleting a member severs every follow (the other
 * side's rows go too), drops them from every ring and request (a ring they
 * created passes on), and removes every stamp and comment they left on anyone's
 * posts; a deleted member's in-flight stamp or comment never lands. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PASSWORD } = require('./helpers/harness');
const { crowd, befriend, ring, note, codeOf } = require('./helpers/social');

test('deletion purges every social trace, here and on the other side', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await befriend(c, 'bram', 'ana');
    await c.coco.post('/api/friends', { handle: 'bram' });   // a pending request to bram
    await c.bram.post('/api/friends', { handle: 'dora' });   // bram's pending request
    const anas = await ring(c, 'ana', ['bram']);
    const brams = await ring(c, 'bram', ['ana', 'coco'], 'Bram\'s');
    const third = (await c.dora.post('/api/rings', { name: 'Dora\'s' })).body;
    await c.bram.post(`/api/rings/join/${codeOf(third)}`);   // a pending ask
    const post = (await note(c.ana, 'hello')).body.id;
    const room = (await note(c.ana, 'room', anas.id)).body.id;
    await c.bram.post(`/api/pages/ana/posts/${post}/stamp`, { kaomoji: '(⊙_⊙)' });
    await c.bram.post(`/api/pages/ana/posts/${post}/comment`, { body: 'a return address' });
    await c.bram.post(`/api/pages/ana/posts/${room}/stamp`, { kaomoji: '🦑' });
    await c.coco.post(`/api/pages/ana/posts/${post}/stamp`, { kaomoji: '✿' });

    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200);

    for (const n of ['ana', 'coco', 'dora']) {
      const f = h.ctx.follows.load(n);
      assert.ok(![...f.following, ...f.followers].some((r) => r.handle === 'bram'), `${n}: no follow row names bram`);
    }
    assert.deepEqual(h.ctx.ringStore.get(anas.id).members.map((m) => m.handle), ['ana']);
    const passed = h.ctx.ringStore.get(brams.id);
    assert.equal(passed.created_by, 'ana', 'his ring passes to the oldest remaining member');
    assert.deepEqual(passed.members.map((m) => m.handle), ['ana', 'coco']);
    assert.equal(h.ctx.ringStore.get(third.id).requests.length, 0, 'his pending ask is gone');
    assert.deepEqual(h.ctx.reactions.loadStamps('ana').map((s) => s.author), ['coco'], 'his stamps are gone; others stay');
    assert.equal(h.ctx.reactions.loadComments('ana').length, 0);
    assert.ok(!fs.existsSync(h.ctx.paths.memberDir('bram')), 'his dir did not come back');
    assert.ok(!JSON.stringify((await h.client().get('/api/pages/ana')).body).includes('bram'), 'nothing of him on the wall');
    assert.equal((await c.ana.get('/api/inbox')).body.join_requests.length, 0);
  } finally { await h.close(); }
});

test('a deleted member\'s in-flight stamp and comment never land', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await befriend(c, 'bram', 'ana');
    const post = (await note(c.ana, 'hello')).body.id;
    const stamp = await c.bram.stream('POST', `/api/pages/ana/posts/${post}/stamp`, { kaomoji: '✿' });
    const comment = await c.bram.stream('POST', `/api/pages/ana/posts/${post}/comment`, { body: 'late' });
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200);
    assert.equal((await stamp.finish()).status, 401);
    assert.equal((await comment.finish()).status, 401);
    assert.equal(h.ctx.reactions.loadStamps('ana').length, 0);
    assert.equal(h.ctx.reactions.loadComments('ana').length, 0);
  } finally { await h.close(); }
});

test('the room sweep has its own step: a damaged store skips that owner, logged, and the rest are swept', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    const clock = require('../lib/clock');
    const { id } = await ring(c, 'ana', ['bram']);
    await note(c.ana, 'a', id);
    await note(c.bram, 'b', id);
    clock.advance(8 * 86400_000);
    fs.writeFileSync(h.ctx.paths.memberFile('ana', 'log.json'), '{ not json');
    const out = h.ctx.ringReset.run();
    assert.equal(out.changed, true, 'bram\'s post was swept');
    assert.ok(h.logs.some((l) => /\[ring-reset\] skipped ana/.test(l)), 'ana was skipped and logged');
    assert.equal(fs.readFileSync(h.ctx.paths.memberFile('ana', 'log.json'), 'utf8'), '{ not json', 'never written over');
    clock.reset();
  } finally { await h.close(); }
});

test('the follows and reaction stores refuse a write for a member who is not there', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    assert.equal((await c.bram.del('/api/me', { password: PASSWORD })).status, 200);
    assert.throws(() => h.ctx.follows.befriend('bram', 'ana', h.base), (e) => e.code === 'MEMBER_GONE');
    assert.throws(() => h.ctx.reactions.saveStamps('bram', []), (e) => e.code === 'MEMBER_GONE');
    assert.throws(() => h.ctx.reactions.saveComments('bram', []), (e) => e.code === 'MEMBER_GONE');
    assert.ok(!fs.existsSync(h.ctx.paths.memberDir('bram')), 'the purge stayed a purge');
    assert.equal(h.ctx.follows.load('ana').followers.length, 0);
    h.ctx.follows.befriend('ana', 'bram', h.base);   // positive control: a live member writes
    assert.ok(fs.existsSync(h.ctx.paths.memberFile('ana', 'follows.json')));
  } finally { await h.close(); }
});
