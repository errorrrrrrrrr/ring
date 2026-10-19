'use strict';
/* ── THE clock (spec 14) ──────────────────────────────────────────────────────
 * One `now()` for every rule with a time in it: token and invite expiry, rate
 * buckets, the login throttle, the unposted-upload sweep, ids. Tests move it;
 * nothing else may. `set` and `advance` refuse under NODE_ENV=production, so a
 * stray call can never make a live server lie about the time.
 *
 * Sessions are the one exception: express-session stamps cookie expiry with the
 * real Date, and a test never needs to move a cookie.
 */

let offset = 0;
let frozen = null;

function now() {
  return frozen !== null ? frozen : Date.now() + offset;
}

function iso(ms = now()) {
  return new Date(ms).toISOString();
}

function guard() {
  if (process.env.NODE_ENV === 'production') throw new Error('clock: settable in tests only');
}

/* Freeze at an instant (ms). */
function set(ms) { guard(); frozen = Number(ms); }

/* Move forward (or back) by ms, frozen or not. */
function advance(ms) {
  guard();
  if (frozen !== null) frozen += Number(ms);
  else offset += Number(ms);
}

function reset() { guard(); offset = 0; frozen = null; }

module.exports = { now, iso, set, advance, reset };
