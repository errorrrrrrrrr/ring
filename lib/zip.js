'use strict';
/* ── The zip writer (spec 12, 14) ─────────────────────────────────────────────
 * A dependency-free writer: Ring takes no zip library. The member export
 * (routes/export.js) is a STANDARD .zip that opens with a double-click, so a
 * person with a file manager can read their own posts.
 *
 * Classic 32-bit zip (no zip64: the export cap sits far below 4 GB). Buffer
 * entries are DEFLATEd; file entries (the images, already compressed formats)
 * are STOREd. Every local header carries real sizes and CRCs and no data
 * descriptor is ever written, so a file's CRC is known before its header:
 *   - a file up to ONE_READ_MAX (above the upload door's 10 MB, so every image
 *     the door stores) is READ ONCE, in chunks into one buffer, with a running
 *     CRC-32 and SHA-256; the bytes hashed are the bytes sent;
 *   - a larger one (only a hand-placed file can be) is read twice through ONE
 *     open handle: a pass for the CRC and SHA-256, then the data pass, whose own
 *     running CRC must match, else the stream fails.
 * A file whose size differs from the one the caller planned, or that grows or
 * changes meanwhile, fails the stream rather than writing a header that lies.
 * A file entry marked `optional` that is gone (ENOENT) when reached is skipped
 * and reported through `onMissing`; any other read error fails the stream.
 *
 * Entry names are relative paths: a name with a `..` segment, a leading `/`, a
 * backslash, a NUL or a drive letter is refused before a byte is written, so no
 * archive this writer makes can unpack outside its folder.
 *
 * CRC-32 is node's native `zlib.crc32` when the runtime has it, else the table
 * version below (same answers; test/export-hardening.test.js holds them equal).
 *
 * Only the writer is here: the server never reads an uploaded zip.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
/* zlib's contract: `prev` is an earlier result (0 to start), the answer is unsigned. */
function crc32Js(buf, prev = 0) {
  let c = (prev ^ 0xFFFFFFFF) | 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const NATIVE_CRC = typeof zlib.crc32 === 'function';
const crc32 = NATIVE_CRC ? (buf, prev = 0) => zlib.crc32(buf, prev) >>> 0 : crc32Js;

/* MS-DOS date and time (2-second resolution, floor at 1980), in UTC so an
 * export reads the same wherever the server runs. */
function dosDateTime(mtimeSec) {
  const d = new Date((mtimeSec || 0) * 1000);
  const y = Math.max(d.getUTCFullYear(), 1980);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const FLAG_UTF8 = 0x0800;
const M_STORE = 0;
const M_DEFLATE = 8;
const MAX32 = 0xFFFFFFFE;   // stay under the zip64 sentinel
const ONE_READ_MAX = 16 * 1024 * 1024;
const CHUNK = 1024 * 1024;

/* A relative path with no way out: no `..` segment, no leading `/`, no
 * backslash (a separator to Windows tools), no NUL, no drive letter. */
function checkName(name) {
  if (typeof name !== 'string' || !name) throw new Error('zip: an entry has no name');
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)
    || name.split('/').includes('..')) {
    throw new Error(`zip: unsafe entry name ${JSON.stringify(name)}`);
  }
}

/* Read `size` bytes of `fh` from position 0 into chunks, with the running CRC
 * and SHA-256. `into` is a Buffer of exactly `size` (the one-read path) or
 * null (the CRC pass of a large file, nothing kept). Throws if the file ends
 * early; a byte past `size` is left to the caller's check. */
async function readPass(fh, size, into) {
  let crc = 0;
  const sha = crypto.createHash('sha256');
  const scratch = into ? null : Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size, 1)));
  let pos = 0;
  while (pos < size) {
    const len = Math.min(CHUNK, size - pos);
    const buf = into || scratch;
    const at = into ? pos : 0;
    const { bytesRead } = await fh.read(buf, at, len, pos);
    if (bytesRead === 0) throw new Error('shrank');
    const part = buf.subarray(at, at + bytesRead);
    crc = crc32(part, crc);
    sha.update(part);
    pos += bytesRead;
  }
  return { crc, sha256: sha.digest('hex') };
}

/* entries: [{ name, mtime?, data: Buffer | () => Buffer, size? }] or
 *          [{ name, mtime?, path, size?, optional? }]
 * A `data` function is called when the writer reaches the entry (the export's
 * manifest goes last, written from what the files turned out to be).
 * hooks.onFile({ entry, size, crc, sha256 }) after each file entry is written;
 * hooks.onMissing(entry) for an optional file gone when reached.
 * Returns a Readable of zip bytes (safe to pipe to an HTTP answer; destroying
 * it closes any file it holds open). */
function createZipStream(entries, hooks = {}) {
  if (entries.length > 65535) throw new Error('zip: too many entries for a classic zip');
  for (const e of entries) checkName(e.name);

  async function* blocks() {
    const central = [];
    let offset = 0;
    const out = (buf) => { offset += buf.length; return buf; };
    const header = (nameBuf, method, time, date, crc, size, comp) => {
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(FLAG_UTF8, 6);
      lfh.writeUInt16LE(method, 8);
      lfh.writeUInt16LE(time, 10);
      lfh.writeUInt16LE(date, 12);
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(comp, 18);
      lfh.writeUInt32LE(size, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28);
      return lfh;
    };
    const fits = (n) => { if (n > MAX32 || offset + n > MAX32) throw new Error('zip: archive exceeds classic zip limits'); };

    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      if (nameBuf.length > 0xFFFF) throw new Error(`zip: entry name too long (${e.name})`);
      const { time, date } = dosDateTime(e.mtime != null ? e.mtime : Date.now() / 1000);
      const lfhOffset = offset;

      if (e.data != null) {
        const data = typeof e.data === 'function' ? e.data() : e.data;
        if (!Buffer.isBuffer(data)) throw new Error(`zip: ${e.name} data must be a Buffer`);
        if (e.size != null && data.length !== e.size) throw new Error(`zip: ${e.name} size mismatch`);
        const crc = crc32(data);
        const body = zlib.deflateRawSync(data, { level: 6 });
        fits(30 + nameBuf.length + body.length);
        yield out(header(nameBuf, M_DEFLATE, time, date, crc, data.length, body.length));
        yield out(nameBuf);
        yield out(body);
        central.push({ nameBuf, time, date, method: M_DEFLATE, crc, compSize: body.length, uncompSize: data.length, lfhOffset });
        continue;
      }
      if (!e.path) throw new Error(`zip: ${e.name} has neither data nor path`);

      let fh;
      try { fh = await fs.promises.open(e.path, 'r'); } catch (err) {
        if (err.code === 'ENOENT' && e.optional) { hooks.onMissing?.(e); continue; }
        throw new Error(`zip: ${e.name} could not be read (${err.code || err.message})`);
      }
      try {
        const st = await fh.stat();
        const size = st.size;
        if (!st.isFile()) throw new Error(`zip: ${e.name} is not a file`);
        if (e.size != null && size !== e.size) throw new Error(`zip: ${e.name} changed size during export`);
        fits(30 + nameBuf.length + size);
        let sums;
        let whole = null;
        try {
          if (size <= ONE_READ_MAX) {
            whole = Buffer.allocUnsafe(size);
            sums = await readPass(fh, size, whole);
          } else {
            sums = await readPass(fh, size, null);
          }
        } catch (err) {
          if (err.message === 'shrank') throw new Error(`zip: ${e.name} shrank during export`);
          throw err;
        }
        const probe = Buffer.allocUnsafe(1);
        if ((await fh.read(probe, 0, 1, size)).bytesRead !== 0) throw new Error(`zip: ${e.name} grew during export`);

        yield out(header(nameBuf, M_STORE, time, date, sums.crc, size, size));
        yield out(nameBuf);
        if (whole) {
          yield out(whole);
        } else {
          let crc = 0;
          let pos = 0;
          while (pos < size) {
            const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
            const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
            if (bytesRead === 0) throw new Error(`zip: ${e.name} shrank during export`);
            const part = buf.subarray(0, bytesRead);
            crc = crc32(part, crc);
            pos += bytesRead;
            yield out(part);
          }
          if (crc !== sums.crc) throw new Error(`zip: ${e.name} changed during export`);
        }
        central.push({ nameBuf, time, date, method: M_STORE, crc: sums.crc, compSize: size, uncompSize: size, lfhOffset });
        hooks.onFile?.({ entry: e, size, crc: sums.crc, sha256: sums.sha256 });
      } finally {
        await fh.close().catch(() => {});
      }
    }

    const cdStart = offset;
    for (const c of central) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(FLAG_UTF8, 8);
      cd.writeUInt16LE(c.method, 10);
      cd.writeUInt16LE(c.time, 12);
      cd.writeUInt16LE(c.date, 14);
      cd.writeUInt32LE(c.crc, 16);
      cd.writeUInt32LE(c.compSize, 20);
      cd.writeUInt32LE(c.uncompSize, 24);
      cd.writeUInt16LE(c.nameBuf.length, 28);
      cd.writeUInt32LE(c.lfhOffset, 42);
      fits(46 + c.nameBuf.length);
      yield out(cd);
      yield out(c.nameBuf);
    }
    const cdSize = offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    yield out(eocd);
  }
  return Readable.from(blocks());
}

/* The same writer, collected into one Buffer (tests and small archives). */
async function zipToBuffer(entries, hooks) {
  const chunks = [];
  for await (const chunk of createZipStream(entries, hooks)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = { createZipStream, zipToBuffer, crc32, crc32Js, NATIVE_CRC, ONE_READ_MAX, checkName };
