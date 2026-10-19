'use strict';
/* ── Names and handles (spec 2.4, 3.1) ────────────────────────────────────────
 * A member's NAME (stored as `slug`) is inside permanent actor URLs, so it is
 * immutable, public the moment it is taken, and retired forever when its member
 * is deleted.
 *
 * THE HANDLE RULE. Every stored field that can point at a member holds a handle:
 * a bare `name` is a member of this server, `name@host` a member of another
 * (lowercase, host in punycode, `:port` only in tests). `name@<this host>` is
 * never written: toHandle() folds it to the bare name. toHandle() is the one
 * writer of a handle; P5's actor cache (`actorFor`) will be the one reader of a
 * remote one.
 */
const net = require('node:net');

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

const RESERVED = new Set([
  'api', 'app', 'login', 'signup', 'logout', 'reset', 'rings', 'ring', 'feed', 'assets',
  'static', 'admin', 'help', 'about', 'settings', 'me', 'health', 'users', 'actor', 'inbox',
  'outbox', 'nodeinfo', 'media', 'authorize_interaction', 'ns', 'well-known',
]);

/* The shape alone: 1 to 30 chars, a-z 0-9 and inner hyphens. */
function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/* May this name be taken at all? Shape and the reserved list; the caller adds
 * "not a member" and "not retired". */
function nameAllowed(name) {
  return validName(name) && !RESERVED.has(name);
}

const REMOTE_NAME_RE = /^[a-z0-9_](?:[a-z0-9_.-]{0,62}[a-z0-9_])?$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const LABEL_RE = /^[a-z0-9_-]{1,63}$/;

/* THE host normalizer (P8 review F4). Every door that compares or fetches a
 * host spells it through here first: the admin's and the members' domain
 * blocks (hostBlocked, blocksHandle, hostUnder), the federation and actor
 * code's hostOf, the fetcher's refuse check (lib/net.js) and BLOCKED_DOMAINS.
 * `raw` is a host as in a URL or a handle, perhaps with a port:
 *   lowercase; ONE trailing dot stripped (`evil.example.` is `evil.example`
 *   to DNS, so it is to every comparison); IDN to ASCII (punycode); an IPv4
 *   literal in its dotted form, an IPv6 literal bracketed and compressed
 *   (`[2001:db8::1]`, as URL writes it); a port kept.
 * Refused (''): an empty label (`a..b`, `.a`, a second trailing dot), a label
 * outside a-z 0-9 _ -, a bad port, anything URL cannot read as a host. A
 * caller that must decide on a refused host treats it as blocked (fail closed). */
function canonHost(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > 300) return '';
  let host;
  let port = '';
  if (s.startsWith('[')) {
    const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(s);
    if (!m || !net.isIPv6(m[1])) return '';
    host = `[${m[1]}]`;
    port = m[2] || '';
  } else if (net.isIPv6(s)) {
    host = `[${s}]`;
  } else {
    const m = /^([^:]*)(?::(\d{1,5}))?$/.exec(s);
    if (!m) return '';
    host = m[1];
    port = m[2] || '';
  }
  if (port && !(Number(port) >= 1 && Number(port) <= 65535)) return '';
  if (/[\s/?#@\\%]/.test(host)) return '';
  let out;
  if (host.startsWith('[')) {
    try { out = new URL(`http://${host}/`).hostname; } catch { return ''; }
  } else {
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (!host || host.split('.').some((l) => !l)) return '';
    const last = host.slice(host.lastIndexOf('.') + 1);
    // Plain ASCII whose last label cannot be numeric is already canonical;
    // anything else (unicode, punycode, a possible IPv4 form) goes through URL.
    if (/^[a-z0-9_.-]+$/.test(host) && !/(^|\.)xn--/.test(host) && /[g-wyz_-]/.test(last)) out = host;
    else {
      try { out = new URL(`http://${host}/`).hostname; } catch { return ''; }
    }
    if (out.length > 253 || !out.split('.').every((l) => LABEL_RE.test(l))) return '';
  }
  return port ? `${out}:${port}` : out;
}

/* `host[:port]` -> [host, port]: an IPv6 literal keeps its brackets. */
function splitHostPort(h) {
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(h);
  return m && (!m[1].startsWith('[') || m[1].endsWith(']')) ? [m[1], m[2] || ''] : [h, ''];
}
const isIpLiteral = (host) => net.isIPv4(host) || (host.startsWith('[') && host.endsWith(']'));

/* The canonical host of a URL (canonHost of URL's own host). A host the
 * normalizer refuses comes back as URL wrote it, lowercased: it equals no
 * canonical host, and hostBlocked refuses it. '' when it is not a URL. */
function hostOfUrl(u) {
  let x;
  try { x = new URL(u); } catch { return ''; }
  return canonHost(x.host) || x.host.toLowerCase();
}

/* A host as stored: canonHost, then a real domain name (HOST_RE). A port only
 * with `allowPort` (tests, which also allow `localhost` and any IPv4 literal);
 * an IP literal (IPv4, or bracketed IPv6) only with `allowIp` (a domain
 * block may name an address, P8 review). */
function normalizeHost(raw, { allowPort = false, allowIp = false } = {}) {
  const c = canonHost(raw);
  if (!c) return '';
  const [host, port] = splitHostPort(c);
  if (port && !allowPort) return '';
  const ok = isIpLiteral(host) ? (allowIp || (allowPort && net.isIPv4(host))) : (HOST_RE.test(host) || (allowPort && host === 'localhost'));
  return ok ? c : '';
}

/* THE handle writer. Accepts `name`, `name@host`, `@name@host`, `acct:name@host`.
 * `localHost` is this server's host (lib/urls.js hostOf). Returns '' when the
 * input is not a handle. A local name is checked for shape only; whether it is a
 * member is the caller's question. */
function toHandle(raw, localHost, { allowPort = false } = {}) {
  let s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('acct:')) s = s.slice(5);
  if (s.startsWith('@')) s = s.slice(1);
  const at = s.indexOf('@');
  if (at < 0) return validName(s) ? s : '';
  const name = s.slice(0, at);
  const host = normalizeHost(s.slice(at + 1), { allowPort });
  if (!host) return '';
  const local = normalizeHost(localHost || '', { allowPort: true });
  if (local && host === local) return validName(name) ? name : '';
  return REMOTE_NAME_RE.test(name) ? `${name}@${host}` : '';
}

/* Is `s` a handle AS STORED (the shape toHandle writes), not merely parseable
 * into one? A bare valid name, or `name@host` with the host already in stored
 * form. Up to MAX_HANDLE characters: 64 (remote name) + 1 + 253 (host) + a test
 * port. A read path keeps only these and never cuts one (federation-r1-04). */
const MAX_HANDLE = 330;
function isHandle(s, { allowPort = false } = {}) {
  if (typeof s !== 'string' || !s || s.length > MAX_HANDLE) return false;
  const at = s.indexOf('@');
  if (at < 0) return validName(s);
  const name = s.slice(0, at);
  const host = s.slice(at + 1);
  return REMOTE_NAME_RE.test(name) && !!host && normalizeHost(host, { allowPort }) === host;
}

/* Does `host` (as in a URL or a handle, perhaps with a port) fall under the
 * blocked `domain`: the domain itself or a subdomain of it (spec 6.1, 6.3)?
 * Both sides through canonHost first (a refused one compares as written, so
 * it matches nothing it should not). A domain written with a port (tests
 * only) matches that host and port exactly; an IP literal matches only
 * itself, any port. */
function hostUnder(host, domain) {
  const h = canonHost(host) || String(host || '').toLowerCase();
  const d = canonHost(domain) || String(domain || '').toLowerCase();
  if (!h || !d) return false;
  const [dh, dp] = splitHostPort(d);
  if (dp) return h === d;
  const [bare] = splitHostPort(h);
  if (isIpLiteral(dh)) return bare === dh;
  return bare === dh || bare.endsWith(`.${dh}`);
}

/* THE site of a host (P8 review F3): what one operator is taken to hold, so
 * a budget or a cap keyed by it is not one per subdomain or per port. No
 * public-suffix list ships (zero new packages), so the registrable domain is
 * approximated: the last two labels, or three when the second-to-last is a
 * common second-level label under a two-letter country code (`co.uk`,
 * `com.au`, `ne.jp`, ...). An IPv4 literal is itself, an IPv6 literal its
 * /48 (one site's allocation). The port never counts. Its honest limit: a
 * shared platform's tenants (`a.example.io`, `b.example.io`) share one site,
 * which only ever lowers what each may send. */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'or', 'ne', 'go', 'gob', 'mil', 'nom', 'ltd', 'plc', 'sch', 'gv', 'lg', 'ad', 'ed', 'gr']);
function siteOf(host) {
  const c = canonHost(host) || String(host || '').toLowerCase();
  const [h] = splitHostPort(c);
  if (!h) return '';
  if (net.isIPv4(h)) return h;
  if (h.startsWith('[')) {
    const { clientIdOf, prefix48Of } = require('./rate-limit');
    return prefix48Of(clientIdOf(h.slice(1, -1))) || h;
  }
  const labels = h.split('.');
  const n = labels.length;
  if (n <= 2) return h;
  const take = labels[n - 1].length === 2 && SECOND_LEVEL.has(labels[n - 2]) ? 3 : 2;
  return labels.slice(-take).join('.');
}

function isLocalHandle(handle) {
  return typeof handle === 'string' && validName(handle);
}

module.exports = { NAME_RE, RESERVED, MAX_HANDLE, validName, nameAllowed, normalizeHost, canonHost, hostOfUrl, splitHostPort, isIpLiteral, siteOf, toHandle, isHandle, isLocalHandle, hostUnder };
