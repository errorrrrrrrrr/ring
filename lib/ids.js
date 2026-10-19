'use strict';
/* ── Ids (spec 2.5) ───────────────────────────────────────────────────────────
 * Every id is minted by this server from the CSPRNG, never Math.random:
 *
 *   post     p     + base36(ms) + 8 random base36
 *   stamp    stmp_ + base36(ms) + 8 random base36
 *   comment  lc_   + base36(ms) + 8 random base36
 *   ring     ring_ + 20 hex
 *   invite   inv_  + 16 hex
 *   activity a     + base36(ms) + 8 random base36   (P2: /users/<name>/activities/<id>)
 *   join code       20 CSPRNG bytes, base64url (a ring's standing join link, 160 bits)
 *
 * An id is never reused: the caller passes the set of ids already taken (live rows
 * plus tombstones) and a collision is minted again. The row stores the short id;
 * the object URL is derived from host, name and id (lib/urls.js), never stored.
 */
const crypto = require('node:crypto');
const clock = require('./clock');

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/* n uniform base36 chars: rejection sampling over random bytes (252 = 36 * 7). */
function randomBase36(n) {
  let out = '';
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b < 252) out += B36[b % 36];
      if (out.length === n) break;
    }
  }
  return out;
}

function timeBase36() {
  return clock.now().toString(36);
}

function mint(prefix, taken) {
  for (;;) {
    const id = prefix + timeBase36() + randomBase36(8);
    if (!taken?.has(id)) return id;
  }
}

const newPostId = (taken) => mint('p', taken);
const newStampId = (taken) => mint('stmp_', taken);
const newCommentId = (taken) => mint('lc_', taken);
const newActivityId = () => mint('a', null);
const newRingId = () => 'ring_' + crypto.randomBytes(10).toString('hex');
const newJoinCode = () => crypto.randomBytes(20).toString('base64url');
const newInviteId = () => 'inv_' + crypto.randomBytes(8).toString('hex');

/* A bearer secret for a link (invite code, signup or reset token): 32 bytes. */
const newToken = () => crypto.randomBytes(32).toString('base64url');

/* What every token file stores instead of the token (spec 3.11: HASHES only). */
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/* The shape a post id in a URL must have before anything is looked up. */
const POST_ID_RE = /^p[0-9a-z]{12,24}$/;
const STAMP_ID_RE = /^stmp_[0-9a-z]{12,24}$/;
const COMMENT_ID_RE = /^lc_[0-9a-z]{12,24}$/;
/* THE ring id shape (spec 2.5): a post audience, a path segment, a row id. */
const RING_ID_RE = /^ring_[0-9a-f]{20}$/;

module.exports = {
  newPostId, newStampId, newCommentId, newRingId, newInviteId, newToken, tokenHash,
  newActivityId, newJoinCode, randomBase36, POST_ID_RE, STAMP_ID_RE, COMMENT_ID_RE, RING_ID_RE,
};
