'use strict';
/* ── From elsewhere (spec 4.8, 6.4, 3.10 `members/<name>/elsewhere.json`) ─────
 * A reply or a mention from OUTSIDE that is not a comment: a non-friend's
 * reply to a member's post, or a public post that mentions them. The OWNER ONLY
 * reads it (the Inbox), for 30 days, at most 500 rows and 1 MB; it is never on
 * the wall, never forwarded, and its media is never fetched (5.7). From there
 * the member may Befriend or Block (Report arrives in P8). THE one reader and
 * writer. A row keeps a PREVIEW (F2): 2000 characters and 200 nodes of the
 * tree, `cut` and the source's `url` when there was more (the Inbox links
 * "more at source"). The unseen count (GET /api/me) is kept per author in
 * memory, so it never reads the rows while the file is unchanged.
 *   { id: 'el_' + 16 hex, kind: 'reply'|'mention', object (the remote Note's id),
 *     author (handle), post_id? (the member's post it answers), tree (the node
 *     tree, lib/remote-html.js: never HTML), cut?, summary, url, published, at,
 *     seen }
 * The same object twice is one row (5.5). An Update by its author re-settles
 * the text; a Delete by its author removes the row; a block hides and drops it;
 * a gone author's rows go (5.3). A write for a gone member throws MemberGone.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { isHandle } = require('./handles');
const { POST_ID_RE } = require('./ids');
const { plainLine } = require('./ring');
const { settleTree, clipTree } = require('./remote-html');
const { MemberGone } = require('./page-store');

const MAX_ROWS = 500;
// A row keeps a PREVIEW (F2): 2000 characters, 200 nodes, and the link to the
// source; a member's whole file at most 1 MB (oldest rows out first).
const PREVIEW_TEXT = 2000;
const PREVIEW_NODES = 200;
const MAX_BYTES = 1024 * 1024;
const KEEP_MS = 30 * 24 * 3600_000;
const ID_RE = /^el_[0-9a-f]{16}$/;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.slice(0, 2000) : '');

function normalizeRow(r) {
  if (!r || typeof r !== 'object' || !ID_RE.test(r.id || '') || !isHandle(r.author, { allowPort: true })) return null;
  if (r.kind !== 'reply' && r.kind !== 'mention') return null;
  const object = httpUrl(r.object);
  if (!object) return null;
  const preview = clipTree(settleTree(r.tree), { maxText: PREVIEW_TEXT, maxNodes: PREVIEW_NODES });
  const row = {
    id: r.id, kind: r.kind, object, author: r.author, tree: preview.tree, summary: plainLine(r.summary, 200),
    url: httpUrl(r.url) || object, published: str(r.published, 40), at: str(r.at, 40), seen: r.seen === true,
  };
  if (r.cut === true || preview.cut) row.cut = true;
  if (typeof r.post_id === 'string' && POST_ID_RE.test(r.post_id)) row.post_id = r.post_id;
  return row;
}

/* Newest rows that fit `MAX_BYTES` together (F2), measured as lib/store.js
 * writes them (two-space indented, each row's lines two spaces deeper). */
function withinBudget(rows) {
  let total = 4;
  let i = rows.length;
  while (i > 0) {
    const text = JSON.stringify(rows[i - 1], null, 2);
    let lines = 1;
    for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) lines++;
    const size = Buffer.byteLength(text, 'utf8') + 2 * lines + 2;
    if (total + size > MAX_BYTES) break;
    total += size;
    i--;
  }
  return i ? rows.slice(i) : rows;
}

function createElsewhere({ paths, members, onWrite = () => {} }) {
  const file = (name) => paths.memberFile(name, 'elsewhere.json');
  // The unseen count per author, per member, read without loading the rows
  // (F2: GET /api/me asks on every load). Valid while the file is the one it
  // was taken from (inode, size, mtime: every write is a new file by rename).
  const unseenCache = new Map();   // name -> { sig, authors: Map(author -> unseen) }
  function load(name) {
    const cut = clock.now() - KEEP_MS;
    const out = [];
    const objects = new Set();
    for (const r of readJSON(file(name), [])) {
      const n = normalizeRow(r);
      if (!n || objects.has(n.object) || Date.parse(n.at || 0) < cut) continue;
      objects.add(n.object);
      out.push(n);
    }
    return out.slice(-MAX_ROWS);
  }
  function save(name, rows) {
    if (!members.get(name)) throw new MemberGone(name);
    const kept = withinBudget(rows.map(normalizeRow).filter(Boolean).slice(-MAX_ROWS));
    writeJSON(file(name), kept);
    remember(name, kept);
    try { onWrite(name, kept); } catch { /* an index hook never fails a write */ }
  }
  const sigOf = (name) => { try { const st = fs.statSync(file(name)); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return 'none'; } };
  function remember(name, rows) {
    const authors = new Map();
    for (const r of rows) if (!r.seen) authors.set(r.author, (authors.get(r.author) || 0) + 1);
    unseenCache.set(name, { sig: sigOf(name), authors });
    return authors;
  }
  /* Unseen rows, a blocked author's not counted (`hidden(author)`), from the
   * cache while the file is unchanged: the rows themselves are read only when
   * the file changed behind the cache. */
  function unseenCount(name, hidden = () => false) {
    const c = unseenCache.get(name);
    const authors = c && c.sig === sigOf(name) ? c.authors : remember(name, load(name));
    let n = 0;
    for (const [a, k] of authors) if (!hidden(a)) n += k;
    return n;
  }

  /* The preview a row keeps of a settled object (F2). */
  function previewOf(obj) {
    const p = clipTree(obj.tree || (typeof obj.source === 'string' ? [obj.source] : []), { maxText: PREVIEW_TEXT, maxNodes: PREVIEW_NODES });
    return { tree: p.tree, cut: p.cut || obj.cut === true };
  }

  /* A settled object (lib/remote-note.js) from `author`. -> 'added' | 'held'. */
  function add(name, { kind, author, obj, postId }) {
    const rows = load(name);
    if (rows.some((r) => r.object === obj.id)) return 'held';
    const p = previewOf(obj);
    rows.push({
      id: `el_${crypto.randomBytes(8).toString('hex')}`, kind, object: obj.id, author, tree: p.tree,
      ...(p.cut ? { cut: true } : {}), summary: obj.summary, url: obj.url, published: obj.published, at: clock.iso(), seen: false,
      ...(postId ? { post_id: postId } : {}),
    });
    save(name, rows);
    return 'added';
  }

  /* An Update or Delete of `objectId` by `author`: only their own row moves. */
  function update(name, author, obj) {
    const rows = load(name);
    const r = rows.find((x) => x.object === obj.id && x.author === author);
    if (!r) return false;
    const p = previewOf(obj);
    r.tree = p.tree;
    r.summary = obj.summary;
    if (p.cut) r.cut = true; else delete r.cut;
    save(name, rows);
    return true;
  }
  function removeObject(name, author, objectId) {
    const rows = load(name);
    const next = rows.filter((x) => !(x.object === objectId && x.author === author));
    if (next.length !== rows.length) save(name, next);
    return rows.length - next.length;
  }
  function removeAuthor(name, author) {
    const rows = load(name);
    const next = rows.filter((x) => x.author !== author);
    if (next.length !== rows.length) save(name, next);
    return rows.length - next.length;
  }
  function removeId(name, id) {
    const rows = load(name);
    const next = rows.filter((x) => x.id !== id);
    if (next.length !== rows.length) save(name, next);
    return next.length !== rows.length;
  }
  function markSeen(name) {
    const rows = load(name);
    let n = 0;
    for (const r of rows) if (!r.seen) { r.seen = true; n++; }
    if (n) save(name, rows);
    return n;
  }
  /* Housekeeping: past 30 days goes (load drops them; this rewrites the file). */
  function prune(name) {
    const raw = readJSON(file(name), []);
    const rows = load(name);
    if (!Array.isArray(raw) || raw.length === rows.length) return 0;
    save(name, rows);
    return raw.length - rows.length;
  }
  const authors = (name) => [...new Set(load(name).map((r) => r.author))];
  return { load, add, update, removeObject, removeAuthor, removeId, markSeen, prune, authors, unseenCount, MAX_ROWS };
}

module.exports = { createElsewhere, MAX_ROWS, KEEP_MS, MAX_BYTES, PREVIEW_TEXT, PREVIEW_NODES };
