'use strict';
/* ── Login throttle, per ACCOUNT (spec 10.11) ─────────────────────────────────
 * On lib/clock.js.
 *
 * The per-IP rate limit stops one machine; this keys on the EMAIL typed, so a
 * spray from many addresses meets one budget. Two windows, failed checks only:
 *   pair     one email from one address   10 failures in 15 minutes
 *   account  one email from anywhere      30 failures in 60 minutes
 * Either spent and the email is refused BEFORE the password is compared.
 *
 *   - Keyed whether or not an account holds the email: not an enumeration oracle.
 *   - A success clears that email's PAIR window for that address only.
 *   - A password reset clears the email everywhere (`clear`): the mailbox is proven.
 *   - In memory, bounded (MAX_KEYS, oldest out): the keys are typed by strangers.
 *   - The address half of a pair key is the CLIENT ID (lib/rate-limit.js
 *     clientId: an IPv6 client is its /64), never the raw address: the caller
 *     passes it.
 */
const clock = require('./clock');

const PAIR = { max: 10, windowMs: 15 * 60_000 };
const ACCOUNT = { max: 30, windowMs: 60 * 60_000 };
const MAX_KEYS = 100_000;

function createLoginThrottle({ pair = PAIR, account = ACCOUNT, maxKeys = MAX_KEYS } = {}) {
  const fails = new Map();   // key -> [timestamps], oldest first

  const pairKey = (name, ip) => `p:${name}\n${ip || 'unknown'}`;
  const acctKey = (name) => `a:${name}`;

  function live(key, windowMs) {
    const list = fails.get(key);
    if (!list) return [];
    const t = clock.now();
    while (list.length && t - list[0] >= windowMs) list.shift();
    if (!list.length) fails.delete(key);
    return list;
  }

  function push(key) {
    const list = fails.get(key);
    if (list) list.push(clock.now());
    else {
      if (fails.size >= maxKeys) {
        // The oldest 1% in one pass: one at a time from the front is quadratic.
        let n = Math.max(1, Math.ceil(maxKeys / 100), fails.size - maxKeys + 1);
        for (const k of fails.keys()) { fails.delete(k); if (--n <= 0) break; }
      }
      fails.set(key, [clock.now()]);
    }
  }

  /* Seconds until `name` may try again from `ip`, or 0 when it may now. */
  function retryAfter(name, ip) {
    if (!name) return 0;
    let wait = 0;
    for (const [key, w] of [[pairKey(name, ip), pair], [acctKey(name), account]]) {
      const list = live(key, w.windowMs);
      if (list.length >= w.max) wait = Math.max(wait, Math.ceil((list[0] + w.windowMs - clock.now()) / 1000));
    }
    return wait > 0 ? Math.max(1, wait) : 0;
  }

  function failed(name, ip) {
    if (!name) return;
    push(pairKey(name, ip));
    push(acctKey(name));
  }

  function succeeded(name, ip) {
    if (name) fails.delete(pairKey(name, ip));
  }

  function clear(name) {
    if (!name) return;
    const prefix = `p:${name}\n`;
    for (const key of fails.keys()) if (key.startsWith(prefix)) fails.delete(key);
    fails.delete(acctKey(name));
  }

  function prune() {
    const longest = Math.max(pair.windowMs, account.windowMs);
    const t = clock.now();
    for (const [key, list] of fails) if (!list.length || t - list[list.length - 1] >= longest) fails.delete(key);
  }

  return { retryAfter, failed, succeeded, clear, prune, size: () => fails.size };
}

module.exports = { createLoginThrottle, PAIR, ACCOUNT };
