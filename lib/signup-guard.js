'use strict';
/* ── The signup door's budgets, so a stranger cannot hold it shut (spec 10.11; P8)
 * P1's known limit: the confirm-mail budget was 5 an hour PER ADDRESS, across
 * every client, so a stranger could spend a real person's budget by typing
 * their address; and the 10 000-row pending file could be filled from enough
 * clients. P8 bounds both and gives the admin a release:
 *
 *   THE REQUESTER is a client's /48 when it is IPv6 (one site holds 65 536
 *   /64s), else its IPv4 address (lib/rate-limit.js clientId, prefix48Of).
 *
 *   MAIL to one address: 5 a DAY per requester (rolling 24 h), so only that
 *   requester's own attempts spend it: a stranger spends their own budget,
 *   never the mailbox owner's. On top, 30 a day per address from every
 *   requester together, the ceiling that keeps the door from mail-bombing
 *   anyone. Both are checked BEFORE either is spent, so an attempt that is
 *   refused (the requester past its own 5, or the ceiling full) spends
 *   nothing: a requester's attempts beyond its own budget never count toward
 *   the ceiling, and an owner who tries while the door is held loses none of
 *   their own (P8 review F5). Hence, exactly: in any 24 hours one requester
 *   puts at most 5 mails into an address's ceiling, so holding an address
 *   shut takes SIX distinct requesters (six IPv4 addresses or six IPv6 /48s)
 *   each spending its whole day's 5 on it; fewer can never close it.
 *
 *   OPENING IT. The owner's own confirm (a signup link clicked through to an
 *   account) clears the address's ceiling and its other pending rows; the
 *   admin's `release` (below) does the same; and before any admin exists, the
 *   shell does it (`npm run signup-release -- <address>`, scripts/
 *   signup-release.js): the script leaves a release note under DATA (the
 *   address's SHA-256 only), which the running server applies at the next
 *   signup attempt for that address (or, stopped, at its first after boot).
 *   A release leaves each requester's own count as it was: a requester that
 *   spent its 5 before the release cannot spend them again until its own day
 *   has rolled, so the ones that held the door cannot refill it at once.
 *
 *   PENDING ROWS: as before, 3 live per address and client, 10 000 in the file,
 *   refused past either, never evicting; and now at most 10 live per requester,
 *   so filling the file takes a thousand requesters. When it is full anyway,
 *   /admin shows it and the admin clears it (each real person signs up again;
 *   nobody's account is touched: a pending row is no account).
 *
 *   RELEASE (POST /api/admin/signups, the admin only): `release` an address
 *   (its ceiling as if never spent, its pending rows gone) or `clear` every
 *   pending row. The admin types the address; the answer is the same whether
 *   or not anything was held for it, and /admin never lists addresses: the
 *   counts it shows (rows, the cap, requesters at their share) name no one.
 *
 * Every path still answers the same 202 and makes the same one fsync'd write
 * (no enumeration by shape or time): a refusal here is quiet, as P1's was.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { prefix48Of } = require('./rate-limit');

const PER_REQUESTER_DAY = { perDay: 5 };
const PER_ADDRESS_DAY = { perDay: 30 };
const PENDING_PER_REQUESTER = 10;
const PENDING_MAX = 10_000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* The shell's release notes (scripts/signup-release.js): DATA/signup-release/
 * <sha256 of the address>, one empty file each. */
const releaseDirOf = (paths) => path.join(paths.root, 'signup-release');

function createSignupGuard({ limits, pending, paths = null, audit = () => {}, logger = console }) {
  const requesterOf = (client) => prefix48Of(client) || String(client || 'unknown');
  const addressKey = (email) => `signup-mail:${email}`;
  const requesterKey = (email, req) => `signup-mail:${email}\n${req}`;
  const releaseDir = paths ? releaseDirOf(paths) : '';

  /* A release note the shell left for this address: applied once, then gone. */
  function shellRelease(email) {
    if (!releaseDir) return false;
    const file = path.join(releaseDir, sha256(email));
    try { fs.statSync(file); } catch { return false; }
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') { logger.error?.(`[signup] release note: ${e.message}`); return false; } }
    release(email);
    audit('signups.released', 'shell');
    return true;
  }

  /* May this requester's signup mail go to `email` now? Both budgets are
   * asked first and spent only together (a refusal spends nothing). */
  function mailOk(email, client) {
    shellRelease(email);
    const r = requesterKey(email, requesterOf(client));
    if (limits.spent(r, PER_REQUESTER_DAY) || limits.spent(addressKey(email), PER_ADDRESS_DAY)) return false;
    limits.take(r, PER_REQUESTER_DAY);
    limits.take(addressKey(email), PER_ADDRESS_DAY);
    return true;
  }

  /* The pending row's add() options: this requester's share of the file. */
  const pendingOpts = (client) => ({ group: requesterOf(client), perGroup: PENDING_PER_REQUESTER });

  /* The address's ceiling as if never spent, its pending rows gone. Each
   * requester's own count stays (header). */
  function release(email) {
    limits.forget(addressKey(email));
    return pending.removeWhere((r) => r.email_lc === email);
  }
  /* The owner confirmed (an account now holds the address): the same. */
  const confirmed = (email) => release(email);
  const clear = () => pending.removeWhere(() => true);

  function stats() {
    const rows = pending.all().filter((r) => Date.parse(r.expires_at) > clock.now());
    const per = new Map();
    for (const r of rows) if (r.group) per.set(r.group, (per.get(r.group) || 0) + 1);
    return {
      pending: rows.length,
      cap: PENDING_MAX,
      per_requester: PENDING_PER_REQUESTER,
      requesters_at_share: [...per.values()].filter((n) => n >= PENDING_PER_REQUESTER).length,
      full: rows.length >= PENDING_MAX,
      mail_per_requester_day: PER_REQUESTER_DAY.perDay,
      mail_per_address_day: PER_ADDRESS_DAY.perDay,
    };
  }

  return { mailOk, pendingOpts, release, confirmed, clear, stats, requesterOf };
}

/* The shell's half (scripts/signup-release.js): leave the note. -> its path. */
function writeReleaseNote(paths, email) {
  const dir = releaseDirOf(paths);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, sha256(email));
  fs.writeFileSync(file, '', { mode: 0o600 });
  return file;
}

module.exports = { createSignupGuard, writeReleaseNote, PER_REQUESTER_DAY, PER_ADDRESS_DAY, PENDING_PER_REQUESTER, PENDING_MAX };
