'use strict';
/* ── What the server tells a member about their own things (spec 6.3; P8) ─────
 * `members/<name>/notices.json`: `[{ id, kind, at, seen }]`. Kinds:
 * `post_removed`, `comment_removed`, `stamp_removed`, written when the admin
 * removes a member's post, comment or stamp from a report, to its AUTHOR only
 * ("its author is told in Inbox"; P8 review F1). The notice names no reporter
 * and carries no copy of the thing: only that one of theirs was removed, and
 * when.
 * Bounded: 50 rows, 90 days (older ones dropped on every write). The member
 * dir goes with the account (lib/purge.js), so the notices go with it.
 */
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { randomBase36 } = require('./ids');
const { MemberGone } = require('./page-store');

const MAX_ROWS = 50;
const KEEP_MS = 90 * 24 * 3600_000;
const KINDS = new Set(['post_removed', 'comment_removed', 'stamp_removed']);

function settle(raw) {
  const cutoff = clock.now() - KEEP_MS;
  return (Array.isArray(raw) ? raw : [])
    .filter((r) => r && typeof r.id === 'string' && KINDS.has(r.kind) && typeof r.at === 'string' && !(Date.parse(r.at) < cutoff))
    .map((r) => ({ id: r.id.slice(0, 40), kind: r.kind, at: r.at.slice(0, 40), seen: r.seen === true }))
    .slice(-MAX_ROWS);
}

function createNotices({ paths, members }) {
  const file = (name) => paths.memberFile(name, 'notices.json');
  const load = (name) => settle(readJSON(file(name), []));
  function add(name, kind) {
    if (!members.get(name)) throw new MemberGone(name);
    const rows = load(name);
    rows.push({ id: `n_${randomBase36(12)}`, kind, at: clock.iso(), seen: false });
    writeJSON(file(name), settle(rows));
  }
  function markSeen(name) {
    const rows = load(name);
    const n = rows.filter((r) => !r.seen).length;
    if (n && members.get(name)) writeJSON(file(name), rows.map((r) => ({ ...r, seen: true })));
    return n;
  }
  const unseen = (name) => load(name).filter((r) => !r.seen).length;
  return { load, add, markSeen, unseen };
}

module.exports = { createNotices, MAX_ROWS, KEEP_MS };
