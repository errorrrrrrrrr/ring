'use strict';
/* ── Friends and followers (spec 3.5, 4.6, 11.1) ──────────────────────────────
 * Friendship carried on follows (lib/follows.js):
 *   GET    /api/friends                    friends, requests in and out
 *   GET    /api/friends/with/:handle       none · pending · friends
 *   POST   /api/friends {handle}           befriend (or confirm a crossing request)
 *   POST   /api/friends/:handle/confirm    only the recipient confirms
 *   DELETE /api/friends/:handle            sever, cancel or decline: either side
 *   GET    /api/followers                  one-way followers and pending requests
 *   POST   /api/followers/:handle/accept   Let follow
 *   POST   /api/followers/:handle/reject   Decline, or remove a follower
 * The lists are private (the member's own); nothing here is a read grant. A
 * `:handle` is URL-encoded. From P5 a remote account (Mastodon) can FOLLOW a
 * member: it shows among the followers and requests (named from the actor
 * cache, with its host), and Let follow, Decline and remove answer it over
 * federation (lib/federation.js). From P6 a member BEFRIENDS across servers: a
 * typed `name@host` is resolved by WebFinger (lib/actors.js lookupHandle; the
 * answer's canonical handle is the one kept), a Follow goes, and the other
 * side's Accept and Follow back make them friends; Befriend on a remote
 * follower confirms (Accept, then a Follow back). A blocked domain
 * (BLOCKED_DOMAINS) and an unresolvable handle answer the 404 an unknown name
 * does. Friend requests spend 5 a minute, 30 a day (spec 10.7).
 */
const express = require('express');
const { fail, wrap } = require('../lib/http');
const { toHandle } = require('../lib/handles');
const { blocksHandle } = require('../lib/ring');
const urls = require('../lib/urls');

module.exports = function friendRoutes(ctx) {
  const { cfg, members, pages, follows, auth, limits, stillMember, whoIs, handleLive, federation } = ctx;
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  const origin = (req) => urls.originOf(req, cfg);
  const opts = { allowPort: cfg.fedTestLoopback };

  /* A handle naming an active member of this server other than me, or (P6) a
   * remote handle this member already has a row with, or ''. */
  const other = (req, raw) => {
    const h = toHandle(raw, urls.hostOf(origin(req)), opts);
    if (!h || h === req.member.slug) return '';
    if (h.includes('@')) {
      if (!federation || federation.blockedHost(h.slice(h.indexOf('@') + 1))) return '';
      return follows.edgesOf(req.member.slug).includes(h) && handleLive(h) ? h : '';
    }
    return members.get(h)?.status === 'active' ? h : '';
  };
  /* A typed remote handle, resolved (P6): the canonical handle, or ''. */
  async function resolveRemote(raw, req) {
    const h = toHandle(raw, urls.hostOf(origin(req)), opts);
    if (!h?.includes('@') || !federation || federation.blockedHost(h.slice(h.indexOf('@') + 1))) return '';
    try {
      const rec = await federation.actors.lookupHandle(h);
      return rec?.handle && !federation.blockedHost(rec.handle.slice(rec.handle.indexOf('@') + 1)) ? rec.handle : '';
    } catch { return ''; }
  }
  const who = (req, h) => whoIs(h, origin(req));
  const answer = (res, r) => (r.error ? fail(res, r.error === 'not_found' ? 404 : 409, r.error) : res.json({ ok: true, ...r }));

  router.get('/api/friends', auth.requireMember, noStore, (req, res) => {
    const me = req.member.slug;
    const f = follows.load(me);
    const friends = new Set(follows.friendHandles(me));
    const live = (r) => handleLive(r.handle);
    res.json({
      friends: [...friends].filter((h) => handleLive(h)).map((h) => who(req, h)),
      pending_in: f.followers.filter((r) => r.state === 'pending' && live(r)).map((r) => ({ ...who(req, r.handle), at: r.at })),
      pending_out: f.following.filter((r) => !friends.has(r.handle) && live(r)).map((r) => ({ ...who(req, r.handle), at: r.at, state: r.state })),
    });
  });

  router.get('/api/friends/with/:handle', auth.requireMember, noStore, (req, res) => {
    const h = other(req, req.params.handle);
    if (!h) return res.json({ status: 'none' });
    res.json(follows.status(req.member.slug, h));
  });

  router.post('/api/friends', auth.requireMember, noStore, limits.limit('friends', { perMinute: 5, perDay: 30 }), wrap(async (req, res) => {
    const me = req.member.slug;
    const raw = req.body?.handle;
    if (typeof raw !== 'string' || !raw.trim()) return fail(res, 400, 'invalid_field');
    if (toHandle(raw, urls.hostOf(origin(req)), opts) === me) return fail(res, 400, 'own_handle');
    let h = other(req, raw);
    if (!h && raw.includes('@')) h = await resolveRemote(raw, req);
    if (!h || h === me) return fail(res, 404, 'not_found');
    // ── tick ──
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    if (blocksHandle(pages.settings(me), h)) return fail(res, 409, 'blocked_them');
    answer(res, follows.befriend(me, h, origin(req)));
  }));

  router.post('/api/friends/:handle/confirm', auth.requireMember, noStore, (req, res) => {
    const h = other(req, req.params.handle);
    if (!h) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    answer(res, follows.confirm(req.member.slug, h, origin(req)));
  });

  router.delete('/api/friends/:handle', auth.requireMember, noStore, (req, res) => {
    const h = toHandle(req.params.handle, urls.hostOf(origin(req)), opts);
    if (!h || h === req.member.slug) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    answer(res, follows.sever(req.member.slug, h, origin(req)));
  });

  router.get('/api/followers', auth.requireMember, noStore, (req, res) => {
    const me = req.member.slug;
    const f = follows.load(me);
    const friends = new Set(follows.friendHandles(me));
    const live = (r) => handleLive(r.handle);
    res.json({
      followers: f.followers.filter((r) => r.state === 'accepted' && !friends.has(r.handle) && live(r)).map((r) => ({ ...who(req, r.handle), at: r.accepted_at || r.at })),
      requests: f.followers.filter((r) => r.state === 'pending' && live(r)).map((r) => ({ ...who(req, r.handle), at: r.at })),
      open_follows: pages.settings(me).open_follows === true,
    });
  });

  router.post('/api/followers/:handle/accept', auth.requireMember, noStore, (req, res) => {
    const h = toHandle(req.params.handle, urls.hostOf(origin(req)), opts);
    if (!h) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    answer(res, follows.letFollow(req.member.slug, h, origin(req)));
  });

  router.post('/api/followers/:handle/reject', auth.requireMember, noStore, (req, res) => {
    const h = toHandle(req.params.handle, urls.hostOf(origin(req)), opts);
    if (!h) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    answer(res, follows.decline(req.member.slug, h, origin(req)));
  });

  return router;
};
