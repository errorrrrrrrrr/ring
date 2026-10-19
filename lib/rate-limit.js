'use strict';
/* ── Rate limits (spec 10.7) ──────────────────────────────────────────────────
 * Rolling minute / hour / day windows of
 * timestamps; a refused call takes nothing, so hammering a shut door does not
 * push it further shut; the 429 says when it opens (Retry-After, retry_after).
 *
 * Each on purpose:
 *   - NO loopback exemption. Ring has no self-fetch, and the self-hosting shape is
 *     a reverse proxy on the same box (spec 15.1), where EVERY request arrives
 *     from loopback: the exemption would switch every limit off.
 *   - Signed in, the bucket is the member's (spec 10.7); anonymous, the CLIENT
 *     ID (clientId below): IPv4 as is, an IPv4-mapped IPv6 address unwrapped, any
 *     other IPv6 address cut to its /64. One /64 is one subscriber, so a client
 *     holding 2^64 addresses still gets ONE budget (security-r1-04). Behind
 *     TRUST_PROXY, req.ip is the client's address from the proxy.
 *   - BOUNDED (robustness-r1-09): at most `maxKeys` buckets, oldest-touched out,
 *     as lib/login-throttle.js does; the ids are typed by strangers. A bucket is
 *     ONE timestamp list trimmed to its rule's longest window, so it never holds
 *     more than that window's budget.
 *   - One instance per app (tests boot several in one process), on lib/clock.js.
 *   - `scale` multiplies every budget; it is an option of createApp for tests that
 *     are not about limits, never an environment variable.
 *
 * missLimit spends only on a 404 (the image namespace: hits are the product,
 * misses are the probe).
 */
const net = require('node:net');
const clock = require('./clock');
const { t } = require('./strings');

const SPANS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const ORDER = ['minute', 'hour', 'day'];
const MAX_KEYS = 100_000;

/* The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(addr) {
  let s = addr;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  return groups.map((g) => Number.parseInt(g || '0', 16));
}

/* THE anonymous client id: what every per-IP bucket and the throttle's pair key
 * hold. Never the raw address of an IPv6 client. */
function clientIdOf(address) {
  let a = String(address || '').trim();
  if (!a) return 'unknown';
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return 'unknown';
  const g = ipv6Groups(a.toLowerCase());
  if (!g) return 'unknown';
  // ::ffff:a.b.c.d is an IPv4 client on a dual-stack socket.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

const clientId = (req) => clientIdOf(req.ip || req.socket?.remoteAddress);

/* The /48 an IPv6 client id (`a:b:c:d::/64`) sits in, or '' (IPv4, unknown).
 * The federation routes give unverified inbound an AGGREGATE bucket per /48
 * on top of the client's own (spec 5.9): one site's allocation holds 65 536
 * /64s, and that must not be 65 536 budgets. */
function prefix48Of(id) {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(String(id || ''));
  return m ? `${m[1]}:${m[2]}:${m[3]}::/48` : '';
}

function createLimits({ scale = 1, maxKeys = MAX_KEYS } = {}) {
  const buckets = new Map();   // id -> { span, ts: [] } (oldest-touched first)

  const budget = (rule) => ({
    minute: rule.perMinute ? rule.perMinute * scale : 0,
    hour: rule.perHour ? rule.perHour * scale : 0,
    day: rule.perDay ? rule.perDay * scale : 0,
  });
  const longest = (max) => SPANS[[...ORDER].reverse().find((k) => max[k])] || SPANS.minute;

  function live(id) {
    const b = buckets.get(id);
    if (!b) return null;
    const now = clock.now();
    let i = 0;
    while (i < b.ts.length && now - b.ts[i] >= b.span) i++;
    if (i) b.ts.splice(0, i);
    return b;
  }

  /* Full: the oldest-touched 1% go in one pass. One at a time from a Map's front
   * walks its deleted holes on every call, quadratic under a flood. */
  function evictOldest() {
    let n = Math.max(1, Math.ceil(maxKeys / 100), buckets.size - maxKeys + 1);
    for (const id of buckets.keys()) {
      buckets.delete(id);
      if (--n <= 0) break;
    }
  }

  const countIn = (b, span, now) => {
    let n = 0;
    for (let i = b.ts.length - 1; i >= 0 && now - b.ts[i] < span; i--) n++;
    return n;
  };

  /* Which window is spent, or null. Takes nothing. */
  function spentOf(id, rule) {
    const b = live(id);
    if (!b) return null;
    const max = budget(rule);
    const now = clock.now();
    for (const k of ORDER) {
      if (max[k] && countIn(b, SPANS[k], now) >= max[k]) {
        // A spent bucket is refreshed too: hammering a shut door must not age it out.
        buckets.delete(id);
        buckets.set(id, b);
        return k;
      }
    }
    return null;
  }

  /* Take a token: null when taken, else the spent window. */
  function take(id, rule) {
    const spent = spentOf(id, rule);
    if (spent) return spent;
    let b = buckets.get(id);
    if (b) buckets.delete(id);   // re-inserted below: the map's order is last-touched
    else {
      if (buckets.size >= maxKeys) evictOldest();
      b = { span: longest(budget(rule)), ts: [] };
    }
    b.ts.push(clock.now());
    buckets.set(id, b);
    return null;
  }

  /* Seconds until the spent window has room again. */
  function waitSeconds(id, rule, spent) {
    const b = buckets.get(id);
    const max = budget(rule)[spent];
    const now = clock.now();
    const inWindow = (b?.ts || []).filter((ts) => now - ts < SPANS[spent]);
    // The oldest stamp whose ageing out brings the count under the budget.
    const pivot = inWindow[Math.max(0, inWindow.length - max)];
    if (pivot === undefined) return Math.ceil(SPANS[spent] / 1000);
    return Math.max(1, Math.ceil((pivot + SPANS[spent] - now) / 1000));
  }

  function refuse(res, id, rule, spent) {
    const after = waitSeconds(id, rule, spent);
    res.set('Retry-After', String(after));
    const key = spent === 'minute' ? 'rate_minute' : spent === 'hour' ? 'rate_hour' : 'rate_day';
    return res.status(429).json({ error: key, message: t(key), retry_after: after });
  }

  const whoOf = (req) => (req.member ? `m:${req.member.slug}` : `ip:${clientId(req)}`);

  /* Middleware: the bucket is the member's when signed in, else the client's. */
  function limit(name, rule) {
    return (req, res, next) => {
      const id = `${name}:${whoOf(req)}`;
      const spent = take(id, rule);
      if (spent) return refuse(res, id, rule, spent);
      next();
    };
  }

  /* For a handler that keys on something it reads itself (an email). Returns
   * false after writing the 429. */
  function allow(res, name, key, rule) {
    const id = `${name}:${key}`;
    const spent = take(id, rule);
    if (spent) { refuse(res, id, rule, spent); return false; }
    return true;
  }

  /* Spend only when the response finishes as a 404; refuse once spent. */
  function missLimit(name, rule) {
    return (req, res, next) => {
      const id = `${name}:ip:${clientId(req)}`;
      const spent = spentOf(id, rule);
      if (spent) return refuse(res, id, rule, spent);
      res.on('finish', () => { if (res.statusCode === 404) take(id, rule); });
      next();
    };
  }

  function prune() {
    for (const id of [...buckets.keys()]) {
      const b = live(id);
      if (b && !b.ts.length) buckets.delete(id);
    }
  }

  /* P8: the admin's release of a signup address (lib/signup-guard.js): its
   * bucket goes, as if never spent. -> how many. `spent(id, rule)` asks
   * without taking (the guard checks two budgets before spending either). */
  function forget(id) { return buckets.delete(id) ? 1 : 0; }
  function forgetPrefix(prefix) {
    let n = 0;
    for (const id of [...buckets.keys()]) if (id.startsWith(prefix)) { buckets.delete(id); n++; }
    return n;
  }

  return { limit, allow, missLimit, take, spent: spentOf, prune, forget, forgetPrefix, size: () => buckets.size };
}

module.exports = { createLimits, clientId, clientIdOf, prefix48Of, MAX_KEYS };
