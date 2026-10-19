'use strict';
/* ── The session store (spec 14) ──────────────────────────────────────────────
 * Ring's own small file store under `DATA/sessions/`, because session-file-store
 * has no `all()`, and "end every session of this member" is a rule here (spec
 * 10.9: a password change ends the others, a reset and a deletion end all).
 *
 * One file per session, named by the SHA-256 of the session id (a directory
 * listing or a stray copy names no live cookie), written through writeJSON, mode
 * 0600 in a 0700 dir. Each file is `{ member, expires, sess }`.
 *
 *   destroyFor(name, { exceptSid })  ends every session of a member
 *   all()                            the live sessions (express-session's API)
 *
 * A destroyed id is remembered (`dead`, a day) so a request already in flight
 * cannot write its session back with set() or touch(); lib/auth.js's
 * `sessions_from` cutoff is the second line. touch() never creates a file and
 * rewrites at most hourly: rolling 30-day sessions without a write per request.
 *
 * A DAMAGED FILE IS NO SESSION. lib/store.js readJSON throws on a file it cannot
 * read or parse (it never pretends a damaged file is empty). A session is
 * disposable, so `read()` catches that per file, logs it once, UNLINKS the file
 * and answers null: that cookie is simply signed out, and one bad file never 500s
 * a request nor stops destroyFor / sweep / all from walking the rest. Unlinking is
 * the safe direction: a file whose member cannot be read must not outlive
 * destroyFor. A row of the wrong shape (no `sess`, no numeric `expires`) is
 * damaged too.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const session = require('express-session');
const { readJSON, writeJSON } = require('./store');

const SID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const DAY = 86_400_000;
const hashOf = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');

class FileSessionStore extends session.Store {
  constructor({ dir, touchEveryMs = 3_600_000, logger = console } = {}) {
    super();
    this.logger = logger;
    this.dir = dir;
    this.touchEveryMs = touchEveryMs;
    this.dead = new Map();   // hash -> when destroyed
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  fileOf(sid) {
    return SID_RE.test(String(sid)) ? path.join(this.dir, `${hashOf(sid)}.json`) : null;
  }

  static expiresOf(sess) {
    const e = sess?.cookie?.expires;
    const ms = e ? new Date(e).getTime() : NaN;
    return Number.isFinite(ms) ? ms : Date.now() + 30 * DAY;
  }

  /* The row in `file`, or null when there is none; a damaged file is unlinked. */
  read(file) {
    let row;
    try { row = readJSON(file, null); }
    catch (e) { return this.discard(file, e.message); }
    if (row === null) return null;
    if (!row || typeof row !== 'object' || !row.sess || typeof row.sess !== 'object' || !Number.isFinite(row.expires)) {
      return this.discard(file, 'not a session row');
    }
    return row;
  }

  discard(file, why) {
    this.logger.error(`[sessions] damaged session file ${path.basename(file)} removed: ${why}`);
    this.unlink(file);
    return null;
  }

  get(sid, cb) {
    const file = this.fileOf(sid);
    if (!file) return cb(null, null);
    const row = this.read(file);
    if (!row?.sess) return cb(null, null);
    if (row.expires <= Date.now()) { this.unlink(file); return cb(null, null); }
    cb(null, row.sess);
  }

  set(sid, sess, cb = () => {}) {
    try {
      const file = this.fileOf(sid);
      if (!file || this.dead.has(hashOf(sid))) return cb();
      writeJSON(file, { member: sess.member || null, expires: FileSessionStore.expiresOf(sess), sess }, { mode: 0o600 });
      cb();
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      const file = this.fileOf(sid);
      if (!file || this.dead.has(hashOf(sid))) return cb();
      const row = this.read(file);
      if (!row) return cb();   // never create: a destroyed session stays destroyed
      const expires = FileSessionStore.expiresOf(sess);
      if (expires - row.expires < this.touchEveryMs) return cb();
      writeJSON(file, { ...row, expires, sess: { ...row.sess, cookie: sess.cookie } }, { mode: 0o600 });
      cb();
    } catch (e) { cb(e); }
  }

  destroy(sid, cb = () => {}) {
    const file = this.fileOf(sid);
    if (file) { this.dead.set(hashOf(sid), Date.now()); this.unlink(file); }
    cb();
  }

  unlink(file) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }

  rows() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const f of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
      const file = path.join(this.dir, f);
      const row = this.read(file);
      if (row) out.push({ hash: f.slice(0, 64), file, row });
    }
    return out;
  }

  all(cb) {
    const now = Date.now();
    const list = this.rows().filter((r) => r.row.expires > now).map((r) => ({ id: r.hash, ...r.row.sess }));
    if (cb) return cb(null, list);
    return list;
  }

  length(cb) { cb(null, this.all().length); }

  clear(cb = () => {}) {
    for (const r of this.rows()) { this.dead.set(r.hash, Date.now()); this.unlink(r.file); }
    cb();
  }

  /* End every session of `member` but `exceptSid`. Synchronous; returns the count. */
  destroyFor(member, { exceptSid } = {}) {
    const keep = exceptSid ? hashOf(exceptSid) : null;
    let n = 0;
    for (const r of this.rows()) {
      if (r.row.member !== member || r.hash === keep) continue;
      this.dead.set(r.hash, Date.now());
      this.unlink(r.file);
      n++;
    }
    return n;
  }

  /* Housekeeping: expired files, and dead ids older than a day. */
  sweep() {
    const now = Date.now();
    let n = 0;
    for (const r of this.rows()) if (r.row.expires <= now) { this.unlink(r.file); n++; }
    for (const [h, at] of this.dead) if (now - at > DAY) this.dead.delete(h);
    return n;
  }
}

module.exports = { FileSessionStore, hashOf };
