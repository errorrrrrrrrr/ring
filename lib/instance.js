'use strict';
/* ── instance.json, the boot check and the data-dir lock (spec 15.2, 15.4) ────
 * `DATA/instance.json` records the origin at first boot, the schema version and
 * `federated_at` (stamped by P5 at the first verified inbound activity, first
 * verified signed GET or first delivery). Once federated, the server REFUSES to
 * boot under another origin: other servers hold its actor URLs for good. Before
 * that the origin may move.
 *
 * THE LOCK CANNOT BE LOST QUIETLY (N11). `federated_at` is the lock: a valid
 * date, or an explicit `null` ("not yet"). A file that is missing, or says
 * neither (`{}`, `federated_at: ""`), is NO lock, and the data dir is searched
 * for federation evidence before anything is written: remote follow rows in a
 * member's follows.json, a cached remote actor (`fed/actors`), a seen inbound
 * activity (`fed/seen`), the instance key (`keys/_instance.pem`). Any of it
 * refuses the boot, naming it: the lock was lost, and booting would let the
 * origin move under servers that hold it. With an explicit `null`, only the
 * evidence nothing but a verified inbound activity leaves (a seen id, a remote
 * FOLLOWER) refuses: that file was edited by hand.
 *
 * verifyDataFiles(): before anything is built, every top-level data file is read
 * and shape-checked. A damaged one REFUSES the boot, naming the file and the
 * error: a module that read it as empty would write that emptiness back over it
 * (lib/store.js: reads fail closed).
 *
 * `DATA/.lock` is a LEASE held by the one process that owns the data dir; the
 * whole concurrency story (lib/store.js) rests on one process. The file holds
 * `{ token, pid, hostname, boot_id, at }` and its mtime is a heartbeat, renewed
 * every HEARTBEAT_MS by an unref'd timer that also re-reads the token: a process
 * that finds someone else's token there has lost the data dir and stops loudly.
 *
 * A lock is STALE, and taken over, when its heartbeat is older than STALE_MS, or
 * when it was written on this host (same hostname and boot id) by a pid that is
 * dead or is our own pid but not held by this process (a container restart). A
 * fresh lock from another host is a refusal, even under our own pid: two
 * containers sharing a volume both run as pid 1. The takeover renames the stale
 * file aside (one renamer wins), re-checks it was the stale one, then creates the
 * new lock with O_EXCL. release() deletes the lock only while it holds our token.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { readJSON, writeJSON, StoreReadError } = require('./store');

const SCHEMA = 1;
const HEARTBEAT_MS = 30_000;
const STALE_MS = 90_000;
const held = new Set();   // lock files this process holds

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return ''; }
}

/* The lock as it is on disk: { body (parsed or null), mtimeMs }, or null. */
function readLock(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let body = null;
  try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* torn or empty: judged by mtime */ }
  return { body: body && typeof body === 'object' ? body : null, mtimeMs: st.mtimeMs };
}

function describe(lock) {
  const b = lock.body || {};
  const age = Math.round((Date.now() - lock.mtimeMs) / 1000);
  return `pid ${b.pid ?? '?'} on host ${b.hostname || '?'}, last heartbeat ${age} s ago`;
}

/* Why the lock is stale, or '' when it is live. Real time: the lock is shared
 * with other processes, which do not share lib/clock.js. */
function staleReason(lock, me, staleMs) {
  if (Date.now() - lock.mtimeMs > staleMs) return 'heartbeat';
  const b = lock.body;
  if (!b) return '';
  const sameHost = b.hostname === me.hostname && (b.boot_id || '') === me.boot_id;
  if (!sameHost || !Number.isInteger(b.pid)) return '';
  if (b.pid === process.pid) return 'own-pid';   // not held here (checked first): a previous life
  return pidAlive(b.pid) ? '' : 'dead-pid';
}

function acquireLock(file, { heartbeatMs = HEARTBEAT_MS, staleMs = STALE_MS, onLost, logger = console } = {}) {
  if (held.has(file)) throw new Error(`Another Ring server in this process already uses this data dir (${file}).`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const me = { token: crypto.randomBytes(16).toString('hex'), pid: process.pid, hostname: os.hostname(), boot_id: bootId() };
  const body = () => JSON.stringify({ ...me, at: new Date().toISOString() });

  const create = () => {
    try { fs.writeFileSync(file, body(), { flag: 'wx', mode: 0o600 }); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  };

  let got = create();
  for (let attempt = 0; !got && attempt < 3; attempt++) {
    const cur = readLock(file);
    if (!cur) { got = create(); continue; }
    if (!staleReason(cur, me, staleMs)) {
      throw new Error(`Another Ring process holds ${file} (${describe(cur)}). One process per data dir. `
        + `A lock whose heartbeat stops goes stale after ${Math.round(staleMs / 1000)} s; if no other Ring process uses this data dir, delete the file.`);
    }
    // Take over: move the stale file aside. Only one renamer wins the path.
    const aside = `${file}.stale-${crypto.randomBytes(6).toString('hex')}`;
    try { fs.renameSync(file, aside); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const moved = readLock(aside);
    const wasStale = moved && (moved.body?.token ?? null) === (cur.body?.token ?? null) && moved.mtimeMs === cur.mtimeMs;
    if (!wasStale) {
      // We moved a lock someone took between our read and our rename: put it back.
      try { fs.linkSync(aside, file); } catch { /* a third process made one: theirs stands */ }
      try { fs.unlinkSync(aside); } catch { /* gone */ }
      continue;
    }
    try { fs.unlinkSync(aside); } catch { /* gone */ }
    logger.warn?.(`[instance] took over a stale data-dir lock (${staleReason(cur, me, staleMs)}: ${describe(cur)})`);
    got = create();
  }
  if (!got) throw new Error(`Could not take the data-dir lock ${file}: another process keeps taking it.`);
  held.add(file);

  const ours = () => {
    const cur = readLock(file);
    return !!cur?.body && cur.body.token === me.token;
  };
  const lost = onLost || ((why) => {
    logger.error(`[instance] FATAL: the data-dir lock ${file} is no longer ours (${why}). Another process uses this data dir; stopping now.`);
    process.exit(70);
  });
  function beat() {
    let cur;
    try { cur = readLock(file); } catch (e) { logger.error(`[instance] lock heartbeat: ${e.message}`); return; }
    if (!cur) return lost('the lock file is gone');
    if (cur.body?.token !== me.token) return lost(`held by ${describe(cur)}`);
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch (e) { logger.error(`[instance] lock heartbeat: ${e.message}`); }
  }
  const timer = setInterval(beat, heartbeatMs);
  timer.unref();

  function release() {
    clearInterval(timer);
    if (!held.delete(file)) return;
    try { if (ours()) fs.unlinkSync(file); } catch { /* already gone */ }
  }
  release.token = me.token;
  release.heartbeat = beat;   // tests: one beat now
  return release;
}

/* The top-level files and the shape each must have. Absent is fine (a fresh data
 * dir); present and unreadable, or the wrong shape, refuses the boot. */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function dataFileChecks(paths) {
  return [
    [paths.members, Array.isArray, 'a list of member rows'],
    [paths.images, isObj, 'an object of image rows'],
    [paths.invites, Array.isArray, 'a list of invites'],
    [paths.retired, Array.isArray, 'a list of retired names'],
    [paths.instance, isObj, 'an object'],
    [paths.pendingSignups, Array.isArray, 'a list of tokens'],
    [paths.passwordResets, Array.isArray, 'a list of tokens'],
    [paths.rings, Array.isArray, 'a list of rings'],   // P2: the one global social file
  ];
}

function verifyDataFiles(paths) {
  const problems = [];
  for (const [file, ok, what] of dataFileChecks(paths)) {
    try {
      const v = readJSON(file, undefined);
      if (v !== undefined && !ok(v)) problems.push(`${file}: not ${what}`);
    } catch (e) {
      problems.push(e instanceof StoreReadError ? `${file}: ${e.cause?.message || e.message}` : `${file}: ${e.message}`);
    }
  }
  if (problems.length) {
    throw new Error(`Ring will not start: a data file is damaged, and starting would write over it.\n  ${problems.join('\n  ')}\n`
      + 'Fix the file (or restore it from a backup) and start again.');
  }
}

const nonEmptyDir = (d) => { try { return fs.readdirSync(d).some((f) => !f.startsWith('.')); } catch { return false; } };

/* What in this data dir says it has federated. `strong`: only the evidence a
 * verified inbound activity leaves. -> list of relative paths. */
function federationEvidence(paths, { strong = false } = {}) {
  if (!paths) return [];
  const found = [];
  if (nonEmptyDir(paths.fedSeenDir)) found.push('fed/seen');
  if (!strong && nonEmptyDir(paths.fedActorsDir)) found.push('fed/actors');
  if (!strong && fs.existsSync(path.join(paths.keysDir, '_instance.pem'))) found.push('keys/_instance.pem');
  let names = [];
  try { names = fs.readdirSync(paths.membersDir); } catch { names = []; }
  for (const n of names) {
    let f = null;
    try { f = JSON.parse(fs.readFileSync(path.join(paths.membersDir, n, 'follows.json'), 'utf8')); } catch { continue; }
    const remote = (rows) => Array.isArray(rows) && rows.some((r) => typeof r?.handle === 'string' && r.handle.includes('@'));
    if (remote(f?.followers) || (!strong && remote(f?.following))) { found.push(`members/${n}/follows.json`); break; }
  }
  return found;
}

const validLock = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

function bootInstance(file, cfg, log = console, paths = null) {
  const now = clock.iso();
  const cur = readJSON(file, null);
  const explicitNull = !!cur && Object.hasOwn(cur, 'federated_at') && cur.federated_at === null && Object.hasOwn(cur, 'origin');
  if (!cur || (!validLock(cur.federated_at) && !explicitNull)) {
    const evidence = federationEvidence(paths);
    if (evidence.length) {
      throw new Error(`Ring will not start: instance.json ${cur ? 'has no origin lock (federated_at)' : 'is missing'}, but this data dir has federated (${evidence.join(', ')}). `
        + 'Its origin is permanent and the record of it is gone: restore instance.json from a backup (spec 15.4). Booting would let the origin move under servers that hold it.');
    }
    const fresh = { origin: cfg.publicOrigin || null, schema: SCHEMA, created_at: cur?.created_at || now, federated_at: null };
    writeJSON(file, fresh);
    return fresh;
  }
  if (explicitNull) {
    const evidence = federationEvidence(paths, { strong: true });
    if (evidence.length) {
      throw new Error(`Ring will not start: instance.json says this server never federated, but it has (${evidence.join(', ')}). `
        + 'Restore instance.json from a backup (spec 15.4): its origin is permanent.');
    }
  }
  if (cur.federated_at && cur.origin !== (cfg.publicOrigin || null)) {
    throw new Error(`This server federated as ${cur.origin}; its actor URLs live in other servers' databases; `
      + 'a new domain is a new server: start with an empty DATA_DIR.');
  }
  if (cfg.publicOrigin && cur.origin !== cfg.publicOrigin) {
    log.log(`[instance] origin ${cur.origin || '(none)'} -> ${cfg.publicOrigin} (not federated yet, so it may still move)`);
    cur.origin = cfg.publicOrigin;
    writeJSON(file, cur);
  }
  return cur;
}

module.exports = { acquireLock, bootInstance, verifyDataFiles, federationEvidence, SCHEMA, HEARTBEAT_MS, STALE_MS };
