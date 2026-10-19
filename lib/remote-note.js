'use strict';
/* ── A remote post, read (spec 4.4, 4.8, 4.10, 5.4, 5.8) ──────────────────────
 * THE one reader of an object another server sent or served: a `Note` (or a
 * friend's `Article` or `Page`, which the Friends feed shows as a titled link).
 * settleObject(doc, { actor }) answers the settled shape every store keeps
 * (fed/walls, From elsewhere, a comment's text, a lookup), or { refused } with
 * why. Nothing from the document survives unsettled: a closed registry, wrong
 * types dropped, never coerced.
 *
 * OWNERSHIP (5.4): the object's `attributedTo` is the actor that sent it, and
 * the object's id is on that actor's host. A remote server can never put words
 * in another host's mouth.
 *
 * THE TWO READERS (4.4): a post from a RING server (`ring.v` 1 and a markdown
 * `source`) keeps its markdown source and its settled Ring term, and is rendered
 * here by lib/ring.js renderRingMarkdown and ringResolveEmbed (escape first, a
 * fixed grammar): no Ring server ever inserts another server's HTML. Anything
 * else keeps the node tree of its `content` (lib/remote-html.js), never HTML.
 *
 * Plain fields (5.8): the warning (`summary`) 200, a title 200, alt text 1500,
 * through lib/ring.js plainLine (control characters and bidi overrides out).
 * At most 4 attachments; an image is kept as its URL (the media cache fetches it
 * for what a member here will see, lib/remote-media.js); video and audio are a
 * link to the source, never fetched. An `Emoji` tag's image is never read.
 *
 * `visibility`: 'public' (as:Public in `to`), 'unlisted' (in `cc`), else
 * 'private'. Ring has no followers-only or direct audience, and a private reply
 * must never become a public comment: every route that keeps a remote object
 * requires public or unlisted (spec 4.10).
 */
const { parseRemoteHtml, settleTree, treeText, remoteHref } = require('./remote-html');
const { plainLine, ringResolveEmbed, renderRingMarkdown, MAX_NOTE_CHARS, KINDS } = require('./ring');
const urls = require('./urls');

const PUBLIC_IDS = new Set([urls.AS_PUBLIC, 'as:Public', 'Public']);
const OBJECT_TYPES = new Set(['Note', 'Article', 'Page']);
const MAX_ATTACHMENTS = 4;

const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const idOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.id === 'string' ? v.id : '');
const { hostOfUrl: canonicalHostOfUrl } = require('./handles');
// THE host normalizer's reading of a URL (lib/handles.js, P8 review F4).
const hostOf = canonicalHostOfUrl;
const httpUrl = (u, max = 2000) => (typeof u === 'string' && u.length <= max && /^https?:\/\//i.test(u) ? u : '');
const isoOr = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : '');

function visibilityOf(doc) {
  if (arr(doc.to).some((x) => PUBLIC_IDS.has(idOf(x)))) return 'public';
  if (arr(doc.cc).some((x) => PUBLIC_IDS.has(idOf(x)))) return 'unlisted';
  return 'private';
}

/* The Ring term of a remote Ring post, settled against a closed registry. */
function settleRingTerm(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
  const out = { v: 1 };
  if (typeof raw.kind === 'string' && KINDS.has(raw.kind) && raw.kind !== 'divider') out.kind = raw.kind;
  const kao = plainLine(raw.kaomoji, 40);
  if (kao) out.kaomoji = kao;
  const href = remoteHref(raw.href);
  if (href) out.href = href;
  if (raw.link && typeof raw.link === 'object') {
    const link = { href: remoteHref(raw.link.href), label: plainLine(raw.link.label, 200), sub: plainLine(raw.link.sub, 300) };
    if (link.href || link.label) out.link = link;
  }
  const e = typeof raw.embed === 'string' ? ringResolveEmbed(raw.embed) : null;
  if (e) out.embed = e.page;
  return out;
}

function settleAttachments(list) {
  const out = [];
  for (const a of arr(list)) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!a || typeof a !== 'object') continue;
    const mediaType = typeof a.mediaType === 'string' ? a.mediaType.toLowerCase() : '';
    const url = httpUrl(typeof a.url === 'string' ? a.url : idOf(a.url) || (a.url && typeof a.url === 'object' ? a.url.href : ''));
    if (a.type === 'Link') {
      const href = remoteHref(a.href);
      if (href) out.push({ kind: 'link', url: href, alt: plainLine(a.name, 200) });
      continue;
    }
    if (!url) continue;
    const kind = mediaType.startsWith('image/') || a.type === 'Image' ? 'image'
      : mediaType.startsWith('video/') || a.type === 'Video' ? 'video'
        : mediaType.startsWith('audio/') || a.type === 'Audio' ? 'audio' : '';
    if (!kind) continue;
    const row = { kind, url, alt: plainLine(a.name, 1500) };
    const w = Number(a.width);
    const h = Number(a.height);
    if (kind === 'image' && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 100_000 && h <= 100_000) { row.width = w; row.height = h; }
    out.push(row);
  }
  return out;
}

/* Settle `doc` as sent or served by `actor` (an actor id). */
function settleObject(doc, { actor }) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { refused: 'not an object' };
  if (!OBJECT_TYPES.has(doc.type)) return { refused: `type ${String(doc.type || '').slice(0, 40)}` };
  const id = httpUrl(doc.id);
  if (!id) return { refused: 'id' };
  const host = hostOf(actor);
  if (!host || hostOf(id) !== host) return { refused: 'object on another host' };
  if (idOf(arr(doc.attributedTo)[0]) !== actor) return { refused: 'attributedTo is not the actor' };
  const content = typeof doc.content === 'string' ? doc.content : '';
  const parsed = parseRemoteHtml(content);
  if (!parsed) return { refused: 'content over 60 KB' };
  const ring = settleRingTerm(doc.ring);
  const out = {
    id,
    type: doc.type,
    actor,
    url: httpUrl(idOf(arr(doc.url)[0]) || (doc.url && typeof doc.url === 'object' ? doc.url.href : '')) || id,
    published: isoOr(doc.published),
    updated: isoOr(doc.updated),
    visibility: visibilityOf(doc),
    in_reply_to: httpUrl(idOf(doc.inReplyTo)),
    mentions: arr(doc.tag).filter((t) => t && t.type === 'Mention').map((t) => httpUrl(t.href)).filter(Boolean).slice(0, 50),
    summary: plainLine(doc.summary, 200),
    sensitive: doc.sensitive === true || !!plainLine(doc.summary, 200),
    attachments: settleAttachments(doc.attachment),
  };
  if (typeof doc.audience === 'string') out.audience = doc.audience;
  if (doc.type !== 'Note') out.name = plainLine(doc.name, 200);
  const md = doc.source && typeof doc.source === 'object' && typeof doc.source.content === 'string' && doc.source.mediaType === 'text/markdown' ? doc.source.content : null;
  if (ring && md !== null) {
    out.ring = ring;
    out.source = md.slice(0, MAX_NOTE_CHARS);
  } else {
    out.tree = parsed.tree;
    if (parsed.cut) out.cut = true;
  }
  return out;
}

/* ONE parse per inbound object (F1): every handler an activity reaches (a
 * member's table for each member it mentions, the server's table) settles the
 * very same embedded object, so the answer is kept against that object (a
 * WeakMap: it goes with the activity) and handed back to the next. The caller
 * must not mutate `doc` in between; inbound bodies are never mutated. */
const settledOnce = new WeakMap();   // doc -> Map(actor -> settled)
function settleCached(doc, { actor }) {
  if (!doc || typeof doc !== 'object') return settleObject(doc, { actor });
  let byActor = settledOnce.get(doc);
  if (!byActor) { byActor = new Map(); settledOnce.set(doc, byActor); }
  if (!byActor.has(actor)) byActor.set(actor, settleObject(doc, { actor }));
  return byActor.get(actor);
}

/* Is the object id `id` ATTRIBUTABLE to the actor `actor` by its path (F11)?
 * 5.4 puts it on the actor's host; on top, an id under the actor's own URL
 * (`<actor>/...`, Mastodon's statuses) is theirs, and an id in the actor's
 * sibling space (`/users/bob/...` when the actor is `/users/mallory`) is
 * ANOTHER actor's and never theirs. Ids elsewhere on the host (Pleroma's
 * `/objects/<uuid>`, Misskey's `/notes/<id>`) pass on the host rule alone. */
function idUnderActor(id, actor) {
  let a;
  let o;
  try { a = new URL(actor); o = new URL(id); } catch { return false; }
  if (a.host.toLowerCase() !== o.host.toLowerCase() || a.protocol !== o.protocol) return false;
  const ap = a.pathname.replace(/\/+$/, '');
  if (o.pathname === ap || o.pathname.startsWith(`${ap}/`)) return true;
  const parent = ap.slice(0, ap.lastIndexOf('/') + 1);   // '/users/' of '/users/bob'
  if (parent.length > 1 && o.pathname.startsWith(parent)) return false;
  return true;
}

/* A settled object read back from a store: the same registry again (a hand
 * edit, or an older shape, never widens what renders). */
function resettle(row) {
  if (!row || typeof row !== 'object') return null;
  const out = { ...row };
  if (row.tree !== undefined) out.tree = settleTree(row.tree);
  if (row.ring !== undefined) out.ring = settleRingTerm(row.ring) || undefined;
  if (typeof row.source === 'string') out.source = row.source.slice(0, MAX_NOTE_CHARS);
  out.summary = plainLine(row.summary, 200);
  out.attachments = Array.isArray(row.attachments) ? row.attachments.filter((a) => a && typeof a === 'object').slice(0, MAX_ATTACHMENTS).map((a) => ({
    kind: ['image', 'video', 'audio', 'link'].includes(a.kind) ? a.kind : 'link',
    url: httpUrl(a.url), alt: plainLine(a.alt, 1500),
    ...(typeof a.media === 'string' && /^m_[0-9a-f]{32}$/.test(a.media) ? { media: a.media } : {}),
    ...(Number.isInteger(a.width) && Number.isInteger(a.height) ? { width: a.width, height: a.height } : {}),
  })).filter((a) => a.url) : [];
  return out;
}

/* The plain text of a settled object (a comment's body, a preview). */
function plainTextOf(o) {
  if (typeof o?.source === 'string') return o.source;
  return treeText(o?.tree || []);
}

/* What the app renders for a settled object (a feed card, a lookup): HTML only
 * from THIS server's own renderer (a Ring post's markdown), else the tree. */
function renderParts(o) {
  const v = {};
  if (o.ring && typeof o.source === 'string') {
    const html = renderRingMarkdown(o.source, { remote: true });   // another server's links: http(s) only
    if (html) v.html = html;
    if (o.ring.kaomoji) v.kaomoji = o.ring.kaomoji;
    if (o.ring.kind) v.ring_kind = o.ring.kind;
    if (o.ring.link) { v.href = o.ring.link.href; v.label = o.ring.link.label || o.ring.link.href; if (o.ring.link.sub) v.sub = o.ring.link.sub; }
    else if (o.ring.href) v.href = o.ring.href;
    if (o.ring.embed) {
      const e = ringResolveEmbed(o.ring.embed);
      if (e) Object.assign(v, { provider: e.provider, src: e.src, media_kind: e.media_kind, page: e.page });
    }
  } else {
    v.tree = o.tree || [];
    if (o.cut) v.cut = true;
  }
  if (o.name) v.title = o.name;
  return v;
}

module.exports = { settleObject, settleCached, idUnderActor, resettle, plainTextOf, renderParts, visibilityOf, settleRingTerm, PUBLIC_IDS, OBJECT_TYPES, MAX_ATTACHMENTS };
