'use strict';
/* ── The image door and the image gate (spec 10.4 to 10.6) ────────────────────
 *   POST /api/images            multipart `image` -> { key }: lib/images.js
 *                               ingest, the one door. Any key a client sends is
 *                               ignored; the server mints it.
 *   GET /api/images/:key/web    THE GATE. Serves when the viewer owns the image,
 *   GET /api/images/:key/thumb  or it is the avatar, the theme background or a
 *                               public post's image of an ENABLED page (the
 *                               projection's list: a page that is off serves
 *                               none of them); or THE RING READ GRANT: the
 *                               viewer shares a ring with the owner and the key
 *                               is on a live post addressed to that ring
 *                               (lib/audience.js: a kick or a lapse closes it at
 *                               once). P7 adds the signed fetch by a ring member's
 *                               server. Else 404, and a 404 spends the per-IP
 *                               miss budget (100 a minute, 1500 a day).
 *   GET /api/images/:key        originals never serve: 404.
 *
 * Cache: a public image `private, max-age=31536000`; anything else (the owner's
 * unposted or archived image) `private, no-store`.
 *
 * Memory (security-r1-05, robustness-r1-05): multer buffers a whole upload, so
 * the UPLOAD GATE runs before it reads a byte: at most UPLOADS_ACTIVE uploads
 * read and decode at once, UPLOADS_WAITING more wait (their bodies unread, in the
 * socket), and past that 503 `busy` with Retry-After. One upload per member at a
 * time (429 `upload_in_progress`). A slot is freed when the answer is sent or the
 * client goes away. `ctx.uploadGate` exposes the sizes (tests).
 */
const express = require('express');
const multer = require('multer');
const { fail, wrap } = require('../lib/http');
const { ImageRefusal, MAX_UPLOAD_BYTES } = require('../lib/images');

const UPLOADS_ACTIVE = 2;
const UPLOADS_WAITING = 4;
const RETRY_AFTER_S = 5;

function createUploadGate({ active = UPLOADS_ACTIVE, waiting = UPLOADS_WAITING } = {}) {
  const gate = { active, waiting, running: 0, queue: [], members: new Set() };
  const pump = () => {
    while (gate.running < gate.active && gate.queue.length) {
      const go = gate.queue.shift();
      gate.running++;
      go();
    }
  };
  gate.middleware = (req, res, next) => {
    const who = req.member.slug;
    if (gate.members.has(who)) return fail(res, 429, 'upload_in_progress');
    if (gate.running >= gate.active && gate.queue.length >= gate.waiting) {
      res.set('Retry-After', String(RETRY_AFTER_S));
      return fail(res, 503, 'busy');
    }
    gate.members.add(who);
    let started = false;
    let done = false;
    const go = () => { started = true; next(); };
    const finish = () => {
      if (done) return;
      done = true;
      gate.members.delete(who);
      if (started) gate.running--;
      else gate.queue = gate.queue.filter((g) => g !== go);
      pump();
    };
    res.on('finish', finish);
    res.on('close', finish);
    gate.queue.push(go);
    pump();
  };
  return gate;
}

module.exports = function imageRoutes(ctx) {
  const { images, projection, audience, auth, limits, stillMember } = ctx;
  const router = express.Router();
  const gate = createUploadGate();
  ctx.uploadGate = gate;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 1024, parts: 12 },
  });
  const miss = limits.missLimit('imgmiss', { perMinute: 100, perDay: 1500 });

  router.post('/api/images', auth.requireMember, limits.limit('upload', { perMinute: 30, perDay: 300 }), gate.middleware,
    (req, res, next) => upload.single('image')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'image_too_large', { mb: MAX_UPLOAD_BYTES / 1048576 });
      if (err) return fail(res, 400, 'no_file');
      next();
    }),
    wrap(async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      if (!req.file) return fail(res, 400, 'no_file');
      const buf = req.file.buffer;
      req.file.buffer = null;
      let key;
      try {
        key = await images.ingest(buf, req.member.slug, { stillValid: () => stillMember(req) });
      } catch (e) {
        if (e instanceof ImageRefusal) {
          if (e.status === 503) res.set('Retry-After', String(RETRY_AFTER_S));
          return fail(res, e.status, e.code, e.vars);
        }
        throw e;
      }
      const r = images.row(key);
      res.status(201).json({
        key,
        url: `/api/images/${key}/web`,
        thumb_url: `/api/images/${key}/thumb`,
        width: r.width,
        height: r.height,
      });
    }));

  const serve = (variant) => (req, res) => {
    const key = String(req.params.key || '');
    const row = images.row(key);
    const file = row && images.variantFile(key, variant);
    if (!file) return fail(res, 404, 'not_found');
    const isPublic = projection.publicImageKeys(row.owner).has(key);
    const isOwner = !!req.member && req.member.slug === row.owner;
    const inRoom = !isPublic && !isOwner && !!req.member && audience.roomImageVisible(key, row.owner, req.member.slug);
    if (!isPublic && !isOwner && !inRoom) return fail(res, 404, 'not_found');
    res.set('Content-Type', images.VARIANT_TYPE);
    res.set('Cache-Control', isPublic ? 'private, max-age=31536000' : 'private, no-store');
    res.sendFile(file, { dotfiles: 'deny', lastModified: false, cacheControl: false }, (err) => {
      if (err && !res.headersSent) fail(res, 404, 'not_found');
    });
  };

  router.get('/api/images/:key/web', miss, serve('web'));
  router.get('/api/images/:key/thumb', miss, serve('thumb'));
  router.get('/api/images/:key', miss, (req, res) => fail(res, 404, 'not_found'));
  // A path whose escape cannot be decoded fails before any route runs: it is a
  // miss too, and spends the budget (security-r1-11).
  router.use('/api/images', (err, req, res, next) => {
    if (!(err instanceof URIError)) return next(err);
    miss(req, res, () => fail(res, 404, 'not_found'));
  });

  return router;
};

module.exports.createUploadGate = createUploadGate;
