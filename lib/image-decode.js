'use strict';
/* ── THE image-decode ceiling (spec 10.4) ─────────────────────────────────────
 * Bytes are what storage costs; PIXELS are what memory costs, and the two are
 * unrelated (an 802 KB interlaced PNG is a 963 MB decode). So:
 *   1. decodeImage() is THE sharp constructor for anything from outside. It pins
 *      `limitInputPixels`, so libvips refuses before it allocates, and a 20 s
 *      `timeout`, so no pipeline holds the one decode slot for minutes.
 *   2. pixelProblem() is the door's question, a header read asked before the
 *      bytes land, so the uploader gets a 413 naming the limit.
 *   3. withDecodeSlot() queues decodes, one at a time, at most DECODE_WAITING
 *      waiting: past that it refuses (DecodeBusy, the door's 503 `busy`) rather
 *      than hold every queued buffer in memory.
 *
 * An animated image counts every frame (width x height x
 * pages), because that is what libvips allocates and what limitInputPixels
 * measures when the frames are decoded together. And an animated image has its
 * own, lower budget (ANIMATED_MAX_PIXELS over all frames, ANIMATED_MAX_FRAMES):
 * re-encoding a GIF quantizes every frame, about 13 times the CPU and 2.5 times
 * the memory of a still image at the same pixel count.
 *
 * `sharp` is not re-exported: a bare constructor elsewhere is a door with no
 * ceiling.
 */
const sharp = require('sharp');

const MAX_IMAGE_PIXELS = 80_000_000;
const ANIMATED_MAX_PIXELS = 25_000_000;
const ANIMATED_MAX_FRAMES = 200;
const DECODE_TIMEOUT_S = 20;
const DECODE_WAITING = 4;

function decodeImage(input, opts = {}) {
  const limit = opts.animated ? ANIMATED_MAX_PIXELS : MAX_IMAGE_PIXELS;
  return sharp(input, { ...opts, limitInputPixels: limit }).timeout({ seconds: DECODE_TIMEOUT_S });
}

/* Header facts: { format, width, height, pages }, or null when unreadable. */
async function imageHeader(input) {
  try {
    const md = await sharp(input).metadata();   // a header read: no surface allocated
    const w = Number(md?.width) || 0;
    const h = Number(md?.height) || 0;
    if (!(w > 0 && h > 0)) return null;
    return { format: md.format, width: w, height: h, pages: Math.max(1, Number(md.pages) || 1) };
  } catch { return null; }
}

/* The ceiling a header breaks, or null: { mp } for the 413's message. Every frame
 * counts; more than one frame is the animated budget. */
function pixelProblem(hd) {
  if (!hd) return null;
  const total = hd.width * hd.height * hd.pages;
  if (hd.pages > 1) {
    if (hd.pages > ANIMATED_MAX_FRAMES || total > ANIMATED_MAX_PIXELS) return { mp: ANIMATED_MAX_PIXELS / 1_000_000 };
    return null;
  }
  return total > MAX_IMAGE_PIXELS ? { mp: MAX_IMAGE_PIXELS / 1_000_000 } : null;
}

async function imageTooManyPixels(input) {
  return !!pixelProblem(await imageHeader(input));
}

class DecodeBusy extends Error {
  constructor() { super('decode queue full'); this.code = 'DECODE_BUSY'; }
}

function createDecodeSlots(limit = 1, { maxWaiting = Infinity } = {}) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  const run = (fn) => new Promise((resolve, reject) => {
    if (active >= limit && waiting.length >= maxWaiting) return reject(new DecodeBusy());
    waiting.push({ fn, resolve, reject });
    next();
  });
  run.stats = () => ({ active, waiting: waiting.length });
  return run;
}
const withDecodeSlot = createDecodeSlots(1, { maxWaiting: DECODE_WAITING });

module.exports = {
  MAX_IMAGE_PIXELS, ANIMATED_MAX_PIXELS, ANIMATED_MAX_FRAMES, DECODE_TIMEOUT_S, DECODE_WAITING,
  decodeImage, imageHeader, imageTooManyPixels, pixelProblem, withDecodeSlot, createDecodeSlots, DecodeBusy,
};
