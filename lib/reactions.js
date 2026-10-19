'use strict';
/* ── Stamps and comments: rows, stores, views (spec 3.7) ──────────────────────
 * THE one reader and writer of
 * `members/<owner>/log-stamps.json` and `log-comments.json`: the reactions ON
 * that owner's posts, sharded per owner so a stamp rewrites one owner's file,
 * never a global one.
 *
 *   stamp    { id: 'stmp_…', post_id, author, kaomoji, custom?, activity_id, at, seen }
 *   comment  { id: 'lc_…', post_id, author, body, truncated?, source_url?, object_id, at, seen }
 * `author` is a handle. A face is a palette face (lib/palette.js: 56 faces, 30
 * nice) or, on a room post only, a CUSTOM face: one line, 20 characters,
 * emoji-safe. A comment is plain text, whitespace collapsed, 280 characters (a
 * decision, not a placeholder). Both are stored raw and escaped by every renderer.
 *
 * Views never carry `seen` (the owner's alone) and sign the author "Firstname L."
 * with a return address and the sender's theme tint (stampTintFromTheme).
 * decorate() is THE render-time filter: a blocked author's rows never show,
 * whatever is on disk (retroactive, enforced at render, spec 3.7).
 *
 * A write for a gone owner throws MemberGone (the purge stays a purge); every
 * write tells the projection (`onWrite(owner)`), because a wall shows these rows.
 * Bounds (files, never shown): 20 000 stamps and 10 000 comments per owner,
 * oldest out.
 */
const { readJSON, writeJSON } = require('./store');
const { isHandle } = require('./handles');
const { POST_ID_RE, STAMP_ID_RE, COMMENT_ID_RE } = require('./ids');
const { blocksHandle, ringSafeColor, shortDisplayName, plainLine } = require('./ring');
const { FACES, NICE_FACES } = require('./palette');
const { MemberGone } = require('./page-store');
const urls = require('./urls');

const MAX_STAMPS = 20_000;
const MAX_COMMENTS = 10_000;
const COMMENT_MAX = 280;
const CUSTOM_FACE_MAX = 20;
const FACE_SET = new Set(FACES);
const NICE_SET = new Set(NICE_FACES);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/* Faces are compared after NFC with U+FE0F removed (spec 4.8). */
const faceKey = (s) => (typeof s === 'string' ? s.normalize('NFC').replace(/️/g, '') : '');
const PALETTE_BY_KEY = new Map(FACES.map((f) => [faceKey(f), f]));
const paletteFace = (s) => PALETTE_BY_KEY.get(faceKey(s)) || '';
const isNice = (face) => NICE_SET.has(face);

/* A custom face: one line, at most 20 characters (code points), never empty. A
 * comment body: plain text, whitespace collapsed, 280 characters. Both through
 * lib/ring.js plainLine: control characters and bidi overrides out (a ring name
 * takes the same door). */
const normalizeCustomFace = (raw) => plainLine(raw, CUSTOM_FACE_MAX);
const normalizeCommentBody = (raw) => plainLine(raw, COMMENT_MAX);

function normalizeStamp(r) {
  if (!r || !STAMP_ID_RE.test(r.id || '') || !POST_ID_RE.test(r.post_id || '') || !isHandle(r.author, { allowPort: true })) return null;
  const custom = r.custom === true;
  const kaomoji = custom ? normalizeCustomFace(r.kaomoji) : paletteFace(r.kaomoji);
  if (!kaomoji) return null;
  const row = { id: r.id, post_id: r.post_id, author: r.author, kaomoji, activity_id: str(r.activity_id, 600), at: str(r.at, 40), seen: r.seen === true };
  if (custom) row.custom = true;
  return row;
}

function normalizeComment(r) {
  if (!r || !COMMENT_ID_RE.test(r.id || '') || !POST_ID_RE.test(r.post_id || '') || !isHandle(r.author, { allowPort: true })) return null;
  const body = normalizeCommentBody(r.body);
  if (!body) return null;
  const row = { id: r.id, post_id: r.post_id, author: r.author, body, object_id: str(r.object_id, 600), at: str(r.at, 40), seen: r.seen === true };
  if (r.truncated === true) row.truncated = true;
  const src = str(r.source_url, 600);
  if (/^https?:\/\//.test(src)) row.source_url = src;
  return row;
}

const normalizeList = (raw, fn, max) => {
  const out = [];
  const ids = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    const n = fn(r);
    if (n && !ids.has(n.id)) { ids.add(n.id); out.push(n); }
  }
  return out.slice(-max);
};

/* The soft ticket tint from a sender's theme bg: 82% toward white. */
function stampTintFromTheme(bg) {
  const s = ringSafeColor(bg);
  const m = /^#([0-9a-fA-F]{6})$/.exec(s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s.slice(0, 7));
  if (!m) return '';
  const mix = (i) => Math.round(255 - (255 - Number.parseInt(m[1].slice(i, i + 2), 16)) * 0.18).toString(16).padStart(2, '0');
  return `#${mix(0)}${mix(2)}${mix(4)}`;
}

const byAt = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/* P8: `serverBlocked(handle)`: a person or domain the admin blocks server-wide
 * never shows at render either, on any wall (the purge removes the rows; this
 * holds for whatever a damaged file kept). */
function createReactions({ paths, members, pages, onWrite = () => {}, onComments = () => {}, serverBlocked = () => false }) {
  // P6: how a REMOTE author signs (the actor cache: name, profile URL, host).
  let remoteWho = null;
  const stampFile = (owner) => paths.memberFile(owner, 'log-stamps.json');
  const commentFile = (owner) => paths.memberFile(owner, 'log-comments.json');
  const guard = (owner) => { if (!members.get(owner)) throw new MemberGone(owner); };

  const loadStamps = (owner) => normalizeList(readJSON(stampFile(owner), []), normalizeStamp, MAX_STAMPS);
  const loadComments = (owner) => normalizeList(readJSON(commentFile(owner), []), normalizeComment, MAX_COMMENTS);
  function saveStamps(owner, rows) {
    guard(owner);
    writeJSON(stampFile(owner), normalizeList(rows, normalizeStamp, MAX_STAMPS));
    onWrite(owner);
  }
  function saveComments(owner, rows) {
    guard(owner);
    const kept = normalizeList(rows, normalizeComment, MAX_COMMENTS);
    writeJSON(commentFile(owner), kept);
    onWrite(owner);
    try { onComments(owner, kept); } catch { /* lib/holders.js: an index hook never fails a write */ }
  }

  /* Drop rows matching `drop(row)` from both files; returns how many went. */
  function removeWhere(owner, drop) {
    let n = 0;
    const s = loadStamps(owner);
    const ks = s.filter((r) => !drop(r));
    if (ks.length !== s.length) { n += s.length - ks.length; saveStamps(owner, ks); }
    const c = loadComments(owner);
    const kc = c.filter((r) => !drop(r));
    if (kc.length !== c.length) { n += c.length - kc.length; saveComments(owner, kc); }
    return n;
  }
  const removeForPost = (owner, postId) => removeWhere(owner, (r) => r.post_id === postId);
  const removeAuthor = (owner, handle) => removeWhere(owner, (r) => r.author === handle);

  /* What a signature shows of `handle`: the full name, the tint, and whether
   * they are an active member (a wall lists active friends only). */
  function signatureParts(handle) {
    if (handle.includes('@')) {
      const v = remoteWho ? remoteWho(handle) : null;
      return { full: v?.name || handle.slice(0, handle.indexOf('@')), tint: '', status: v?.gone ? 'gone' : 'remote', url: v?.url || '', host: handle.slice(handle.indexOf('@') + 1) };
    }
    const m = members.get(handle);
    let tint = '';
    try { tint = m ? stampTintFromTheme(pages.settings(handle).bg) : ''; } catch { tint = ''; }
    return { full: m?.display_name || handle, tint, status: m?.status || 'gone' };
  }
  const signatureOf = (handle) => { const s = signatureParts(handle); return `${s.full}\n${s.tint}\n${s.status}`; };

  /* A signer for one request or one build: memoized per handle. `record(handle,
   * signature)` lets the projection know whose name and tint a wall used. */
  function authorResolver(origin, record = () => {}) {
    const cache = new Map();
    return (handle) => {
      if (!cache.has(handle)) {
        const parts = signatureParts(handle);
        record(handle, signatureOf(handle));
        // A remote name signs "Firstname L. · host" (spec 2.4), so it can never
        // pass as a local friend; its link is its own profile, not a wall here.
        if (parts.host) cache.set(handle, { handle, name: `${shortDisplayName(parts.full) || parts.full} · ${parts.host}`, url: parts.url, host: parts.host, tint: '', remote: true });
        else cache.set(handle, { handle, name: shortDisplayName(parts.full) || handle, url: urls.pageUrl(origin, handle), host: urls.hostOf(origin), tint: parts.tint });
      }
      return cache.get(handle);
    };
  }

  const stampView = (s, authorOf) => {
    const who = authorOf(s.author);
    const out = { id: s.id, kaomoji: s.kaomoji, at: s.at, author: { handle: who.handle, name: who.name, url: who.url, host: who.host } };
    if (s.custom) out.custom = true;
    if (who.tint) out.tint = who.tint;
    return out;
  };
  const commentView = (c, authorOf) => {
    const who = authorOf(c.author);
    const out = { id: c.id, body: c.body, at: c.at, author: { handle: who.handle, name: who.name, url: who.url, host: who.host } };
    if (c.truncated) { out.truncated = true; if (c.source_url) out.source_url = c.source_url; }
    return out;
  };

  /* Map post id -> { stamps, comments } for `postIds`, oldest first, blocked
   * authors left out (the owner's lists, `settings`). */
  function decorate(owner, settings, postIds, authorOf) {
    const want = new Set(postIds);
    const out = new Map([...want].map((id) => [id, { stamps: [], comments: [] }]));
    if (!want.size) return out;
    for (const s of loadStamps(owner).sort(byAt)) {
      if (want.has(s.post_id) && !blocksHandle(settings, s.author) && !serverBlocked(s.author)) out.get(s.post_id).stamps.push(stampView(s, authorOf));
    }
    for (const c of loadComments(owner).sort(byAt)) {
      if (want.has(c.post_id) && !blocksHandle(settings, c.author) && !serverBlocked(c.author)) out.get(c.post_id).comments.push(commentView(c, authorOf));
    }
    return out;
  }

  return {
    loadStamps, saveStamps, loadComments, saveComments, removeForPost, removeAuthor, removeWhere,
    authorResolver, signatureOf, stampView, commentView, decorate,
    bindRemote: (fn) => { remoteWho = fn; },
  };
}

module.exports = {
  createReactions, normalizeStamp, normalizeComment, normalizeCustomFace, normalizeCommentBody,
  stampTintFromTheme, paletteFace, faceKey, isNice, FACE_SET, NICE_SET, COMMENT_MAX, CUSTOM_FACE_MAX,
};
