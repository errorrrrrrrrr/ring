'use strict';
/* ── Link tokens (spec 3.11) ──────────────────────────────────────────────────
 * One shape for `pending-signups.json` (24 h) and `password-resets.json` (1 h):
 * the mailed link carries a 256-bit token, the file holds only its SHA-256, so a
 * leaked file or backup redeems nothing. A token is single use: `take` removes
 * its row in the same synchronous tick that reads it.
 *
 * Rows are bounded: at most `perKey` live rows for one key and `max` rows in the
 * file. What happens past a bound is the file's `full` policy:
 *   'evict'   the oldest row goes (password resets: the key is a member, and only
 *             the mailbox owner ever receives any of its links)
 *   'refuse'  the NEW row is not written and add() returns null (pending signups:
 *             a stranger can type any email, so a stranger must never be able to
 *             push the mailbox owner's own row out; security-r1-01)
 *
 * P8 (spec 10.11): add() may name a `group` (the pending signups' requester, a
 * client's /48 or its IPv4 address) with `perGroup`: past that many live rows
 * of the group the `refuse` policy turns the new row away too, so one requester
 * fills at most its share of the file, never the whole of it.
 *
 * touch() rewrites the file unchanged, through the same fsync'd write: a path that
 * must cost what an add() costs (no enumeration by timing, spec 10.11) calls it.
 */
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { newToken, tokenHash } = require('./ids');

function createTokenFile(file, { ttlMs, perKey = 3, max = 10_000, full = 'evict' }) {
  if (!['evict', 'refuse'].includes(full)) throw new Error(`tokens: full must be evict or refuse, not ${full}`);
  const load = () => {
    const raw = readJSON(file, []);
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.hash === 'string') : [];
  };
  const live = (r) => Date.parse(r.expires_at) > clock.now();

  return {
    /* Store a row under a fresh token; returns the token (the only copy), or null
     * when the `refuse` policy turned it away. */
    add(key, data, { group = '', perGroup = 0 } = {}) {
      const rows = load().filter(live);
      const mine = rows.filter((r) => r.key === key);
      const groupFull = !!group && perGroup > 0 && rows.filter((r) => r.group === group).length >= perGroup;
      if (full === 'refuse' && (mine.length >= perKey || rows.length >= max || groupFull)) {
        writeJSON(file, rows);   // the same write either way: a refusal costs what an add costs
        return null;
      }
      const token = newToken();
      const drop = new Set(mine.slice(0, Math.max(0, mine.length - perKey + 1)));
      const kept = rows.filter((r) => !drop.has(r));
      kept.push({ ...data, key, ...(group ? { group } : {}), hash: tokenHash(token), created_at: clock.iso(), expires_at: clock.iso(clock.now() + ttlMs) });
      writeJSON(file, kept.slice(-max));
      return token;
    },
    /* The fsync'd write of an add(), changing nothing a reader can see. */
    touch() {
      writeJSON(file, load().filter(live));
    },
    find(token) {
      if (typeof token !== 'string' || !token || token.length > 128) return null;
      const h = tokenHash(token);
      return load().find((r) => r.hash === h && live(r)) || null;
    },
    /* Single use: remove and return the live row, or null. Synchronous. */
    take(token) {
      if (typeof token !== 'string' || !token || token.length > 128) return null;
      const h = tokenHash(token);
      const rows = load();
      const row = rows.find((r) => r.hash === h);
      if (!row) return null;
      writeJSON(file, rows.filter((r) => r !== row));
      return live(row) ? row : null;
    },
    removeWhere(pred) {
      const rows = load();
      const next = rows.filter((r) => !pred(r));
      if (next.length !== rows.length) writeJSON(file, next);
      return rows.length - next.length;
    },
    sweep() {
      const rows = load();
      const next = rows.filter(live);
      if (next.length !== rows.length) writeJSON(file, next);
      return rows.length - next.length;
    },
    all: load,
  };
}

module.exports = { createTokenFile };
