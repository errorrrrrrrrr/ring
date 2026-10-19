'use strict';
/* ── Room copies (spec 3.10 `fed/rooms/<ring id>/`, 4.7; P7) ───────────────────
 * THE one reader and writer of `fed/rooms/`: the live room posts of members of
 * OTHER servers, in a ring a member here belongs to, kept so this server's
 * members of that ring can read them, with the stamps and comments the ring's
 * members left on them. ONE FILE PER COPY (P7 review F7), under the LOCAL ring
 * id (a home row or a replica, lib/rings.js):
 *   fed/rooms/<ring id>/<key>.json   { ring, post: entry }, key = the first 32
 *                                    hex of SHA-256(the copy's object id)
 *   entry: a settled object (lib/remote-note.js) plus
 *          author   the post's author's handle (a member of the ring)
 *          expires  min(ring.expires, published + 7 days): the copy's own end,
 *                   enforced HERE whatever happens to the reset's Delete
 *          at       when it landed
 *          stamps   [{ id (the Like's id), author, face, custom?, at }]
 *          comments [{ id (the Note's id), author, body, at }]
 *          its image attachments carry the media-cache id (lib/remote-media.js),
 *          fetched under the ring's read grant (signed as a member here)
 *
 * THE INDEX, in memory: built once per process by reading every copy file
 * (nothing else ever reads them all), then kept by every write: object id ->
 * { ring, key, author, published, expires, media, comments }, the ring's copy
 * ids, a comment id -> its copy, and a media id -> the copies that name it. So
 * a stamp, a comment, a find or a findComment reads ONE file and writes at
 * most one; mediaIds(), mediaRings(), the sweep and the caps read none; only a
 * ring's feed (list) reads that ring's live copies. `stats()` counts the files
 * and bytes read and written (the gate counts them, never the time).
 *
 * READ-TIME EXPIRY: every read keeps only entries whose `expires` is after now,
 * so a copy never shows past its week even when the home is down and no sweep
 * ran (spec 4.7: every server enforces expiry itself). The hourly sweep
 * (lib/app.js ringReset) removes them for good.
 *
 * Who may read a copy is the caller's rule (lib/feeds.js, routes/remote.js):
 * the ring's members HERE, and nobody else; this store answers to no route.
 *
 * Bounds (P7 review F7): a copy's settled entry at most MAX_COPY_BYTES; 500
 * copies a ring and 200 live copies per author a ring (oldest out, the
 * author's own first); 200 stamps a copy (one per author); 200 comments a copy
 * and 20 per author on one copy (the 21st is refused); 4 attachments (the
 * settle's). An id belongs to the FIRST author that put it (another author's
 * Create with the same id is 'another', never an overwrite). Each write is one
 * synchronous tick (spec 3.11), each file written atomically.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { writeFileAtomic } = require('./store');
const { isHandle } = require('./handles');
const { RING_ID_RE } = require('./ids');
const { resettle } = require('./remote-note');
const { paletteFace, normalizeCustomFace, normalizeCommentBody } = require('./reactions');

const MAX_POSTS = 500;
const MAX_PER_AUTHOR = 200;
const MAX_REACTIONS = 200;
const MAX_COMMENTS_PER_AUTHOR = 20;
const MAX_COPY_BYTES = 64 * 1024;
const KEY_RE = /^[0-9a-f]{32}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const handleOk = (h) => isHandle(h, { allowPort: true });
const httpUrl = (u) => (typeof u === 'string' && u.length <= 2000 && /^https?:\/\//i.test(u) ? u : '');
const keyOf = (objectId) => crypto.createHash('sha256').update(String(objectId)).digest('hex').slice(0, 32);

function settleStamp(s) {
  if (!s || !httpUrl(s.id) || !handleOk(s.author)) return null;
  const custom = s.custom === true;
  const face = custom ? normalizeCustomFace(s.face) : paletteFace(s.face);
  if (!face) return null;
  return { id: s.id, author: s.author, face, ...(custom ? { custom: true } : {}), at: str(s.at, 40) };
}
function settleComment(c) {
  if (!c || !httpUrl(c.id) || !handleOk(c.author)) return null;
  const body = normalizeCommentBody(c.body);
  if (!body) return null;
  return { id: c.id, author: c.author, body, at: str(c.at, 40) };
}
/* At most `perAuthor` of one author's, keeping the latest. */
function capPerAuthor(list, perAuthor) {
  const n = new Map();
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const k = (n.get(list[i].author) || 0) + 1;
    n.set(list[i].author, k);
    if (k <= perAuthor) out.push(list[i]);
  }
  return out.reverse();
}
/* The copy itself, without its reactions (what MAX_COPY_BYTES bounds). */
function settleCopy(raw) {
  const e = resettle(raw);
  if (!e || !httpUrl(e.id) || !handleOk(raw.author) || !Number.isFinite(Date.parse(raw.expires || ''))) return null;
  delete e.stamps;
  delete e.comments;
  e.mentions = [];   // a room copy names no one: nothing reads them, and they cost bytes
  e.author = raw.author;
  e.expires = new Date(Date.parse(raw.expires)).toISOString();
  e.at = str(raw.at, 40);
  return Buffer.byteLength(JSON.stringify(e)) <= MAX_COPY_BYTES ? e : null;
}
function settleEntry(raw) {
  const e = settleCopy(raw);
  if (!e) return null;
  e.stamps = (Array.isArray(raw.stamps) ? raw.stamps : []).map(settleStamp).filter(Boolean);
  e.stamps = e.stamps.filter((s, i) => e.stamps.findLastIndex((x) => x.author === s.author) === i).slice(-MAX_REACTIONS);
  e.comments = capPerAuthor((Array.isArray(raw.comments) ? raw.comments : []).map(settleComment).filter(Boolean), MAX_COMMENTS_PER_AUTHOR).slice(-MAX_REACTIONS);
  return e;
}

function createRooms({ paths, logger = console }) {
  const dir = paths.fedRoomsDir;
  const ringDir = (ringId) => {
    if (!RING_ID_RE.test(String(ringId))) throw new Error('rooms: not a ring id');
    return path.join(dir, ringId);
  };
  const fileOf = (ringId, key) => path.join(ringDir(ringId), `${key}.json`);
  const io = { filesRead: 0, bytesRead: 0, filesWritten: 0, filesRemoved: 0 };

  // ── the index ──
  const byId = new Map();       // object id -> meta { ring, key, author, published, expires (ms), media: [], comments: Set }
  const byRing = new Map();     // ring id -> Set(object id)
  const commentOf = new Map();  // `${ring}\n${comment id}` -> object id
  const mediaRefs = new Map();  // media id -> Set(object id)
  let indexed = false;

  const mediaOfEntry = (e) => (e.attachments || []).map((a) => a.media).filter(Boolean);
  function unindex(objectId) {
    const m = byId.get(objectId);
    if (!m) return null;
    byId.delete(objectId);
    byRing.get(m.ring)?.delete(objectId);
    if (byRing.get(m.ring)?.size === 0) byRing.delete(m.ring);
    for (const c of m.comments) commentOf.delete(`${m.ring}\n${c}`);
    for (const id of m.media) {
      const s = mediaRefs.get(id);
      if (s) { s.delete(objectId); if (!s.size) mediaRefs.delete(id); }
    }
    return m;
  }
  function indexEntry(ringId, key, e) {
    unindex(e.id);
    const meta = { ring: ringId, key, author: e.author, published: e.published || e.at || '', expires: Date.parse(e.expires), media: mediaOfEntry(e), comments: new Set(e.comments.map((c) => c.id)) };
    byId.set(e.id, meta);
    if (!byRing.has(ringId)) byRing.set(ringId, new Set());
    byRing.get(ringId).add(e.id);
    for (const c of meta.comments) commentOf.set(`${ringId}\n${c}`, e.id);
    for (const id of meta.media) {
      if (!mediaRefs.has(id)) mediaRefs.set(id, new Set());
      mediaRefs.get(id).add(e.id);
    }
    return meta;
  }

  /* One copy file, settled; null when absent, unreadable or not this ring's. */
  function readFile(ringId, key) {
    let raw;
    try {
      const text = fs.readFileSync(fileOf(ringId, key), 'utf8');
      io.filesRead++;
      io.bytesRead += Buffer.byteLength(text);
      raw = JSON.parse(text);
    } catch { return null; }
    if (!raw || raw.ring !== ringId || !raw.post || keyOf(raw.post.id) !== key) return null;
    return settleEntry(raw.post);
  }
  function writeFile(ringId, e) {
    const key = keyOf(e.id);
    fs.mkdirSync(ringDir(ringId), { recursive: true, mode: 0o700 });
    writeFileAtomic(fileOf(ringId, key), JSON.stringify({ ring: ringId, post: e }));
    io.filesWritten++;
    indexEntry(ringId, key, e);
  }
  function removeFile(ringId, objectId) {
    const m = unindex(objectId);
    if (!m) return null;
    try { fs.rmSync(fileOf(ringId, m.key), { force: true }); io.filesRemoved++; } catch { /* gone */ }
    if (!byRing.has(ringId)) { try { fs.rmdirSync(ringDir(ringId)); } catch { /* not empty, or gone */ } }
    return m;
  }

  function ringDirs() {
    try { return fs.readdirSync(dir).filter((f) => RING_ID_RE.test(f)); } catch { return []; }
  }
  function ensureIndex() {
    if (indexed) return;
    indexed = true;
    for (const ringId of ringDirs()) {
      let files = [];
      try { files = fs.readdirSync(ringDir(ringId)); } catch { continue; }
      for (const f of files) {
        const key = f.endsWith('.json') ? f.slice(0, -5) : '';
        if (!KEY_RE.test(key)) continue;
        try {
          const e = readFile(ringId, key);
          if (e && !byId.has(e.id)) indexEntry(ringId, key, e);
        } catch (err) { logger.error(`[rooms] skipped ${ringId}/${f}: ${err.message}`); }
      }
    }
  }
  const metaOf = (objectId) => { ensureIndex(); return byId.get(objectId) || null; };
  const live = (m, nowMs) => m.expires > nowMs;
  const idsOf = (ringId) => { ensureIndex(); return [...(byRing.get(ringId) || [])]; };
  const newest = (a, b) => (byId.get(b).published > byId.get(a).published ? 1 : byId.get(b).published < byId.get(a).published ? -1 : 0);

  /* The ring ids holding at least one copy. */
  function ringIds() { ensureIndex(); return [...byRing.keys()]; }

  /* The live copies of a ring (read-time expiry), newest first: the feed. */
  function list(ringId, nowMs = clock.now()) {
    const out = [];
    for (const id of idsOf(ringId).filter((x) => live(byId.get(x), nowMs)).sort(newest)) {
      const e = readFile(ringId, byId.get(id).key);
      if (e && Date.parse(e.expires) > nowMs) out.push(e);
    }
    return out;
  }
  /* The live copies' ids and authors, read from the index alone (the Group's outbox). */
  function metas(ringId, nowMs = clock.now()) {
    return idsOf(ringId).filter((x) => live(byId.get(x), nowMs)).sort(newest).map((id) => ({ id, author: byId.get(id).author }));
  }
  /* -> { ringId, post } for a live copy held anywhere here, or null. One file. */
  function find(objectId, nowMs = clock.now()) {
    if (typeof objectId !== 'string' || !objectId) return null;
    const m = metaOf(objectId);
    if (!m || !live(m, nowMs)) return null;
    const post = readFile(m.ring, m.key);
    if (!post || post.id !== objectId) return null;
    return { ringId: m.ring, post };
  }

  /* Add or replace a copy. -> 'added' | 'updated' | 'another' (the id is
   * another author's, or another ring's) | 'expired' | 'refused' (unsettled,
   * or over MAX_COPY_BYTES). A replace keeps the reactions. Past 200 live
   * copies of its author in the ring, the author's oldest goes; past 500 in
   * the ring, the ring's oldest. */
  function put(ringId, entry) {
    ensureIndex();
    const e = settleCopy({ ...entry, at: entry.at || clock.iso() });
    if (!e) return 'refused';
    const nowMs = clock.now();
    if (Date.parse(e.expires) <= nowMs) return 'expired';
    const held = byId.get(e.id);
    if (held && (held.ring !== ringId || held.author !== e.author)) return 'another';
    if (held) {
      const prev = readFile(ringId, held.key);
      writeFile(ringId, { ...e, stamps: prev?.stamps || [], comments: prev?.comments || [], at: prev?.at || e.at });
      return 'updated';
    }
    writeFile(ringId, { ...e, stamps: [], comments: [] });
    // The caps, from the index: no file is read.
    const mine = idsOf(ringId).filter((id) => byId.get(id).author === e.author && live(byId.get(id), nowMs)).sort(newest);
    for (const id of mine.slice(MAX_PER_AUTHOR)) removeFile(ringId, id);
    const all = idsOf(ringId).sort(newest);
    for (const id of all.slice(MAX_POSTS)) removeFile(ringId, id);
    return byId.has(e.id) ? 'added' : 'refused';
  }

  /* Change one copy with `fn(post)` (true when it changed); -> the post or null.
   * One file read, at most one written. */
  function change(ringId, objectId, fn) {
    const m = metaOf(objectId);
    if (!m || m.ring !== ringId) return null;
    const post = readFile(ringId, m.key);
    if (!post || !fn(post)) return null;
    writeFile(ringId, post);
    return post;
  }

  /* A copy removed by its own author (a Delete, the reset, Keep). -> the media ids it held. */
  function remove(ringId, objectId, author) {
    const m = metaOf(objectId);
    if (!m || m.ring !== ringId || (author && m.author !== author)) return null;
    removeFile(ringId, objectId);
    return [...m.media];
  }

  /* Every copy whose author is not in `keep(handle)` goes (a member left or was
   * removed: their posts leave the room with them). -> media ids dropped. */
  function keepAuthors(ringId, keep) {
    const out = [];
    for (const id of idsOf(ringId)) {
      const m = byId.get(id);
      if (keep(m.author)) continue;
      removeFile(ringId, id);
      out.push(...m.media);
    }
    return out;
  }

  /* The ring is gone for this server (left, removed, deleted): every copy. */
  function drop(ringId) {
    const out = [];
    for (const id of idsOf(ringId)) out.push(...(removeFile(ringId, id)?.media || []));
    try { fs.rmSync(ringDir(ringId), { recursive: true, force: true }); } catch { /* gone */ }
    return out;
  }

  // ── reactions on a copy (what the ring's members left; the post's own
  //    server is the authority and withdraws a refused one by Remove) ──

  function stamp(ringId, objectId, { id, author, face, custom = false }) {
    return !!change(ringId, objectId, (p) => {
      const s = settleStamp({ id, author, face, custom, at: clock.iso() });
      if (!s) return false;
      p.stamps = [...p.stamps.filter((x) => x.author !== author), s].slice(-MAX_REACTIONS);
      return true;
    });
  }
  function unstamp(ringId, objectId, { id, author }) {
    return !!change(ringId, objectId, (p) => {
      const n = p.stamps.length;
      p.stamps = p.stamps.filter((x) => !(x.id === id && (!author || x.author === author)));
      return p.stamps.length !== n;
    });
  }
  /* A comment; past MAX_COMMENTS_PER_AUTHOR of its author on this copy, refused. */
  function comment(ringId, objectId, { id, author, body }) {
    return !!change(ringId, objectId, (p) => {
      if (p.comments.some((c) => c.id === id)) return false;
      if (p.comments.filter((c) => c.author === author).length >= MAX_COMMENTS_PER_AUTHOR) return false;
      const c = settleComment({ id, author, body, at: clock.iso() });
      if (!c) return false;
      p.comments = [...p.comments, c].slice(-MAX_REACTIONS);
      return true;
    });
  }
  function uncomment(ringId, objectId, { id, author }) {
    return !!change(ringId, objectId, (p) => {
      const n = p.comments.length;
      p.comments = p.comments.filter((x) => !(x.id === id && (!author || x.author === author)));
      return p.comments.length !== n;
    });
  }
  /* A reaction by id, stamp or comment (a Remove names either). */
  function unreact(ringId, objectId, reactionId) {
    return !!change(ringId, objectId, (p) => {
      const n = p.stamps.length + p.comments.length;
      p.stamps = p.stamps.filter((x) => x.id !== reactionId);
      p.comments = p.comments.filter((x) => x.id !== reactionId);
      return p.stamps.length + p.comments.length !== n;
    });
  }
  /* The copy holding a comment with this id (a comment's Delete names only it). One file. */
  function findComment(ringId, commentId) {
    ensureIndex();
    const objectId = commentOf.get(`${ringId}\n${commentId}`);
    const m = objectId ? byId.get(objectId) : null;
    return m ? readFile(ringId, m.key) : null;
  }

  /* The hourly sweep: expired copies out, and the copies of rings this server
   * no longer holds (`held(ringId)` false). From the index: no file is read.
   * -> { copies, media: [ids] }. */
  function sweep(held, nowMs = clock.now()) {
    ensureIndex();
    let copies = 0;
    const media = [];
    for (const ringId of new Set([...byRing.keys(), ...ringDirs()])) {
      try {
        if (!held(ringId)) { const before = idsOf(ringId).length; media.push(...drop(ringId)); copies += before; continue; }
        for (const id of idsOf(ringId)) {
          const m = byId.get(id);
          if (live(m, nowMs)) continue;
          removeFile(ringId, id);
          copies++;
          media.push(...m.media);
        }
      } catch (e) { logger.error(`[rooms] sweep: skipped ${ringId}: ${e.message}`); }
    }
    return { copies, media };
  }

  /* Every media id a copy names (housekeeping, forgetMedia). From the index. */
  function mediaIds() {
    ensureIndex();
    return new Set(mediaRefs.keys());
  }
  /* The rings (of `ringIdsToCheck`) whose LIVE copies name this media id. From the index. */
  function mediaRings(mediaId, ringIdsToCheck, nowMs = clock.now()) {
    ensureIndex();
    const rings = new Set();
    for (const id of mediaRefs.get(mediaId) || []) {
      const m = byId.get(id);
      if (m && live(m, nowMs)) rings.add(m.ring);
    }
    return ringIdsToCheck.filter((r) => rings.has(r));
  }
  /* The live copies of `ringId` that name this media id (F6: what a room
   * image's fetch is for): [{ id, author }]. From the index. */
  function mediaCopies(mediaId, ringId, nowMs = clock.now()) {
    ensureIndex();
    const out = [];
    for (const id of mediaRefs.get(mediaId) || []) {
      const m = byId.get(id);
      if (m && m.ring === ringId && live(m, nowMs)) out.push({ id, author: m.author });
    }
    return out;
  }

  const stats = () => ({ ...io, copies: byId.size });

  return {
    list, metas, find, put, change, remove, keepAuthors, drop, stamp, unstamp, comment, uncomment, unreact, findComment,
    sweep, mediaIds, mediaRings, mediaCopies, ringIds, stats,
  };
}

module.exports = { createRooms, MAX_POSTS, MAX_PER_AUTHOR, MAX_REACTIONS, MAX_COMMENTS_PER_AUTHOR, MAX_COPY_BYTES, keyOf };
