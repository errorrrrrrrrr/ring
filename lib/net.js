'use strict';
/* ── THE fetcher (spec 5.6) ───────────────────────────────────────────────────
 * The private-range tables (isPrivateIpv4, isPrivateIpv6 with mapped, compatible,
 * NAT64 and IPv4-translated ::ffff:0:0:0/96 forms), "resolve every
 * answer and refuse the host if ANY is private", the approved answer PINNED into
 * the socket's lookup (a rebinding second answer is never asked for, let alone
 * used), redirects re-resolved and re-checked hop by hop, a redirect's body never
 * read, a body past its cap aborting the socket, and a status outside 200..599 a
 * failed fetch rather than a thrown Response.
 *
 * And, each on purpose:
 *   - https ONLY. http, `localhost` and loopback addresses are allowed only under
 *     the test hook (`allowLoopback`, from FED_TEST_LOOPBACK=1, which lib/config.js
 *     refuses under NODE_ENV=production). The hook opens LOOPBACK only: RFC 1918,
 *     link-local, CGNAT, ULA and the rest stay refused, so the SSRF gate runs with
 *     the hook on.
 *   - A GET follows at most 3 redirects; a POST (a delivery) NEVER follows one:
 *     the 3xx is returned as the answer and the caller treats it as a failure.
 *   - Every hop is signed afresh (`sign(url, method, headers)`): a signature
 *     covers the host and path, which a redirect changes.
 *   - Time caps: connect (5 s) and total (10 s JSON, 20 s media, 15 s delivery,
 *     the caller's choice) both abort the socket. `Accept-Encoding: identity`, so
 *     the byte cap is the true size. No cookies, no credentials, no proxy.
 *   - Concurrency: at most 2 requests at once per remote host, 8 overall; the rest
 *     wait in order, at most 64 of them (past that a request is refused at once,
 *     ERR_BUSY), and the wait counts against the request's own deadline. A
 *     caller may bring its own gate (inbound key fetches have theirs, so a flood
 *     of them never delays a delivery).
 *   - No Puppeteer guard (Ring renders no page).
 *   - `refuseHost(host)` (P6; P8 the admin's domain blocks): a host it names is
 *     never asked, on any hop (ERR_BLOCKED): one door, so no fetch and no
 *     delivery reaches it. The host is THE normalizer's (lib/handles.js
 *     canonHost) before the check, and a URL whose host ends in one dot is
 *     asked without it, so `evil.example.` is refused as `evil.example`.
 *
 * Every outgoing request goes through fetchGuarded(), deliveries included.
 * parseJsonSafe() is the one reader of a remote JSON body (and of an inbox
 * body): a nesting depth over 32 is refused, `__proto__`, `constructor` and
 * `prototype` keys are dropped.
 */
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { canonHost } = require('./handles');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_GET_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 5000;
const PER_HOST = 2;
const OVERALL = 8;
const MAX_WAITING = 64;

class NetError extends Error {
  constructor(message, code = 'ERR_NET') {
    super(message);
    this.name = 'NetError';
    this.code = code;
  }
}
const refused = (why = 'only public https URLs are fetched') => new NetError(why, 'ERR_PUBLIC_URL_REQUIRED');

function cleanHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function ipv4Bytes(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const bytes = parts.map(Number);
  return bytes.every((n) => n >= 0 && n <= 255) ? bytes : null;
}

/* This network, RFC 1918, loopback, CGNAT, link-local,
 * IETF and documentation ranges, benchmarking, multicast and reserved. */
function isPrivateIpv4(address) {
  const bytes = ipv4Bytes(address);
  if (!bytes) return true;
  const [a, b, c] = bytes;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Bytes(address) {
  let value = cleanHostname(address).split('%')[0];
  if (!value) return null;
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4Bytes(tail);
    if (!v4) return null;
    value = `${value.slice(0, lastColon)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [...left, ...Array(fill).fill('0'), ...right];
  if (words.length !== 8 || words.some((w) => !/^[0-9a-f]{1,4}$/i.test(w))) return null;
  return words.flatMap((w) => { const n = Number.parseInt(w, 16); return [n >> 8, n & 0xff]; });
}

function isPrivateIpv6(address) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZeroThroughV4 = bytes.slice(0, 12).every((n) => n === 0);
  const mappedV4 = bytes.slice(0, 10).every((n) => n === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  // IPv4-translated (RFC 2765, ::ffff:0:0:0/96): classed like the mapped form.
  const translatedV4 = bytes.slice(0, 8).every((n) => n === 0) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0;
  if (allZeroThroughV4 || mappedV4 || translatedV4) {
    // :: and ::1 are private; a compatible, mapped or translated IPv4 keeps its IPv4 class.
    if (bytes.slice(12).every((n) => n === 0) || bytes.slice(12).join('.') === '0.0.0.1') return true;
    return isPrivateIpv4(bytes.slice(12).join('.'));
  }
  // NAT64 (RFC 6052, 8215): the well-known /96 takes its embedded IPv4's class;
  // the rest of 64:ff9b::/32 (local-use included) is private.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes.slice(4, 12).every((n) => n === 0)) return isPrivateIpv4(bytes.slice(12).join('.'));
    return true;
  }
  return (bytes[0] & 0xfe) === 0xfc // fc00::/7 unique-local
    || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) // fe80::/10 link-local
    || (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) // fec0::/10 site-local
    || bytes[0] === 0xff // multicast
    || (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) // documentation
    || (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) // Teredo
    || (bytes[0] === 0x20 && bytes[1] === 0x02); // 6to4
}

function isPrivateAddress(address) {
  const value = cleanHostname(address);
  const family = net.isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family === 6) return isPrivateIpv6(value);
  return true;
}

/* Loopback only: 127/8, ::1 and their mapped form. What the test hook opens. */
function isLoopbackAddress(address) {
  const value = cleanHostname(address);
  if (net.isIP(value) === 4) return value.startsWith('127.');
  const b = net.isIP(value) === 6 ? ipv6Bytes(value) : null;
  if (!b) return false;
  if (b.slice(0, 15).every((n) => n === 0) && b[15] === 1) return true;
  const mapped = b.slice(0, 10).every((n) => n === 0) && b[10] === 0xff && b[11] === 0xff;
  const translated = b.slice(0, 8).every((n) => n === 0) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0;
  return (mapped || translated) && b[12] === 127;
}

const isLocalName = (h) => h === 'localhost' || h.endsWith('.localhost');

function parseTarget(rawUrl, { allowLoopback }) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { throw refused(); }
  if (url.username || url.password) throw refused();
  if (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:')) throw refused();
  const hostname = cleanHostname(url.hostname);
  if (!hostname) throw refused();
  if (isLocalName(hostname) && !allowLoopback) throw refused();
  return { url, hostname };
}

/* Is this address allowed? Public, or loopback under the test hook. */
const allowedAddress = (address, allowLoopback) => !isPrivateAddress(address) || (allowLoopback && isLoopbackAddress(address));

/* Resolve EVERY answer; one disallowed answer refuses the host. */
async function resolveTarget(rawUrl, { allowLoopback = false, lookup = dns.promises.lookup } = {}) {
  const { url, hostname } = parseTarget(rawUrl, { allowLoopback });
  const family = net.isIP(hostname);
  let addresses;
  if (family) addresses = [{ address: hostname, family }];
  else if (isLocalName(hostname)) addresses = [{ address: '127.0.0.1', family: 4 }];   // only reached under the hook
  else {
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); } catch { throw refused('the host does not resolve'); }
  }
  if (!Array.isArray(addresses)) addresses = addresses ? [addresses] : [];
  if (!addresses.length || addresses.some(({ address }) => !allowedAddress(address, allowLoopback))) throw refused();
  return { url, addresses };
}

/* The approved answer, and only it, for every lookup the socket makes. */
function createPinnedLookup(addresses) {
  const approved = addresses.map(({ address, family }) => ({ address, family: Number(family) }));
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, approved);
    else callback(null, approved[0].address, approved[0].family);
  };
}

// ── concurrency: 2 per host, 8 overall, in arrival order ──
/* A gate. The wait queue is CAPPED (`maxWaiting`): past it acquire() refuses at
 * once (ERR_BUSY), so a flood never grows an unbounded line. A waiter carries
 * its request's deadline: time spent waiting counts against it, and a waiter
 * whose deadline passes leaves the line (ERR_BUSY too: the slot was never ours,
 * the remote was never asked). */
function createGate({ perHost = PER_HOST, overall = OVERALL, maxWaiting = MAX_WAITING } = {}) {
  const active = new Map();
  let total = 0;
  const waiting = [];
  const can = (host) => total < overall && (active.get(host) || 0) < perHost;
  function take(host) { total++; active.set(host, (active.get(host) || 0) + 1); }
  function release(host) {
    total--;
    const n = (active.get(host) || 1) - 1;
    if (n) active.set(host, n); else active.delete(host);
    for (let i = 0; i < waiting.length; i++) {
      if (can(waiting[i].host)) { const w = waiting.splice(i, 1)[0]; clearTimeout(w.timer); take(w.host); w.resolve(); i--; }
    }
  }
  function acquire(host, { deadline = Infinity } = {}) {
    if (can(host)) { take(host); return Promise.resolve(); }
    if (waiting.length >= maxWaiting) return Promise.reject(new NetError('too many requests are waiting', 'ERR_BUSY'));
    return new Promise((resolve, reject) => {
      const w = { host, resolve, timer: null };
      if (Number.isFinite(deadline)) {
        w.timer = setTimeout(() => {
          const i = waiting.indexOf(w);
          if (i >= 0) waiting.splice(i, 1);
          reject(new NetError('waited too long for a free slot', 'ERR_BUSY'));
        }, Math.max(1, deadline - Date.now()));
        w.timer.unref?.();
      }
      waiting.push(w);
    });
  }
  return { acquire, release, stats: () => ({ total, waiting: waiting.length }) };
}

/* One request to one pinned target. Resolves { status, headers, body } or rejects. */
function requestOnce(target, { method, headers, body, maxBytes, deadline, connectTimeoutMs }) {
  const client = target.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(total); clearTimeout(connect); fn(v); } };
    const req = client.request(target.url, {
      method,
      headers,
      lookup: createPinnedLookup(target.addresses),
      agent: false,
      servername: net.isIP(target.url.hostname) ? undefined : target.url.hostname,
    }, (incoming) => {
      clearTimeout(connect);
      const status = incoming.statusCode || 0;
      if (REDIRECT_STATUSES.has(status) && incoming.headers.location) {
        // A redirect's body is never read: it would count against nothing.
        incoming.on('error', () => {});
        incoming.destroy();
        return done(resolve, { status, headers: incoming.headers, body: Buffer.alloc(0) });
      }
      const declared = Number(incoming.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        incoming.destroy();
        req.destroy();
        return done(reject, new NetError('the response is too large', 'ERR_TOO_LARGE'));
      }
      const chunks = [];
      let size = 0;
      incoming.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          incoming.destroy();
          req.destroy();
          done(reject, new NetError('the response is too large', 'ERR_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('error', (e) => done(reject, e));
      incoming.on('end', () => {
        if (status < 200 || status > 599) return done(reject, new NetError(`the remote answered status ${status}`, 'ERR_STATUS'));
        done(resolve, { status, headers: incoming.headers, body: Buffer.concat(chunks) });
      });
    });
    const left = Math.max(1, deadline - Date.now());
    const total = setTimeout(() => { req.destroy(); done(reject, new NetError('the remote took too long', 'ERR_TIMEOUT')); }, left);
    const connect = setTimeout(() => {
      if (!req.socket || req.socket.connecting) { req.destroy(); done(reject, new NetError('could not connect in time', 'ERR_TIMEOUT')); }
    }, Math.min(connectTimeoutMs, left));
    req.on('error', (e) => done(reject, e));
    req.end(body);
  });
}

/* Build a fetcher over one policy. `allowLoopback` is the test hook. */
function createNet({ allowLoopback = false, userAgent = 'Ring', lookup, gate = createGate(), refuseHost = null } = {}) {
  /* fetchGuarded(url, { method, headers, body, maxBytes, timeoutMs, sign, gate, maxRedirects })
   *   -> { status, headers, body (Buffer), url (the final one) }
   * `gate` replaces this fetcher's own gate for one call (lib/federation.js keeps
   * inbound key fetches on a gate of their own). `timeoutMs` is the whole call:
   * the wait for a slot, every hop and every body.
   * `sign(url, method, headers)` adds a signature for this hop (and may set
   * Date, Host, Digest). A POST's 3xx is returned, never followed. */
  async function fetchGuarded(rawUrl, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const maxBytes = opts.maxBytes ?? 1024 * 1024;
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    const maxRedirects = opts.maxRedirects ?? MAX_GET_REDIRECTS;
    let current = String(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // THE host normalizer first (lib/handles.js canonHost, P8 review F4): a
      // host it refuses is never asked, and one trailing dot is stripped from
      // the URL itself, so the name checked is the name resolved and asked.
      let u;
      try { u = new URL(current); } catch { throw refused(); }
      const h = canonHost(u.host);
      if (!h) throw refused('not a valid host');
      if (u.hostname.endsWith('.') && !u.hostname.startsWith('[')) { u.hostname = u.hostname.slice(0, -1); current = u.href; }
      // A blocked domain (the admin's list, P8) is never asked, on any hop.
      if (refuseHost?.(h)) throw new NetError('a blocked domain', 'ERR_BLOCKED');
      const target = await resolveTarget(current, { allowLoopback, lookup: opts.lookup || lookup });
      const headers = {};
      for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
      delete headers.cookie;
      delete headers.authorization;
      headers['accept-encoding'] = 'identity';
      headers['user-agent'] = userAgent;
      headers.host = target.url.host;
      if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
      if (opts.sign) Object.assign(headers, opts.sign(target.url, method, headers) || {});
      const hostKey = target.url.host;
      const g = opts.gate || gate;
      await g.acquire(hostKey, { deadline });
      let res;
      try {
        res = await requestOnce(target, { method, headers, body: opts.body, maxBytes, deadline, connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS });
      } finally { g.release(hostKey); }
      const location = res.headers.location;
      // A POST (a delivery) never follows a redirect: its 3xx is the answer.
      if (!REDIRECT_STATUSES.has(res.status) || !location || method !== 'GET') return { ...res, url: target.url.href };
      if (hop === maxRedirects) throw new NetError('too many redirects', 'ERR_REDIRECTS');
      current = new URL(location, target.url).href;
    }
    throw new NetError('too many redirects', 'ERR_REDIRECTS');
  }

  return { fetchGuarded, allowLoopback };
}

const AP_TYPES = /^application\/(activity\+json|ld\+json)\b/i;
const isApContentType = (ct) => AP_TYPES.test(String(ct || '').trim());

/* THE remote JSON reader: depth over `maxDepth` refused (null), prototype keys
 * dropped, anything that is not a JSON object or array refused. */
function parseJsonSafe(input, { maxDepth = 32 } = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123 || c === 91) { if (++depth > maxDepth) return null; }
    else if (c === 125 || c === 93) depth--;
  }
  let v;
  try {
    v = JSON.parse(text, (k, val) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : val));
  } catch { return null; }
  return v && typeof v === 'object' ? v : null;
}

module.exports = {
  createNet, createGate, resolveTarget, createPinnedLookup, parseJsonSafe, isApContentType,
  isPrivateAddress, isLoopbackAddress, NetError, MAX_GET_REDIRECTS,
};
