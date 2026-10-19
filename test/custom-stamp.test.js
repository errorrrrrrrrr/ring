'use strict';
/* Gate: room-licensed custom faces (spec 16.2 "custom-stamp", 3.7). The closed
 * palette stays the law on every
 * public surface; in a shared ROOM a member gets the full palette plus one
 * bounded custom face; the room is decided by the STORED audience; bounds are
 * emoji-safe; outsiders are opaque; a kept post sheds its custom faces. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { crowd, ring, note } = require('./helpers/social');

test('custom faces live in rooms only, bounded, one line; a kept post sheds them', async () => {
  const { h, c } = await crowd(['ana', 'bram', 'finn']);
  try {
    const { id } = await ring(c, 'ana', ['bram']);
    await c.ana.put('/api/me/page', { enabled: true });
    const room = (await note(c.ana, 'in the room', id)).body.id;
    const pub = (await note(c.ana, 'in the open')).body.id;
    const rp = `/api/pages/ana/posts/${room}`;
    const pp = `/api/pages/ana/posts/${pub}`;

    let r = await c.bram.post(`${rp}/stamp`, { kaomoji: '🦑 ink!' });
    assert.equal(r.status, 200);
    assert.equal(r.body.mine, '🦑 ink!', 'a member presses a CUSTOM face onto a room post');
    const card = (await c.bram.get(`/api/rings/${id}/feed`)).body.posts.find((p) => p.id === room);
    const face = card.stamps.find((s) => s.kaomoji === '🦑 ink!');
    assert.ok(face && face.custom === true, 'the room board wears it, marked custom');
    assert.equal((await c.bram.post(`${rp}/stamp`, { kaomoji: '(⊙_⊙)' })).status, 200, 'a non-friend member gets the full palette in the room');

    assert.equal((await c.bram.post(`${pp}/stamp`, { kaomoji: '🦑 ink!' })).body.error, 'custom_room_only', 'a custom face on a public post is refused');
    assert.equal((await c.bram.post(`${pp}/stamp`, { kaomoji: '(⊙_⊙)' })).body.error, 'friends_only', 'a non-friend gets only the nice shelf on the wall');
    assert.equal((await c.bram.post(`${pp}/stamp`, { kaomoji: '(⌒‿⌒)' })).status, 200, 'the nice shelf still works there');
    assert.equal((await c.finn.post(`${rp}/stamp`, { kaomoji: '🦑 ink!' })).status, 404, 'an outsider cannot even see the room post');

    r = await c.bram.post(`${rp}/stamp`, { kaomoji: '🎨'.repeat(30) });
    assert.equal(Array.from(r.body.mine).length, 20, 'oversize is cut emoji-safe at 20');
    assert.equal((await c.bram.post(`${rp}/stamp`, { kaomoji: '   ' })).body.error, 'stamp_invalid', 'whitespace is not a face');
    r = await c.bram.post(`${rp}/stamp`, { kaomoji: 'two\nlines x' });
    assert.equal(r.status, 200);
    assert.ok(!/\n/.test(r.body.mine), 'a face is one line');
    assert.equal(r.body.mine, 'two lines x');

    // A NICE palette face from someone else (one face per sender: written as a row) is
    // in every reader's Public tier and survives the move; bram's custom face does not
    // (the rest of the room-grant rule: test/social-hardening.test.js R7).
    await h.ctx.reactions.saveStamps('ana', [...h.ctx.reactions.loadStamps('ana'), { id: 'stmp_mpalettepalet1', post_id: room, author: 'finn', kaomoji: '(⌒‿⌒)', activity_id: 'x', at: new Date().toISOString(), seen: false }]);
    r = await c.ana.post(`/api/posts/${room}/keep`);
    assert.equal(r.body.audience, 'public');
    const wall = (await h.client().get('/api/pages/ana')).body;
    const kept = wall.posts.find((p) => p.id === room);
    assert.ok(!kept.stamps.some((s) => s.kaomoji.includes('two lines') || s.custom), 'the custom face did not follow it out');
    assert.ok(kept.stamps.some((s) => s.kaomoji === '(⌒‿⌒)' && s.author.handle === 'finn'), 'a nice palette face survives the move');
    assert.ok(!JSON.stringify(wall).includes('🦑') && !JSON.stringify(wall).includes('two lines'), 'no custom face ever reaches the wall');
  } finally { await h.close(); }
});

test('the room is decided by the STORED audience, never the client', async () => {
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await ring(c, 'ana', ['bram']);
    await c.ana.put('/api/me/page', { enabled: true });
    const pub = (await note(c.ana, 'in the open')).body.id;
    // Whatever the body claims, the post is public: a custom face is refused.
    const r = await c.bram.post(`/api/pages/ana/posts/${pub}/stamp`, { kaomoji: '🦑', audience: 'ring_0123456789abcdef0123', custom: true });
    assert.equal(r.body.error, 'custom_room_only');
  } finally { await h.close(); }
});
