'use strict';
/* ── Inbound activity ids, deduplicated for 7 days (spec 5.5, 3.10) ───────────
 * `fed/seen/<YYYY-MM-DD>.txt`: one line per activity HANDLED (appended, the JSONL
 * exception, like audit.log). Boot loads the last 7 days into one in-memory map;
 * has(id) answers from it. Housekeeping removes the day files past 7 days and
 * forgets their ids.
 *
 * BOUNDED (N5). A line, and a key in memory, is a FIXED-LENGTH hash of the id
 * (the first 128 bits of SHA-256, 32 hex characters), never the id itself: an id
 * may be 2000 characters long and is chosen by the sender. At most `max` ids are
 * kept (100 000 by default), oldest out. A day file past twice that many lines
 * is rewritten (temp and rename) from the ids memory still holds for that day,
 * so the disk is bounded as well and keeps the newest. The caller records
 * only an activity it actually HANDLED (lib/federation.js inboxPost): one
 * dropped as not for us, or not in the registry, costs nothing here.
 *
 * The same activity delivered twice (a sender's retry, a replay with a fresh
 * signature) applies once: the inbox answers 202 and does nothing. A day file
 * written before the hashes (raw ids) is read and hashed on load.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { writeFileAtomic } = require('./store');

const KEEP_DAYS = 7;
const MAX_SEEN = 100_000;
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.txt$/;
const HASH_RE = /^[0-9a-f]{32}$/;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hashOf = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32);

function createSeen(dir, { max = MAX_SEEN } = {}) {
  const ids = new Map();   // hash -> day, oldest first
  let loaded = false;
  let fileDay = '';
  let fileLines = 0;

  const cutoffDay = () => dayOf(clock.now() - KEEP_DAYS * 24 * 3600_000);

  function put(h, day) {
    ids.delete(h);
    ids.set(h, day);
    if (ids.size > max) {
      let n = ids.size - max;
      for (const k of ids.keys()) { ids.delete(k); if (--n <= 0) break; }
    }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    const cut = cutoffDay();
    const today = dayOf(clock.now());
    for (const f of files.sort()) {
      const m = DAY_RE.exec(f);
      if (!m || m[1] < cut) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      let lines = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        lines++;
        put(HASH_RE.test(line) ? line : hashOf(line), m[1]);
      }
      if (m[1] === today) { fileDay = today; fileLines = lines; }
    }
  }

  function has(id) {
    load();
    if (typeof id !== 'string' || !id) return false;
    const day = ids.get(hashOf(id));
    return !!day && day >= cutoffDay();
  }

  function add(id) {
    load();
    if (typeof id !== 'string' || !id || id.length > 2000) return;
    const h = hashOf(id);
    const day = dayOf(clock.now());
    put(h, day);
    if (day !== fileDay) { fileDay = day; fileLines = 0; }
    const file = path.join(dir, `${day}.txt`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fileLines >= 2 * max) {
      // Past twice the cap: the day file becomes what memory holds for the day.
      const keep = [];
      for (const [k, d] of ids) if (d === day) keep.push(k);
      writeFileAtomic(file, keep.length ? `${keep.join('\n')}\n` : '', { mode: 0o600 });
      fileLines = keep.length;
      return;   // h is the newest, so it is in `keep`
    }
    fileLines++;
    fs.appendFileSync(file, `${h}\n`, { mode: 0o600 });
  }

  /* Housekeeping: day files past the window, and their ids. */
  function sweep() {
    load();
    const cut = cutoffDay();
    let n = 0;
    for (const [h, day] of ids) if (day < cut) ids.delete(h);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return 0; }
    for (const f of files) {
      const m = DAY_RE.exec(f);
      if (m && m[1] < cut) { fs.rmSync(path.join(dir, f), { force: true }); n++; }
    }
    return n;
  }

  return { has, add, sweep, size: () => { load(); return ids.size; } };
}

module.exports = { createSeen, KEEP_DAYS, MAX_SEEN, hashOf };
