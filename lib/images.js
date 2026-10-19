'use strict';
/* ── THE image door (spec 10.4, 10.5) ─────────────────────────────────────────
 * Every image a member uploads enters through ingest(): the sniff, the decode
 * ceiling of lib/image-decode.js, the re-encode, the variants and the storage
 * stop:
 *
 *   1. real-bytes sniff: JPEG, PNG, GIF, WebP; SVG, HTML and all else refused,
 *      whatever the name or MIME type says;
 *   2. the 80 MP decode ceiling, asked before anything is written (413);
 *   3. EVERY original re-encoded by sharp: `.rotate()` applies the orientation,
 *      metadata (EXIF, GPS, XMP, ICC) is dropped, animation is kept. A failed
 *      re-encode refuses; raw bytes are never written, whatever the format;
 *   4. variants `web` (1600) and `thumb` (600), WebP, made BEFORE the answer, so
 *      a 200 means the image is servable;
 *   5. the key is server-minted, `img_` + imageStamp() (64 CSPRNG bits); a client
 *      never names one;
 *   6. ownership in `images.json`: `key -> { owner, bytes, created_at, width,
 *      height, type, source }` (the web variant's size and type for P5's
 *      attachments, the sniffed source format; all added to the spec's row);
 *   7. the quota, MEMBER_STORAGE_MB per member: 413 `storage_full`;
 *   8. the owner is checked again IN the commit tick (`memberLive`, plus the
 *      caller's `stillValid`): an upload whose owner was deleted, suspended or
 *      signed out while it decoded writes nothing (401 `not_signed_in`);
 *   9. a full decode queue refuses (503 `busy`) instead of queueing a buffer.
 *
 * `images.json` is cached and re-read when it changes underneath (lib/store.js
 * cachedFile); a damaged one is a read error, never an empty table.
 *
 * The sweeps (spec 11.4): an unposted upload past 24 h goes, unless its owner's
 * references cannot be read (that owner is skipped, never treated as "nothing
 * referenced"), and a sweep that would remove more than BRAKE of the rows refuses
 * and says so. Files in images/ with no row (a crash between the files and the
 * row) go after an hour.
 *
 * Files: `DATA/images/<key>` (the re-encoded original, never served),
 * `<key>__web`, `<key>__thumb`. All the awaiting happens first; the files and
 * the row land in one synchronous tick, after the quota is checked again.
 */
const fs = require('node:fs');
const clock = require('./clock');
const path = require('node:path');
const { cachedFile, writeFileAtomic } = require('./store');
const { imageStamp } = require('./image-stamp');
const { safePathIn } = require('./security');
const { decodeImage, imageHeader, pixelProblem, withDecodeSlot, DecodeBusy } = require('./image-decode');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const WEB_MAX = 1600;
const THUMB_MAX = 600;
const VARIANT_TYPE = 'image/webp';
const KEY_RE = /^img_\d{13}_[0-9a-f]{16}$/;
const BRAKE = { ratio: 0.2, min: 20 };   // a sweep removing more than both refuses

/* Magic bytes, never a header or a filename. */
function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

class ImageRefusal extends Error {
  constructor(status, code, vars) { super(code); this.status = status; this.code = code; this.vars = vars; }
}

function createImages({ paths, cfg, memberLive = () => true }) {
  const table = cachedFile(paths.images, {
    fallback: () => ({}),
    shape: (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('images.json is not an object of rows');
      return raw;
    },
  });
  const load = () => table.get();
  const commit = (next) => table.set(next);

  const fileOf = (key, variant) => safePathIn(paths.imagesDir, variant ? `${key}__${variant}` : key);

  const row = (key) => (KEY_RE.test(String(key)) ? load()[key] || null : null);
  const owns = (key, slug) => !!slug && row(key)?.owner === slug;
  const usage = (slug) => Object.values(load()).reduce((n, r) => (r.owner === slug ? n + (r.bytes || 0) : n), 0);
  const keysOf = (slug) => Object.keys(load()).filter((k) => load()[k].owner === slug);

  /* Encode the original in its own format, oriented and stripped. */
  async function reencode(buf, kind) {
    const animated = kind === 'gif' || kind === 'webp';
    const img = decodeImage(buf, animated ? { animated: true } : {}).rotate();
    if (kind === 'jpeg') return img.jpeg({ quality: 95 }).toBuffer();
    if (kind === 'png') return img.png({ compressionLevel: 9 }).toBuffer();
    if (kind === 'gif') return img.gif().toBuffer();
    return img.webp({ quality: 95 }).toBuffer();
  }

  async function variant(original, kind, max, quality) {
    const animated = kind === 'gif' || kind === 'webp';
    const { data, info } = await decodeImage(original, animated ? { animated: true } : {})
      .resize(max, max, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.pageHeight || info.height };
  }

  /* THE door. Returns the new key; throws ImageRefusal { status, code }. */
  async function ingest(buf, owner, { maxBytes = MAX_UPLOAD_BYTES, stillValid = () => true } = {}) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw new ImageRefusal(400, 'no_file');
    if (buf.length > maxBytes) throw new ImageRefusal(413, 'image_too_large', { mb: Math.round(maxBytes / 1048576) });
    const kind = sniffImageType(buf);
    if (!kind) throw new ImageRefusal(400, 'unsupported_image');
    const header = await imageHeader(buf);
    if (!header) throw new ImageRefusal(400, 'image_failed');
    const pixels = pixelProblem(header);
    if (pixels) throw new ImageRefusal(413, 'too_many_pixels', pixels);
    if (usage(owner) + buf.length > cfg.memberStorageBytes) throw new ImageRefusal(413, 'storage_full');

    let original, web, thumb;
    try {
      ({ original, web, thumb } = await withDecodeSlot(async () => {
        const o = await reencode(buf, kind);
        return { original: o, web: await variant(o, kind, WEB_MAX, 82), thumb: await variant(o, kind, THUMB_MAX, 75) };
      }));
    } catch (e) {
      if (e instanceof DecodeBusy) throw new ImageRefusal(503, 'busy');
      throw new ImageRefusal(400, 'image_failed');   // never written raw
    }

    // ── the commit tick: no await from here to the end ──
    if (!memberLive(owner) || !stillValid()) throw new ImageRefusal(401, 'not_signed_in');
    const bytes = original.length + web.data.length + thumb.data.length;
    if (usage(owner) + bytes > cfg.memberStorageBytes) throw new ImageRefusal(413, 'storage_full');
    let key = `img_${imageStamp()}`;
    while (load()[key]) key = `img_${imageStamp()}`;
    fs.mkdirSync(paths.imagesDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(fileOf(key), original);
    writeFileAtomic(fileOf(key, 'web'), web.data);
    writeFileAtomic(fileOf(key, 'thumb'), thumb.data);
    commit({
      ...load(),
      [key]: { owner, bytes, created_at: clock.iso(), width: web.width, height: web.height, type: VARIANT_TYPE, source: kind },
    });
    return key;
  }

  /* Delete keys (bytes and rows). Synchronous. */
  function remove(keys) {
    const list = [...keys].filter((k) => KEY_RE.test(String(k)));
    if (!list.length) return 0;
    const next = { ...load() };
    let n = 0;
    for (const key of list) {
      for (const v of [null, 'web', 'thumb']) {
        const f = fileOf(key, v);
        if (f) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
      }
      if (next[key]) { delete next[key]; n++; }
    }
    commit(next);
    return n;
  }

  /* Housekeeping (spec 11.4): an upload no page references, older than 24 h.
   * `referencedBy(owner)` answers a Set, or THROWS when it cannot tell: that
   * owner's images are skipped. `log(line)` hears every skip and a braked run. */
  function sweepUnreferenced(referencedBy, { olderThanMs = 24 * 3600_000, brake = BRAKE, log = () => {} } = {}) {
    const cutoff = clock.now() - olderThanMs;
    const all = load();
    const refs = new Map();
    const stale = [];
    for (const [key, r] of Object.entries(all)) {
      if (Date.parse(r.created_at) > cutoff) continue;
      if (!refs.has(r.owner)) {
        try { refs.set(r.owner, referencedBy(r.owner)); }
        catch (e) {
          refs.set(r.owner, null);
          log(`[images] sweep skipped ${r.owner}'s images: ${e.message}`);
        }
      }
      const held = refs.get(r.owner);
      if (held && !held.has(key)) stale.push(key);
    }
    const total = Object.keys(all).length;
    if (brake && stale.length > brake.min && stale.length > total * brake.ratio) {
      log(`[images] sweep REFUSED: it would remove ${stale.length} of ${total} image rows. Check members.json and members/*/log.json; nothing was deleted.`);
      return 0;
    }
    return remove(stale);
  }

  /* Housekeeping: files in images/ whose key has no row, older than an hour (a
   * crash or a full disk between the files and the row). */
  function sweepOrphanFiles({ olderThanMs = 3600_000 } = {}) {
    let names;
    try { names = fs.readdirSync(paths.imagesDir); } catch { return 0; }
    const all = load();
    const now = clock.now();
    let n = 0;
    for (const f of names) {
      const key = f.replace(/__(web|thumb)$/, '');
      if (!KEY_RE.test(key) || all[key]) continue;
      const p = path.join(paths.imagesDir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > olderThanMs) { fs.unlinkSync(p); n++; }
      } catch { /* gone */ }
    }
    return n;
  }

  /* Bytes of a variant for the gate (never the original). */
  function variantFile(key, v) {
    if (!KEY_RE.test(String(key)) || (v !== 'web' && v !== 'thumb')) return null;
    const f = fileOf(key, v);
    return f && fs.existsSync(f) ? f : null;
  }

  return { ingest, row, owns, usage, keysOf, remove, sweepUnreferenced, sweepOrphanFiles, variantFile, KEY_RE, VARIANT_TYPE };
}

module.exports = { createImages, sniffImageType, ImageRefusal, MAX_UPLOAD_BYTES, KEY_RE, WEB_MAX, THUMB_MAX, BRAKE };
