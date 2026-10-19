'use strict';
/* ── Named rings (spec 3.6, 4.7, 11.1) ────────────────────────────────────────
 * Each write is an activity to the ring's Group, decided
 * by its home (lib/groups.js). Non-members get one opaque 404 on every ring
 * route: a ring's existence is its members' business. A request from a handle
 * the viewer blocks is left out of THEIR view (and their inbox and dot), as if it
 * never came: it stays the asker's unanswered request (spec 6.1).
 *   GET    /api/rings                         my rings
 *   POST   /api/rings {name}                  create (5 a minute, 30 a day); a link comes with it
 *   PATCH  /api/rings/:id {name}              rename, any member
 *   POST   /api/rings/:id/link                rotate, any member
 *   DELETE /api/rings/:id/link                switch it off, any member
 *                                             (rename, rotate and off share ONE
 *                                             budget, 10 a minute, 60 a day: each
 *                                             rewrites rings.json and the audit)
 *   GET    /api/rings/join/:code              what a live code opens: name, who offers,
 *                                             how full (a count, never the members)
 *   POST   /api/rings/join/:code              ask (10 a minute, 60 a day): a request, not a seat
 *   POST   /api/rings/join {url}              ask by a pasted link: this server's, or
 *                                             (P7) another Ring server's: the Join
 *                                             goes from here, the answer comes later
 * P7: a ring may hold members of other servers (their handles `name@host`, each
 * shown with its host) and may be hosted elsewhere (a REPLICA: its acts go to
 * its Group, whose home decides, lib/ring-fed.js). `hosts` lists every server
 * that holds the room: the trust notice names them.
 *   POST   /api/rings/:id/requests/:handle {approve}   any member (30 a minute,
 *                                             300 a day); a KICKED handle only by
 *                                             the creator (403 ring_creator_only)
 *   POST   /api/rings/:id/leave               any member
 *   DELETE /api/rings/:id/members/:handle     kick: the creator
 *   DELETE /api/rings/:id                     delete: the creator
 *   GET    /api/rings/:id/feed                the room (lib/feeds.js), ends at 200
 */
const express = require('express');
const clock = require('../lib/clock');
const { fail, wrap } = require('../lib/http');
const { toHandle } = require('../lib/handles');
const { RING_ID_RE } = require('../lib/ids');
const R = require('../lib/rings');
const { blocksHandle } = require('../lib/ring');
const urls = require('../lib/urls');

module.exports = function ringRoutes(ctx) {
  const { cfg, members, pages, ringStore, groups, feeds, auth, limits, stillMember, whoIs, ringFed } = ctx;
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  const origin = (req) => urls.originOf(req, cfg);
  const relay = (res, r) => fail(res, r.status, r.error || 'not_found');
  const nameOf = (h) => members.get(h)?.display_name || h;

  /* How a ring shows a handle: a member here, or (P7) a member of another
   * server named from the actor cache, with the host it is on. */
  const person = (h, o) => {
    if (!h.includes('@')) return { handle: h, name: nameOf(h), url: urls.pageUrl(o, h), host: urls.hostOf(o) };
    const w = whoIs(h, o);
    return { handle: h, name: w.name || h, url: w.url || '', host: h.slice(h.indexOf('@') + 1), remote: true };
  };
  /* A member's view of their own ring. `hosts`: every server that holds the
   * room (spec 4.7, the trust notice); `home`: the server that hosts its Group. */
  function ringView(r, me, req) {
    const o = origin(req);
    const live = r.home ? R.joinLinkLive(r, clock.now()) : !!r.join_url && Date.parse(r.join_expires || 0) > clock.now();
    const mine = pages.settings(me);
    let homeHost = urls.hostOf(o);
    try { if (!r.home) homeHost = new URL(r.ap_id).host; } catch { /* keep */ }
    return {
      id: r.id, name: r.name, created_by: r.created_by, created_at: r.created_at, mine: r.created_by === me, rev: r.rev,
      home: r.home, home_host: homeHost,
      members: r.members.map((m) => ({ ...person(m.handle, o), joined_at: m.joined_at })),
      requests: r.requests.filter((q) => !blocksHandle(mine, q.handle)).map((q) => ({
        ...person(q.handle, o), asked_at: q.asked_at, ...(R.wasKicked(r, q.handle) ? { kicked: true } : {}),
      })),
      join: !live ? null : r.home
        ? { url: urls.joinUrl(o, r.join.code), code: r.join.code, expires_at: r.join.expires_at }
        : { url: r.join_url, code: r.join_url.split('/').pop(), expires_at: r.join_expires },
      full: R.ringIsFull(r),
      hosts: R.hostsOf(r, urls.hostOf(o)),
    };
  }

  /* The ring this caller belongs to, or the opaque 404 (answered here). */
  function memberRing(req, res) {
    const id = String(req.params.id || '');
    const ring = RING_ID_RE.test(id) ? ringStore.get(id) : null;
    if (!ring || !R.isMember(ring, req.member.slug)) { fail(res, 404, 'not_found'); return null; }
    return ring;
  }
  const after = (req, res, r, id) => {
    if (r.status >= 400) return relay(res, r);
    const ring = ringStore.get(id);
    if (!ring || !R.isMember(ring, req.member.slug)) return res.json({ ok: true });
    res.json(ringView(ring, req.member.slug, req));
  };
  const gone = (res) => fail(res, 401, 'not_signed_in');

  router.get('/api/rings', auth.requireMember, noStore, (req, res) => {
    const me = req.member.slug;
    res.json({ rings: R.ringsOf(ringStore.load(), me).map((r) => ringView(r, me, req)), max_members: R.RING_MAX_MEMBERS, max_rings: R.RING_MAX_PER_MEMBER });
  });

  router.post('/api/rings', auth.requireMember, noStore, limits.limit('rings', { perMinute: 5, perDay: 30 }), (req, res) => {
    if (!stillMember(req)) return gone(res);
    const r = groups.create(req.member.slug, req.body?.name, origin(req));
    if (r.status >= 400) return relay(res, r);
    res.status(201).json(ringView(r.ring, req.member.slug, req));
  });

  // The join routes first: `join` is never a ring id.
  const preview = limits.limit('ringjoin', { perMinute: 20, perDay: 200 });
  const askLimit = limits.limit('ringask', { perMinute: 10, perDay: 60 });

  router.get('/api/rings/join/:code', auth.requireMember, noStore, preview, (req, res) => {
    const me = req.member.slug;
    const rings = ringStore.load();
    const ring = R.ringByJoinCode(rings, String(req.params.code || ''), clock.now());
    if (!ring) return fail(res, 404, 'not_found');
    res.json({
      name: ring.name,
      offered_by: nameOf(ring.join.created_by),
      members: R.ringOccupancy(ring),
      max_members: R.RING_MAX_MEMBERS,
      already_member: R.isMember(ring, me),
      requested: R.hasRequested(ring, me),
      full: R.ringIsFull(ring),
      at_my_cap: R.ringsOf(rings, me).length >= R.RING_MAX_PER_MEMBER,
      hosts: R.hostsOf(ring, urls.hostOf(origin(req))),
    });
  });

  function ask(req, res, code) {
    if (!stillMember(req)) return gone(res);
    const me = req.member.slug;
    const r = groups.ask(me, code, origin(req));
    if (r.status >= 400) return relay(res, r);
    if (r.member) return res.json(ringView(ringStore.get(r.ring.id), me, req));
    res.json({ requested: true, name: r.ring.name });
  }

  router.post('/api/rings/join/:code', auth.requireMember, noStore, askLimit, (req, res) => ask(req, res, String(req.params.code || '')));

  router.post('/api/rings/join', auth.requireMember, noStore, askLimit, wrap(async (req, res) => {
    const raw = typeof req.body?.url === 'string' ? req.body.url.trim().slice(0, 2000) : '';
    const l = urls.parseLocal(raw, origin(req));
    if (l?.kind === 'join') return ask(req, res, l.id);
    // P7: a join link of ANOTHER Ring server: read, checked, and the Join sent
    // from here (lib/ring-fed.js askRemote: Ring servers only, never a blocked
    // domain, the 3-ring cap first).
    if (!ringFed || !/^https?:\/\//i.test(raw)) return fail(res, 404, 'not_found');
    const me = req.member.slug;
    const r = await ringFed.askRemote(me, raw);
    if (!stillMember(req)) return gone(res);
    if (r.status >= 400) return relay(res, r);
    if (r.member) return res.json(ringView(r.ring, me, req));
    res.json({ requested: true, name: r.ring.name, remote: true });
  }));

  // Rename, rotate and switch-off: one bucket (each rewrites rings.json and the audit).
  const linkLimit = limits.limit('ringlink', { perMinute: 10, perDay: 60 });
  const answerLimit = limits.limit('ringanswer', { perMinute: 30, perDay: 300 });

  router.patch('/api/rings/:id', auth.requireMember, noStore, linkLimit, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    if (!stillMember(req)) return gone(res);
    if (typeof req.body?.name !== 'string') return fail(res, 400, 'ring_name_required');
    after(req, res, groups.rename(req.member.slug, ring.id, req.body.name, origin(req)), ring.id);
  });

  router.post('/api/rings/:id/link', auth.requireMember, noStore, linkLimit, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    if (!stillMember(req)) return gone(res);
    after(req, res, groups.link(req.member.slug, ring.id, 'rotate', origin(req)), ring.id);
  });

  router.delete('/api/rings/:id/link', auth.requireMember, noStore, linkLimit, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    if (!stillMember(req)) return gone(res);
    after(req, res, groups.link(req.member.slug, ring.id, 'off', origin(req)), ring.id);
  });

  router.post('/api/rings/:id/requests/:handle', auth.requireMember, noStore, answerLimit, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    if (!stillMember(req)) return gone(res);
    const who = toHandle(req.params.handle, urls.hostOf(origin(req)), { allowPort: cfg.fedTestLoopback });
    const approve = req.body?.approve === true;
    const r = groups.answer(req.member.slug, ring.id, who, approve, origin(req));
    if (r.status >= 400) return relay(res, r);
    if (approve && !r.admitted) return fail(res, 400, 'ring_limit_them');   // their server left at once: at their cap
    after(req, res, r, ring.id);
  });

  router.post('/api/rings/:id/leave', auth.requireMember, noStore, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    if (!stillMember(req)) return gone(res);
    const r = groups.leave(req.member.slug, ring.id, origin(req));
    if (r.status >= 400) return relay(res, r);
    res.json({ ok: true, dissolved: !!r.dissolved });
  });

  router.delete('/api/rings/:id/members/:handle', auth.requireMember, noStore, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    if (!stillMember(req)) return gone(res);
    const who = toHandle(req.params.handle, urls.hostOf(origin(req)), { allowPort: cfg.fedTestLoopback });
    if (!who) return fail(res, 404, 'not_found');
    after(req, res, groups.kick(req.member.slug, ring.id, who, origin(req)), ring.id);
  });

  router.delete('/api/rings/:id', auth.requireMember, noStore, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    if (!stillMember(req)) return gone(res);
    const r = groups.destroy(req.member.slug, ring.id, origin(req));
    if (r.status >= 400) return relay(res, r);
    res.json({ ok: true });
  });

  router.get('/api/rings/:id/feed', auth.requireMember, noStore, (req, res) => {
    const ring = memberRing(req, res);
    if (!ring) return;
    res.json(feeds.ring({ ring, viewer: req.member.slug, origin: origin(req) }));
  });

  return router;
};
