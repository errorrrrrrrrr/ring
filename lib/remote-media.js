'use strict';
/* ── The remote media cache (spec 5.7, 3.10 `fed/media/` + `fed/media.json`) ──
 * DECISION (5.7): cache and re-encode, never hotlink. A remote image is fetched
 * by THIS server (through lib/net.js: the SSRF guard, the size cap, https only,
 * BLOCKED_DOMAINS), passes the same sharp door as an upload (the byte sniff, the
 * decode ceiling read from the header first, one decode at a time, a 20 s
 * timeout; lib/image-decode.js), and only its two re-encoded WebP variants are
 * kept: `web` (1600) and `thumb` (600). The original is never written, so no
 * remote file can carry a decoder payload or a GPS tag to a viewer, nobody's IP
 * reaches the remote server, and CSP stays `img-src 'self'`.
 *
 *   want(url, { maxBytes, kind, room })  -> id, synchronously: the row is written
 *                    `pending` (or found) and the fetch is queued in the
 *                    background; callers store the id (a wall entry, an actor's
 *                    avatar). The id is `m_` + 32 hex of SHA-256(url): one URL,
 *                    one copy, however many rows name it.
 *   ensure(id, { mayStart }) -> the row when ready, queueing a pending,
 *                    failed (after a minute) or trimmed one first and waiting
 *                    for it: the route's miss.
 *   file(id, v)    -> the variant's path, or null.
 *
 * SERVED (routes/remote.js `/media/:id/web|thumb`) to SIGNED-IN MEMBERS OF THIS
 * SERVER ONLY, never on a public page, in RSS or to a federation route (P7 adds a
 * room copy's images, to that ring's members only).
 *
 * FETCHED only for what a member here will see: a remote friend's posts (on
 * receipt and the one outbox read at befriending) and the avatars of actors a
 * member's rows name (lib/actors.js, F7); never for From elsewhere, never for a
 * lookup (spec 5.7, 6.4).
 *
 * BOUNDS: images 10 MB, avatars 2 MB (the fetch cap, the socket aborts past
 * it); at most 4 fetches at once and 500 waiting (past that a want stays pending
 * and a later miss queues it); a miss joins the same line, never a fetch of its
 * own (F8), and a member's misses that put a new fetch in line spend their own
 * budget (routes/remote.js); 50 000 image rows and 10 000 avatar rows, counted
 * apart (F7). trim(limit): least recently used
 * variants out until the files fit `REMOTE_MEDIA_MB`; the row stays `trimmed`
 * so a miss refetches. sweep(referenced): rows no store names any more go, with
 * their files, after an hour's grace.
 *
 * `fed/media.json` is held in memory, written atomically on a 1 s debounce and
 * at flush() (the hot path is a want per remote image, a used_at per serve).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hostOfUrl } = require('./handles');
const clock = require('./clock');
const { readJSON, writeJSON, writeFileAtomic } = require('./store');
const { sniffImageType } = require('./images');
const { decodeImage, imageHeader, pixelProblem, withDecodeSlot } = require('./image-decode');
const { signHeaders } = require('./http-sig');

const IMAGE_MAX = 10 * 1024 * 1024;
const WEB_MAX = 1600;
const THUMB_MAX = 600;
const MAX_ROWS = 50_000;         // images (walls)
const MAX_AVATAR_ROWS = 10_000;  // avatars: a cap of their own (F7), so no flood of them blinds a wall
const ACTIVE = 4;
const WAITING = 500;
const RETRY_FAILED_MS = 60_000;
const GRACE_MS = 3600_000;
const ID_RE = /^m_[0-9a-f]{32}$/;
const STATES = new Set(['pending', 'ready', 'failed', 'trimmed']);

const idOfUrl = (url) => `m_${crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32)}`;

function createMedia({ paths, net, logger = console, debounceMs = 1000, roomSigner = () => null }) {
  let table = null;
  let dirty = false;
  let timer = null;
  const running = new Map();   // id -> promise
  const waiting = [];
  const waiters = new Map();   // id -> { promise, resolve }: a miss waiting on a queued fetch (F8)
  const counts = { image: 0, avatar: 0 };
  let active = 0;
  const kindOf = (r) => (r?.kind === 'avatar' ? 'avatar' : 'image');

  function load() {
    if (table) return table;
    const raw = readJSON(paths.fedMediaIndex, {});
    const t = new Map();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, r] of Object.entries(raw)) {
        if (ID_RE.test(id) && r && typeof r === 'object' && typeof r.url === 'string' && /^https?:\/\//.test(r.url)) {
          t.set(id, { ...r, state: STATES.has(r.state) ? (r.state === 'ready' || r.state === 'trimmed' ? r.state : 'pending') : 'pending' });
        }
      }
    }
    table = t;
    counts.image = 0;
    counts.avatar = 0;
    for (const r of t.values()) counts[kindOf(r)]++;
    return table;
  }
  function drop(t, id) {
    const r = t.get(id);
    if (!r) return;
    t.delete(id);
    counts[kindOf(r)]--;
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || !table) return;
    dirty = false;
    try { writeJSON(paths.fedMediaIndex, Object.fromEntries(table)); }
    catch (e) { dirty = true; logger.error(`[media] could not write media.json: ${e.message}`); }
  }
  function touch() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    timer.unref?.();
  }

  const fileOf = (id, v) => path.join(paths.fedMediaDir, `${id}__${v}`);
  function unlinkFiles(id) {
    for (const v of ['web', 'thumb']) { try { fs.unlinkSync(fileOf(id, v)); } catch { /* gone */ } }
  }

  /* One fetch and re-encode. Resolves the row (ready or failed). */
  async function fetchOne(id) {
    const r = load().get(id);
    if (!r) return null;
    let web;
    let thumb;
    try {
      // A room image (P7) is fetched under the ring's read grant, signed as a
      // member here of THAT ring, and only while a live copy in that ring
      // names it, from its author's host (P7 review F6: `roomSigner` decides,
      // lib/ring-fed.js). Asked again at every fetch: a miss after the copy or
      // the member left fetches nothing.
      const accept = 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1';
      const signers = r.room ? (roomSigner(r, id) || []) : [null];
      if (!signers.length) throw new Error('no copy in its ring names it, or no member there to sign as');
      let res = null;
      // One member after another, while the answer is a refusal (the author
      // may block one of them, F4): at most a ring's seats.
      for (const as of signers.slice(0, 6)) {
        const sign = as ? (u, method, headers) => signHeaders({ method, url: u, headers: { ...headers, accept }, keyId: as.keyId, privateKey: as.privateKey, nowMs: clock.now() }) : undefined;
        res = await net.fetchGuarded(r.url, { headers: { accept }, maxBytes: r.max || IMAGE_MAX, timeoutMs: 20_000, sign, maxRedirects: r.room ? 0 : undefined });
        if (![401, 403, 404].includes(res.status)) break;
      }
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if (!/^image\//i.test(String(res.headers['content-type'] || ''))) throw new Error('not an image type');
      const buf = res.body;
      const kind = sniffImageType(buf);
      if (!kind) throw new Error('not an image');
      const header = await imageHeader(buf);
      if (!header || pixelProblem(header)) throw new Error('too many pixels or unreadable');
      const animated = kind === 'gif' || kind === 'webp';
      ({ web, thumb } = await withDecodeSlot(async () => {
        const make = async (max, quality) => {
          const { data, info } = await decodeImage(buf, animated ? { animated: true } : {})
            .rotate()
            .resize(max, max, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality })
            .toBuffer({ resolveWithObject: true });
          return { data, width: info.width, height: info.pageHeight || info.height };
        };
        return { web: await make(WEB_MAX, 82), thumb: await make(THUMB_MAX, 75) };
      }));
    } catch (e) {
      // ── tick ──
      const cur = load().get(id);
      if (cur) { cur.state = 'failed'; cur.failed_at = clock.iso(); cur.why = String(e.message || e).slice(0, 120); touch(); }
      return cur || null;
    }
    // ── tick: the files, then the row ──
    const cur = load().get(id);
    if (!cur) return null;   // swept meanwhile
    fs.mkdirSync(paths.fedMediaDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(fileOf(id, 'web'), web.data);
    writeFileAtomic(fileOf(id, 'thumb'), thumb.data);
    Object.assign(cur, { state: 'ready', bytes: web.data.length + thumb.data.length, width: web.width, height: web.height, fetched_at: clock.iso(), used_at: clock.iso() });
    delete cur.why;
    delete cur.failed_at;
    touch();
    return cur;
  }

  function pump() {
    while (active < ACTIVE && waiting.length) {
      const id = waiting.shift();
      if (running.has(id)) continue;
      start(id);
    }
  }
  function start(id) {
    active++;
    const p = fetchOne(id).catch((e) => { logger.error(`[media] ${id}: ${e.message}`); return null; }).finally(() => {
      active--;
      running.delete(id);
      const w = waiters.get(id);
      if (w) { waiters.delete(id); w.resolve(); }
      pump();
    });
    running.set(id, p);
    return p;
  }
  /* Resolves when `id`'s fetch (running, or queued) has finished. */
  function settled(id) {
    if (running.has(id)) return running.get(id).then(() => {});
    let w = waiters.get(id);
    if (!w) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      w = { promise, resolve };
      waiters.set(id, w);
    }
    return w.promise;
  }

  /* -> the id; the fetch runs in the background (bounded). */
  /* `room` (P7): a room image, for the copy of that ring (its LOCAL id); the
   * row is marked `room` with its ring, routes/remote.js serves it only to that
   * ring's members, and the fetch is signed as a member of that ring
   * (`roomSigner`). Its id is its own, the URL plus `#room:<ring id>` (P7
   * review F6): never the id of the same URL fetched for a public wall, nor
   * for another ring. */
  function want(url, { maxBytes = IMAGE_MAX, kind = 'image', room = '' } = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2000) return '';
    const t = load();
    const id = idOfUrl(room ? `${url}#room:${room}` : url);
    let r = t.get(id);
    if (!r) {
      const k = kind === 'avatar' ? 'avatar' : 'image';
      if (counts[k] >= (k === 'avatar' ? MAX_AVATAR_ROWS : MAX_ROWS)) return '';
      r = { url, kind: k, max: Math.min(maxBytes, IMAGE_MAX), state: 'pending', at: clock.iso(), ...(room ? { room: true, ring: room } : {}) };
      t.set(id, r);
      counts[k]++;
      touch();
    }
    if (r.state === 'pending' && !running.has(id) && !waiting.includes(id) && waiting.length < WAITING) {
      waiting.push(id);
      queueMicrotask(pump);
    }
    return id;
  }

  /* The serving route's miss: wait for the fetch, queued like any other (F8):
   * a miss never starts a fetch past ACTIVE, it joins the waiting line (and is
   * refused when the line is full). `mayStart()` is asked only when this miss
   * would put a NEW fetch in line (not one already running or waiting): the
   * route's per-member budget; false refuses. -> row or null. */
  async function ensure(id, { mayStart = () => true } = {}) {
    if (!ID_RE.test(String(id))) return null;
    const r = load().get(id);
    if (!r) return null;
    if (r.state === 'ready' && fs.existsSync(fileOf(id, 'web'))) return r;
    if (r.state === 'failed' && clock.now() - Date.parse(r.failed_at || 0) < RETRY_FAILED_MS) return null;
    if (!running.has(id) && !waiting.includes(id)) {
      if (waiting.length >= WAITING || !mayStart()) return null;
      r.state = 'pending';
      waiting.push(id);
      pump();
    }
    await settled(id);
    const now = load().get(id);
    return now?.state === 'ready' ? now : null;
  }

  function file(id, v) {
    if (!ID_RE.test(String(id)) || (v !== 'web' && v !== 'thumb')) return null;
    const r = load().get(id);
    if (r?.state !== 'ready') return null;
    const f = fileOf(id, v);
    if (!fs.existsSync(f)) return null;
    r.used_at = clock.iso();
    touch();
    return f;
  }

  const row = (id) => { const r = load().get(id); return r ? { ...r } : null; };

  /* Least recently used out until the variants fit `limitBytes`. -> files trimmed. */
  function trim(limitBytes) {
    const t = load();
    const ready = [...t.entries()].filter(([, r]) => r.state === 'ready');
    let total = ready.reduce((n, [, r]) => n + (r.bytes || 0), 0);
    if (total <= limitBytes) return 0;
    ready.sort((a, b) => String(a[1].used_at || '').localeCompare(String(b[1].used_at || '')));
    let n = 0;
    for (const [id, r] of ready) {
      if (total <= limitBytes) break;
      unlinkFiles(id);
      total -= r.bytes || 0;
      r.state = 'trimmed';
      r.bytes = 0;
      n++;
    }
    if (n) touch();
    return n;
  }

  /* Rows no store names any more (`referenced(id)` false), past the grace. */
  function sweep(referenced) {
    const t = load();
    const now = clock.now();
    let n = 0;
    for (const [id, r] of [...t]) {
      if (referenced(id) || running.has(id)) continue;
      if (now - Date.parse(r.at || 0) < GRACE_MS) continue;
      unlinkFiles(id);
      drop(t, id);
      n++;
    }
    if (n) touch();
    return n;
  }

  /* Drop these rows at once, with their files, unless `referenced(id)` (P7: a
   * room image goes with its copy, spec 4.7, not after the sweep's grace). */
  function forget(ids, referenced = () => false) {
    const t = load();
    let n = 0;
    for (const id of new Set(ids)) {
      if (!t.has(id) || referenced(id) || running.has(id)) continue;
      unlinkFiles(id);
      drop(t, id);
      n++;
    }
    if (n) touch();
    return n;
  }

  /* Drop every row whose URL's host `blocked(host)` names (BLOCKED_DOMAINS). */
  function dropHosts(blocked) {
    const t = load();
    let n = 0;
    for (const [id, r] of [...t]) {
      const h = hostOfUrl(r.url);   // THE normalizer's host (P8 review F4)
      if (h && blocked(h)) { unlinkFiles(id); drop(t, id); n++; }
    }
    if (n) touch();
    return n;
  }

  /* Tests: wait until nothing is queued or running. */
  async function idle() {
    while (running.size || waiting.length) {
      pump();
      await Promise.all([...running.values()]);
      await new Promise((r) => setImmediate(r));
    }
  }

  const stats = () => { load(); return { active, waiting: waiting.length, rows: { ...counts } }; };
  return { want, ensure, file, row, trim, sweep, forget, dropHosts, flush, idle, stats, size: () => load().size, ID_RE };
}

module.exports = { createMedia, idOfUrl, ID_RE, IMAGE_MAX, MAX_ROWS, MAX_AVATAR_ROWS, ACTIVE, WAITING };
