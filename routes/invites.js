'use strict';
/* ── Invites (spec 11.1) ──────────────────────────────────────────────────────
 *   GET /api/invites          the member's invites, live, used and expired
 *   POST /api/invites         mint: at most INVITES_PER_MEMBER live, 10 a day
 *   DELETE /api/invites/:id   revoke a live one of your own (anything else 404)
 * Rules of the row: lib/invites.js.
 */
const express = require('express');
const { fail } = require('../lib/http');
const urls = require('../lib/urls');

module.exports = function inviteRoutes(ctx) {
  const { cfg, invites, auth, limits, audit } = ctx;
  const router = express.Router();

  const view = (r, origin) => ({
    id: r.id,
    code: r.code,
    url: `${origin}/signup?invite=${encodeURIComponent(r.code)}`,
    state: invites.stateOf(r),
    created_at: r.created_at,
    expires_at: r.expires_at,
    used_by: r.used_by || null,
    used_at: r.used_at || null,
  });

  router.get('/api/invites', auth.requireMember, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const origin = urls.originOf(req, cfg);
    const mine = invites.listFor(req.member.slug).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    res.json({
      invites: mine.map((r) => view(r, origin)),
      live: invites.liveCount(req.member.slug),
      limit: cfg.invitesPerMember,
    });
  });

  router.post('/api/invites', auth.requireMember, limits.limit('invite', { perMinute: 10, perDay: 10 }), (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (cfg.invitesPerMember === 0) return fail(res, 403, 'invites_off');
    const me = req.member.slug;
    if (invites.liveCount(me) >= cfg.invitesPerMember) return fail(res, 409, 'invite_limit', { n: cfg.invitesPerMember });
    const row = invites.mint(me);
    audit('invite.minted', me, { invite: row.id });
    res.status(201).json(view(row, urls.originOf(req, cfg)));
  });

  router.delete('/api/invites/:id', auth.requireMember, (req, res) => {
    if (!invites.revoke(String(req.params.id), req.member.slug)) return fail(res, 404, 'not_found');
    audit('invite.revoked', req.member.slug, { invite: req.params.id });
    res.json({ ok: true });
  });

  return router;
};
