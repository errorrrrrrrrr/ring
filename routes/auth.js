'use strict';
/* ── Accounts: signup, confirm, names, login, logout, reset (spec 11.1, 10.11) ─
 * An injected Router: every dependency arrives in `ctx`.
 *
 * NO EMAIL ENUMERATION. Signup always answers `202 { check_email: true }` once the
 * request is well formed: a new email gets a confirm link, a taken one an "already
 * have an account" mail. Both paths hash the password first, then ANSWER, then do
 * their store write and mail in the same tick after the answer has left (the
 * taken path rewrites the pending file unchanged, `pending.touch()`), so neither
 * the answer's time nor its shape says which path ran (security-r1-02,
 * spec-r1-09). Forgot does the same: 202 first, then the lookup, the token, the
 * audit and the mail. Login has one `401 invalid_credentials`; an unknown email
 * costs a dummy bcrypt compare; the per-account throttle runs before the compare.
 *
 * THE DOOR. `SIGNUP=invite` (default) needs a live invite, except the very first
 * account, whose email equals ADMIN_EMAIL: it needs none and becomes `admin`
 * (spec 6.3). After that ADMIN_EMAIL grants nothing. `SIGNUP=open` needs no invite.
 * While no member exists, EVERY invite-less signup answers the same 202: only
 * ADMIN_EMAIL gets a row and a mail, so the answer names no address (spec-r1-02).
 *
 * THE PASSWORD IS THE MAILBOX HOLDER'S (security-r1-01, option (a)). Signup keeps
 * the password's hash on the pending row; confirm takes `{ token, password }` and
 * refuses (403 password_mismatch) unless the password matches that hash. A stranger
 * who plants a signup for someone else's address can mail them a link, but the
 * mailbox owner cannot complete it with their own password, and nobody else holds
 * the token. Pending rows are keyed per email AND client and refused, never
 * evicted, past three: a stranger cannot push the owner's own row out.
 *
 * NOR HOLD THE DOOR SHUT (P8, spec 10.11; lib/signup-guard.js): the confirm
 * mail's budget is per address AND requester (a client's /48, or its IPv4
 * address: 5 a day), with a daily ceiling per address (30), both asked before
 * either is spent; a requester holds at most its share of the pending file;
 * the owner's confirm, the admin (/admin) and the shell (npm run
 * signup-release) each release an address.
 *
 * THE COMMIT. Confirm does its awaiting first (the password check, the RSA
 * keypair staged under a random name), then in ONE synchronous tick re-checks
 * everything against fresh reads, commits the key, writes the member row (the row
 * is the commit), consumes the invite and the token. Then it signs in through
 * completeLogin. Login likewise re-reads the row after its compare: a reset that
 * committed meanwhile wins (robustness-r1-03).
 */
const express = require('express');
const clock = require('../lib/clock');
const { fail, wrap } = require('../lib/http');
const { t } = require('../lib/strings');
const { validName } = require('../lib/handles');
const { plainLine } = require('../lib/ring');
const urls = require('../lib/urls');
const { clientId } = require('../lib/rate-limit');
const { hashPassword, verifyPassword, passwordProblem } = require('../lib/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validEmail = (e) => e.length <= 254 && EMAIL_RE.test(e);

module.exports = function authRoutes(ctx) {
  const { cfg, members, invites, pending, resets, keys, mailer, limits, throttle, auth, audit, meView, cookieName, signupGuard } = ctx;
  const logger = ctx.logger || console;
  const router = express.Router();

  const hostOf = (origin) => urls.hostOf(origin) || 'localhost';
  const checkEmail = (res) => res.status(202).json({ check_email: true, message: t('check_email') });

  /* Work that must not show in the answer's timing: run after the answer is sent,
   * in this same tick. A failure is logged, never answered (the answer is out). */
  const afterAnswer = (what, fn) => {
    try { fn(); } catch (e) { logger.error(`[${what}] failed after the answer: ${e.message}`); }
  };

  /* The first-admin rule, asked at confirm time: still no member, still ADMIN_EMAIL. */
  const bootstrapNow = (row) => !!row.bootstrap && members.count() === 0 && !!cfg.adminEmail && row.email_lc === cfg.adminEmail;

  /* What may still stop a confirm, asked before and again inside the commit tick. */
  function confirmProblem(row) {
    if (members.byEmail(row.email_lc)) return [409, 'email_taken'];
    if (!members.nameAvailable(row.slug)) return [409, 'name_unavailable'];
    if (bootstrapNow(row)) return null;
    if (row.invite_id) {
      const inv = invites.get(row.invite_id);
      if (!inv || !invites.isLive(inv)) return [400, 'invite_invalid'];
      return null;
    }
    if (cfg.signup !== 'open') return [400, 'invite_required'];
    return null;
  }

  router.post('/api/signup', limits.limit('signup', { perMinute: 5, perDay: 20 }), wrap(async (req, res) => {
    if (!mailer.available()) return fail(res, 503, 'mail_unavailable');
    const origin = urls.mailOriginOf(req, cfg);
    if (!origin) return fail(res, 503, 'mail_unavailable');
    const b = req.body || {};
    const email = normEmail(b.email);
    if (!validEmail(email)) return fail(res, 400, 'email_invalid');
    const pwProblem = passwordProblem(b.password);
    if (pwProblem) return fail(res, 400, pwProblem);
    const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
    if (!validName(slug)) return fail(res, 400, 'name_invalid');
    if (!members.nameAvailable(slug)) return fail(res, 409, 'name_unavailable');
    if (b.display_name !== undefined && typeof b.display_name !== 'string') return fail(res, 400, 'display_name_invalid');
    const displayName = plainLine(b.display_name || '', 60) || slug;

    let inviteId = null;
    let quiet = false;   // answered like any signup, but nothing is written or mailed
    const bootstrapWindow = members.count() === 0 && !!cfg.adminEmail;
    const bootstrap = bootstrapWindow && email === cfg.adminEmail;
    if (!bootstrap && cfg.signup !== 'open') {
      const code = typeof b.invite === 'string' ? b.invite.trim() : '';
      const inv = code ? invites.byCode(code) : null;
      if (inv) inviteId = inv.id;
      else if (bootstrapWindow) quiet = true;   // no oracle for ADMIN_EMAIL (spec-r1-02)
      else return fail(res, 400, code ? 'invite_invalid' : 'invite_required');
    }

    // Hashed on EVERY path below, so the answer takes the same time.
    const passwordHash = await hashPassword(b.password);

    checkEmail(res);
    afterAnswer('signup', () => {
      const host = hostOf(origin);
      if (quiet) { pending.touch(); return; }
      // A quiet budget per address AND requester (P8): a stranger spends their
      // own, never the mailbox owner's; a daily ceiling per address on top.
      const mailOk = signupGuard.mailOk(email, clientId(req));
      if (members.byEmail(email)) {
        pending.touch();   // the new path's fsync'd write, changing nothing
        if (mailOk) {
          mailer.send({
            to: email,
            subject: t('mail.exists.subject', { host }),
            text: t('mail.exists.body', { host, login: `${origin}/login`, reset: `${origin}/reset` }),
          });
        }
        return;
      }
      if (!mailOk) { pending.touch(); return; }
      const token = pending.add(`${email}\n${clientId(req)}`, {
        email, email_lc: email, password_hash: passwordHash, slug, display_name: displayName,
        invite_id: inviteId, bootstrap,
      }, signupGuard.pendingOpts(clientId(req)));
      // This client already holds three live links for this email, or its
      // requester its share of the file, or the file is full.
      if (!token) return;
      mailer.send({
        to: email,
        subject: t('mail.confirm.subject', { host }),
        text: t('mail.confirm.body', { display_name: displayName, name: slug, host, url: `${origin}/signup/confirm?token=${token}` }),
      });
    });
  }));

  router.post('/api/signup/confirm', limits.limit('confirm', { perMinute: 10, perDay: 100 }), wrap(async (req, res) => {
    const token = req.body?.token;
    const row = pending.find(token);
    if (!row) return fail(res, 400, 'token_invalid');
    // Only whoever chose the password at signup completes it (security-r1-01).
    if (!(await verifyPassword(req.body?.password, row.password_hash))) return fail(res, 403, 'password_mismatch');
    const early = confirmProblem(row);
    if (early) return fail(res, early[0], early[1]);

    const staged = await keys.stage();   // the keypair exists before the row

    // ── the commit tick: fresh reads, no await until completeLogin ──
    const fresh = pending.find(token);
    if (!fresh || fresh.password_hash !== row.password_hash) { keys.discard(staged); return fail(res, 400, 'token_invalid'); }
    const late = confirmProblem(fresh);
    if (late) { keys.discard(staged); return fail(res, late[0], late[1]); }
    const inviter = fresh.invite_id ? invites.get(fresh.invite_id)?.created_by || null : null;
    const role = bootstrapNow(fresh) ? 'admin' : 'member';
    keys.commit(staged, fresh.slug);
    try {
      members.insert({
        slug: fresh.slug,
        email: fresh.email,
        email_lc: fresh.email_lc,
        password_hash: fresh.password_hash,
        display_name: fresh.display_name,
        role,
        invited_by: inviter,
        created_at: clock.iso(),
        status: 'active',
      });
    } catch (e) {
      keys.remove(fresh.slug);
      throw e;
    }
    if (fresh.invite_id && !invites.consume(fresh.invite_id, fresh.slug)) {
      console.error(`[signup] invite ${fresh.invite_id} was not live at consume time`);
    }
    pending.take(token);
    // The owner's own confirm: the address's ceiling as if never spent, its
    // other pending rows gone (P8 review F5, lib/signup-guard.js).
    signupGuard.confirmed(fresh.email_lc);
    audit('member.created', fresh.slug, { role, invited_by: inviter });

    await auth.completeLogin(req, fresh.slug);
    res.json({ member: meView(fresh.slug, req) });
  }));

  router.get('/api/names/:slug', limits.limit('names', { perMinute: 30, perDay: 1000 }), (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    res.set('Cache-Control', 'no-store');
    res.json({ name: slug, available: members.nameAvailable(slug) });
  });

  router.post('/api/login', limits.limit('login', { perMinute: 10, perDay: 100 }), wrap(async (req, res) => {
    const b = req.body || {};
    const email = normEmail(b.email);
    const client = clientId(req);
    const wait = throttle.retryAfter(email, client);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: 'too_many_attempts', message: t('too_many_attempts'), retry_after: wait });
    }
    const m = email ? members.byEmail(email) : null;
    const ok = await verifyPassword(b.password, m?.password_hash);
    if (!m || !ok) {
      throttle.failed(email, client);
      return fail(res, 401, 'invalid_credentials');
    }
    // ── tick: the row as it is NOW. A reset or change that committed during the
    // compare wins; the old password signs nobody in (robustness-r1-03).
    const fresh = members.get(m.slug);
    if (!fresh || fresh.password_hash !== m.password_hash) return fail(res, 401, 'invalid_credentials');
    throttle.succeeded(email, client);
    if (fresh.status !== 'active') return fail(res, 403, 'suspended');
    await auth.completeLogin(req, m.slug);
    res.json({ member: meView(m.slug, req) });
  }));

  router.post('/api/logout', auth.requireMember, wrap(async (req, res) => {
    await auth.logout(req);
    res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: cfg.production, path: '/' });
    res.json({ ok: true });
  }));

  router.post('/api/password/forgot', limits.limit('reset', { perMinute: 5, perDay: 20 }), (req, res) => {
    if (!mailer.available()) return fail(res, 503, 'mail_unavailable');
    const origin = urls.mailOriginOf(req, cfg);
    if (!origin) return fail(res, 503, 'mail_unavailable');
    const email = normEmail(req.body?.email);
    if (!validEmail(email)) return fail(res, 400, 'email_invalid');
    // 3 an hour per email, keyed whether or not an account holds it.
    if (!limits.allow(res, 'reset-email', email, { perHour: 3 })) return;
    checkEmail(res);
    afterAnswer('forgot', () => {
      const m = members.byEmail(email);
      if (m?.status !== 'active') { resets.touch(); return; }
      const host = hostOf(origin);
      const token = resets.add(m.slug, { slug: m.slug });
      mailer.send({
        to: m.email,
        subject: t('mail.reset.subject', { host }),
        text: t('mail.reset.body', { name: m.slug, host, url: `${origin}/reset?token=${token}` }),
      });
      audit('password.reset_requested', m.slug);
    });
  });

  router.post('/api/password/reset', limits.limit('reset-redeem', { perMinute: 5, perDay: 50 }), wrap(async (req, res) => {
    const b = req.body || {};
    const problem = passwordProblem(b.password);
    if (problem) return fail(res, 400, problem);
    if (!resets.find(b.token)) return fail(res, 400, 'token_invalid');
    const passwordHash = await hashPassword(b.password);

    // ── tick: single use first, then the credential ──
    const row = resets.take(b.token);
    if (!row) return fail(res, 400, 'token_invalid');
    const m = members.get(row.slug);
    if (!m) return fail(res, 400, 'token_invalid');
    members.update(m.slug, { password_hash: passwordHash });
    resets.removeWhere((r) => r.slug === m.slug);
    auth.endSessions(m.slug);   // every session, this browser's too
    throttle.clear(m.email_lc);
    audit('password.reset', m.slug);
    res.json({ ok: true });
  }));

  return router;
};

module.exports.normEmail = normEmail;
module.exports.validEmail = validEmail;
