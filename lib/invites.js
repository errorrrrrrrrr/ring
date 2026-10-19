'use strict';
/* ── Invites (spec decision 1, 11.1) ──────────────────────────────────────────
 * `invites.json`: `{ id, code, created_by, created_at, expires_at, used_by,
 * used_at }`. Single use, 14 days, at most INVITES_PER_MEMBER (5) live per
 * member, revocable by their minter. `created_by` and `used_by` are handles.
 *
 * The code is a 160-bit bearer secret stored as is, so its minter
 * may copy the link again from the list. Signup only CHECKS a code; the invite is
 * consumed in the confirm tick, the same tick that writes the member row.
 */
const crypto = require('node:crypto');
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { newInviteId } = require('./ids');

const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;

function createInvites(paths) {
  const load = () => {
    const raw = readJSON(paths.invites, []);
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === 'string') : [];
  };
  const save = (rows) => writeJSON(paths.invites, rows);
  const isLive = (r) => !r.used_at && Date.parse(r.expires_at) > clock.now();
  const stateOf = (r) => (r.used_at ? 'used' : isLive(r) ? 'live' : 'expired');

  return {
    isLive,
    stateOf,
    listFor: (slug) => load().filter((r) => r.created_by === slug),
    liveCount: (slug) => load().filter((r) => r.created_by === slug && isLive(r)).length,
    /* A live invite by code, or null. Constant-time compare per row. */
    byCode(code) {
      if (typeof code !== 'string' || code.length < 20 || code.length > 64) return null;
      const want = Buffer.from(code);
      for (const r of load()) {
        const got = Buffer.from(String(r.code));
        if (got.length === want.length && crypto.timingSafeEqual(got, want)) return isLive(r) ? r : null;
      }
      return null;
    },
    get: (id) => load().find((r) => r.id === id) || null,
    mint(slug) {
      const rows = load();
      const taken = new Set(rows.map((r) => r.id));
      let id = newInviteId();
      while (taken.has(id)) id = newInviteId();
      const row = {
        id,
        code: crypto.randomBytes(20).toString('base64url'),
        created_by: slug,
        created_at: clock.iso(),
        expires_at: clock.iso(clock.now() + INVITE_TTL_MS),
      };
      save([...rows, row]);
      return row;
    },
    /* Mark used. Returns false when the invite is no longer live. Synchronous. */
    consume(id, by) {
      const rows = load();
      const r = rows.find((x) => x.id === id);
      if (!r || !isLive(r)) return false;
      r.used_by = by;
      r.used_at = clock.iso();
      save(rows);
      return true;
    },
    /* Revoke a live invite of `slug`'s. */
    revoke(id, slug) {
      const rows = load();
      const r = rows.find((x) => x.id === id && x.created_by === slug);
      if (!r || r.used_at) return false;
      save(rows.filter((x) => x !== r));
      return true;
    },
    /* A deleted member's traces: invites they minted, and the redemption they used. */
    removeFor(slug) {
      const rows = load();
      const next = rows
        .filter((r) => r.created_by !== slug)
        .map((r) => (r.used_by === slug ? { ...r, used_by: null } : r));
      save(next);
    },
    /* Housekeeping: unused invites past expiry go. */
    sweep() {
      const rows = load();
      const next = rows.filter((r) => r.used_at || isLive(r));
      if (next.length !== rows.length) save(next);
      return rows.length - next.length;
    },
  };
}

module.exports = { createInvites, INVITE_TTL_MS };
