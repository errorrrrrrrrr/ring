'use strict';
/* ── Who here holds a remote object (spec 4.10, F3) ───────────────────────────
 * An Update or Delete of a remote Note by its author must reach every row here
 * that keeps it, and nothing else: the comments a remote author left on a
 * member's posts (`log-comments.json`, a remote `object_id`) and their From
 * elsewhere rows (`elsewhere.json`, `object`). A wall entry is found by
 * lib/walls.js's own index. This index maps a remote object id to the members
 * holding it, so such an activity reads only those members' files, never every
 * member's: a Delete of an id nobody holds reads no member file at all.
 *
 * Built ONCE, lazily, at the first lookup (one pass over every member's two
 * files), then kept by the stores' write hooks (lib/reactions.js saveComments,
 * lib/elsewhere.js save), which hand over the rows they wrote. In memory only:
 * a restart builds it again. A purged member keeps stale entries until a
 * restart; a lookup that names them finds no row and writes nothing.
 *
 * `sent.json` (a member's own stamps and comments ON remote posts) is not here:
 * an Update or Delete of the remote post changes nothing in it (the row is
 * what an Undo names), and a gone author's rows go by author (lib/remote-in.js
 * forget).
 */
function createHolders({ members, loadComments, loadElsewhere, logger = console }) {
  const byObject = new Map();   // object id -> Set(member name)
  const byMember = new Map();   // name -> { comments: Set(id), elsewhere: Set(id) }
  let built = false;

  function put(name, which, ids) {
    let m = byMember.get(name);
    if (!m) { m = { comments: new Set(), elsewhere: new Set() }; byMember.set(name, m); }
    const other = which === 'comments' ? m.elsewhere : m.comments;
    for (const id of m[which]) {
      if (ids.has(id) || other.has(id)) continue;
      const s = byObject.get(id);
      if (s) { s.delete(name); if (!s.size) byObject.delete(id); }
    }
    m[which] = ids;
    for (const id of ids) {
      let s = byObject.get(id);
      if (!s) { s = new Set(); byObject.set(id, s); }
      s.add(name);
    }
  }
  const commentIds = (rows) => new Set(rows.filter((c) => typeof c?.author === 'string' && c.author.includes('@') && typeof c.object_id === 'string' && c.object_id).map((c) => c.object_id));
  const elsewhereIds = (rows) => new Set(rows.map((r) => r?.object).filter((o) => typeof o === 'string' && o));

  function build() {
    if (built) return;
    built = true;
    for (const m of members.all()) {
      try { put(m.slug, 'comments', commentIds(loadComments(m.slug))); } catch (e) { logger.error(`[holders] comments of ${m.slug}: ${e.message}`); }
      try { put(m.slug, 'elsewhere', elsewhereIds(loadElsewhere(m.slug))); } catch (e) { logger.error(`[holders] From elsewhere of ${m.slug}: ${e.message}`); }
    }
  }

  return {
    /* The members holding a row about this remote object id. */
    of(id) { build(); return [...(byObject.get(id) || [])]; },
    noteComments(name, rows) { if (built) put(name, 'comments', commentIds(rows)); },
    noteElsewhere(name, rows) { if (built) put(name, 'elsewhere', elsewhereIds(rows)); },
    size: () => byObject.size,
  };
}

module.exports = { createHolders };
