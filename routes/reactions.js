'use strict';
/* ── Stamps and comments on a wall's posts (spec 3.7, 11.1) ───────────────────
 * The target is a path, not a host:
 *   POST   /api/pages/:name/posts/:id/stamp {kaomoji}   press, toggle, replace
 *   DELETE /api/pages/:name/posts/:id/stamp/:sid        author or owner, else opaque 404
 *   POST   /api/pages/:name/posts/:id/comment {body}    confirmed friends only
 *   DELETE /api/pages/:name/posts/:id/comment/:cid      author or owner, else opaque 404
 * The rules live in lib/stamps.js and lib/comments.js (the post's own server is
 * the authority, applied through the inbound registry). You can only react to
 * what you can see (lib/audience.js): a post you may not see, a lapsed room post
 * and an unknown one are the same 404. Stamps spend 20 a minute and 200 a day,
 * comments 6 and 100 (spec 10.7). Every write asks stillMember in its tick.
 */
const express = require('express');
const { fail } = require('../lib/http');
const { validName } = require('../lib/handles');
const { POST_ID_RE } = require('../lib/ids');
const urls = require('../lib/urls');

module.exports = function reactionRoutes(ctx) {
  const { cfg, stamps, comments, auth, limits, stillMember } = ctx;
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  const target = (req) => {
    const owner = String(req.params.name || '');
    const postId = String(req.params.id || '');
    return validName(owner) && POST_ID_RE.test(postId) ? { owner, postId } : null;
  };
  const relay = (res, r) => fail(res, r.status, r.error || 'not_found');
  const base = '/api/pages/:name/posts/:id';

  router.post(`${base}/stamp`, auth.requireMember, noStore, limits.limit('stamp', { perMinute: 20, perDay: 200 }), (req, res) => {
    const t = target(req);
    if (!t) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    const origin = urls.originOf(req, cfg);
    const r = stamps.press({ me: req.member.slug, ...t, rawFace: req.body?.kaomoji, origin });
    if (r.status >= 400) return relay(res, r);
    const list = stamps.viewsFor(t.owner, t.postId, origin);
    const mine = list.find((s) => s.author.handle === req.member.slug);
    res.json({ ok: true, action: r.action, stamps: list, mine: r.action === 'removed' ? '' : (mine?.kaomoji || '') });
  });

  router.delete(`${base}/stamp/:sid`, auth.requireMember, noStore, (req, res) => {
    const t = target(req);
    if (!t) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    const r = stamps.takeBack({ me: req.member.slug, ...t, stampId: String(req.params.sid), origin: urls.originOf(req, cfg) });
    if (r.status >= 400) return relay(res, r);
    res.json({ ok: true });
  });

  router.post(`${base}/comment`, auth.requireMember, noStore, limits.limit('comment', { perMinute: 6, perDay: 100 }), (req, res) => {
    const t = target(req);
    if (!t) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    const origin = urls.originOf(req, cfg);
    const r = comments.write({ me: req.member.slug, ...t, body: req.body?.body, origin });
    if (r.status >= 400) return relay(res, r);
    res.json({ ok: true, comments: comments.viewsFor(t.owner, t.postId, origin) });
  });

  router.delete(`${base}/comment/:cid`, auth.requireMember, noStore, (req, res) => {
    const t = target(req);
    if (!t) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    const r = comments.takeBack({ me: req.member.slug, ...t, commentId: String(req.params.cid), origin: urls.originOf(req, cfg) });
    if (r.status >= 400) return relay(res, r);
    res.json({ ok: true });
  });

  return router;
};
