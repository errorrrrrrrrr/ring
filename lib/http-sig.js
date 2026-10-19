'use strict';
/* ── HTTP Signatures, draft-cavage, both ways (spec 5.1, 5.2) ─────────────────
 * On node:crypto, no package. What Mastodon sends and expects:
 *   Signature: keyId="<actor>#main-key",algorithm="rsa-sha256",
 *              headers="(request-target) host date digest",signature="<base64>"
 *
 * Signing (signHeaders): a POST signs `(request-target) host date digest`, a GET
 * `(request-target) host date accept`. `Date` (RFC 7231, GMT) is set at each
 * attempt by the caller's clock, never at queue time; `Digest: SHA-256=<base64>`
 * covers the exact body bytes sent.
 *
 * Verifying (verifyRequest), the checks of 5.2 that need no network, in order:
 *   3. the header parses; `algorithm` is rsa-sha256, or hs2019 (or absent) with
 *      an RSA key; the signed headers include (request-target), host and date,
 *      and on a POST digest (or content-digest)
 *   4. `Date` within one hour of now either way; `Host` is this host
 *   5. every digest header the signature COVERS (Digest, Content-Digest)
 *      equals the hash of the raw bytes; an uncovered one that disagrees with
 *      the bytes refuses the request (digestProblem)
 *   7. the key (the caller's `getKey(keyId, { refresh })`): verify; on a failure
 *      with a cached key, ONE refetch (key rotation) and verify again
 *   8. the signature value was not seen inside the window (replay; POSTs
 *      only, the caller passes no guard for a GET; persisted across restarts)
 * Steps 1, 2, 6 and 9 to 11 are the inbox's (routes/federation.js). A refusal is
 * { ok: false, status, reason }; reasons are for logs and tests, never shown.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SKEW_MS = 3600_000;

function digestOf(body) {
  return `SHA-256=${crypto.createHash('sha256').update(body ?? '').digest('base64')}`;
}

/* `keyId="a",algorithm="b",...` -> { keyId, algorithm, headers: [...], signature } or null. */
function parseSignature(header) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const out = {};
  const re = /\s*([a-zA-Z]+)\s*=\s*"([^"]*)"\s*(?:,|$)/y;
  let m;
  let pos = 0;
  while (pos < header.length) {
    re.lastIndex = pos;
    m = re.exec(header);
    if (!m) return null;
    out[m[1]] = m[2];
    pos = re.lastIndex;
  }
  if (!out.keyId || !out.signature) return null;
  return {
    keyId: out.keyId,
    algorithm: out.algorithm ? out.algorithm.toLowerCase() : '',
    headers: (out.headers || 'date').toLowerCase().split(/\s+/).filter(Boolean),
    signature: out.signature,
    created: out.created,
    expires: out.expires,
  };
}

/* The signing string over `names`, from a lowercase header map. */
function signingString(names, { method, path, headers }) {
  return names.map((n) => {
    if (n === '(request-target)') return `(request-target): ${method.toLowerCase()} ${path}`;
    const v = headers[n];
    return `${n}: ${Array.isArray(v) ? v.join(', ') : v}`;
  }).join('\n');
}

/* The headers to add to an outgoing request. `url` is a URL object (one hop). */
function signHeaders({ method, url, headers = {}, body, keyId, privateKey, nowMs }) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const add = {};
  add.date = new Date(nowMs).toUTCString();
  add.host = url.host;
  const m = method.toUpperCase();
  const names = ['(request-target)', 'host', 'date'];
  if (m === 'POST') {
    add.digest = digestOf(body);
    names.push('digest');
  } else if (h.accept) {
    names.push('accept');
  }
  const all = { ...h, ...add };
  const path = `${url.pathname}${url.search}`;
  const str = signingString(names, { method: m, path, headers: all });
  const signature = crypto.sign('sha256', Buffer.from(str), privateKey).toString('base64');
  add.signature = `keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`;
  return add;
}

/* A digest header against the body's bytes: 'match' when every algorithm it
 * names that this server knows (SHA-256, SHA-512) equals the body's and at least
 * one does; 'mismatch' when any known one differs; 'unknown' when it names none
 * this server knows (or is absent). `Digest` is RFC 3230 (`SHA-256=<base64>`),
 * `Content-Digest` RFC 9530 (`sha-256=:<base64>:`). */
const DIGEST_ALGS = { 'sha-256': 'sha256', 'sha-512': 'sha512' };
function digestState(name, value, body) {
  if (typeof value !== 'string' || !value.trim()) return 'unknown';
  const bytes = body ?? Buffer.alloc(0);
  let matched = false;
  for (const part of value.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const alg = DIGEST_ALGS[part.slice(0, i).trim().toLowerCase()];
    if (!alg) continue;
    let v = part.slice(i + 1).trim();
    if (name === 'content-digest') {
      const m = /^:([A-Za-z0-9+/=]*):$/.exec(v);
      if (!m) return 'mismatch';
      v = m[1];
    }
    if (v !== crypto.createHash(alg).update(bytes).digest('base64')) return 'mismatch';
    matched = true;
  }
  return matched ? 'match' : 'unknown';
}

/* The digest check of 5.2 step 5, bound to the signature (F1): every digest
 * header the signature COVERS must match the body, and a digest header it does
 * not cover may ride along only when it agrees (a request carrying a Digest and
 * a Content-Digest that disagree is refused, whichever is signed). `signed` is
 * the signature's header list. A POST whose signature covers neither is refused
 * before this (unsigned_digest). -> '' or the refusal reason. */
function digestProblem(headers, body, signed) {
  let covered = 0;
  for (const name of ['digest', 'content-digest']) {
    const state = digestState(name, headers[name], body);
    if (signed.includes(name)) {
      covered++;
      if (state !== 'match') return 'digest';
    } else if (state === 'mismatch') return 'digest_conflict';
  }
  return covered ? '' : 'unsigned_digest';
}

const isRsa = (pem) => {
  try { return crypto.createPublicKey(pem).asymmetricKeyType === 'rsa'; } catch { return false; }
};

function verifyWith(pem, str, signature) {
  try { return crypto.verify('sha256', Buffer.from(str), pem, Buffer.from(signature, 'base64')); }
  catch { return false; }
}

/* The replay guard (5.2 step 8): a bounded set of seen POST signature values,
 * each kept for the window (a Date may be an hour either side of now, so a
 * value can come back for two hours). With `dir`, it SURVIVES A RESTART: each
 * value's SHA-256 is appended to `<dir>/<YYYY-MM-DDTHH>.txt` (the hour it was
 * seen) and boot reads back every hour file still inside the window; prune()
 * forgets expired values and removes the hour files past it. Bounded twice:
 * `max` values in memory (oldest out) and `max` lines per hour file (past it a
 * value is still checked in memory, not written). Without `dir` (unit tests)
 * it is memory only. */
function createReplayGuard({ windowMs = 2 * SKEW_MS, max = 200_000, now = Date.now, dir = '' } = {}) {
  const seen = new Map();   // sha256(signature) -> expiry
  const HOUR = 3600_000;
  const HOUR_FILE = /^(\d{4}-\d{2}-\d{2}T\d{2})\.txt$/;
  let loaded = !dir;
  let hourKey = '';
  let hourLines = 0;
  const hash = (sig) => crypto.createHash('sha256').update(String(sig)).digest('hex');
  const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);
  const hourStart = (key) => Date.parse(`${key}:00:00.000Z`);
  // A value written in hour H expires by the end of H plus the window.
  const fileExpiry = (key) => hourStart(key) + HOUR + windowMs;

  function evict(t) {
    for (const [k, e] of seen) { if (e <= t || seen.size >= max) seen.delete(k); if (seen.size < max * 0.99) break; }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    const t = now();
    for (const f of files.sort()) {
      const m = HOUR_FILE.exec(f);
      if (!m || fileExpiry(m[1]) <= t) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const exp = fileExpiry(m[1]);
      for (const line of text.split('\n')) {
        if (!/^[0-9a-f]{64}$/.test(line)) continue;
        if (seen.size >= max) evict(t);
        seen.set(line, exp);
      }
    }
  }

  function persist(h, t) {
    if (!dir) return;
    const key = hourOf(t);
    if (key !== hourKey) { hourKey = key; hourLines = 0; }
    if (hourLines >= max) return;
    hourLines++;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, `${key}.txt`), `${h}\n`, { mode: 0o600 });
    } catch { /* memory still holds it */ }
  }

  return {
    seen(sig) {
      load();
      const t = now();
      const h = hash(sig);
      const exp = seen.get(h);
      if (exp && exp > t) return true;
      if (seen.size >= max) evict(t);
      seen.set(h, t + windowMs);
      persist(h, t);
      return false;
    },
    prune() {
      load();
      const t = now();
      for (const [k, e] of seen) if (e <= t) seen.delete(k);
      if (!dir) return 0;
      let n = 0;
      let files = [];
      try { files = fs.readdirSync(dir); } catch { return 0; }
      for (const f of files) {
        const m = HOUR_FILE.exec(f);
        if (m && fileExpiry(m[1]) <= t) { fs.rmSync(path.join(dir, f), { force: true }); n++; }
      }
      return n;
    },
    size: () => { load(); return seen.size; },
  };
}

/* Verify a request (5.2 steps 3, 4, 5, 7, 8).
 *   req      { method, path (with query), headers (lowercase), body (Buffer|undefined) }
 *   host     this server's host (`Host` must equal it)
 *   getKey   async (keyId, { refresh }) -> { pem, owner, cached } | null
 *   replay   createReplayGuard()
 * -> { ok: true, keyId, owner } | { ok: false, status, reason } */
async function verifyRequest(req, { host, getKey, replay, nowMs }) {
  const method = req.method.toUpperCase();
  const h = req.headers;
  const sig = parseSignature(h.signature);
  if (!sig) return { ok: false, status: 401, reason: h.signature ? 'signature_unparsable' : 'unsigned' };
  if (sig.algorithm && sig.algorithm !== 'rsa-sha256' && sig.algorithm !== 'hs2019') return { ok: false, status: 401, reason: 'algorithm' };
  const need = ['(request-target)', 'host', 'date'];
  for (const n of need) if (!sig.headers.includes(n)) return { ok: false, status: 401, reason: `unsigned_${n}` };
  if (method === 'POST' && !sig.headers.includes('digest') && !sig.headers.includes('content-digest')) return { ok: false, status: 401, reason: 'unsigned_digest' };
  for (const n of sig.headers) {
    if (n !== '(request-target)' && h[n] === undefined) return { ok: false, status: 401, reason: `missing_${n}` };
  }

  const date = Date.parse(h.date);
  if (!Number.isFinite(date) || Math.abs(nowMs - date) > SKEW_MS) return { ok: false, status: 401, reason: 'date' };
  if (String(h.host || '').toLowerCase() !== String(host).toLowerCase()) return { ok: false, status: 401, reason: 'host' };

  if (method === 'POST') {
    const why = digestProblem(h, req.body, sig.headers);
    if (why) return { ok: false, status: 401, reason: why };
  }

  const str = signingString(sig.headers, { method, path: req.path, headers: h });
  let key;
  // A getKey error carrying a status (a spent fetch budget, a full fetch queue:
  // 429) is the answer; any other failure is an unknown key.
  try { key = await getKey(sig.keyId, { refresh: false }); } catch (e) { if (e?.status) return { ok: false, status: e.status, reason: e.reason || 'key_busy' }; key = null; }
  if (!key?.pem || !isRsa(key.pem)) return { ok: false, status: 401, reason: 'key' };
  let good = verifyWith(key.pem, str, sig.signature);
  if (!good && key.cached) {
    // Key rotation: one refetch (the cache rate-limits it per actor), then once more.
    let fresh = null;
    try { fresh = await getKey(sig.keyId, { refresh: true }); } catch (e) { if (e?.status) return { ok: false, status: e.status, reason: e.reason || 'key_busy' }; fresh = null; }
    if (fresh?.pem && isRsa(fresh.pem) && fresh.pem !== key.pem) {
      key = fresh;
      good = verifyWith(key.pem, str, sig.signature);
    }
  }
  if (!good) return { ok: false, status: 401, reason: 'signature' };
  if (replay?.seen(sig.signature)) return { ok: false, status: 401, reason: 'replay' };
  return { ok: true, keyId: sig.keyId, owner: key.owner };
}

module.exports = { signHeaders, verifyRequest, parseSignature, signingString, digestOf, digestProblem, createReplayGuard, SKEW_MS };
