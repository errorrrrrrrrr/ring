'use strict';
/* ── THE image-key stamp ──────────────────────────────────────────────────────
 * The server mints every key; the client never names one (spec 10.5).
 *
 *   imageStamp() -> '<ms>_<16 hex chars>'   e.g. 1791539358767_9f3c0a7e12b4d6e8
 *
 * The millisecond keeps keys readable in a listing; the 64 bits from the platform
 * CSPRNG are the protection. A seeded generator is never used here.
 */
const crypto = require('node:crypto');
const clock = require('./clock');

function randomHex16() {
  return crypto.randomBytes(8).toString('hex');
}

function imageStamp() {
  return String(clock.now()) + '_' + randomHex16();
}

const STAMP_RE = /^\d{13}_[0-9a-f]{16}$/;

module.exports = { imageStamp, randomHex16, STAMP_RE };
