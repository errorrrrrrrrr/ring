'use strict';
/* ── Own posts (spec 11.1, 3.2) ───────────────────────────────────────────────
 *   POST /api/posts         create: the server mints the id (CSPRNG, never one
 *                           used before) and created_at; `archive` and unknown
 *                           kinds are refused; a ring audience needs membership
 *   PATCH /api/posts/:id    edit: kind, created_at and audience are immutable;
 *                           `updated_at` moves only when what federates as the
 *                           Note's content changes (note, cw, kaomoji, media):
 *                           a pin or a switch is not an edit (spec 4.9), and a
 *                           PATCH that changes nothing writes nothing
 *   DELETE /api/posts/:id   with the images nothing else references; a tombstone
 *                           keeps the id from ever coming back
 * Shapes and the write settle: lib/ring.js. Every write goes through the page
 * store, which drops the member's projection. A post may only reference its
 * author's own images (400 `foreign_image`), and a delete only ever frees the
 * author's own.
 *
 * Every write asks stillMember(req) in its commit tick: the session was read
 * before the body arrived, and a deletion or ended session in between must not
 * write (lib/page-store.js refuses a gone member's dir as well).
 *
 * P2: a room audience needs membership of that ring now (400 `not_in_ring`);
 * every change leaves as its activity (lib/post-delivery.js); a deleted post
 * takes its stamps and comments with it.
 *   POST /api/posts/:id/keep   the AUTHOR's one-way move of a room or archived
 *                              post to Public (spec 3.8, 4.9): a re-address, not
 *                              a copy; 409 `page_off` while the page is off (the
 *                              post would vanish from every surface); a kept room
 *                              post sheds every reaction made under the ROOM
 *                              GRANT (spec 3.7): all its comments, and each stamp
 *                              outside its sender's Public tier (a custom face; a
 *                              non-nice face from a non-friend), so the room's
 *                              crowd never lands on the public wall; a lapsed or
 *                              archived one its whole crowd (the sweep's rule)
 *   GET /api/archive           my shelf (lib/feeds.js)
 */
const express = require('express');
const clock = require('../lib/clock');
const { fail } = require('../lib/http');
const { settlePost, MAX_POSTS } = require('../lib/ring');
const { newPostId } = require('../lib/ids');
const urls = require('../lib/urls');
const { isMember } = require('../lib/rings');
const { isRoomAudience, ringPostLive } = require('../lib/ring-reset');
const { isNice } = require('../lib/reactions');

/* Did what federates as the Note's content change? (P5 maps updated_at to the
 * Note's `updated`, which Mastodon shows as "Edited".) */
const CONTENT = ['note', 'cw', 'kaomoji'];
function contentChanged(prev, next) {
  if (CONTENT.some((k) => (prev[k] ?? '') !== (next[k] ?? ''))) return true;
  return JSON.stringify(prev.media ?? null) !== JSON.stringify(next.media ?? null);
}

module.exports = function postRoutes(ctx) {
  const { cfg, pages, images, auth, limits, ownPostView, stillMember, ringStore, reactions, follows, delivery, feeds, audit } = ctx;
  const gone = (res) => fail(res, 401, 'not_signed_in');
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };

  router.post('/api/posts', auth.requireMember, noStore, limits.limit('post', { perMinute: 30, perDay: 300 }), (req, res) => {
    const name = req.member.slug;
    const s = settlePost(req.body, { ownsImage: (k) => images.owns(k, name) });
    if (s.error) return fail(res, 400, s.error);
    const post = s.post;
    if (post.audience === 'archive') return fail(res, 400, 'archive_refused');

    // ── tick ──
    if (!stillMember(req)) return gone(res);
    if (post.audience !== 'public') {
      // You may only address a room you are in (membership is what makes a room a room).
      const ring = ringStore.get(post.audience);
      if (!ring || !isMember(ring, name)) return fail(res, 400, 'not_in_ring');
    }
    const store = pages.load(name);
    if (store.posts.length >= MAX_POSTS) return fail(res, 400, 'posts_full', { n: MAX_POSTS });
    post.id = newPostId(pages.takenIds(name, store));
    post.created_at = clock.iso();
    store.posts.push(post);
    pages.save(name, store);
    const origin = urls.originOf(req, cfg);
    delivery.created(post, origin, name);
    res.status(201).json(ownPostView(post, origin, name));
  });

  router.patch('/api/posts/:id', auth.requireMember, noStore, limits.limit('post', { perMinute: 30, perDay: 300 }), (req, res) => {
    const name = req.member.slug;
    if (!stillMember(req)) return gone(res);
    const store = pages.load(name);
    const i = store.posts.findIndex((p) => p.id === req.params.id);
    if (i < 0) return fail(res, 404, 'not_found');
    const prev = store.posts[i];
    const s = settlePost(req.body, { prev, ownsImage: (k) => images.owns(k, name) });
    if (s.error) return fail(res, 400, s.error);
    const origin = urls.originOf(req, cfg);
    if (JSON.stringify(s.post) === JSON.stringify(prev)) return res.json(ownPostView(prev, origin, name));
    const changed = contentChanged(prev, s.post);
    if (changed) s.post.updated_at = clock.iso();
    store.posts[i] = s.post;
    pages.save(name, store);
    delivery.edited(prev, s.post, origin, name, { contentChanged: changed });
    res.json(ownPostView(s.post, origin, name));
  });

  router.delete('/api/posts/:id', auth.requireMember, noStore, (req, res) => {
    const name = req.member.slug;
    if (!stillMember(req)) return gone(res);
    // The one delete (lib/app.js deletePost): the admin's removal from a report
    // (P8) goes through it too.
    if (!ctx.deletePost(name, req.params.id, urls.originOf(req, cfg))) return fail(res, 404, 'not_found');
    res.json({ ok: true });
  });

  router.post('/api/posts/:id/keep', auth.requireMember, noStore, (req, res) => {
    const name = req.member.slug;
    if (!stillMember(req)) return gone(res);
    const store = pages.load(name);
    const post = store.posts.find((p) => p.id === req.params.id);
    if (!post) return fail(res, 404, 'not_found');
    const origin = urls.originOf(req, cfg);
    if (post.audience === 'public') return res.json(ownPostView(post, origin, name));   // idempotent
    if (store.enabled !== true) return fail(res, 409, 'page_off');
    const prev = { ...post };
    const lapsed = isRoomAudience(post.audience) && !ringPostLive(post, clock.now());
    post.audience = 'public';
    delete post.archived_from;
    delete post.archived_at;
    pages.save(name, store);
    // The room's crowd never follows the post out: what the ROOM GRANT allowed goes
    // (every comment; a custom face; a non-nice face from a non-friend), what any
    // Public reader could have left stays. A lapsed or archived post loses its whole
    // crowd, as the sweep would have.
    const friends = new Set(follows.friendHandles(name));
    const roomOnly = (r) => r.body !== undefined || r.custom === true || (!isNice(r.kaomoji) && !friends.has(r.author));
    reactions.removeWhere(name, (r) => r.post_id === post.id && (lapsed || prev.audience === 'archive' || roomOnly(r)));
    audit('post.kept', name, { post: post.id, from: prev.archived_from || prev.audience });
    delivery.kept(prev, post, origin, name);
    res.json(ownPostView(post, origin, name));
  });

  router.get('/api/archive', auth.requireMember, noStore, (req, res) => {
    res.json(feeds.archive({ viewer: req.member.slug, origin: urls.originOf(req, cfg) }));
  });

  return router;
};
