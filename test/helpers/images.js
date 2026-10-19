'use strict';
/* Image fixtures, made at test time with sharp (no binary blobs in the repo). */
const zlib = require('node:zlib');
const sharp = require('sharp');

/* A JPEG carrying a GPS position, a camera make and an orientation of 6 (rotate
 * 90 degrees): 40 wide, 20 tall as stored, 20 x 40 once oriented. */
function gpsJpeg({ width = 40, height = 20 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: '#c33' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'FixtureCam', Model: 'GPS-1' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '4/1 21/1 0/1' },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

const png = (w = 64, h = 48, bg = '#3a6') => sharp({ create: { width: w, height: h, channels: 4, background: bg } }).png().toBuffer();

/* Three frames, plus a GIF comment extension carrying `marker` before the trailer:
 * a re-encode drops it, so its absence proves the bytes were not stored raw. */
async function animatedGif(marker = 'RING-GIF-COMMENT') {
  const frames = await Promise.all(['#f00', '#0f0', '#00f'].map((c) => png(30, 20, c)));
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  const text = Buffer.from(marker, 'ascii');
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, text.length]), text, Buffer.from([0x00])]);
  return Buffer.concat([gif.subarray(0, gif.length - 1), comment, gif.subarray(gif.length - 1)]);
}

/* A PNG whose header claims w x h with no real pixel data behind it: the decode
 * ceiling must refuse it from the header alone. */
function pngHeaderOnly(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* An animated GIF whose header claims `frames` frames of w x h, each with a
 * 1-pixel LZW block: the decode ceiling must count every frame from the header
 * alone. A loop extension and a graphic control block per frame, as real ones. */
function gifHeaderOnly(w, h, frames) {
  const u16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  const parts = [
    Buffer.from('GIF89a', 'ascii'), u16(w), u16(h), Buffer.from([0x80, 0, 0]),   // a 2-colour global table
    Buffer.from([0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'ascii'), Buffer.from([3, 1, 0, 0, 0]),
  ];
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]));
    parts.push(Buffer.from([0x2c]), u16(0), u16(0), u16(w), u16(h), Buffer.from([0]));
    parts.push(Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

module.exports = { gpsJpeg, png, animatedGif, pngHeaderOnly, gifHeaderOnly, sharp };
