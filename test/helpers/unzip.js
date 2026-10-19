'use strict';
/* A strict zip reader for the suites (never shipped): the central directory is
 * the authority, every entry inflated with node:zlib and checked against its
 * CRC and size. Returns Map(name -> Buffer). Throws on anything it does not
 * expect, so a writer that drifts from the classic zip shape fails loudly. */
const zlib = require('node:zlib');

function unzip(buf) {
  let at = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { at = i; break; }
  }
  if (at < 0) throw new Error('unzip: no end of central directory');
  const count = buf.readUInt16LE(at + 10);
  const cdSize = buf.readUInt32LE(at + 12);
  const cdOffset = buf.readUInt32LE(at + 16);
  if (cdOffset + cdSize !== at) throw new Error('unzip: central directory is not where the EOCD says');
  const out = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('unzip: bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const comp = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const lfh = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extra + comment;
    if (flags & 0x0008) throw new Error(`unzip: ${name} uses a data descriptor`);
    if (buf.readUInt32LE(lfh) !== 0x04034b50) throw new Error(`unzip: ${name} has no local header`);
    if (buf.readUInt32LE(lfh + 14) !== crc || buf.readUInt32LE(lfh + 18) !== comp || buf.readUInt32LE(lfh + 22) !== size) {
      throw new Error(`unzip: ${name} local header disagrees with the directory`);
    }
    const start = lfh + 30 + buf.readUInt16LE(lfh + 26) + buf.readUInt16LE(lfh + 28);
    const raw = buf.subarray(start, start + comp);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`unzip: ${name} method ${method}`);
    if (data.length !== size) throw new Error(`unzip: ${name} size`);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`unzip: ${name} CRC`);
    if (out.has(name)) throw new Error(`unzip: ${name} twice`);
    out.set(name, data);
  }
  return out;
}

module.exports = { unzip };
