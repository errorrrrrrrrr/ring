'use strict';
/* Gate: the endless square (spec 16.2 "feed-pagination", 3.9).
 * GET /api/feed pages 20 at a time behind an opaque
 * [created_at, id, name] cursor; no duplicate and no skip across pages; a post
 * added mid-scroll shifts nothing already read; a member whose page is off is on
 * no page; a garbage cursor reads from the top; members only; a ROOM ends and
 * never offers a cursor. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { crowd, ring, note } = require('./helpers/social');

test.afterEach(() => clock.reset());

test('20 a page, newest first, no dup, no skip; a mid-scroll post shifts nothing; junk reads from the top', async () => {
  const t0 = Date.parse('2026-10-01T09:00:00Z');
  clock.set(t0);
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await c.bram.put('/api/me/page', { enabled: true });
    const made = [];
    for (let i = 1; i <= 45; i++) {
      clock.set(t0 + i * 60_000);
      made.push((await note(i % 2 ? c.ana : c.bram, `post ${i}`)).body.id);
    }
    clock.set(t0 + 46 * 60_000);
    await note(c.coco, 'coco is unpublished');
    const { id } = await ring(c, 'ana', ['bram']);
    await note(c.ana, 'a room post', id);
    await c.ana.post('/api/posts', { kind: 'divider', media: { variant: 'dots' } });
    const ids = (r) => r.body.posts.map((p) => p.id);

    assert.equal((await h.client().get('/api/feed')).status, 401, 'members only');
    const p1 = await c.coco.get('/api/feed');
    assert.equal(p1.body.posts.length, 20);
    assert.equal(ids(p1)[0], made[44]);
    assert.equal(ids(p1)[19], made[25]);
    assert.equal(p1.body.ends, false);
    assert.equal(typeof p1.body.next_cursor, 'string');
    assert.equal(p1.body.me_page_off, true);
    assert.ok(Array.isArray(p1.body.palette));
    const p2 = await c.coco.get(`/api/feed?cursor=${p1.body.next_cursor}`);
    assert.deepEqual([ids(p2)[0], ids(p2)[19]], [made[24], made[5]], 'page two continues exactly');
    const p3 = await c.coco.get(`/api/feed?cursor=${p2.body.next_cursor}`);
    assert.deepEqual(ids(p3), made.slice(0, 5).reverse(), 'page three is the tail');
    assert.equal(p3.body.ends, true);
    assert.equal(p3.body.next_cursor, null);
    const all = [...ids(p1), ...ids(p2), ...ids(p3)];
    assert.equal(new Set(all).size, 45);
    assert.equal(all.length, 45, 'the union is every post once');
    const text = JSON.stringify([p1.body, p2.body, p3.body]);
    assert.ok(!text.includes('coco is unpublished'), 'a page that is off is on no page');
    assert.ok(!text.includes('a room post'), 'never a room post');
    assert.ok(![p1, p2, p3].some((p) => p.body.posts.some((x) => x.kind === 'divider')), 'dividers are furniture');
    assert.ok(p1.body.posts.every((p) => p.author?.handle && Array.isArray(p.stamps)));

    clock.set(t0 + 50 * 60_000);
    const added = (await note(c.ana, 'while scrolling')).body.id;
    const again = await c.coco.get(`/api/feed?cursor=${p1.body.next_cursor}`);
    assert.deepEqual(ids(again), ids(p2), 'the old cursor returns the identical page two');
    assert.equal(ids(await c.coco.get('/api/feed'))[0], added, 'a fresh page one leads with the new post');
    const junk = await c.coco.get('/api/feed?cursor=%%%not-a-cursor');
    assert.equal(junk.status, 200);
    assert.equal(ids(junk)[0], added, 'junk reads from the top');

    // A room ends, and never offers a cursor.
    await note(c.bram, 'another room post', id);
    const room = await c.ana.get(`/api/rings/${id}/feed?cursor=${p1.body.next_cursor}`);
    assert.equal(room.body.posts.length, 2, 'everything it holds, the cursor ignored');
    assert.equal(room.body.ends, true);
    assert.equal(room.body.next_cursor, undefined);
  } finally { await h.close(); }
});
