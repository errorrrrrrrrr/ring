'use strict';
/* ── Escaping and path guards ─────────────────────────────────────────────────
 * escapeHtml is THE escape for user text going into HTML; lib/ring.js's renderer
 * escapes first and then emits only its own fixed grammar. safePathIn is the
 * traversal guard for any file named from request input.
 */
const path = require('node:path');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* `name` resolved inside `baseDir`, or null if it would escape it. */
function safePathIn(baseDir, name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  if (name === '.' || name === '..') return null;
  const resolved = path.resolve(baseDir, name);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) return null;
  return resolved;
}

module.exports = { escapeHtml, safePathIn };
