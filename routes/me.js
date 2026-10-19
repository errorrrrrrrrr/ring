'use strict';
/* ── The member's own account and page settings (spec 11.1) ───────────────────
 *   GET/PATCH /api/me           profile, role, page switches; { display_name }
 *   POST /api/me/password       { current, next }: ends the OTHER sessions and
 *                               voids every outstanding reset link
 *   DELETE /api/me              { password }: the local purge (spec 11.4), every
 *                               session ended, the name retired
 *   GET/PUT /api/me/page        the raw page store; the settable fields
 *
 * The purge (lib/purge.js) is the one place a member's traces are listed.
 *
 * P5: a change to what the Person shows (display name, bio, avatar, links,
 * theme, the switches, page on or off, indexable, open_follows) sends
 * Update{Person} to the followers' servers (ctx.profileChanged; spec 4.9). A
 * block list change shows nothing on the Person; a block (of a person, or of a
 * domain: every follow with a handle it matches) ends the follows between them
 * both ways with Undo and Reject (spec 6.1), and sends nothing else.
 *
 * A password check awaits bcrypt, so the row can change underneath it (a reset
 * redeemed meanwhile). The tick after the awaits re-reads the row and answers 409
 * password_changed unless the hash and this session are still current: a stale
 * check never overwrites a reset, nor deletes an account (robustness-r1-03).
 */
const express = require('express');
const { fail, wrap } = require('../lib/http');
const { t } = require('../lib/strings');
const { plainLine, settlePageInput, blocksHandle, MAX_BLOCKED, MAX_BLOCKED_DOMAINS } = require('../lib/ring');
const { toHandle, normalizeHost } = require('../lib/handles');
const { hashPassword, verifyPassword, passwordProblem } = require('../lib/auth');
const urls = require('../lib/urls');

module.exports = function meRoutes(ctx) {
  const { cfg, members, pages, images, auth, limits, audit, meView, ownPostView, purge, resets, cookieName, reactions, follows, profileChanged } = ctx;
  const PERSON_FIELDS = ['enabled', 'indexable', 'open_follows', 'stamps_off', 'comments_off', 'theme', 'bio', 'avatar_key', 'links'];
  const personSig = (store) => JSON.stringify(PERSON_FIELDS.map((k) => store[k]));
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };

  /* Still the row the password was checked against, and still a live session? */
  const stillCurrent = (req, m) => {
    const fresh = members.get(m.slug);
    if (!fresh || fresh.password_hash !== m.password_hash) return false;
    const cutoff = fresh.sessions_from ? Date.parse(fresh.sessions_from) : 0;
    return (Number(req.session?.at) || 0) >= cutoff;
  };

  router.get('/api/me', auth.requireMember, noStore, (req, res) => {
    res.json(meView(req.member.slug, req));
  });

  // Each settings write is a full fsync'd rewrite (and maybe an audit line): bounded (robustness-r1-11).
  const settingsLimit = limits.limit('settings', { perMinute: 60, perDay: 1000 });

  router.patch('/api/me', auth.requireMember, noStore, settingsLimit, (req, res) => {
    const b = req.body || {};
    if (b.display_name !== undefined) {
      const name = typeof b.display_name === 'string' ? plainLine(b.display_name, 60) : '';
      if (!name) return fail(res, 400, 'display_name_invalid');
      const was = members.get(req.member.slug)?.display_name;
      members.update(req.member.slug, { display_name: name });   // drops the projection
      if (was !== name) profileChanged(req.member.slug);
    }
    res.json(meView(req.member.slug, req));
  });

  router.post('/api/me/password', auth.requireMember, noStore, limits.limit('password', { perMinute: 5, perDay: 30 }), wrap(async (req, res) => {
    const b = req.body || {};
    const problem = passwordProblem(b.next);
    if (problem) return fail(res, 400, problem);
    const m = members.get(req.member.slug);
    if (!(await verifyPassword(b.current, m.password_hash))) return fail(res, 403, 'wrong_password');
    const hash = await hashPassword(b.next);
    // ── tick ──
    if (!stillCurrent(req, m)) return fail(res, 409, 'password_changed');
    members.update(m.slug, { password_hash: hash });
    resets.removeWhere((r) => r.slug === m.slug);   // a link mailed earlier redeems nothing now
    auth.endSessions(m.slug, req);   // the others end, this one stays
    audit('password.changed', m.slug);
    res.json({ ok: true });
  }));

  router.delete('/api/me', auth.requireMember, noStore, limits.limit('password', { perMinute: 5, perDay: 30 }), wrap(async (req, res) => {
    const m = members.get(req.member.slug);
    if (!(await verifyPassword(req.body?.password, m.password_hash))) return fail(res, 403, 'wrong_password');
    // ── tick ──
    if (!stillCurrent(req, m)) return fail(res, 409, 'password_changed');
    if (m.role === 'admin' && members.admins().length === 1 && members.count() > 1) return fail(res, 409, 'last_admin');
    purge(m.slug, { origin: urls.originOf(req, cfg) });
    await auth.logout(req);
    res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: cfg.production, path: '/' });
    res.json({ ok: true });
  }));

  router.get('/api/me/page', auth.requireMember, noStore, (req, res) => {
    const name = req.member.slug;
    const store = pages.load(name);
    const origin = urls.originOf(req, cfg);
    // `shown_tracked` is the store's own bookkeeping (lib/ring.js, N10), never the client's.
    const { shown_tracked: _bookkeeping, ...view } = store;
    res.json({ ...view, posts: store.posts.map((p) => ownPostView(p, origin, name)) });
  });

  router.put('/api/me/page', auth.requireMember, noStore, settingsLimit, (req, res) => {
    const name = req.member.slug;
    const b = req.body || {};
    // The session was read before the body arrived: still a member, now? (robustness-r1-02)
    if (!ctx.stillMember(req)) return fail(res, 401, 'not_signed_in');
    const store = pages.load(name);
    const settled = settlePageInput(b, store, { ownsImage: (k) => images.owns(k, name) });
    if (settled.error) return res.status(400).json({ error: settled.error, field: settled.field, message: t(settled.error) });
    const next = settled.store;
    const host = urls.hostOf(urls.originOf(req, cfg));
    const opts = { allowPort: cfg.fedTestLoopback };

    // The block lists hold handles and hosts (spec 3.3, 6.1).
    let blocked = '';
    if (b.block !== undefined) {
      const h = toHandle(b.block, host, opts);
      if (!h || h === name) return fail(res, 400, 'invalid_field');
      if (!next.blocked.includes(h) && next.blocked.length < MAX_BLOCKED) next.blocked.push(h);
      if (next.blocked.includes(h)) blocked = h;
    }
    if (b.unblock !== undefined) {
      const h = toHandle(b.unblock, host, opts) || String(b.unblock);
      next.blocked = next.blocked.filter((x) => x !== h);
    }
    let blockedDomain = '';
    // THE host normalizer (P8 review F4): case, one trailing dot, IDN; an IP
    // literal is a domain block of that address.
    const dopts = { ...opts, allowIp: true };
    if (b.block_domain !== undefined) {
      const d = normalizeHost(b.block_domain, dopts);
      if (!d || d === host) return fail(res, 400, 'invalid_field');
      if (!next.blocked_domains.includes(d) && next.blocked_domains.length < MAX_BLOCKED_DOMAINS) next.blocked_domains.push(d);
      if (next.blocked_domains.includes(d)) blockedDomain = d;
    }
    if (b.unblock_domain !== undefined) {
      const d = normalizeHost(b.unblock_domain, dopts) || String(b.unblock_domain);
      next.blocked_domains = next.blocked_domains.filter((x) => x !== d);
    }

    pages.save(name, next);
    if (blocked) {
      // Retroactive (spec 6.1): their stamps and comments on my posts go (render
      // already hides them: this reclaims the bytes), and the follows between us
      // end both ways (Undo + Reject; never a Block activity).
      const n = reactions.removeAuthor(name, blocked);
      if (follows.edgesOf(name).includes(blocked)) follows.sever(name, blocked, urls.originOf(req, cfg));
      audit('member.blocked', name, { handle: blocked, reactions: n });
    }
    if (blockedDomain) {
      // A domain block ends every follow with a handle it now matches, both ways,
      // exactly as a person block does (spec 6.1: Undo of mine, Reject of theirs).
      const origin = urls.originOf(req, cfg);
      const saved = pages.load(name);
      const gone = follows.edgesOf(name).filter((h) => h.includes('@') && blocksHandle(saved, h));
      for (const h of gone) follows.sever(name, h, origin);
      audit('member.blocked_domain', name, { domain: blockedDomain, follows: gone.length });
    }
    const saved = pages.load(name);
    const origin = urls.originOf(req, cfg);
    // While the page stays off, the Person is minimal: only open_follows shows on it.
    const stayedOff = store.enabled !== true && saved.enabled !== true;
    if (stayedOff ? store.open_follows !== saved.open_follows : personSig(store) !== personSig(saved)) profileChanged(name);
    const changed = ['enabled', 'indexable'].filter((k) => store[k] !== saved[k]);
    if (changed.length) audit('page.switched', name, Object.fromEntries(changed.map((k) => [k, saved[k]])));
    res.json({ ...saved, posts: saved.posts.map((p) => ownPostView(p, origin, name)) });
  });

  return router;
};
