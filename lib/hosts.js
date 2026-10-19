'use strict';
/* ── Remote hosts: failing and unavailable (spec 3.10 `fed/hosts.json`, 7) ────
 * One row per remote host seen: `{ failing_since, unavailable, last_success_at,
 * cleared_at }`. THE one reader and writer of the file.
 *
 *   failure(host)   a delivery to it failed: the first failure since its last
 *                   success starts `failing_since`; failing for 7 days with no
 *                   success marks it `unavailable` (answers true then)
 *   success(host)   a delivery got a 2xx: the failing mark goes
 *   heard(host)     a VERIFIED inbound request from it: both marks go (it speaks
 *                   again); the admin's clear (P8) is the same act
 *   unavailable(h)  no deliveries are written for it, and its queued ones drop
 *
 * THE TABLE LIVES IN MEMORY (N6). It is read once, on first use, and every call
 * after that answers from memory: heard() runs on each verified request and
 * unavailable() per recipient and per attempt, so neither may parse a file. A
 * change marks the table dirty and ONE write follows, DEBOUNCED (`debounceMs`,
 * default 2 s, an unref'd timer), through lib/store.js writeJSON (temp, fsync,
 * rename): atomic, and it survives a restart. flush() writes now (shutdown).
 * A crash loses at most the last debounce window of marks, which only delays a
 * host's 7-day clock by that much.
 *
 * A file that cannot be read is never written over: the call that needed it
 * throws (the queue parks that job a minute, lib/queue.js) and the next call
 * reads again. At most MAX_HOSTS rows; past it the oldest-inserted HEALTHY rows go
 * first (a failing mark is the evidence that keeps a dead host's jobs from being
 * written, so it is the last thing dropped).
 *
 * P6: the host's NodeInfo (spec 8.2), read once a day per host on use, lands in
 * the same row: `software` (its name, lowercase), `version`, `ring_protocol` (a
 * Ring server's `metadata.ringProtocol`) and `nodeinfo_at`. A stamp sent there
 * picks its activity by the software (spec 4.8). A failed read is recorded with
 * an empty name and asked again after an hour. `media_hosts` (F7): the hosts a
 * friend's posts from this host carried images on, at most 8, the hosts an
 * avatar of this host's actors may be fetched from besides its own.
 */
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');

const DEAD_AFTER_MS = 7 * 24 * 3600_000;
const MAX_HOSTS = 50_000;
const DEBOUNCE_MS = 2000;
const MEDIA_HOSTS = 8;

function createHosts(file, { debounceMs = DEBOUNCE_MS, maxHosts = MAX_HOSTS, logger = console } = {}) {
  let table = null;   // host -> row, insertion order oldest first
  let dirty = false;
  let timer = null;

  function load() {
    if (table) return table;
    const raw = readJSON(file, {});   // throws on a damaged file: nothing is written over it
    const t = new Map();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [h, r] of Object.entries(raw)) if (r && typeof r === 'object' && !Array.isArray(r)) t.set(h, { ...r });
    }
    table = t;
    return table;
  }

  function trim() {
    if (table.size <= maxHosts) return;
    let over = table.size - maxHosts;
    for (const [h, r] of table) {
      if (over <= 0) break;
      if (r.failing_since || r.unavailable) continue;
      table.delete(h);
      over--;
    }
    for (const h of table.keys()) { if (over-- <= 0) break; table.delete(h); }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || !table) return false;
    dirty = false;
    try {
      writeJSON(file, Object.fromEntries(table));
    } catch (e) {
      dirty = true;
      logger.error(`[hosts] could not write ${file}: ${e.message}`);
      return false;
    }
    return true;
  }

  function touch() {
    dirty = true;
    trim();
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    timer.unref?.();
  }

  const row = (host) => {
    let r = table.get(host);
    if (!r) { r = {}; table.set(host, r); }
    return r;
  };

  function failure(host) {
    load();
    const r = row(host);
    const now = clock.now();
    let changed = false;
    if (!r.failing_since) { r.failing_since = clock.iso(now); changed = true; }
    if (!r.unavailable && now - Date.parse(r.failing_since) >= DEAD_AFTER_MS) { r.unavailable = true; changed = true; }
    if (changed) touch();
    return r.unavailable === true;
  }

  function success(host) {
    load();
    const r = table.get(host);
    if (r && !r.failing_since && r.last_success_at && !r.unavailable) return;
    const w = row(host);
    delete w.failing_since;
    w.last_success_at = clock.iso();
    touch();
  }

  function heard(host) {
    load();
    const r = table.get(host);
    if (!r || (!r.failing_since && !r.unavailable)) return false;
    delete r.failing_since;
    delete r.unavailable;
    r.cleared_at = clock.iso();
    touch();
    return true;
  }

  /* NodeInfo facts (P6). `info`: { software, version, ring_protocol }. */
  function setSoftware(host, info) {
    load();
    const r = row(host);
    r.software = String(info.software || '').slice(0, 60);
    r.version = String(info.version || '').slice(0, 60);
    const rp = Number(info.ring_protocol);
    if (Number.isInteger(rp) && rp > 0 && rp < 1000) r.ring_protocol = rp; else delete r.ring_protocol;
    r.nodeinfo_at = clock.iso();
    touch();
  }

  /* P6 (F7): another host this host's posts carry their images on (a CDN:
   * Mastodon's files.<host>), seen on a FRIEND's wall. An avatar may come from
   * one of these or from the host itself. At most MEDIA_HOSTS, newest kept. */
  function addMediaHost(host, mediaHost) {
    if (!host || !mediaHost || host === mediaHost) return false;
    load();
    const r = row(host);
    const list = Array.isArray(r.media_hosts) ? r.media_hosts.filter((h) => typeof h === 'string') : [];
    if (list.includes(mediaHost)) return false;
    r.media_hosts = [...list, mediaHost].slice(-MEDIA_HOSTS);
    touch();
    return true;
  }
  const mediaHostsOf = (host) => { const r = load().get(host); return Array.isArray(r?.media_hosts) ? [...r.media_hosts] : []; };

  const get = (host) => { const r = load().get(host); return r ? { ...r } : null; };
  const unavailable = (host) => load().get(host)?.unavailable === true;
  const all = () => Object.fromEntries([...load()].map(([h, r]) => [h, { ...r }]));

  return { failure, success, heard, clear: heard, get, unavailable, all, flush, setSoftware, addMediaHost, mediaHostsOf, size: () => load().size };
}

module.exports = { createHosts, DEAD_AFTER_MS, MAX_HOSTS, DEBOUNCE_MS };
