'use strict';
/* ── Posts and the page store: shapes, the write settle, the text renderer ────
 * Spec 3.2, 3.3, 10.8. Pure: no storage, no request, no clock.
 * lib/page-store.js reads and writes through normalizePage;
 * the routes settle client input through settlePost / settlePageInput;
 * lib/projection.js builds the public view with publicPostView.
 *
 *   - Kinds are a closed set (note, image, link, embed, divider); a stored post of
 *     any other kind normalizes to nothing.
 *   - `link` carries `key` (an owned image) and `sub`, and needs `href` OR `label`.
 *   - `cw` (content warning) and `updated_at` ride every kind.
 *   - The page store carries `indexable`, `open_follows`, `blocked_domains`, `bio`,
 *     `avatar_key`, `links`; posts are capped at 500.
 *   - Ids are never minted here (lib/ids.js mints from the CSPRNG): a client
 *     never names its own id.
 *   - Bad hrefs and unresolvable embeds are REFUSED at write (settlePost), not
 *     only dropped at render.
 *
 * THE TEXT RENDERER (ringSafeHref, ringInline, renderRingMarkdown,
 * ringResolveEmbed) is frozen: escape first, then re-expand a small fixed
 * grammar into tags this module emits; every URL validated; an embed is rebuilt on
 * a fixed origin from an id we extract. It changes only with a security review.
 */
const { escapeHtml } = require('./security');
const { isHandle, hostUnder, normalizeHost } = require('./handles');
const { RING_ID_RE } = require('./ids');

const MAX_POSTS = 500;
const MAX_NOTE_CHARS = 6000;
const MAX_BLOCKED = 500;
const MAX_BLOCKED_DOMAINS = 100;
const MAX_LINKS = 4;

const KINDS = new Set(['note', 'image', 'link', 'embed', 'divider']);
const FONTS = new Set(['', 'serif', 'sans', 'mono', 'cursive', 'fantasy', 'system']);
const CURSORS = new Set(['', 'pointer', 'crosshair', 'cell', 'help', 'progress', 'grab', 'wait']);
const DIVIDERS = new Set(['line', 'dots', 'stars', 'wave']);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/* Invisible and filler characters (F12): every format character (Unicode Cf:
 * U+00AD, U+061C, U+180E, U+200B, U+200E, U+200F, U+2060 to U+206F, U+FEFF and
 * the rest) and the letters and symbols that draw nothing (the Hangul fillers
 * U+115F, U+1160, U+3164, U+FFA0, the braille blank U+2800). Three joiners stay
 * where they do a job: U+200D inside an emoji sequence, U+200C between letters
 * (Persian, the Indic scripts), the emoji tag characters after a black flag. */
const INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800\u2060-\u206F]/gu;
const PICTO = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F/u;
const LETTER = /[\p{L}\p{M}]/u;
const VISIBLE = /[^\s\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]/u;
function codePointBefore(s, at) {
  if (at <= 0) return '';
  const lo = s.charCodeAt(at - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && at >= 2 ? String.fromCodePoint(s.codePointAt(at - 2)) : s[at - 1];
}
function stripInvisible(s) {
  return s.replace(INVISIBLE, (ch, at, all) => {
    const before = codePointBefore(all, at);
    const after = String.fromCodePoint(all.codePointAt(at + ch.length) ?? 0x20);
    if (ch === '\u200D') return PICTO.test(before) && /\p{Extended_Pictographic}/u.test(after) ? ch : '';
    if (ch === '\u200C') return LETTER.test(before) && LETTER.test(after) ? ch : '';
    const cp = ch.codePointAt(0);
    if (cp >= 0xe0020 && cp <= 0xe007f) {
      const b = before.codePointAt(0) || 0;
      return b === 0x1f3f4 || (b >= 0xe0020 && b <= 0xe007f) ? ch : '';
    }
    return '';
  });
}

/* Plain one-line text: control characters and bidi overrides out (to a space),
 * invisible and filler characters out, whitespace collapsed, capped. Text with
 * nothing visible left is '' (a caller's fallback names the handle instead).
 * For names, `cw`, link labels and the like. */
function plainLine(v, max) {
  if (typeof v !== 'string') return '';
  const s = Array.from(
    stripInvisible(v.replace(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, ' ')).replace(/\s+/g, ' ').trim(),
  ).slice(0, max).join('');
  return VISIBLE.test(s) ? s : '';
}

/* Hex-only colour (#rgb .. #rrggbbaa): zero CSS-injection surface. */
function ringSafeColor(c) {
  const s = String(c || '').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : '';
}

function normalizeTheme(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    bg: ringSafeColor(t.bg),
    bg_image_key: str(t.bg_image_key, 200),
    font: FONTS.has(t.font) ? t.font : '',
    marquee: str(t.marquee, 200),
    blink: t.blink === true,
    cursor: CURSORS.has(t.cursor) ? t.cursor : '',
  };
}

/* Where a post lives (spec 3.4): 'public', a ring id (`ring_` + 20 hex, the one
 * shape lib/ids.js mints), or 'archive'. Absent reads as 'public'. Anything else
 * is null: the write path refuses it (`not_in_ring`) and a stored one reads as
 * 'archive', the author-only shelf (fail closed: an unreadable address is never
 * Public and never some room). A ring id is only TRUSTED after the write path
 * checks membership. */
function normalizeAudience(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'public') return 'public';
  if (raw === 'archive') return 'archive';
  return typeof raw === 'string' && RING_ID_RE.test(raw) ? raw : null;
}

/* Per-kind media. Anything outside the kind's shape is dropped. */
function normalizeMedia(kind, raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  switch (kind) {
    case 'image': return { key: str(m.key, 200), alt: str(m.alt, 300), href: str(m.href, 500) };
    case 'link': {
      const out = { href: str(m.href, 500), label: plainLine(m.label, 200) };
      const key = str(m.key, 200);
      if (key) out.key = key;
      const sub = plainLine(m.sub, 300);
      if (sub) out.sub = sub;
      return out;
    }
    case 'embed': return { url: str(m.url, 500) };
    case 'divider': return { variant: DIVIDERS.has(m.variant) ? m.variant : 'line' };
    default: return null;
  }
}

/* Normalize ONE stored post. Returns null for an unknown kind or an empty
 * husk. The id is kept as stored; it is never minted here. */
function normalizePost(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  const id = str(raw.id, 40);
  if (!id) return null;
  const kind = raw.kind;
  const post = { id, kind, created_at: str(raw.created_at, 40), audience: normalizeAudience(raw.audience) ?? 'archive' };
  const updated = str(raw.updated_at, 40);
  if (updated) post.updated_at = updated;
  if (post.audience === 'archive') {
    const from = typeof raw.archived_from === 'string' && RING_ID_RE.test(raw.archived_from) ? raw.archived_from : '';
    if (from) post.archived_from = from;
    const at = str(raw.archived_at, 40);
    if (at) post.archived_at = at;
  }
  const note = str(raw.note, MAX_NOTE_CHARS);
  if (note) post.note = note;
  const cw = plainLine(raw.cw, 100);
  if (cw) post.cw = cw;
  const kaomoji = str(raw.kaomoji, 40);
  if (kaomoji) post.kaomoji = kaomoji;
  if (raw.pinned === true) post.pinned = true;
  // `shown`: this post was once public on an enabled page (stamped by
  // lib/page-store.js save). Only then does its deletion federate a Delete, and
  // its URL answer 410 rather than 404 (spec 4.9, N10).
  if (raw.shown === true) post.shown = true;
  if (raw.stamps_off === true) post.stamps_off = true;
  if (raw.comments_off === true) post.comments_off = true;

  if (kind === 'note') {
    if (!note) return null;   // a note post IS its note
  } else {
    post.media = normalizeMedia(kind, raw.media);
    if (kind === 'image' && !post.media.key) return null;
    if (kind === 'link' && !post.media.href && !post.media.label) return null;
    if (kind === 'embed' && !post.media.url) return null;
  }
  return post;
}

/* A page link (spec 3.3): http(s) only, rendered rel="me". */
function normalizeLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const href = str(raw.href, 500).trim();
  if (!/^https?:\/\/[^\s]+$/i.test(href)) return null;
  return { label: plainLine(raw.label, 40), href };
}

/* THE page store shape, `members/<name>/log.json`, on every read and write.
 * `shown_tracked`: the store records which posts were ever shown (N10). A store
 * written before that existed has every public post counted as shown: the safe
 * side, since a Delete for a copy nobody holds costs nothing. */
function normalizePage(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const posts = [];
  const seen = new Set();
  const tracked = r.shown_tracked === true;
  for (const p of (Array.isArray(r.posts) ? r.posts : []).slice(0, MAX_POSTS)) {
    const n = normalizePost(p);
    if (n && !seen.has(n.id)) {
      if (!tracked && n.audience === 'public' && n.kind !== 'divider') n.shown = true;
      seen.add(n.id);
      posts.push(n);
    }
  }
  return {
    shown_tracked: true,
    enabled: r.enabled === true,
    indexable: r.indexable === true,
    open_follows: r.open_follows === true,
    stamps_off: r.stamps_off === true,
    comments_off: r.comments_off === true,
    // Handles are never cut (a cut handle matches nobody, so a block would fail open);
    // anything not in stored handle shape is dropped (federation-r1-04).
    blocked: [...new Set((Array.isArray(r.blocked) ? r.blocked : []).filter((s) => isHandle(s, { allowPort: true })))].slice(0, MAX_BLOCKED),
    // Through THE host normalizer on read too (P8 review F4): a hand-edited
    // `Evil.Example.` is `evil.example`; what it refuses is dropped.
    blocked_domains: [...new Set((Array.isArray(r.blocked_domains) ? r.blocked_domains : []).map((d) => (typeof d === 'string' ? normalizeHost(d, { allowPort: true, allowIp: true }) : '')).filter(Boolean))].slice(0, MAX_BLOCKED_DOMAINS),
    theme: normalizeTheme(r.theme),
    bio: str(r.bio, 500),
    avatar_key: str(r.avatar_key, 200),
    links: (Array.isArray(r.links) ? r.links : []).map(normalizeLink).filter(Boolean).slice(0, MAX_LINKS),
    posts,
  };
}

/* Has this page's owner blocked `handle` (spec 6.1)? The handle itself, or its
 * host or a parent domain of it on the domain list. `settings` is the store or
 * lib/page-store.js settings(): both carry `blocked` and `blocked_domains`. */
function blocksHandle(settings, handle) {
  if (!handle || !settings) return false;
  if ((settings.blocked || []).includes(handle)) return true;
  const at = handle.indexOf('@');
  if (at < 0) return false;
  // lib/handles.js hostUnder: the domain or a subdomain; a domain stored with a
  // port (tests only) matches that host and port exactly.
  const host = handle.slice(at + 1);
  return (settings.blocked_domains || []).some((d) => hostUnder(host, d));
}

/* Every image key a page store references: avatar, theme background, image and
 * link posts. What the sweep spares and what a deleted post may free. */
function pageImageKeys(store) {
  const keys = new Set();
  if (store?.avatar_key) keys.add(store.avatar_key);
  if (store?.theme?.bg_image_key) keys.add(store.theme.bg_image_key);
  for (const p of store?.posts || []) {
    if ((p.kind === 'image' || p.kind === 'link') && p.media?.key) keys.add(p.media.key);
  }
  return keys;
}

function postImageKey(p) {
  return (p.kind === 'image' || p.kind === 'link') && p.media?.key ? p.media.key : '';
}

// ── The write settle ───────────────────────────────────────────────────────────

/* Settle a create (prev = null) or an edit (prev = the stored post) from client
 * input. Returns { post } or { error }. `ownsImage(key)` answers whether the key
 * belongs to the author. The caller mints the id and created_at of a create and
 * checks the audience (ring membership); this checks everything else.
 * On an edit, kind, created_at, audience and the server-kept fields are immutable:
 * whatever the client sends for them is ignored. */
function settlePost(body, { prev = null, ownsImage }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const kind = prev ? prev.kind : b.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return { error: 'unknown_kind' };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (b.media !== undefined && !isObj(b.media)) return { error: 'invalid_field' };
  // An edit merges media field by field: sending { alt } keeps the image.
  const merged = prev
    ? { ...prev, ...b, media: isObj(b.media) ? { ...(prev.media || {}), ...b.media } : prev.media }
    : { ...b };
  merged.id = prev ? prev.id : 'pending';
  merged.kind = kind;
  merged.created_at = prev ? prev.created_at : '';
  if (!prev && normalizeAudience(b.audience) === null) return { error: 'not_in_ring' };
  merged.audience = prev ? prev.audience : normalizeAudience(b.audience);
  if (prev) {
    for (const k of ['archived_from', 'archived_at', 'updated_at', 'shown']) {
      if (prev[k] === undefined) delete merged[k]; else merged[k] = prev[k];
    }
  } else {
    for (const k of ['archived_from', 'archived_at', 'updated_at', 'shown']) delete merged[k];
  }
  for (const k of ['pinned', 'stamps_off', 'comments_off']) {
    if (merged[k] !== undefined && typeof merged[k] !== 'boolean') return { error: 'invalid_field' };
  }

  const post = normalizePost(merged);
  if (!post) return { error: 'empty_post' };

  const m = post.media || {};
  if (kind === 'image' || kind === 'link') {
    if (m.href && !ringSafeHref(m.href)) return { error: 'bad_href' };
    const key = postImageKey(post);
    if (key && !ownsImage(key)) return { error: 'foreign_image' };
  }
  if (kind === 'embed' && !ringResolveEmbed(m.url)) return { error: 'bad_embed' };
  return { post };
}

/* Settle a PUT /api/me/page body over the current store. Returns { store,
 * blocked?, unblocked? } or { error }. Booleans must be literal booleans; an
 * image key must be the member's own; a link must be http(s). Handles and hosts
 * for the block lists are settled by the caller (it knows this host). */
function settlePageInput(body, store, { ownsImage }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const next = { ...store, theme: { ...store.theme }, links: store.links.slice(), blocked: store.blocked.slice(), blocked_domains: store.blocked_domains.slice() };
  for (const k of ['enabled', 'indexable', 'open_follows', 'stamps_off', 'comments_off']) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') return { error: 'invalid_field', field: k };
    next[k] = b[k];
  }
  if (b.theme !== undefined) {
    if (!b.theme || typeof b.theme !== 'object' || Array.isArray(b.theme)) return { error: 'invalid_field', field: 'theme' };
    const theme = normalizeTheme({ ...store.theme, ...b.theme });
    if (theme.bg_image_key && theme.bg_image_key !== store.theme.bg_image_key && !ownsImage(theme.bg_image_key)) return { error: 'foreign_image', field: 'theme' };
    next.theme = theme;
  }
  if (b.bio !== undefined) {
    if (typeof b.bio !== 'string') return { error: 'invalid_field', field: 'bio' };
    next.bio = b.bio.slice(0, 500);
  }
  if (b.avatar_key !== undefined) {
    if (typeof b.avatar_key !== 'string') return { error: 'invalid_field', field: 'avatar_key' };
    if (b.avatar_key && !ownsImage(b.avatar_key)) return { error: 'foreign_image', field: 'avatar_key' };
    next.avatar_key = b.avatar_key;
  }
  if (b.links !== undefined) {
    if (!Array.isArray(b.links) || b.links.length > MAX_LINKS) return { error: 'invalid_field', field: 'links' };
    const links = [];
    for (const l of b.links) {
      const n = normalizeLink(l);
      if (!n) return { error: 'bad_href', field: 'links' };
      links.push(n);
    }
    next.links = links;
  }
  return { store: next };
}

// ── The text renderer ──────────────────────────────────────────────────────────

/* Safe href: http(s), mailto, or a site-relative path. Anything else (javascript:,
 * data:, vbscript:, protocol-relative //evil) is ''. */
function ringSafeHref(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^mailto:[^\s]+@[^\s]+$/i.test(s)) return s;
  if (/^\/(?!\/)/.test(s)) return s;
  return '';
}

/* A link in ANOTHER server's markdown (F10): http(s) only. A site-relative
 * path would resolve against THIS origin, and a mailto is not a web link. */
const remoteLinkHref = (u) => { const h = ringSafeHref(u); return /^https?:\/\//i.test(h) ? h : ''; };

/* Inline markdown on ALREADY-ESCAPED text: strong, em, code, links. `remote`:
 * the text is another server's, so its links are http(s) only. */
function ringInline(escaped, { remote = false } = {}) {
  let s = String(escaped);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const href = (remote ? remoteLinkHref : ringSafeHref)(url.replace(/&amp;/g, '&'));
    if (!href) return text;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener ugc">${text}</a>`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?![\w])/g, '$1<em>$2</em>');
  return s;
}

/* A tiny markdown subset to safe HTML: headings (# h3, ## h4, ### h5), hr,
 * blockquote, unordered lists, paragraphs with <br> breaks. `remote: true` for
 * another Ring server's markdown (lib/remote-note.js renderParts): its links
 * are http(s) only. */
function renderRingMarkdown(md, { remote = false } = {}) {
  const inline = (x) => ringInline(x, { remote });
  const escaped = escapeHtml(String(md || '').slice(0, MAX_NOTE_CHARS));
  const lines = escaped.split(/\r?\n/);
  const out = [];
  let para = [];
  let list = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join('<br>')) + '</p>'); para = []; } };
  const flushList = () => { if (list.length) { out.push('<ul>' + list.map((li) => '<li>' + inline(li) + '</li>').join('') + '</ul>'); list = []; } };
  for (const line of lines) {
    const tl = line.trim();
    let m;
    if (!tl) { flushPara(); flushList(); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(tl)) { flushPara(); flushList(); out.push('<hr>'); }
    else if ((m = tl.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); flushList(); const lvl = m[1].length + 2; out.push(`<h${lvl}>` + inline(m[2]) + `</h${lvl}>`); }
    else if ((m = tl.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); }
    else if ((m = tl.match(/^[-*]\s+(.*)$/))) { flushPara(); list.push(m[1]); }
    else { flushList(); para.push(tl); }
  }
  flushPara(); flushList();
  return out.join('\n');
}

/* The bio's inline subset (spec 3.3): links and emphasis, line breaks kept. */
function renderInline(text, max = 500) {
  return ringInline(escapeHtml(String(text || '').slice(0, max))).replace(/\r?\n/g, '<br>');
}

/* A share URL to a canonical embed src on a FIXED origin, or null. */
function ringResolveEmbed(url) {
  const s = String(url || '').trim();
  let m;
  if ((m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([\w-]{6,20})/i)))
    return { provider: 'youtube', src: 'https://www.youtube-nocookie.com/embed/' + m[1], media_kind: 'video', page: 'https://www.youtube.com/watch?v=' + m[1] };
  if ((m = s.match(/vimeo\.com\/(?:video\/)?(\d{6,15})/i)))
    return { provider: 'vimeo', src: 'https://player.vimeo.com/video/' + m[1], media_kind: 'video', page: 'https://vimeo.com/' + m[1] };
  if (/^https?:\/\/(?:[\w-]+\.)?soundcloud\.com\/[^\s"'<>]+$/i.test(s))
    return { provider: 'soundcloud', src: 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(s) + '&color=%23999999&auto_play=false&show_user=true', media_kind: 'audio', page: s };
  return null;
}

/* The embed origins the CSP's frame-src allows (spec 10.12). */
const EMBED_ORIGINS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://w.soundcloud.com'];

/* "Firstname L." for a name signing someone else's wall (spec 3.1). */
function shortDisplayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.';
}

module.exports = {
  MAX_POSTS, MAX_NOTE_CHARS, MAX_BLOCKED, MAX_BLOCKED_DOMAINS, MAX_LINKS,
  KINDS, FONTS, CURSORS, DIVIDERS, EMBED_ORIGINS,
  plainLine, ringSafeColor, normalizeTheme, normalizeAudience, normalizeMedia, normalizePost,
  normalizeLink, normalizePage, blocksHandle, pageImageKeys, postImageKey, settlePost, settlePageInput,
  ringSafeHref, ringInline, renderRingMarkdown, renderInline, ringResolveEmbed, shortDisplayName,
  escapeHtml,
};
