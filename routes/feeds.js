'use strict';
/* ── The square, Friends and the Inbox (spec 3.9, 11.1) ───────────────────────
 * The routes:
 *   GET  /api/feed?cursor=     the square: this server's members' public posts,
 *                              members only, 20 a page (lib/feeds.js)
 *   GET  /api/feed/friends     confirmed friends' public posts, ends at 200, `muted`
 *   GET  /api/inbox            what waits for me (lib/inbox.js)
 *   POST /api/inbox/seen       mark received stamps and comments seen
 * Members only, `private, no-store`. The archive is GET /api/archive
 * (routes/posts.js), a ring's feed GET /api/rings/:id/feed (routes/rings.js).
 */
const express = require('express');
const { fail } = require('../lib/http');
const urls = require('../lib/urls');

module.exports = function feedRoutes(ctx) {
  const { cfg, feeds, inbox, auth, stillMember } = ctx;
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  const origin = (req) => urls.originOf(req, cfg);

  router.get('/api/feed', auth.requireMember, noStore, (req, res) => {
    res.json(feeds.square({ viewer: req.member.slug, cursor: req.query.cursor, origin: origin(req) }));
  });

  router.get('/api/feed/friends', auth.requireMember, noStore, (req, res) => {
    res.json(feeds.friends({ viewer: req.member.slug, origin: origin(req) }));
  });

  router.get('/api/inbox', auth.requireMember, noStore, (req, res) => {
    res.json(inbox.view(req.member.slug, origin(req)));
  });

  router.post('/api/inbox/seen', auth.requireMember, noStore, (req, res) => {
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    res.json({ ok: true, marked: inbox.markSeen(req.member.slug) });
  });

  return router;
};
