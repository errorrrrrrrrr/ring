'use strict';
/* ── The audit log (spec 9: `audit(event, actor, details)`) ───────────────────
 * Append-only JSONL, one `{ ts, event, actor, ...details }` per line, kept 90
 * days, pruned by the hourly housekeeping, never on an append (a prune per
 * append would read the whole file per event).
 *
 * Appends are appendFileSync, the JSONL exception to writeJSON. The prune is not
 * an in-place rewrite: lib/store.js filterLines streams the kept lines to a temp,
 * fsyncs and renames, so a crash or a full disk mid-prune leaves the old log
 * whole, and a log of any size prunes (no single string holds it).
 *
 * Never an email, a password, a token or a key in a row: actors and subjects are
 * handles. `details` passes through a deny list as a last guard.
 */
const fs = require('node:fs');
const clock = require('./clock');
const { filterLines } = require('./store');

const RETENTION_MS = 90 * 24 * 3600 * 1000;
const DENY = new Set(['email', 'password', 'password_hash', 'token', 'key_pem', 'private_key', 'code']);

function createAudit(file) {
  function audit(event, actor, details = {}) {
    const entry = { ts: clock.iso(), event, actor: actor || 'system' };
    for (const [k, v] of Object.entries(details || {})) if (!DENY.has(k)) entry[k] = v;
    try { fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 }); }
    catch (e) { console.error('[audit] append failed:', e.message); }
  }

  /* Throws on an I/O error: housekeeping logs it by step. */
  function prune() {
    const cutoff = clock.now() - RETENTION_MS;
    return filterLines(file, (line) => {
      const m = line.match(/"ts":"([^"]+)"/);
      return !m || !(Date.parse(m[1]) <= cutoff);   // undatable lines are kept, never lost
    });
  }

  function read() {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; }
  }

  audit.prune = prune;
  audit.read = read;
  return audit;
}

module.exports = { createAudit, RETENTION_MS };
