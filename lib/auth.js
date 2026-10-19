'use strict';
/* ── Sessions and identity (spec 9, 10.9, 10.11) ──────────────────────────────
 *   completeLogin(req, name)  THE identity door: the session id ROTATES (regenerate,
 *                             a planted pre-login id never becomes the signed-in
 *                             one), the identity is stamped, and the session is
 *                             SAVED before the caller answers. Nothing is
 *                             carried across the rotation.
 *   loadMember                sets `req.member` = `{ slug, display_name, role }`
 *                             once per request, from a live, active member whose
 *                             session is not older than their `sessions_from`.
 *   requireMember             401 otherwise. requireAdmin: 403 for non-admins.
 *   endSessions(name, keep)   a password change ends the other sessions, a reset
 *                             or a deletion ends all: the store's destroyFor plus
 *                             the `sessions_from` cutoff on the member row.
 *
 * Passwords: bcryptjs, cost 10. An unknown email is compared against
 * DUMMY_HASH so it costs the same time as a known one.
 *
 * ONE PASSWORD QUEUE (robustness-r1-04). bcryptjs runs a cost-10 hash or compare
 * as about 70 ms of synchronous work on the event loop; twenty at once froze the
 * whole server for over a second. Every hash and compare goes through `queue`: one
 * in flight, at most QUEUE_MAX waiting, so the loop takes its I/O turns between
 * two of them. Past that, the work is refused with a RING_BUSY error, which
 * lib/http.js answers 503 `busy` with Retry-After.
 */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const clock = require('./clock');
const { fail } = require('./http');

const BCRYPT_COST = 10;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
const DUMMY_HASH = bcrypt.hash(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);
const QUEUE_MAX = 32;

/* A FIFO of password work, one at a time. `fn` is called when its turn comes. */
function createPasswordQueue({ max = QUEUE_MAX } = {}) {
  const waiting = [];
  let running = false;
  let peak = 0;

  function pump() {
    if (running || !waiting.length) return;
    running = true;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => {
      running = false;
      // A macrotask between two jobs: timers and I/O get their turn.
      setImmediate(pump);
    });
  }

  function run(fn) {
    if (waiting.length >= max) {
      const e = new Error('password queue full');
      e.code = 'RING_BUSY';
      e.retryAfter = 5;
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      peak = Math.max(peak, waiting.length);
      pump();
    });
  }

  return { run, size: () => waiting.length + (running ? 1 : 0), peak: () => peak, max };
}

const queue = createPasswordQueue();

const hashPassword = (pw) => queue.run(() => bcrypt.hash(String(pw), BCRYPT_COST));

/* Compare against the row's hash, or the dummy one: same cost either way. A full
 * queue throws (RING_BUSY), never answers false: busy is not a wrong password. */
async function verifyPassword(pw, hash) {
  const against = hash || (await DUMMY_HASH);
  return queue.run(async () => {
    try { return await bcrypt.compare(String(pw ?? ''), against); }
    catch { return false; }
  });
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return 'password_short';
  if (pw.length > PASSWORD_MAX) return 'password_long';
  return '';
}

function createAuth({ members, sessionStore }) {
  function stamp(req, name) {
    req.session.member = name;
    req.session.at = clock.now();
  }

  async function completeLogin(req, name) {
    if (!req.session) req.sessionStore.generate(req);
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    stamp(req, name);
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  }

  function logout(req) {
    return new Promise((resolve) => {
      if (!req.session) return resolve();
      req.session.destroy(() => resolve());
    });
  }

  function loadMember(req, res, next) {
    const s = req.session;
    if (!s?.member) return next();
    const m = members.get(s.member);
    const cutoff = m?.sessions_from ? Date.parse(m.sessions_from) : 0;
    if (!m || (Number(s.at) || 0) < cutoff) {
      // The member is gone, or this session was ended: it stops being a session.
      return s.destroy(() => next());
    }
    if (m.status === 'active') req.member = { slug: m.slug, display_name: m.display_name, role: m.role };
    next();
  }

  function requireMember(req, res, next) {
    if (!req.member) return fail(res, 401, 'not_signed_in');
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.member) return fail(res, 401, 'not_signed_in');
    if (req.member.role !== 'admin') return fail(res, 403, 'forbidden');
    next();
  }

  /* End sessions of `name`. With `keepReq`, that request's session survives
   * (re-stamped at the cutoff instant). Synchronous. */
  function endSessions(name, keepReq = null) {
    const at = clock.now();
    members.update(name, { sessions_from: clock.iso(at) });
    sessionStore.destroyFor(name, { exceptSid: keepReq?.sessionID });
    if (keepReq?.session) keepReq.session.at = at;
  }

  return { completeLogin, logout, loadMember, requireMember, requireAdmin, endSessions };
}

module.exports = {
  createAuth, hashPassword, verifyPassword, passwordProblem, createPasswordQueue, queue,
  PASSWORD_MIN, BCRYPT_COST, DUMMY_HASH, QUEUE_MAX,
};
