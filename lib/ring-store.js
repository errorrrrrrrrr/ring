'use strict';
/* ── rings.json, the ring store door (spec 3.6, 3.11) ─────────────────────────
 * THE one reader and writer of `DATA/rings.json`. Every read normalizes
 * (lib/rings.js normalizeRings) and is read from disk (fail closed: a damaged
 * file is a StoreReadError, never an empty list a later write would persist over
 * the rings). Checked at boot with the other top-level files (lib/instance.js).
 *
 * The concurrency rule (spec 3.11): a caller loads, changes and saves in ONE
 * synchronous tick. `update(fn)` is that tick: fn gets the rings array and
 * returns the array to write, or `undefined` to write nothing.
 */
const { readJSON, writeJSON } = require('./store');
const { normalizeRings } = require('./rings');

function createRingStore(paths, { onWrite = () => {} } = {}) {
  const load = () => normalizeRings(readJSON(paths.rings, []));
  function save(rings) {
    writeJSON(paths.rings, normalizeRings(rings));
    onWrite();
  }
  function update(fn) {
    const rings = load();
    const next = fn(rings);
    if (next !== undefined) save(next);
    return next;
  }
  const get = (id) => load().find((r) => r.id === id) || null;
  return { load, save, update, get };
}

module.exports = { createRingStore };
