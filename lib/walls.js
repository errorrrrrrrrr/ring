'use strict';
/* ── Remote friends' walls (spec 3.9, 3.10 `fed/walls/<sha256(handle)>.json`) ──
 * What fills the Friends feed from another server: a remote FRIEND's recent
 * public (or unlisted) posts, kept per handle, shared by every member here who
 * is their friend. THE one reader and writer of `fed/walls/`.
 *   { handle, actor, backfilled_at, posts: [entry] }
 *   entry: a settled object (lib/remote-note.js) plus `at` (when it landed);
 *          its image attachments carry the media-cache id (lib/remote-media.js)
 * Bounds: 200 posts per wall, 90 days (housekeeping), newest kept. A wall is
 * DROPPED WITH THE FRIENDSHIP: when no member here is a friend of the handle any
 * more (lib/app.js, on every follow change), and by housekeeping as a sweep.
 *
 * Writes come from the inbound handlers (a Create, an Update or a Delete signed
 * by the wall's own actor: lib/remote-in.js checks ownership first) and from the
 * one outbox read at befriending (lib/federation.js backfill). A Create for an
 * id already held is a no-op (5.5); an Update replaces a held entry only; a
 * Delete removes it. The index maps a post's id to its wall, so a stamp or a
 * comment on a remote post finds it without a fetch, and an Update or Delete
 * reads only the wall that holds it (F3). An id belongs to the FIRST wall that
 * held it: another handle's Create with the same id is 'another', never an
 * overwrite (F11), and lib/remote-in.js refuses an id in another actor's path
 * (lib/remote-note.js idUnderActor) before it gets here.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { isHandle } = require('./handles');
const { resettle } = require('./remote-note');

const MAX_POSTS = 200;
const KEEP_MS = 90 * 24 * 3600_000;

function createWalls({ paths, media = null, onMediaHost = () => {}, logger = console }) {
  const dir = paths.fedWallsDir;
  const fileOf = (handle) => path.join(dir, `${crypto.createHash('sha256').update(handle).digest('hex')}.json`);
  const index = new Map();   // object id -> handle
  let indexed = false;

  function read(handle) {
    const raw = readJSON(fileOf(handle), null);
    if (!raw || raw.handle !== handle) return { handle, actor: '', backfilled_at: '', posts: [] };
    const posts = (Array.isArray(raw.posts) ? raw.posts : []).map(resettle).filter((p) => p && typeof p.id === 'string');
    return { handle, actor: typeof raw.actor === 'string' ? raw.actor : '', backfilled_at: typeof raw.backfilled_at === 'string' ? raw.backfilled_at : '', posts };
  }

  function ensureIndex() {
    if (indexed) return;
    indexed = true;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const raw = readJSON(path.join(dir, f), null);
        if (!raw || !isHandle(raw.handle, { allowPort: true })) continue;
        // The first wall to hold an id keeps it (F11): never another handle's.
        for (const p of Array.isArray(raw.posts) ? raw.posts : []) if (p && typeof p.id === 'string' && !index.has(p.id)) index.set(p.id, raw.handle);
      } catch (e) { logger.error(`[walls] skipped ${f}: ${e.message}`); }
    }
  }

  const byNewest = (a, b) => ((b.published || b.at || '') > (a.published || a.at || '') ? 1 : -1);

  function write(w) {
    w.posts.sort(byNewest);
    const cut = clock.now() - KEEP_MS;
    const dropped = w.posts.filter((p, i) => i >= MAX_POSTS || Date.parse(p.published || p.at || 0) < cut);
    w.posts = w.posts.filter((p) => !dropped.includes(p));
    for (const p of dropped) if (index.get(p.id) === w.handle) index.delete(p.id);
    writeJSON(fileOf(w.handle), w);
    for (const p of w.posts) if (!index.has(p.id)) index.set(p.id, w.handle);
  }

  /* Image attachments into the media cache (they will be seen: 5.7). */
  function withMedia(entry) {
    if (!media) return entry;
    return { ...entry, attachments: entry.attachments.map((a) => (a.kind === 'image' ? { ...a, media: media.want(a.url) || undefined } : a)) };
  }

  /* A settled object from the wall's own actor. -> 'added' | 'held' |
   * 'another' (F11: an id another handle's wall holds is never taken over, so a
   * stamp or a comment on it still goes to its first author). */
  function add(handle, actorId, obj) {
    ensureIndex();
    const holder = index.get(obj.id);
    if (holder && holder !== handle) return 'another';
    const w = read(handle);
    if (w.posts.some((p) => p.id === obj.id)) return 'held';
    w.actor = actorId;
    w.posts.push(withMedia({ ...obj, at: clock.iso() }));
    // Where this host keeps its images (an avatar may come from there, F7).
    let own = '';
    try { own = new URL(actorId).host.toLowerCase(); } catch { own = ''; }
    for (const a of obj.attachments || []) {
      if (a.kind !== 'image') continue;
      let h = '';
      try { h = new URL(a.url).host.toLowerCase(); } catch { h = ''; }
      if (own && h && h !== own) { try { onMediaHost(own, h); } catch (e) { logger.error(`[walls] media host: ${e.message}`); } }
    }
    write(w);
    return 'added';
  }

  /* An Update of a held entry (its own actor's). -> true when it changed. */
  function update(handle, obj) {
    ensureIndex();
    if (index.get(obj.id) !== handle) return false;
    const w = read(handle);
    const i = w.posts.findIndex((p) => p.id === obj.id);
    if (i < 0) return false;
    w.posts[i] = withMedia({ ...obj, at: w.posts[i].at });
    write(w);
    return true;
  }

  function remove(handle, id) {
    ensureIndex();
    if (index.get(id) !== handle) return false;
    const w = read(handle);
    const next = w.posts.filter((p) => p.id !== id);
    if (next.length === w.posts.length) return false;
    w.posts = next;
    index.delete(id);
    write(w);
    return true;
  }

  function drop(handle) {
    ensureIndex();
    for (const [id, h] of [...index]) if (h === handle) index.delete(id);
    try { fs.rmSync(fileOf(handle), { force: true }); return true; } catch { return false; }
  }

  function markBackfilled(handle, actorId) {
    const w = read(handle);
    w.actor = actorId || w.actor;
    w.backfilled_at = clock.iso();
    write(w);
  }

  const list = (handle) => read(handle).posts;
  const backfilledAt = (handle) => read(handle).backfilled_at;
  /* The wall (handle) holding this remote post, or ''. */
  const holderOf = (id) => { ensureIndex(); return index.get(id) || ''; };
  const entry = (id) => { const h = holderOf(id); return h ? read(h).posts.find((p) => p.id === id) || null : null; };

  /* Every wall's handle (housekeeping). */
  function handles() {
    ensureIndex();
    return [...new Set(index.values())];
  }

  /* Housekeeping: walls no friendship holds (`keep(handle)` false) go; the rest
   * lose posts past 90 days. Also every media id still named. */
  function sweep(keep) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      let raw = null;
      try { raw = readJSON(path.join(dir, f), null); } catch { continue; }
      if (!raw || !isHandle(raw.handle, { allowPort: true })) continue;
      if (!keep(raw.handle)) { drop(raw.handle); n++; continue; }
      const w = read(raw.handle);
      const before = w.posts.length;
      write(w);
      n += before - w.posts.length;
    }
    return n;
  }

  /* Every media id a wall names (the media sweep keeps these), or null when a
   * wall cannot be read: "could not read" is never "names nothing". */
  function mediaIds() {
    const out = new Set();
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return out; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const raw = readJSON(path.join(dir, f), null);
        for (const p of raw?.posts || []) for (const a of p.attachments || []) if (typeof a.media === 'string') out.add(a.media);
      } catch (e) {
        logger.error(`[walls] ${f} could not be read: the media sweep waits: ${e.message}`);
        return null;
      }
    }
    return out;
  }

  return { add, update, remove, drop, list, entry, holderOf, handles, markBackfilled, backfilledAt, sweep, mediaIds, MAX_POSTS };
}

module.exports = { createWalls, MAX_POSTS, KEEP_MS };
