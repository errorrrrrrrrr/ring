'use strict';
/* ── The odometer (spec 7, 13.2) ──────────────────────────────────────────────
 * A real early-web hit counter on each wall: ANONYMOUS reads of a published page
 * count (a signed-in visit is not a hit), buffered
 * in memory and flushed to `members/<name>/log-visits.json` each minute and at
 * shutdown. A flush never creates a purged member's directory back. A damaged
 * counter file is never written over (lib/store.js reads fail closed): its page
 * still serves, showing the unflushed hits, and the hits wait in the buffer.
 */
const fs = require('node:fs');
const { readJSON, writeJSON } = require('./store');

function createVisits(paths) {
  const buffer = new Map();   // name -> uncounted hits

  const file = (name) => paths.memberFile(name, 'log-visits.json');
  const stored = (name) => Number(readJSON(file(name), { count: 0 })?.count) || 0;
  const storedOrNull = (name) => { try { return stored(name); } catch { return null; } };

  return {
    bump(name) { buffer.set(name, (buffer.get(name) || 0) + 1); },
    count: (name) => (storedOrNull(name) || 0) + (buffer.get(name) || 0),
    drop(name) { buffer.delete(name); },
    flush() {
      for (const [name, n] of buffer) {
        if (!fs.existsSync(paths.memberDir(name))) { buffer.delete(name); continue; }
        const was = storedOrNull(name);
        if (was === null) continue;   // damaged: keep the hits, never write over it
        buffer.delete(name);
        writeJSON(file(name), { count: was + n });
      }
    },
  };
}

module.exports = { createVisits };
