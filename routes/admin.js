'use strict';
/* ── The server admin's API (spec 6.3, 11.1; P8) ──────────────────────────────
 * Every route is `A`: a signed-in ACTIVE admin (lib/auth.js requireAdmin: 401
 * signed out, 403 `forbidden` for anyone else), behind the same session, CSRF
 * check, JSON-only rule and headers as the rest of /api, never cached, and on
 * one budget (60 a minute, 2000 a day per admin). The page itself is /admin
 * (routes/app.js), the same bundle's lazy chunk.
 *
 *   GET  /api/admin/reports                 the queue, open first, newest first,
 *                                           a PAGE at a time (P8 review F3):
 *                                           ?state=open|closed|all (all),
 *                                           ?limit (50, at most 200), ?cursor
 *                                           (the `next` of the page before)
 *                                           -> { reports, next }
 *   POST /api/admin/reports/:id             { action, note }: dismiss, resolve,
 *                                           remove_post, remove_comment,
 *                                           remove_stamp, suspend, block_actor,
 *                                           block_domain (each closes the report
 *                                           as resolved, with the note), forward
 *                                           (sends the Flag; the report stays
 *                                           open); a CLOSED report refuses every
 *                                           action (409 report_closed) but
 *                                           `reopen`
 *   GET  /api/admin/domain-blocks           the list (private: hosts, reasons)
 *   POST /api/admin/domain-blocks           { host, reason } -> 201
 *   DELETE /api/admin/domain-blocks/:host
 *   GET  /api/admin/actor-blocks            server-wide person blocks
 *   POST /api/admin/actor-blocks            { handle, reason } -> 201 (the actor is
 *                                           looked up first when this server does
 *                                           not know it; an unreachable one is
 *                                           blocked by handle)
 *   DELETE /api/admin/actor-blocks/:handle
 *   GET  /api/admin/members                 every account, with role and status
 *   POST /api/admin/members/:name           { action: suspend, unsuspend,
 *                                           make_admin, step_down (oneself) }
 *   GET  /api/admin/federation              failing and unavailable hosts, the
 *                                           queue's depth, the origin and
 *                                           federated_at (ops readouts, not
 *                                           social counts)
 *   POST /api/admin/federation/hosts/:host/clear
 *   GET  /api/admin/signups                 the signup door's counts (10.11):
 *                                           names no address
 *   POST /api/admin/signups                 { action: release, email } or
 *                                           { action: clear }; the same answer
 *                                           whether or not anything was held
 * A decision's effects are lib/moderate.js's; this file only reads the body,
 * checks what the target is, and answers.
 */
const express = require('express');
const { fail, wrap } = require('../lib/http');
const { toHandle, normalizeHost } = require('../lib/handles');
const { normEmail, validEmail } = require('./auth');
const urls = require('../lib/urls');

const REPORT_ACTIONS = new Set(['dismiss', 'resolve', 'remove_post', 'remove_comment', 'remove_stamp', 'suspend', 'block_actor', 'block_domain', 'forward', 'reopen']);
const REPORT_STATES = new Set(['open', 'closed', 'all']);
const MEMBER_ACTIONS = new Set(['suspend', 'unsuspend', 'make_admin', 'step_down']);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const hostOfHandle = (h) => (h.includes('@') ? h.slice(h.indexOf('@') + 1) : '');
const decode = (s) => { try { return decodeURIComponent(s); } catch { return ''; } };

module.exports = function adminRoutes(ctx) {
  const { cfg, members, invites, auth, limits, moderation, moderate, instance, signupGuard } = ctx;
  const router = express.Router();
  const guard = [
    auth.requireAdmin,
    (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); },
    limits.limit('admin', { perMinute: 60, perDay: 2000 }),
  ];
  const by = (req) => req.member.slug;
  /* Asked again after an await (a lookup): still signed in, active, admin. */
  const stillAdmin = (req) => ctx.stillMember(req) && members.get(req.member.slug)?.role === 'admin';
  const originOf = (req) => urls.originOf(req, cfg);
  const opts = { allowPort: cfg.fedTestLoopback };

  /* How the queue shows a handle: a member here, or a remote actor. */
  function who(handle, origin) {
    if (!handle) return null;
    if (!handle.includes('@')) {
      const m = members.get(handle);
      return { handle, name: m?.display_name || handle, local: true, status: m ? m.status : 'gone', url: urls.pageUrl(origin, handle) };
    }
    const v = ctx.federation ? ctx.federation.actors.view(handle) : null;
    return { handle, name: v?.name || handle, local: false, host: hostOfHandle(handle), url: v?.url || '', blocked: moderation.handleBlocked(handle) };
  }
  const reportView = (r, origin) => ({ ...r, target_view: who(r.target, origin), from_view: r.remote ? { host: r.from, actor: r.actor || '' } : who(r.from, origin) });

  // ── reports ──

  router.get('/api/admin/reports', ...guard, (req, res) => {
    const origin = originOf(req);
    const q = req.query || {};
    const state = typeof q.state === 'string' && REPORT_STATES.has(q.state) ? q.state : 'all';
    const limit = /^\d{1,3}$/.test(String(q.limit ?? '')) ? Number(q.limit) : undefined;
    const page = moderation.pageReports({ state, cursor: typeof q.cursor === 'string' ? q.cursor : '', limit });
    if (!page) return fail(res, 400, 'bad_request');
    res.json({ reports: page.rows.map((r) => reportView(r, origin)), next: page.next });
  });

  router.post('/api/admin/reports/:id', ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    const action = b.action;
    if (!REPORT_ACTIONS.has(action)) return fail(res, 400, 'bad_request');
    if (b.note !== undefined && typeof b.note !== 'string') return fail(res, 400, 'bad_request');
    let row = moderation.getReport(String(req.params.id));
    if (!row) return fail(res, 404, 'not_found');
    const origin = originOf(req);
    const note = str(b.note, 1000);
    if (action === 'reopen') {
      if (row.state === 'open') return fail(res, 409, 'report_open');
      return res.json({ report: reportView(moderate.reopenReport(row.id, { by: by(req) }), origin) });
    }
    // A closed report is closed: no action but reopen (P8 review).
    if (row.state !== 'open') return fail(res, 409, 'report_closed');
    const remoteTarget = row.target.includes('@');
    let rec = null;
    if (action === 'block_actor' && remoteTarget && ctx.federation) {
      // Learn the actor's id and inbox first (a fetch) when not cached.
      try { rec = await ctx.federation.actors.lookupHandle(row.target); } catch { rec = null; }
      // ── tick: the awaits are over; who asks and what they ask about, again ──
      if (!stillAdmin(req)) return fail(res, 403, 'forbidden');
      row = moderation.getReport(row.id);
      if (!row) return fail(res, 404, 'not_found');
      if (row.state !== 'open') return fail(res, 409, 'report_closed');
    }
    // ── tick ──
    switch (action) {
      case 'dismiss': case 'resolve':
        break;
      case 'remove_post':
        if (!moderate.removeReportedPost(row.id, { by: by(req), origin })) return fail(res, 409, 'nothing_to_remove');
        break;
      case 'remove_comment': case 'remove_stamp':
        if (row.kind !== (action === 'remove_comment' ? 'comment' : 'stamp')) return fail(res, 409, 'nothing_to_remove');
        if (!moderate.removeReportedReaction(row.id, { by: by(req), origin })) return fail(res, 409, 'nothing_to_remove');
        break;
      case 'suspend': {
        if (remoteTarget) return fail(res, 400, 'not_local');
        const r = moderate.setStatus(row.target, 'suspended', { by: by(req) });
        if (r.error) return fail(res, r.status, r.error);
        break;
      }
      case 'block_actor': {
        if (!remoteTarget) return fail(res, 400, 'not_remote');
        const r = moderate.blockActor(row.target, { by: by(req), origin, rec, reason: note });
        if (r.error) return fail(res, 400, r.error);
        break;
      }
      case 'block_domain': {
        if (!remoteTarget) return fail(res, 400, 'not_remote');
        const r = moderate.blockDomain(hostOfHandle(row.target), { by: by(req), origin, reason: note });
        if (r.error) return fail(res, r.error === 'block_limit' ? 409 : 400, r.error);
        break;
      }
      case 'forward': {
        if (!remoteTarget || row.remote) return fail(res, 400, 'not_remote');
        if (row.forwarded) return fail(res, 409, 'already_forwarded');
        if (!moderate.forwardReport(row.id, { by: by(req), origin })) return fail(res, 409, 'not_forwardable');
        return res.json({ report: reportView(moderation.getReport(row.id), origin) });
      }
      default:
        return fail(res, 400, 'bad_request');
    }
    const state = action === 'dismiss' ? 'dismissed' : 'resolved';
    const done = moderate.closeReport(row.id, state, { by: by(req), note: note || (action === 'dismiss' || action === 'resolve' ? '' : action) });
    res.json({ report: reportView(done, origin) });
  }));

  // ── domain blocks ──

  router.get('/api/admin/domain-blocks', ...guard, (req, res) => {
    res.json({ blocks: moderation.listDomains().reverse() });
  });
  router.post('/api/admin/domain-blocks', ...guard, (req, res) => {
    const b = req.body || {};
    if (typeof b.host !== 'string' || (b.reason !== undefined && typeof b.reason !== 'string')) return fail(res, 400, 'bad_request');
    const raw = b.host.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const r = moderate.blockDomain(raw, { reason: b.reason || '', by: by(req), origin: originOf(req) });
    if (r.error) return fail(res, r.error === 'block_limit' ? 409 : 400, r.error);
    res.status(r.added ? 201 : 200).json(r);
  });
  router.delete('/api/admin/domain-blocks/:host', ...guard, (req, res) => {
    const host = normalizeHost(decode(req.params.host), { allowPort: true, allowIp: true });
    if (!host || !moderate.unblockDomain(host, { by: by(req) })) return fail(res, 404, 'not_found');
    res.json({ ok: true });
  });

  // ── actor blocks ──

  router.get('/api/admin/actor-blocks', ...guard, (req, res) => {
    res.json({ blocks: moderation.listActors().reverse().map(({ inbox: _inbox, ...b }) => b) });
  });
  router.post('/api/admin/actor-blocks', ...guard, wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.handle !== 'string' || (b.reason !== undefined && typeof b.reason !== 'string')) return fail(res, 400, 'bad_request');
    const origin = originOf(req);
    const handle = toHandle(b.handle, urls.hostOf(origin), opts);
    if (!handle) return fail(res, 400, 'handle_invalid');
    if (!handle.includes('@')) return fail(res, 400, 'not_remote');
    let rec = null;
    if (ctx.federation && !moderation.hostBlocked(hostOfHandle(handle))) {
      try { rec = await ctx.federation.actors.lookupHandle(handle); } catch { rec = null; }
      // The awaits are over: still an active admin (P8 review)?
      if (!stillAdmin(req)) return fail(res, 403, 'forbidden');
    }
    // ── tick ──
    const r = moderate.blockActor(rec?.handle || handle, { reason: b.reason || '', by: by(req), origin, rec });
    if (r.error) return fail(res, r.error === 'block_limit' ? 409 : 400, r.error);
    res.status(r.added ? 201 : 200).json(r);
  }));
  router.delete('/api/admin/actor-blocks/:handle', ...guard, (req, res) => {
    const handle = decode(req.params.handle);
    if (!handle || !moderate.unblockActor(handle, { by: by(req) })) return fail(res, 404, 'not_found');
    res.json({ ok: true });
  });

  // ── members ──

  const memberView = (m) => ({
    name: m.slug, display_name: m.display_name, email: m.email, role: m.role, status: m.status,
    created_at: m.created_at, invited_by: m.invited_by || null, invites_live: invites.liveCount(m.slug),
  });
  router.get('/api/admin/members', ...guard, (req, res) => {
    res.json({ members: members.all().map(memberView), invites_per_member: cfg.invitesPerMember, signup: cfg.signup });
  });
  router.post('/api/admin/members/:name', ...guard, (req, res) => {
    const action = req.body?.action;
    if (!MEMBER_ACTIONS.has(action)) return fail(res, 400, 'bad_request');
    const name = String(req.params.name);
    if (action === 'step_down' && name !== by(req)) return fail(res, 403, 'forbidden');
    const r = action === 'suspend' ? moderate.setStatus(name, 'suspended', { by: by(req) })
      : action === 'unsuspend' ? moderate.setStatus(name, 'active', { by: by(req) })
      : moderate.setRole(name, action === 'make_admin' ? 'admin' : 'member', { by: by(req) });
    if (r.error) return fail(res, r.status, r.error);
    res.json({ member: memberView(r.member) });
  });

  // ── federation (ops readouts) ──

  router.get('/api/admin/federation', ...guard, (req, res) => {
    const f = ctx.federation;
    const hosts = [];
    if (f) {
      for (const [host, r] of Object.entries(f.hosts.all())) {
        if (!r.failing_since && !r.unavailable) continue;
        hosts.push({ host, failing_since: r.failing_since || '', unavailable: r.unavailable === true, last_success_at: r.last_success_at || '', software: r.software || '' });
      }
      hosts.sort((a, b) => (a.failing_since < b.failing_since ? -1 : 1));
    }
    res.json({
      federation: !!f, origin: instance.origin || cfg.publicOrigin || '', federated_at: instance.federated_at || '',
      queue_depth: f ? f.queue.depth() : 0, hosts: hosts.slice(0, 200), hosts_total: hosts.length,
    });
  });
  router.post('/api/admin/federation/hosts/:host/clear', ...guard, (req, res) => {
    const f = ctx.federation;
    const host = normalizeHost(decode(req.params.host), { allowPort: true });
    if (!f || !host || !f.hosts.get(host)) return fail(res, 404, 'not_found');
    f.hosts.clear(host);
    ctx.audit('federation.host_cleared', by(req), { host });
    res.json({ ok: true });
  });

  // ── the signup door (10.11) ──

  router.get('/api/admin/signups', ...guard, (req, res) => res.json(signupGuard.stats()));
  router.post('/api/admin/signups', ...guard, (req, res) => {
    const b = req.body || {};
    if (b.action === 'clear') {
      signupGuard.clear();
      ctx.audit('signups.cleared', by(req));
      return res.json({ ok: true, ...signupGuard.stats() });
    }
    if (b.action !== 'release') return fail(res, 400, 'bad_request');
    const email = normEmail(b.email);
    if (!validEmail(email)) return fail(res, 400, 'email_invalid');
    signupGuard.release(email);
    ctx.audit('signups.released', by(req));   // the address itself is not logged
    res.json({ ok: true, ...signupGuard.stats() });
  });

  return router;
};
