'use strict';
/* ── The remote actor cache (spec 2.4, 3.10, 5.3) ─────────────────────────────
 * THE one reader of a remote handle (`actorFor` in the spec's words): handle to
 * actor id and back, and the keys that verify their signatures. A remote actor
 * lives in `fed/actors/<sha256(actor id)>.json`:
 *   { id, handle, type, inbox, shared_inbox, key_id, key_pem, name, url,
 *     fetched_at, refetched_at }
 * held in memory once read (one process per data dir), with a handle index.
 *
 * AN ACTOR DOCUMENT IS ACCEPTED ONLY WHEN (5.3):
 *   - its `id` equals the URL fetched (else it is fetched once more by its id,
 *     on the same host, which must then match); every AP document is fetched
 *     with REDIRECTS OFF, so the URL fetched is always the URL asked for;
 *   - `inbox`, `endpoints.sharedInbox`, `outbox` and `publicKey.id` are on the
 *     actor's host (an inbox elsewhere would make this server POST wherever an
 *     attacker points), and `publicKey.owner` is the actor id;
 *   - its host is not this server's (a local member is never cached);
 *   - WebFinger for `acct:<preferredUsername>@<host>` on that host answers with
 *     the same actor id (2.4). The HANDLE comes from that pair, through
 *     lib/handles.js toHandle, and binds one to one: a handle already bound to
 *     another actor id refuses the newcomer (fail closed; the old rows keep
 *     pointing at whoever they named).
 *
 * Every fetch is a GET through lib/net.js (the SSRF guard), signed by the
 * instance actor (5.1); WebFinger goes unsigned (it is public everywhere). A
 * document must say `application/activity+json` or `application/ld+json`
 * (an HTML page is never read as JSON), 1 MB, 10 s; a fetch an INBOUND request
 * needs (its key, a forwarded activity) gets 5 s (the caller's `timeoutMs`).
 *
 * Freshness: an entry is fresh for 24 h; a stale one is used and refreshed in
 * the background. keyFor(keyId, { refresh: true }) refetches at once for a
 * signature that failed with the cached key (rotation), at most once every 10
 * minutes per actor (5.2 step 7). A keyId whose fetch FAILED is not fetched
 * again for 5 minutes (a bounded negative cache, 10 000 keyIds, oldest out);
 * a forwarded activity's id is held in the same cache (fetchForwarded).
 *
 * P6:
 *   - GONE (5.3): a 410 for a cached actor, or a Delete{Person} signed by the
 *     actor itself (lib/federation.js), makes markGone(id): the record keeps only
 *     id, handle and `gone_at`, so the handle stays bound for good and nothing
 *     verifies with its key again; resolve() of a gone actor throws. `onGone`
 *     (lib/federation.js) removes what rows here still name it.
 *   - Update{Person} IN: applyUpdate(doc) replaces the cached fields after the
 *     same checks a fetch gets (id, inbox, shared inbox, outbox and key on the
 *     actor's host, the key's owner), and the handle must stay the one bound:
 *     nothing in P6 moves a handle (a new preferredUsername is refused).
 *   - the record keeps the bio as a node tree (lib/remote-html.js, never HTML),
 *     the avatar's URL and its media-cache id (lib/remote-media.js, served to
 *     members here only), and a Ring server's switches (`ring.stamps_off`,
 *     `ring.comments_off`). F7: the avatar is fetched only for an actor some
 *     member's rows name (`named`, markNamed: follows either way, friends,
 *     comments, From elsewhere), only from the actor's own host or a host its
 *     server is recorded serving media from, and a new avatar URL at most once
 *     an hour per actor (`avatar_src`, `avatar_at`).
 *   - a TRANSIENT WebFinger failure on a refetch keeps a bound actor bound: only
 *     an ANSWER that disagrees (a 200 naming another actor or none, a 404 or
 *     410) unbinds or refuses it.
 *   - UNBOUND KEYS (the Pleroma/Akkoma instance-actor case): an `Application`
 *     or `Service` actor whose WebFinger does not answer with it may still sign a
 *     GET (authorized fetch reads only what a stranger may read) when the caller
 *     asks `allowUnbound`; it is cached with NO handle (`unbound: true`), so it
 *     can never act: lib/federation.js refuses it on every inbox POST.
 *   - lookupHandle(handle): a typed `name@host` resolved by WebFinger, for
 *     Befriend and the lookup (the answer's canonical handle may differ: a split
 *     domain).
 *   - the 90-day prune (3.10): an actor unused for 90 days and named by no row
 *     here goes; a gone record stays (it keeps the handle bound).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { parseJsonSafe, isApContentType } = require('./net');
const { signHeaders } = require('./http-sig');
const { toHandle, isHandle, hostOfUrl: canonicalHostOfUrl } = require('./handles');
const { plainLine } = require('./ring');
const { parseRemoteHtml, settleTree } = require('./remote-html');
const urls = require('./urls');

const FRESH_MS = 24 * 3600_000;
const REFETCH_MS = 10 * 60_000;
const NEG_MS = 5 * 60_000;
const NEG_MAX = 10_000;
const ACTOR_TYPES = new Set(['Person', 'Service', 'Application', 'Group', 'Organization']);
const SERVER_TYPES = new Set(['Application', 'Service']);   // may sign a GET unbound
const PRUNE_AFTER_MS = 90 * 24 * 3600_000;
const USED_WRITE_MS = 24 * 3600_000;
const AVATAR_MAX = 2 * 1024 * 1024;
const AVATAR_CHANGE_MS = 3600_000;   // one new avatar per actor per hour (F7)
const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

class ActorError extends Error {
  // `httpStatus`, never `status`: a getKey error with a `status` is an answer
  // (lib/http-sig.js: 429 busy), and a remote's 404 is no answer of ours.
  constructor(reason, httpStatus) { super(`actor refused: ${reason}`); this.reason = reason; this.code = 'ACTOR_REFUSED'; if (httpStatus) this.httpStatus = httpStatus; }
}

// THE host normalizer's reading of a URL (lib/handles.js, P8 review F4).
const hostOfUrl = canonicalHostOfUrl;
const sameHost = (u, host) => typeof u === 'string' && !!u && hostOfUrl(u) === host;
const stripFragment = (u) => String(u || '').split('#')[0];

function createActors({ paths, net, keys, cfg, media = null, mediaHostsOf = () => [], logger = console }) {
  const dir = paths.fedActorsDir;
  const byId = new Map();
  const byHandle = new Map();
  const used = new Map();   // id -> ms of the last use this process saw (persisted daily)
  let onGone = () => {};
  let loaded = false;
  const inflight = new Map();
  const localOrigin = () => cfg.publicOrigin;
  const localHost = () => urls.hostOf(localOrigin()).toLowerCase();
  const fileOf = (id) => path.join(dir, `${crypto.createHash('sha256').update(id).digest('hex')}.json`);

  function index(rec) {
    byId.set(rec.id, rec);
    if (rec.handle) byHandle.set(rec.handle, rec.id);
  }
  const usable = (rec) => !!rec && !rec.gone_at;

  function load() {
    if (loaded) return;
    loaded = true;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const rec = readJSON(path.join(dir, f), null);
        if (rec && typeof rec.id === 'string' && (isHandle(rec.handle, { allowPort: true }) || ((rec.unbound === true || rec.group === true) && rec.handle === ''))) index(rec);
      } catch (e) { logger.error(`[actors] skipped ${f}: ${e.message}`); }
    }
  }

  /* May this record's avatar be fetched (F7)? Its host is the actor's own, or a
   * host the actor's server is recorded serving media from (lib/hosts.js, the
   * images of its posts on a friend's wall). */
  function avatarHostOk(rec) {
    const h = hostOfUrl(rec.avatar_url);
    const own = hostOfUrl(rec.id);
    return !!h && (h === own || (mediaHostsOf(own) || []).includes(h));
  }

  /* The avatar into the media cache (5.7, F7): only for an actor a member's rows
   * name (`named`: a follow either way, a friendship, a comment, a From
   * elsewhere row; markNamed), from an allowed host, and at most one NEW avatar
   * URL an hour per actor (an Update{Person} per minute cannot make this server
   * fetch a URL per minute). Anything else keeps the previous copy, or none. */
  function settleAvatar(rec, prev) {
    const carry = () => {
      rec.avatar = prev?.avatar || '';
      if (prev?.avatar_src) rec.avatar_src = prev.avatar_src; else delete rec.avatar_src;
      if (prev?.avatar_at) rec.avatar_at = prev.avatar_at; else delete rec.avatar_at;
    };
    if (!media || rec.gone_at) return;
    if (!rec.named || !rec.avatar_url || !avatarHostOk(rec)) {
      rec.avatar = '';
      delete rec.avatar_src;
      if (prev?.avatar_at) rec.avatar_at = prev.avatar_at;
      return;
    }
    if (prev?.avatar && prev.avatar_src === rec.avatar_url) { carry(); return; }
    const last = Date.parse(prev?.avatar_at || 0) || 0;
    if (last && clock.now() - last < AVATAR_CHANGE_MS) { carry(); return; }
    try { rec.avatar = media.want(rec.avatar_url, { maxBytes: AVATAR_MAX, kind: 'avatar' }); } catch { rec.avatar = ''; }
    rec.avatar_src = rec.avatar_url;
    rec.avatar_at = clock.iso();
  }

  function save(rec) {
    const prev = byId.get(rec.id);
    if (prev?.named && !rec.gone_at) rec.named = true;
    settleAvatar(rec, prev);
    writeJSON(fileOf(rec.id), rec);
    index(rec);
  }

  // ── fetching (instance-signed GETs through the guard) ──

  const sign = (accept) => (url, method, headers) => signHeaders({
    method, url, headers: { ...headers, accept }, keyId: `${localOrigin()}/actor#main-key`, privateKey: keys.instancePrivateKey(), nowMs: clock.now(),
  });

  /* GET an AP document: { doc, url } or throws. REDIRECTS OFF (F2): every
   * object this server reads from another one is read at the URL it asked for,
   * so the final URL IS the requested one, and a 3xx is a refusal. An open
   * redirect on a victim's host can never make a document the attacker serves
   * look like the victim's. `gate` (lib/net.js) is the caller's choice: inbound
   * key fetches pass their own. */
  async function getDoc(url, { gate, timeoutMs = 10_000, signAs = null } = {}) {
    let res;
    // `signAs` (P7, spec 5.1): a fetch of a room object made on a member's
    // behalf is signed as that member ({ keyId, privateKey }), not the instance.
    const signer = signAs ? (u, method, headers) => signHeaders({ method, url: u, headers: { ...headers, accept: AP_ACCEPT }, keyId: signAs.keyId, privateKey: signAs.privateKey, nowMs: clock.now() }) : sign(AP_ACCEPT);
    try {
      res = await net.fetchGuarded(url, {
        headers: { accept: AP_ACCEPT }, sign: signer, maxBytes: 1024 * 1024, timeoutMs, maxRedirects: 0, gate,
      });
    } catch (e) {
      if (e?.code === 'ERR_REDIRECTS') throw new ActorError('redirect');
      throw e;
    }
    if (res.status !== 200) throw new ActorError(`status ${res.status}`, res.status);
    if (res.url !== new URL(url).href) throw new ActorError('redirect');
    if (!isApContentType(res.headers['content-type'])) throw new ActorError('content type');
    const doc = parseJsonSafe(res.body);
    if (!doc || Array.isArray(doc)) throw new ActorError('not a JSON object');
    return { doc, url: res.url };
  }

  // Under the test hook a loopback host, or any *.localhost name (lib/net.js
  // resolves those to loopback; an IDN fake lives there), is asked over http.
  const schemeOf = (host) => (cfg.fedTestLoopback && (/^(127\.|localhost|\[::1\])/.test(host) || /\.localhost(:\d+)?$/.test(host)) ? 'http' : 'https');

  /* WebFinger for acct:<name>@<host>: the JRD's links, or throws. */
  async function webfinger(name, host, { gate, timeoutMs = 10_000 } = {}) {
    const url = `${schemeOf(host)}://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${name}@${host}`)}`;
    const res = await net.fetchGuarded(url, { headers: { accept: 'application/jrd+json, application/json' }, maxBytes: 256 * 1024, timeoutMs, gate });
    if (res.status !== 200) throw new ActorError(`webfinger status ${res.status}`, res.status);
    if (!/^application\/(jrd\+json|json)\b/i.test(String(res.headers['content-type'] || ''))) throw new ActorError('webfinger content type');
    const jrd = parseJsonSafe(res.body);
    return Array.isArray(jrd?.links) ? jrd.links.filter((l) => l && typeof l === 'object') : [];
  }

  async function webfingerSelf(name, host, opts = {}) {
    const links = await webfinger(name, host, opts);
    const self = links.find((l) => l.rel === 'self' && /^application\/(activity\+json|ld\+json)/.test(String(l.type || '')));
    return typeof self?.href === 'string' ? self.href : '';
  }

  function keyOf(doc, keyId) {
    const list = Array.isArray(doc.publicKey) ? doc.publicKey : [doc.publicKey];
    return list.find((k) => k && typeof k === 'object' && (!keyId || k.id === keyId)) || null;
  }

  /* Did WebFinger ANSWER (a 404 or 410 says "no such account"; a 200 that
   * is not JRD is an answer too), or was it only unreachable? */
  function webfingerAnswered(e) {
    if (!(e instanceof ActorError)) return false;   // the network: a timeout, a reset, a refused socket
    if (e.httpStatus) return e.httpStatus === 404 || e.httpStatus === 410;
    return true;
  }

  /* The fields every check (5.3) leaves to read from a validated document. */
  function profileOf(doc) {
    const icon = Array.isArray(doc.icon) ? doc.icon[0] : doc.icon;
    const iconUrl = icon && typeof icon === 'object' ? (typeof icon.url === 'string' ? icon.url : icon.url?.href) : '';
    const bio = typeof doc.summary === 'string' ? parseRemoteHtml(doc.summary, { maxText: 2000 }) : null;
    const ring = doc.ring && typeof doc.ring === 'object' && doc.ring.v === 1 ? doc.ring : null;
    return {
      name: plainLine(typeof doc.name === 'string' ? doc.name : '', 60),
      url: typeof doc.url === 'string' && /^https?:\/\//.test(doc.url) ? doc.url.slice(0, 600) : '',
      bio: bio ? bio.tree : [],
      avatar_url: typeof iconUrl === 'string' && /^https?:\/\//.test(iconUrl) && iconUrl.length <= 2000 ? iconUrl : '',
      outbox: typeof doc.outbox === 'string' ? doc.outbox : '',
      ring_switches: ring ? { stamps_off: ring.stamps_off === true, comments_off: ring.comments_off === true } : null,
    };
  }

  /* The document's own checks (5.3) that need no fetch: -> { host, key, shared }. */
  function checkDoc(doc, keyId) {
    if (!ACTOR_TYPES.has(doc.type)) throw new ActorError('not an actor');
    const host = hostOfUrl(doc.id);
    if (!host || host === localHost()) throw new ActorError('host');
    if (!sameHost(doc.inbox, host)) throw new ActorError('inbox on another host');
    const shared = doc.endpoints && typeof doc.endpoints === 'object' ? doc.endpoints.sharedInbox : undefined;
    if (shared !== undefined && !sameHost(shared, host)) throw new ActorError('shared inbox on another host');
    if (doc.outbox !== undefined && !sameHost(doc.outbox, host)) throw new ActorError('outbox on another host');
    const key = keyOf(doc, keyId);
    if (!key || typeof key.publicKeyPem !== 'string' || !sameHost(key.id, host) || key.owner !== doc.id) throw new ActorError('key');
    return { host, key, shared };
  }

  /* Validate an actor document fetched from `fetchedUrl` (5.3). Returns the record. */
  async function accept(doc, fetchedUrl, { keyId, gate, timeoutMs, allowUnbound = false } = {}) {
    if (typeof doc.id !== 'string' || doc.id !== fetchedUrl) throw new ActorError('id is not the fetched URL');
    const { host, key, shared } = checkDoc(doc, keyId);
    const prev = byId.get(doc.id);
    if (prev?.gone_at) throw new ActorError('gone');
    const record = (handle, extra = {}) => ({
      id: doc.id,
      handle,
      type: doc.type,
      inbox: doc.inbox,
      shared_inbox: typeof shared === 'string' ? shared : '',
      key_id: key.id,
      key_pem: key.publicKeyPem,
      ...profileOf(doc),
      avatar: prev?.avatar || '',
      fetched_at: clock.iso(),
      refetched_at: prev?.refetched_at || '',
      used_at: prev?.used_at || '',
      ...extra,
    });
    // A RING'S GROUP (P7, spec 4.7): a Group carrying the Ring term has no
    // WebFinger and no handle. It is cached as a `group` record: its key
    // verifies what the Group signs, and nothing else may use it (it names no
    // one: lib/federation.js routes what it signs to the ring tables only, and
    // only for the ring whose `ap_id` it is).
    if (doc.type === 'Group' && doc.ring && typeof doc.ring === 'object' && doc.ring.v === 1) return record('', { group: true, name: plainLine(typeof doc.name === 'string' ? doc.name : '', 60) });
    const handle = toHandle(`${String(doc.preferredUsername || '')}@${host}`, localHost(), { allowPort: cfg.fedTestLoopback });
    const unbound = () => {
      if (!allowUnbound || !SERVER_TYPES.has(doc.type)) return null;
      return record('', { unbound: true });
    };
    if (!handle?.includes('@')) { const u = unbound(); if (u) return u; throw new ActorError('handle'); }
    const bound = byHandle.get(handle);
    if (bound && bound !== doc.id) throw new ActorError('handle bound to another actor');
    let self = '';
    let answered = true;
    try { self = await webfingerSelf(String(doc.preferredUsername), host, { gate, timeoutMs }); }
    catch (e) { if (e?.code === 'ERR_BUSY') throw e; self = ''; answered = webfingerAnswered(e); }
    if (self !== doc.id) {
      // A TRANSIENT WebFinger failure (no answer: a timeout, a refused socket,
      // a 5xx or 429) never downgrades an actor already bound to this very
      // handle: the binding stays until a refetch that IS answered disagrees.
      if (!answered && prev && !prev.unbound && prev.handle === handle) return record(handle);
      const u = unbound();
      if (u) return u;
      throw new ActorError('webfinger does not answer with this actor');
    }
    return record(handle);
  }

  /* Fetch, validate and cache the actor at `id`. A document whose id is another
   * URL on the same host is fetched once more by that id (redirects are off, so
   * this is the one way a canonical id differs from the URL asked for). */
  async function fetchActor(id, { keyId, gate, timeoutMs, allowUnbound = false } = {}) {
    let doc;
    let url;
    try {
      ({ doc, url } = await getDoc(id, { gate, timeoutMs }));
      if (doc.id !== url && typeof doc.id === 'string' && sameHost(doc.id, hostOfUrl(url))) {
        ({ doc, url } = await getDoc(doc.id, { gate, timeoutMs }));   // once more, by its own id
      }
    } catch (e) {
      // A 410 for an actor this server knows: it is gone (5.3).
      if (e?.httpStatus === 410 && usable(byId.get(id))) markGone(id);
      throw e;
    }
    const rec = await accept(doc, url, { keyId, gate, timeoutMs, allowUnbound });
    save(rec);
    return rec;
  }

  function once(id, fn) {
    if (inflight.has(id)) return inflight.get(id);
    const p = fn().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  const stale = (rec) => clock.now() - Date.parse(rec.fetched_at || 0) > FRESH_MS;

  function refreshLater(rec) {
    once(rec.id, () => fetchActor(rec.id)).catch((e) => logger.error(`[actors] refresh of ${rec.id} failed: ${e.message}`));
  }

  /* The cached record for an actor id, or null (a gone one included). Sync. */
  function get(id) { load(); return byId.get(id) || null; }
  const touch = (id) => { used.set(id, clock.now()); };

  /* The record for `id`: cached (refreshed in the background when stale), else
   * fetched. A gone actor throws; an unbound one is never a person to act on. */
  async function resolve(id, { gate, timeoutMs } = {}) {
    const rec = get(id);
    if (rec?.gone_at) throw new ActorError('gone', 410);
    if (rec && !rec.unbound) { touch(id); if (stale(rec)) refreshLater(rec); return rec; }
    const fresh = await once(id, () => fetchActor(id, { gate, timeoutMs }));
    if (fresh.unbound) throw new ActorError('unbound');
    touch(id);
    return fresh;
  }

  // ── the negative cache (F4): a keyId whose fetch failed is not fetched again
  // for NEG_MS, so one client cannot make this server fetch the same dead key
  // over and over. Bounded (oldest out). A local congestion failure (ERR_BUSY:
  // the fetch queue was full) is never cached: the remote was never asked.
  const failed = new Map();   // keyId -> until (ms)
  function failedRecently(keyId) {
    const until = failed.get(keyId);
    if (until === undefined) return false;
    if (until > clock.now()) return true;
    failed.delete(keyId);
    return false;
  }
  function markFailed(keyId, e) {
    if (e?.code === 'ERR_BUSY') return;
    if (failed.size >= NEG_MAX) {
      let n = Math.ceil(NEG_MAX / 100);
      for (const k of failed.keys()) { failed.delete(k); if (--n <= 0) break; }
    }
    failed.delete(keyId);
    failed.set(keyId, clock.now() + NEG_MS);
  }

  /* The cached owner record of a keyId, or null. */
  function cachedOwner(keyId) {
    const rec = byId.get(stripFragment(keyId));
    if (usable(rec) && rec.key_id === keyId) return rec;
    // Perhaps another actor's key document (key id without a fragment pointing at
    // its owner): look for a cached owner of exactly this key.
    for (const r of byId.values()) if (usable(r) && r.key_id === keyId) return r;
    return null;
  }

  /* Is this key answerable from the cache, with no fetch? */
  function hasKey(keyId) { load(); return typeof keyId === 'string' && !!cachedOwner(keyId); }

  /* The key behind a signature's keyId: { pem, owner, cached } or null.
   *   refresh      refetch at once (a signature failed with the cached key)
   *   gate         the lib/net.js gate the fetch waits on (inbound: its own)
   *   beforeFetch  called right before this call reaches the network (never for
   *                a cache hit or a negative-cache hit); may throw to refuse (a
   *                spent budget), may return a release function run after
   *   timeoutMs    each document's whole fetch (inbound: 5 s) */
  async function keyFor(keyId, { refresh = false, gate, beforeFetch, timeoutMs, allowUnbound = false } = {}) {
    load();
    if (typeof keyId !== 'string' || !/^https?:\/\//.test(keyId)) return null;
    const actorId = stripFragment(keyId);
    if (byId.get(actorId)?.gone_at) return null;   // a gone actor signs nothing (5.3)
    const rec = cachedOwner(keyId);
    if (rec && !refresh) {
      touch(rec.id);
      if (stale(rec)) refreshLater(rec);
      return { pem: rec.key_pem, owner: rec.id, cached: true, unbound: rec.unbound === true };
    }
    if (rec && clock.now() - Date.parse(rec.refetched_at || 0) < REFETCH_MS) return null;
    if (failedRecently(keyId)) return null;
    const release = beforeFetch ? beforeFetch() : null;
    try {
      if (rec) {
        rec.refetched_at = clock.iso();
        save(rec);
        const fresh = await once(rec.id, () => fetchActor(rec.id, { keyId, gate, timeoutMs, allowUnbound }));
        return { pem: fresh.key_pem, owner: fresh.id, cached: false, unbound: fresh.unbound === true };
      }
      // Unknown: fetch what the keyId names. An actor carries the key; a bare key
      // document names its owner, which is fetched and must carry the same key.
      const fetched = await once(actorId, async () => {
        const { doc, url } = await getDoc(actorId, { gate, timeoutMs });
        if (ACTOR_TYPES.has(doc.type)) {
          let d = doc;
          let u = url;
          if (d.id !== u && typeof d.id === 'string' && sameHost(d.id, hostOfUrl(u))) ({ doc: d, url: u } = await getDoc(d.id, { gate, timeoutMs }));
          const r = await accept(d, u, { keyId, gate, timeoutMs, allowUnbound });
          save(r);
          return r;
        }
        if (typeof doc.owner === 'string' && doc.id === keyId && sameHost(doc.owner, hostOfUrl(keyId))) return fetchActor(doc.owner, { keyId, gate, timeoutMs, allowUnbound });
        throw new ActorError('the key id names no actor');
      });
      return { pem: fetched.key_pem, owner: fetched.id, cached: false, unbound: fetched.unbound === true };
    } catch (e) {
      markFailed(keyId, e);
      throw e;
    } finally {
      if (typeof release === 'function') release();
    }
  }

  /* A FORWARDED activity (5.2 step 9), read from its own host: { doc, url,
   * actor } or throws. The same door as a key fetch (N8): the negative cache
   * (an id whose fetch failed is not fetched again for NEG_MS), `beforeFetch`
   * (the client's budget and in-flight slots, called once, only when the
   * network is reached), the caller's gate and timeout. `check(doc, url)` runs
   * on the document BEFORE its actor is resolved (an actor on another host is
   * never fetched): false answers { mismatch: true }, cached as a failure. Its
   * actor, when not cached, is resolved inside the same slot. */
  async function fetchForwarded(id, { gate, beforeFetch, timeoutMs, check = () => true } = {}) {
    load();
    if (failedRecently(id)) throw new ActorError('fetched recently and failed');
    const release = beforeFetch ? beforeFetch() : null;
    try {
      const { doc, url } = await getDoc(id, { gate, timeoutMs });
      if (!check(doc, url)) { markFailed(id); return { doc, url, actor: null, mismatch: true }; }
      const actor = await resolve(doc.actor, { gate, timeoutMs });
      return { doc, url, actor };
    } catch (e) {
      markFailed(id, e);
      throw e;
    } finally {
      if (typeof release === 'function') release();
    }
  }

  /* A Ring Group read from its JOIN LINK (P7, spec 4.7): `GET <home>/rings/
   * join/<code>` answers the asker's view of the Group, whose id is the Group's
   * own URL on the same host (redirects are off, so the host vouches for it).
   * The document passes the same checks (inbox and key on its host, the key's
   * owner) and is cached as a `group` record, so the Join can be delivered and
   * the Group's answer verified. -> the record, or throws ActorError. */
  function acceptGroupDoc(doc, joinUrl) {
    load();
    if (doc?.type !== 'Group' || doc.ring?.v !== 1 || typeof doc.id !== 'string') throw new ActorError('not a ring');
    const host = hostOfUrl(joinUrl);
    if (!host || hostOfUrl(doc.id) !== host || !/\/rings\/ring_[0-9a-f]{20}$/.test(new URL(doc.id).pathname)) throw new ActorError('the ring is not on the link\'s host');
    const { key, shared } = checkDoc(doc, '');
    const prev = byId.get(doc.id);
    if (prev?.gone_at) throw new ActorError('gone');
    const rec = {
      id: doc.id, handle: '', type: 'Group', group: true, inbox: doc.inbox, shared_inbox: typeof shared === 'string' ? shared : '',
      key_id: key.id, key_pem: key.publicKeyPem, name: plainLine(typeof doc.name === 'string' ? doc.name : '', 60),
      url: '', bio: [], avatar_url: '', outbox: typeof doc.outbox === 'string' ? doc.outbox : '', ring_switches: null, avatar: '',
      fetched_at: clock.iso(), refetched_at: prev?.refetched_at || '', used_at: prev?.used_at || '',
    };
    save(rec);
    return rec;
  }

  /* A URL as a handle: a member here by name, a cached remote actor by its
   * handle, else ''. Sync: callers verified (and so cached) the actor first. */
  function handleOf(url) {
    const l = urls.parseLocal(url, localOrigin());
    if (l?.kind === 'person') return l.name;
    if (l) return '';
    const rec = get(url);
    return rec && !rec.gone_at && !rec.unbound ? rec.handle : '';
  }

  /* A remote handle's actor id, or '' (a gone one included: rows naming it
   * still say who it was). */
  function idOf(handle) { load(); return byHandle.get(handle) || ''; }

  /* How the app shows a remote handle: { handle, name, url, host, remote,
   * avatar_url?, gone? }. The avatar is the media cache's copy (members only). */
  function view(handle) {
    const rec = get(idOf(handle));
    const host = handle.slice(handle.indexOf('@') + 1);
    const out = { handle, name: rec?.name || handle.slice(0, handle.indexOf('@')), url: rec?.url || rec?.id || '', host, remote: true };
    if (rec?.avatar) out.avatar_url = `/media/${rec.avatar}/thumb`;
    if (Array.isArray(rec?.bio) && rec.bio.length) out.bio = settleTree(rec.bio);
    if (rec?.gone_at) out.gone = true;
    return out;
  }

  /* The Ring switches a remote Ring member's Person carries (4.3), or null. */
  const switchesOf = (handle) => get(idOf(handle))?.ring_switches || null;

  // ── P6: gone, Update{Person}, lookup, the prune ──

  /* The actor is gone (5.3): keep only id, handle and when. Idempotent. */
  function markGone(id) {
    load();
    const rec = byId.get(id);
    if (!rec || rec.gone_at) return false;
    const gone = { id, handle: rec.handle, gone_at: clock.iso(), ...(rec.unbound ? { unbound: true } : {}) };
    writeJSON(fileOf(id), gone);
    index(gone);
    try { onGone(gone); } catch (e) { logger.error(`[actors] onGone for ${id}: ${e.stack || e.message}`); }
    return true;
  }

  /* An Update{Person} signed by the actor itself (5.3): the embedded document
   * replaces the cached fields after the same checks, and the handle stays the
   * one bound. -> the record, or throws ActorError. Sync: no fetch. */
  function applyUpdate(doc, signer) {
    load();
    const prev = byId.get(signer);
    if (!prev || prev.gone_at || prev.unbound) throw new ActorError('not a cached actor');
    if (!doc || typeof doc !== 'object' || doc.id !== signer) throw new ActorError('not the signer itself');
    const { host, key, shared } = checkDoc(doc, '');
    const handle = toHandle(`${String(doc.preferredUsername || '')}@${host}`, localHost(), { allowPort: cfg.fedTestLoopback });
    if (handle !== prev.handle) throw new ActorError('a handle never moves');
    const profile = profileOf(doc);   // ONE parse of the bio (F1)
    const rec = {
      ...prev,
      type: doc.type,
      inbox: doc.inbox,
      shared_inbox: typeof shared === 'string' ? shared : '',
      key_id: key.id,
      key_pem: key.publicKeyPem,
      ...profile,
      fetched_at: clock.iso(),
    };
    save(rec);
    return rec;
  }

  /* A typed handle (`name@host`) to its actor record, by WebFinger (cached
   * first). -> the record (its `handle` is canonical), or throws. */
  async function lookupHandle(handle) {
    load();
    const known = idOf(handle);
    if (known) return resolve(known);
    const at = handle.indexOf('@');
    if (at < 1) throw new ActorError('handle');
    const self = await webfingerSelf(handle.slice(0, at), handle.slice(at + 1));
    if (!self) throw new ActorError('webfinger names no actor');
    return resolve(self);
  }

  /* An actor a member's rows now name (F7): its avatar may be fetched from
   * now on (and is, at once, when it passes the host rule). Idempotent. */
  function markNamed(handle) {
    load();
    const rec = byId.get(byHandle.get(handle) || '');
    if (!rec || rec.gone_at || rec.unbound || rec.named) return false;
    save({ ...rec, named: true });
    return true;
  }

  /* The subscribe template of a remote account's server (8.5), from WebFinger.
   * `gate`, `timeoutMs`: an anonymous visitor's ask runs on its own small gate
   * with a short deadline (lib/federation.js, F4). */
  async function subscribeTemplate(handle, { gate, timeoutMs } = {}) {
    const at = handle.indexOf('@');
    if (at < 1) throw new ActorError('handle');
    const host = handle.slice(at + 1);
    const links = await webfinger(handle.slice(0, at), host, { gate, timeoutMs });
    const t = links.find((l) => l.rel === 'http://ostatus.org/schema/1.0/subscribe' && typeof l.template === 'string');
    if (!t || !/^https?:\/\//.test(t.template) || !t.template.includes('{uri}') || t.template.length > 2000) throw new ActorError('no subscribe template');
    return t.template;
  }

  /* The 90-day prune (3.10). `referenced(handle)` answers whether any row here
   * names the handle. Gone records stay (the binding). Also persists `used_at`
   * at most once a day per actor. -> how many went. */
  function prune(referenced) {
    load();
    const now = clock.now();
    let n = 0;
    for (const rec of [...byId.values()]) {
      if (rec.gone_at) continue;
      const lastUse = Math.max(Date.parse(rec.used_at || 0) || 0, used.get(rec.id) || 0, Date.parse(rec.fetched_at || 0) || 0);
      if (now - lastUse > PRUNE_AFTER_MS && !(rec.handle && referenced(rec.handle)) && !(rec.group && referenced(rec.id))) {
        try { fs.rmSync(fileOf(rec.id), { force: true }); } catch { /* best effort */ }
        byId.delete(rec.id);
        if (rec.handle && byHandle.get(rec.handle) === rec.id) byHandle.delete(rec.handle);
        used.delete(rec.id);
        n++;
        continue;
      }
      const u = used.get(rec.id) || 0;
      if (u && u - (Date.parse(rec.used_at || 0) || 0) > USED_WRITE_MS) {
        const next = { ...rec, used_at: new Date(u).toISOString() };
        writeJSON(fileOf(rec.id), next);
        index(next);
      }
    }
    return n;
  }

  /* Every cached record (housekeeping, the domain blocks). */
  const all = () => { load(); return [...byId.values()]; };

  /* P8, an admin's block (6.3): every record `pred(rec)` names goes from the
   * cache, file and all (its avatar row is then named by nothing and the media
   * sweep takes it). A GONE record stays: it keeps its handle bound (5.3).
   * -> how many went. */
  function forget(pred) {
    load();
    let n = 0;
    for (const rec of [...byId.values()]) {
      if (rec.gone_at || !pred(rec)) continue;
      try { fs.rmSync(fileOf(rec.id), { force: true }); } catch { /* best effort */ }
      byId.delete(rec.id);
      if (rec.handle && byHandle.get(rec.handle) === rec.id) byHandle.delete(rec.handle);
      used.delete(rec.id);
      n++;
    }
    return n;
  }

  /* Where to POST for this actor: its personal inbox, or the shared one. */
  function inboxOf(rec, { personal }) {
    return personal || !rec.shared_inbox ? rec.inbox : rec.shared_inbox;
  }

  return {
    get, resolve, keyFor, hasKey, handleOf, idOf, view, inboxOf, fetchActor, getDoc, fetchForwarded, failedRecently, acceptGroupDoc,
    markGone, applyUpdate, markNamed, lookupHandle, subscribeTemplate, switchesOf, prune, all, forget, webfinger,
    setOnGone: (fn) => { onGone = fn; },
    size: () => { load(); return byId.size; },
  };
}

module.exports = { createActors, ActorError, AP_ACCEPT, FRESH_MS, REFETCH_MS, NEG_MS, NEG_MAX, PRUNE_AFTER_MS, SERVER_TYPES, AVATAR_CHANGE_MS };
