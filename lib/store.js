'use strict';
/* ── The JSON file store ──────────────────────────────────────────────────────
 * Every write goes through writeJSON: a unique hidden temp in the same directory,
 * fsync, rename over the target, fsync the directory (so an acknowledged write
 * survives a power cut, not only a crash). A reader, or a crash mid-write, never
 * sees a truncated file. Reads never create anything; writes create their
 * directory.
 *
 * READS FAIL CLOSED. readJSON answers the fallback ONLY when the file does not
 * exist (ENOENT). Bad JSON, an empty file, EACCES, EIO: a StoreReadError naming
 * the file. A read error is never an empty file, because every caller writes back
 * what it read, and an empty value written over a damaged file is the data gone.
 *
 * Files are 0600 and directories 0700 unless a caller says otherwise: the data
 * dir holds password hashes, emails and signing keys.
 *
 * The concurrency rule (spec 3.11): every read-modify-write runs in ONE synchronous
 * tick, never an await between load and save. One process per data dir, so that is
 * the whole story. Do the awaiting (hashing, key generation, image work) first.
 *
 * cachedFile(): a file a module keeps in memory (members.json, images.json) is
 * re-read when it changed underneath (an operator's hand edit while the server
 * runs), checked by a stat on every access, so the next write never serializes a
 * stale cache over the edit.
 *
 * filterLines(): the JSONL exception to writeJSON (audit.log, the mail outbox are
 * appended to). Pruning one streams it in chunks to a temp and renames, the same
 * atomic replace, and never holds the whole file in one string.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class StoreReadError extends Error {
  constructor(file, cause) {
    super(`store: cannot read ${file}: ${cause?.message || cause}. Fix or restore the file; it was not overwritten.`);
    this.name = 'StoreReadError';
    this.file = file;
    this.code = 'STORE_READ';
    this.cause = cause;
  }
}

function readJSON(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new StoreReadError(file, e);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new StoreReadError(file, e); }
}

function writeJSON(file, data, { mode } = {}) {
  writeFileAtomic(file, JSON.stringify(data, null, 2), { mode });
}

/* fsync the directory so the rename itself is durable. Platforms (or filesystems)
 * without directory fsync answer EINVAL, EISDIR, EPERM or EBADF: skipped. */
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* no directory fsync here */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

const tmpNameFor = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
const TMP_RE = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/;

/* The same atomic replace for bytes or a string (images, key files). */
function writeFileAtomic(file, data, { mode } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = tmpNameFor(file);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode ?? 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
  fsyncDir(dir);
}

/* Keep the lines of a JSONL file for which keep(line) is true. Streams in chunks;
 * rewrites (temp, fsync, rename) only when a line goes. Returns lines removed. */
function filterLines(file, keep, { mode = 0o600, chunk = 1 << 20 } = {}) {
  let src;
  try { src = fs.openSync(file, 'r'); }
  catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  const tmp = tmpNameFor(file);
  let out;
  let removed = 0;
  try {
    out = fs.openSync(tmp, 'w', mode);
    const buf = Buffer.alloc(chunk);
    let rest = Buffer.alloc(0);
    const take = (line) => {
      if (!line.length) return;
      if (keep(line.toString('utf8'))) fs.writeSync(out, Buffer.concat([line, Buffer.from('\n')]));
      else removed++;
    };
    for (;;) {
      const n = fs.readSync(src, buf, 0, buf.length, null);
      if (n === 0) break;
      let data = Buffer.concat([rest, buf.subarray(0, n)]);
      for (let i = data.indexOf(0x0a); i >= 0; i = data.indexOf(0x0a)) {
        take(data.subarray(0, i));
        data = data.subarray(i + 1);
      }
      rest = Buffer.from(data);
    }
    take(rest);
    if (removed) {
      fs.fsyncSync(out);
      fs.closeSync(out);
      out = undefined;
      fs.renameSync(tmp, file);
      fsyncDir(path.dirname(file));
    }
    return removed;
  } finally {
    fs.closeSync(src);
    if (out !== undefined) { try { fs.closeSync(out); } catch { /* closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* renamed, or never made */ }
  }
}

/* A file a module caches in memory. get() re-reads when the file changed since
 * this process last read or wrote it (inode, size, mtime, ctime); set() writes
 * through. `shape(raw)` returns the value or throws (a wrong shape is a read
 * error too). A failed read is never cached. `onReload(prev, next)` runs when a
 * change made outside this process was read in. */
function cachedFile(file, { fallback, shape = (v) => v, mode, onReload } = {}) {
  let value;
  let sig = null;   // the stat signature value was read at or written as, '' for absent
  const sigOf = () => {
    try {
      const s = fs.statSync(file);
      return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch (e) {
      if (e.code === 'ENOENT') return '';
      throw new StoreReadError(file, e);
    }
  };
  function get() {
    const now = sigOf();
    if (sig !== null && now === sig) return value;
    const raw = readJSON(file, undefined);
    let v;
    try { v = shape(raw === undefined ? fallback() : raw); }
    catch (e) { throw e instanceof StoreReadError ? e : new StoreReadError(file, e); }
    const prev = value;
    const reloaded = sig !== null;
    value = v;
    sig = now;
    if (reloaded && onReload) onReload(prev, value);   // changed underneath: tell the caches above
    return value;
  }
  function set(next) {
    writeJSON(file, next, { mode });
    value = next;
    sig = sigOf();
  }
  return { get, set, file };
}

/* Housekeeping (crash leftovers): hidden `.<file>.<pid>.<hex>.tmp` files older
 * than `olderThanMs` in each dir (not recursive). Returns the count removed. */
function sweepTemps(dirs, nowMs, olderThanMs = 3600_000) {
  let n = 0;
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!TMP_RE.test(f)) continue;
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && nowMs - st.mtimeMs > olderThanMs) { fs.unlinkSync(p); n++; }
      } catch { /* gone */ }
    }
  }
  return n;
}

module.exports = { readJSON, writeJSON, writeFileAtomic, filterLines, cachedFile, sweepTemps, fsyncDir, StoreReadError, TMP_RE };
