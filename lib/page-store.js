'use strict';
/* ── The page store door (spec 3.3) ───────────────────────────────────────────
 * THE one reader and writer of `members/<name>/log.json` and
 * `members/<name>/tombstones.json`. Every read normalizes (lib/ring.js
 * normalizePage); every write normalizes again and tells the projection cache
 * (spec 3.9: "memoized and dropped on their write"). A read never creates a file.
 *
 * Tombstones (spec 3.10): a deleted post's id and when, 10 000 rows, oldest out.
 * They make "an id is never reused" certain (lib/ids.js mints against them) and,
 * from P5, answer 410 for the object URL.
 *
 * A write for a member who is gone (deleted while the request's body was still
 * arriving) throws MemberGone (401 `not_signed_in`) instead of creating
 * `members/<name>/` again: the purge must stay a purge (spec 11.4). The check runs
 * in the write's own tick, so nothing can slip between it and the write.
 *
 * settings(name) answers the five page switches, the block lists and the theme
 * background (a stamp's tint) from a small cache checked against the file's stat,
 * so GET /api/me, a block check or a signature does not parse a 500-post log.
 * post(name, id) and tombstone(name, id) answer ONE post or tombstone the same
 * way (N4): a by-id index built once per file change, at most 200 members held,
 * least recently used out. The AP object route and the queue's still-sendable
 * check read through them, never a full parse per request.
 *
 * SHOWN (N10). Every save of an ENABLED page stamps `shown: true` on each of its
 * public posts: from then on that post was public to the world. Its tombstone
 * keeps the mark. Only a shown post's deletion federates a Delete with the page
 * off, and only a shown post's URL answers 410 (lib/post-delivery.js,
 * routes/federation.js); a post written and deleted while the page was off was
 * never anyone's to recall.
 */
const fs = require('node:fs');
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { normalizePage } = require('./ring');

const MAX_TOMBSTONES = 10_000;
const MAX_INDEXED = 200;
const SWITCHES = ['enabled', 'indexable', 'open_follows', 'stamps_off', 'comments_off'];

class MemberGone extends Error {
  constructor(name) { super(`page store: ${name} is not a member`); this.code = 'MEMBER_GONE'; this.status = 401; }
}

function createPageStore(paths, { onWrite = () => {}, memberExists = () => true } = {}) {
  const logFile = (name) => paths.memberFile(name, 'log.json');
  const tombFile = (name) => paths.memberFile(name, 'tombstones.json');
  const switchCache = new Map();   // name -> { sig, settings }
  const postIndex = new Map();     // name -> { sig, byId }, least recently used first
  const tombIndex = new Map();     // name -> { sig, byId }

  const sigOf = (file) => {
    try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch { return ''; }
  };

  function load(name) {
    return normalizePage(readJSON(logFile(name), {}));
  }

  function guard(name) {
    if (!memberExists(name)) throw new MemberGone(name);
  }

  function save(name, store) {
    guard(name);
    const n = normalizePage(store);
    if (n.enabled) for (const p of n.posts) if (p.audience === 'public' && p.kind !== 'divider') p.shown = true;
    writeJSON(logFile(name), n);
    switchCache.delete(name);
    postIndex.delete(name);
    onWrite(name);
  }

  /* A by-id index of one file, rebuilt when its stat changes. */
  function indexed(cache, name, file, build) {
    const sig = sigOf(file);
    let hit = cache.get(name);
    if (hit && hit.sig === sig) { cache.delete(name); cache.set(name, hit); return hit.byId; }
    hit = { sig, byId: build() };
    cache.delete(name);
    cache.set(name, hit);
    if (cache.size > MAX_INDEXED) cache.delete(cache.keys().next().value);
    return hit.byId;
  }

  /* One stored post by id (a copy), or null. */
  function post(name, id) {
    const byId = indexed(postIndex, name, logFile(name), () => new Map(load(name).posts.map((p) => [p.id, p])));
    const p = byId.get(id);
    return p ? { ...p } : null;
  }

  /* One tombstone by id (a copy), or null. */
  function tombstone(name, id) {
    const byId = indexed(tombIndex, name, tombFile(name), () => new Map(tombstones(name).map((t) => [t.id, t])));
    const t = byId.get(id);
    return t ? { ...t } : null;
  }

  /* The page switches only. */
  function settings(name) {
    const file = logFile(name);
    const sig = sigOf(file);
    const hit = switchCache.get(name);
    if (hit && hit.sig === sig) return { ...hit.settings, blocked: hit.settings.blocked.slice(), blocked_domains: hit.settings.blocked_domains.slice() };
    const store = load(name);
    const s = Object.fromEntries(SWITCHES.map((k) => [k, store[k]]));
    s.blocked = store.blocked;
    s.blocked_domains = store.blocked_domains;
    s.bg = store.theme.bg;
    if (switchCache.size > 5000) switchCache.clear();
    switchCache.set(name, { sig, settings: s });
    return { ...s, blocked: s.blocked.slice(), blocked_domains: s.blocked_domains.slice() };
  }

  function tombstones(name) {
    const raw = readJSON(tombFile(name), []);
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === 'string') : [];
  }

  function addTombstone(name, post) {
    guard(name);
    const rows = tombstones(name);
    rows.push({ id: post.id, kind: post.kind, audience: post.audience, shown: post.shown === true, deleted_at: clock.iso() });
    writeJSON(tombFile(name), rows.slice(-MAX_TOMBSTONES));
    tombIndex.delete(name);
  }

  /* Every id this member's posts have ever had, live or deleted. Pass the store
   * the caller already loaded to spare a second parse. */
  function takenIds(name, store = load(name)) {
    const ids = new Set(store.posts.map((p) => p.id));
    for (const t of tombstones(name)) ids.add(t.id);
    return ids;
  }

  const exists = (name) => fs.existsSync(paths.memberDir(name));

  const forget = (name) => { switchCache.delete(name); postIndex.delete(name); tombIndex.delete(name); };

  return { load, save, settings, tombstones, addTombstone, takenIds, exists, forget, post, tombstone };
}

module.exports = { createPageStore, MemberGone, MAX_TOMBSTONES };
