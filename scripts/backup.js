#!/usr/bin/env node
'use strict';
/* ── The admin's full-data backup (spec 15.4) ─────────────────────────────────
 *   node scripts/backup.js [--data <DATA_DIR>] [--out <dir>]
 *
 * Writes `ring-<YYYY-MM-DD>T<HHMMSS>Z.tar.gz` of the whole data directory into
 * `--out` (default: the current directory), minus what a restore does not
 * need or must not bring back:
 *   sessions/      signed-in sessions (a restore signs everyone in again)
 *   fed/media/     the remote media cache (refetched on the next miss)
 *   backups/       pre-migration tars (15.5)
 *   .lock          the running process's lease (15.4)
 *   hidden `.<file>.<pid>.<hex>.tmp` write temps, symlinks, sockets
 *   any earlier backup (`ring-<stamp>.tar.gz`, `.part` too), wherever it sits
 * `--data` defaults to DATA_DIR, then `./data`; it must hold `instance.json`
 * (a Ring data dir). The output may not land inside the data dir, except in
 * its own `backups/`, which the tar leaves out. "Inside" is decided on the
 * real paths, by device and inode up the tree, so a symlink, a symlinked
 * `--data` or a case-insensitive spelling is no way in. An existing target
 * file is refused, never overwritten.
 *
 * CONSISTENCY. A STOPPED server gives a fully consistent tar. On a LIVE server
 * the tar is consistent per account index, by the ORDER of the walk: a
 * reference is read before what it names, and each directory is listed only
 * when the walk reaches it (never one listing up front). At the top: first the
 * account dirs (`members/<name>/`, whose page stores name images, rings and
 * people; also `fed/`, `queue/`), then the indexes (`members.json`,
 * `images.json`, `rings.json` and every other top-level file), then `keys/`
 * and `images/`. Below the top, a directory's files are read before its
 * subdirectories are listed. Ring writes a key file or an image before the
 * row that names it, and a row before a post that names it, so every row the
 * tar holds has its file and every image a post names has its row. A file
 * removed after its row was read is missing (a deletion in flight); anything
 * written after the walk passed it is not in the tar. Every data file is
 * replaced by rename, so a file read is a whole file, old or new.
 *
 * READING. A file up to ONE_READ_MAX is read whole BEFORE its header is
 * written (so it is recorded at its true size); a larger one is streamed from
 * one open handle, exactly the size it had when opened (an appended log keeps
 * its prefix; one that shrinks fails the run). Past USTAR_MAX (8 GiB, what a
 * ustar size field holds) the run fails and names the file. A file or
 * directory gone between the listing and the read (ENOENT) is skipped and
 * counted; ANY other read error fails the run with the file's path in the data
 * dir and the error code, and no tar is left behind.
 *
 * THE TAR IS A SECRET. It holds every member's password hash and email, every
 * signing key (`keys/`), the mail outbox's live links and the invite codes. It
 * is written 0600, as `.part` first and moved into place when complete, and
 * this script prints only the path, the file count and the size: never a byte
 * of a file, and a file's name only when it is the one the run failed on.
 * Keep it like a password; it is never offered as a web download.
 *
 * Format: POSIX ustar, gzipped, entries relative to the data dir (no wrapping
 * folder), uid and gid 0, so a restore is `tar --no-same-owner -xzf
 * ring-....tar.gz -C <empty DATA_DIR>` as the server's user (or a `chown -R`
 * after extracting as root), then start with the same PUBLIC_ORIGIN (the
 * origin lock, 15.2). Names up to 255 bytes use ustar's prefix field; a longer
 * one (none of Ring's own) is skipped and counted. Directories are recorded
 * 0700, files 0600.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const EXCLUDE_DIRS = new Set(['sessions', 'fed/media', 'backups']);
const EXCLUDE_FILES = new Set(['.lock']);
/* Top-level dirs whose files the indexes name: walked last, in this order. */
const BLOBS_LAST = ['keys', 'images'];
const TMP_RE = /^\..+\.tmp$/;
const BACKUP_RE = /^ring-\d{8}T\d{6}Z\.tar\.gz(\.part)?$/i;
const BLOCK = 512;
const ONE_READ_MAX = 16 * 1024 * 1024;
const USTAR_MAX = 8 ** 11 - 1;   // 11 octal digits
const CHUNK = 1024 * 1024;

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0').slice(-(width - 1)) + '\0';
}

/* name + prefix split at a slash (ustar: name 100 bytes, prefix 155). */
function splitName(rel) {
  const b = Buffer.from(rel, 'utf8');
  if (b.length <= 100) return { name: rel, prefix: '' };
  for (let i = rel.length - 1; i > 0; i--) {
    if (rel[i] !== '/') continue;
    const prefix = rel.slice(0, i);
    const name = rel.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix };
  }
  return null;
}

function header(rel, size, mtimeSec, dir) {
  const parts = splitName(rel);
  if (!parts) return null;
  const h = Buffer.alloc(BLOCK);
  h.write(parts.name, 0, 'utf8');
  h.write(octal(dir ? 0o700 : 0o600, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.max(0, Math.floor(mtimeSec)), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(dir ? '5' : '0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  if (parts.prefix) h.write(parts.prefix, 345, 'utf8');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0').slice(-6) + '\0 ', 148, 'ascii');
  return h;
}

const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;

/* Where `out` lands relative to the data dir, on REAL paths: 'outside',
 * 'backups' (its own backups/, allowed) or a refusal. The nearest existing
 * ancestor of `out` is resolved (symlinks followed), then every directory up
 * to the root is compared with the data dir and its backups/ by device and
 * inode, which also catches a case-insensitive spelling of either. */
function placeOut(out, data) {
  const dataSt = fs.statSync(data);
  let backupsSt = null;
  try { const st = fs.statSync(path.join(data, 'backups')); if (st.isDirectory()) backupsSt = st; } catch { /* not yet */ }
  let base = path.resolve(out);
  const rest = [];
  while (!fs.existsSync(base)) {
    const up = path.dirname(base);
    if (up === base) break;
    rest.unshift(path.basename(base));
    base = up;
  }
  const start = fs.realpathSync(base);
  let viaBackups = false;
  for (let cur = start; ; cur = path.dirname(cur)) {
    const st = fs.statSync(cur);
    if (backupsSt && sameNode(st, backupsSt)) viaBackups = true;
    if (sameNode(st, dataSt)) {
      // The data dir itself, with backups/ still to make: only that exact name.
      if (viaBackups || (cur === start && rest[0] === 'backups')) return 'backups';
      throw new Error('backup: the output may not be inside the data dir (except its backups/)');
    }
    if (path.dirname(cur) === cur) return 'outside';
  }
}

/* A read failure other than "gone": the run stops, naming the file. */
function readError(rel, e) {
  return new Error(`backup: could not read ${rel || '.'} in the data dir (${e.code || e.message}); nothing was written`);
}

/* Write the backup. Returns { file, files, bytes, skipped }. Prints nothing.
 * `onStep(kind, rel)` (tests only) is awaited right after each directory is
 * listed ('list') and right before each file is read ('read'). */
async function createBackup({ dataDir, outDir = process.cwd(), now = new Date(), onStep = null } = {}) {
  if (!dataDir) throw new Error('backup: no data dir');
  const given = path.resolve(dataDir);
  if (!fs.existsSync(path.join(given, 'instance.json'))) throw new Error(`backup: ${given} is not a Ring data dir (no instance.json)`);
  const data = fs.realpathSync(given);
  placeOut(outDir, data);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  placeOut(outDir, data);   // again, now that it exists
  const out = fs.realpathSync(outDir);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = path.join(out, `ring-${stamp.slice(0, 8)}T${stamp.slice(9)}.tar.gz`);
  const part = `${file}.part`;
  if (fs.existsSync(file)) throw new Error(`backup: ${file} already exists; a backup never overwrites one`);

  const stats = { files: 0, skipped: 0 };
  const step = async (kind, rel) => { if (onStep) await onStep(kind, rel); };
  const abs = (rel) => path.join(data, rel);

  async function* fileBlocks(rel) {
    await step('read', rel);
    let fd;
    try { fd = fs.openSync(abs(rel), 'r'); } catch (e) {
      if (e.code === 'ENOENT') { stats.skipped++; return; }   // gone meanwhile
      throw readError(rel, e);
    }
    try {
      let st;
      let buf = null;
      try {
        st = fs.fstatSync(fd);
        if (!st.isFile()) { stats.skipped++; return; }   // replaced by something else meanwhile
        if (st.size > USTAR_MAX) {
          throw new Error(`backup: ${rel} in the data dir is ${st.size} bytes, past the 8 GiB a tar entry can record; nothing was written`);
        }
        if (st.size <= ONE_READ_MAX) buf = fs.readFileSync(fd);   // whole, before its header
      } catch (e) {
        if (e.message.startsWith('backup: ')) throw e;
        throw readError(rel, e);
      }
      const size = buf ? buf.length : st.size;
      const h = header(rel, size, st.mtimeMs / 1000, false);
      if (!h) { stats.skipped++; return; }   // a name past 255 bytes
      yield h;
      if (buf) {
        yield buf;
      } else {
        let pos = 0;
        while (pos < size) {
          const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
          let n;
          try { n = fs.readSync(fd, chunk, 0, chunk.length, pos); } catch (e) { throw readError(rel, e); }
          if (n === 0) throw new Error(`backup: ${rel} in the data dir shrank while it was read; nothing was written`);
          pos += n;
          yield n === chunk.length ? chunk : chunk.subarray(0, n);
        }
      }
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad) yield Buffer.alloc(pad);
      stats.files++;
    } finally {
      fs.closeSync(fd);
    }
  }

  /* One directory: listed when reached, its files first, then its subdirs. */
  async function* dirBlocks(rel) {
    let names;
    let dirSt;
    try {
      names = fs.readdirSync(rel ? abs(rel) : data).sort();
      dirSt = fs.statSync(rel ? abs(rel) : data);
    } catch (e) {
      if (e.code === 'ENOENT' && rel) return;   // a dir removed meanwhile (a purge)
      throw readError(rel, e);
    }
    await step('list', rel);
    if (rel) {
      const h = header(`${rel}/`, 0, dirSt.mtimeMs / 1000, true);
      if (h) yield h;
    }
    const files = [];
    const dirs = [];
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try { st = fs.lstatSync(abs(r)); } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw readError(r, e);
      }
      if (st.isDirectory()) {
        if (!EXCLUDE_DIRS.has(r)) dirs.push(r);
      } else if (st.isFile()) {
        if (!rel && EXCLUDE_FILES.has(n)) continue;
        if (TMP_RE.test(n) || BACKUP_RE.test(n)) continue;
        files.push(r);
      }
      // symlinks, sockets and the rest: never followed, never written
    }
    if (rel) {
      for (const f of files) yield* fileBlocks(f);
      for (const d of dirs) yield* dirBlocks(d);
      return;
    }
    // The top: the account dirs, then the indexes, then the files they name.
    for (const d of dirs.filter((x) => !BLOBS_LAST.includes(x))) yield* dirBlocks(d);
    for (const f of files) yield* fileBlocks(f);
    for (const d of BLOBS_LAST.filter((x) => dirs.includes(x))) yield* dirBlocks(d);
  }

  async function* blocks() {
    yield* dirBlocks('');
    yield Buffer.alloc(BLOCK * 2);
  }

  // The stream owns the descriptor: flushed to disk before it closes, closed
  // by the stream on success and on failure alike.
  const ws = fs.createWriteStream(null, { fd: fs.openSync(part, 'wx', 0o600), flush: true });
  try {
    await pipeline(Readable.from(blocks()), zlib.createGzip({ level: 6 }), ws);
    if (!ws.closed) await new Promise((resolve, reject) => { ws.once('close', resolve); ws.once('error', reject); });
  } catch (e) {
    if (!ws.closed) await new Promise((resolve) => { ws.once('close', resolve); ws.destroy(); });
    try { fs.unlinkSync(part); } catch { /* gone */ }
    throw e;
  }
  // Into place without overwriting: a hard link fails if the name was taken
  // meanwhile. A filesystem with no hard links gets a checked rename.
  try {
    fs.linkSync(part, file);
    fs.unlinkSync(part);
  } catch (e) {
    if (e.code === 'EEXIST' || fs.existsSync(file)) {
      try { fs.unlinkSync(part); } catch { /* gone */ }
      throw new Error(`backup: ${file} already exists; a backup never overwrites one`);
    }
    fs.renameSync(part, file);
  }
  fs.chmodSync(file, 0o600);
  return { file, files: stats.files, skipped: stats.skipped, bytes: fs.statSync(file).size };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data' || a === '--out') o[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`backup: unknown argument ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write('node scripts/backup.js [--data <DATA_DIR>] [--out <dir>]\nWrites ring-<time>.tar.gz of the data dir. It holds every password hash and signing key: keep it like a password.\n');
    return;
  }
  const r = await createBackup({ dataDir: o.data || process.env.DATA_DIR || './data', outDir: o.out || process.cwd() });
  process.stdout.write(`backup written: ${r.file} (${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB${r.skipped ? `, ${r.skipped} skipped: removed while it ran, or a name past 255 bytes` : ''})\nIt holds every password hash and signing key: keep it like a password.\n`);
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exit(1); });
}

module.exports = { createBackup, placeOut, EXCLUDE_DIRS, BLOBS_LAST, ONE_READ_MAX, USTAR_MAX };
