'use strict';
/* ── A member's stamps and comments on REMOTE posts (spec 3.7, 3.10) ──────────
 * `members/<name>/sent.json`: what this member pressed or wrote on a post of
 * another server, kept so it can be taken back (an Undo or a Delete of the very
 * activity sent) and shown on their own Friends feed. THE one reader and writer.
 *   { id, kind: 'stamp'|'comment', object (the remote post's id), author (its
 *     author's handle), face? (a stamp), body? (a comment), activity (the bare
 *     activity as sent: what an Undo carries, or the Note a Delete names), at }
 * A stamp's `id` is the Like's `stmp_` tail, a comment's the `lc_` tail of its
 * Note URL (`/users/<name>/comments/<id>`, served from here, routes/federation.js).
 * P7: a reaction on a ROOM copy keeps `group` (the ring's Group, where it went
 * and where its take-back goes) and, for a custom face, `custom`.
 * One stamp per (member, post): a new face replaces the row. 2000 rows, oldest
 * out. A write for a gone member throws MemberGone (the purge stays a purge).
 */
const { readJSON, writeJSON } = require('./store');
const { isHandle } = require('./handles');
const { STAMP_ID_RE, COMMENT_ID_RE } = require('./ids');
const { MemberGone } = require('./page-store');

const MAX_ROWS = 2000;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function normalizeRow(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.kind !== 'stamp' && r.kind !== 'comment') return null;
  if (!(r.kind === 'stamp' ? STAMP_ID_RE : COMMENT_ID_RE).test(r.id || '')) return null;
  if (typeof r.object !== 'string' || !/^https?:\/\//.test(r.object) || !isHandle(r.author, { allowPort: true })) return null;
  if (!r.activity || typeof r.activity !== 'object') return null;
  const row = { id: r.id, kind: r.kind, object: r.object.slice(0, 2000), author: r.author, activity: r.activity, at: str(r.at, 40) };
  if (r.kind === 'stamp') row.face = str(r.face, 40);
  else row.body = str(r.body, 600);
  // P7: a reaction on a room copy went to the ring's Group (`group`), and its
  // take-back goes there too; a custom face is a room's.
  if (typeof r.group === 'string' && /^https?:\/\//.test(r.group)) row.group = r.group.slice(0, 600);
  if (r.kind === 'stamp' && r.custom === true) row.custom = true;
  return row;
}

function createSent({ paths, members }) {
  const file = (name) => paths.memberFile(name, 'sent.json');
  function load(name) {
    const out = [];
    const ids = new Set();
    for (const r of readJSON(file(name), [])) {
      const n = normalizeRow(r);
      if (n && !ids.has(`${n.kind}:${n.id}`)) { ids.add(`${n.kind}:${n.id}`); out.push(n); }
    }
    return out.slice(-MAX_ROWS);
  }
  function save(name, rows) {
    if (!members.get(name)) throw new MemberGone(name);
    writeJSON(file(name), rows.map(normalizeRow).filter(Boolean).slice(-MAX_ROWS));
  }
  const stampOn = (name, object) => load(name).find((r) => r.kind === 'stamp' && r.object === object) || null;
  const commentsOn = (name, object) => load(name).filter((r) => r.kind === 'comment' && r.object === object);
  const byId = (name, kind, id) => load(name).find((r) => r.kind === kind && r.id === id) || null;
  function put(name, row) {
    const rows = load(name).filter((r) => !(r.kind === row.kind && (r.id === row.id || (row.kind === 'stamp' && r.object === row.object))));
    rows.push(row);
    save(name, rows);
  }
  function remove(name, kind, id) {
    const rows = load(name);
    const next = rows.filter((r) => !(r.kind === kind && r.id === id));
    if (next.length !== rows.length) save(name, next);
    return next.length !== rows.length;
  }
  /* Every row about a handle's posts (that author is gone, 5.3). */
  function removeAuthor(name, handle) {
    const rows = load(name);
    const next = rows.filter((r) => r.author !== handle);
    if (next.length !== rows.length) save(name, next);
    return rows.length - next.length;
  }
  /* Every remote author this member reacted to (the farewell's recipients). */
  const authors = (name) => [...new Set(load(name).map((r) => r.author))];
  return { load, stampOn, commentsOn, byId, put, remove, removeAuthor, authors, MAX_ROWS };
}

module.exports = { createSent, MAX_ROWS };
