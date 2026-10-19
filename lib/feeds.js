'use strict';
/* ── The feeds and the shelf (spec 3.9) ───────────────────────────────────────
 * ZERO NEW ACCESS (spec 10.1): the
 * square and Friends read each author through their memoized public projection
 * (lib/projection.js: an active member, a page that is ON, `public` posts only,
 * reactions decorated and block-filtered), so a switch is honoured live; a ring
 * feed reads only posts addressed to THAT ring, from its current members, inside
 * their week (read-time expiry). Only dated posts feed; dividers stay furniture.
 *
 *   square   every member of THIS server, 20 a page newest first behind an
 *            opaque base64url cursor [created_at, id, name] that anchors to a
 *            position, never an offset (a post added mid-scroll shifts nothing
 *            already read; a garbage cursor reads from the top)
 *   friends  confirmed friends' public posts, ends at 200; `muted` names the
 *            friends whose page is off (observable on their wall anyway)
 *   ring     the room, ends at 200, never a cursor
 *   archive  the author's shelf: archived posts and lapsed room posts the sweep
 *            has not reached yet; no reactions
 * Every feed says `me_page_off`, and carries the palette. A post whose author
 * blocks the viewer shows every switch shut (stamps_off, comments_off), as the
 * wall does: what a stamp or comment from them would be answered anyway.
 *
 * P6: Friends also reads REMOTE friends' walls (lib/walls.js: what their server
 * delivered, and the one outbox read at befriending). A remote card is marked
 * `origin: 'remote'`; its text is this server's own rendering of a Ring post's
 * markdown, or the node tree (lib/remote-html.js) of anyone else's, never their
 * HTML; its images are the media cache's copies (`/media/<id>/web`, members
 * only). Its stamps and comments are the VIEWER'S OWN (lib/sent.js): what other
 * people left lives on the post's own server. A blocked domain's walls never
 * show (BLOCKED_DOMAINS).
 */
const clock = require('./clock');
const { STAMP_STYLES } = require('./palette');
const { shortDisplayName, blocksHandle } = require('./ring');
const { isMember } = require('./rings');
const { ringPostLive, ringPostExpiresAt, isRoomAudience } = require('./ring-reset');
const urls = require('./urls');
const { renderParts } = require('./remote-note');

const FEED_PAGE = 20;
const FEED_MAX = 200;

const newestFirst = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
const feedable = (p) => !!p.created_at && p.kind !== 'divider';

const encodeCursor = (p) => Buffer.from(JSON.stringify([p.created_at, p.id, p.author.handle])).toString('base64url');
function decodeCursor(s) {
  try {
    const [t, id, name] = JSON.parse(Buffer.from(String(s || ''), 'base64url').toString('utf8'));
    return typeof t === 'string' && typeof id === 'string' ? { t, id, name: String(name || '') } : null;
  } catch { return null; }
}

function createFeeds({ members, pages, projection, reactions, follows, ringStore }) {
  let remote = null;   // P6: { walls, describe(handle), sent, switchesOf(handle), blocked(host) }; P7: copiesOf(ring)
  const authorView = (handle, origin) => ({
    handle, name: shortDisplayName(members.get(handle)?.display_name || handle) || handle,
    url: urls.pageUrl(origin, handle), host: urls.hostOf(origin),
  });
  const mePageOff = (me) => pages.settings(me).enabled !== true;
  const shutFor = (handle, viewer) => !!viewer && viewer !== handle && blocksHandle(pages.settings(handle), viewer);
  const SHUT = { stamps_off: true, comments_off: true };
  const publicPostsOf = (handle, origin, viewer) => {
    const view = projection.get(handle, origin);
    if (!view) return null;
    const author = authorView(handle, origin);
    const shut = shutFor(handle, viewer) ? SHUT : null;
    return view.posts.filter(feedable).map((p) => ({ ...p, author, ...shut }));
  };

  function square({ viewer, cursor, origin }) {
    const posts = [];
    for (const m of members.all()) {
      if (m.status !== 'active') continue;
      posts.push(...(publicPostsOf(m.slug, origin, viewer) || []));
    }
    posts.sort(newestFirst);
    const cur = decodeCursor(cursor);
    let start = 0;
    if (cur) {
      const i = posts.findIndex((p) => p.created_at === cur.t && p.id === cur.id && (!cur.name || p.author.handle === cur.name));
      start = i >= 0 ? i + 1 : posts.findIndex((p) => p.created_at < cur.t);
      if (start < 0) start = posts.length;
    }
    const page = posts.slice(start, start + FEED_PAGE);
    const ends = start + page.length >= posts.length;
    return { posts: page, ends, next_cursor: !ends && page.length ? encodeCursor(page.at(-1)) : null, palette: STAMP_STYLES, me_page_off: mePageOff(viewer) };
  }

  /* A remote post as a card (P6): a wall entry, or a looked-up post. */
  function remoteCard(e, handle, viewer, origin, mine = remote.sent.load(viewer)) {
    const who = remote.describe(handle);
    const author = { handle, name: who.name, url: who.url, host: who.host };
    const sw = remote.switchesOf(handle) || {};
    const me = authorView(viewer, origin);
    const v = renderParts(e);
    const images = e.attachments.filter((a) => a.kind === 'image' && a.media);
    const kind = images.length ? 'image' : (v.ring_kind === 'link' || v.ring_kind === 'embed') ? v.ring_kind : (v.title ? 'link' : 'note');
    const card = {
      id: e.id, kind, created_at: e.published || e.at, audience: 'public', url: e.url, origin: 'remote', author,
      ...(e.updated ? { updated_at: e.updated } : {}),
      ...(e.sensitive ? { cw: e.summary || '…' } : {}),
      ...v,
      media: images.map((a) => ({ url: `/media/${a.media}/web`, thumb_url: `/media/${a.media}/thumb`, alt: a.alt, ...(a.width ? { width: a.width, height: a.height } : {}) })),
      // Video, audio, links, and an image not cached (a lookup's): a link to the source.
      links: e.attachments.filter((a) => !(a.kind === 'image' && a.media)).map((a) => ({ kind: a.kind, url: a.url, alt: a.alt })),
      stamps: mine.filter((r) => r.kind === 'stamp' && r.object === e.id).map((r) => ({ id: r.id, kaomoji: r.face, at: r.at, author: me })),
      comments: mine.filter((r) => r.kind === 'comment' && r.object === e.id).map((r) => ({ id: r.id, body: r.body, at: r.at, author: me })),
      stamps_off: sw.stamps_off === true,
      comments_off: sw.comments_off === true,
    };
    if (images[0]) Object.assign(card, { image_url: card.media[0].url, thumb_url: card.media[0].thumb_url, alt: images[0].alt, ...(images[0].width ? { width: images[0].width, height: images[0].height } : {}) });
    if (v.title && !card.label) { card.label = v.title; card.href = e.url; }
    return card;
  }

  /* A remote friend's wall entries as cards (P6). */
  function remotePostsOf(handle, origin, viewer) {
    if (!remote) return [];
    const who = remote.describe(handle);
    if (who.gone || remote.blocked(who.host) || remote.handleBlocked?.(handle)) return [];
    const mine = remote.sent.load(viewer);
    return remote.walls.list(handle).map((e) => remoteCard(e, handle, viewer, origin, mine)).filter((p) => p.created_at);
  }

  function friends({ viewer, origin }) {
    const posts = [];
    const muted = [];
    for (const h of follows.friendHandles(viewer)) {
      if (h.includes('@')) { posts.push(...remotePostsOf(h, origin, viewer)); continue; }
      const mine = members.get(h) ? publicPostsOf(h, origin, viewer) : null;
      if (mine) posts.push(...mine);
      else if (members.get(h)) muted.push({ ...authorView(h, origin), reason: 'page_off' });
    }
    posts.sort(newestFirst);
    return { posts: posts.slice(0, FEED_MAX), ends: true, muted, palette: STAMP_STYLES, me_page_off: mePageOff(viewer) };
  }

  function ring({ ring: r, viewer, origin }) {
    const nowMs = clock.now();
    const posts = [];
    for (const m of r.members) {
      if (members.get(m.handle)?.status !== 'active') continue;
      const store = pages.load(m.handle);
      const room = store.posts.filter((p) => p.audience === r.id && ringPostLive(p, nowMs) && feedable(p));
      if (!room.length) continue;
      const author = authorView(m.handle, origin);
      const deco = reactions.decorate(m.handle, store, room.map((p) => p.id), reactions.authorResolver(origin));
      const shut = shutFor(m.handle, viewer);
      for (const p of room) {
        const v = projection.viewOf(p, origin, m.handle);
        if (!v) continue;
        posts.push({
          ...v, audience: r.id, expires_at: new Date(ringPostExpiresAt(p)).toISOString(), author,
          stamps: deco.get(p.id).stamps, comments: deco.get(p.id).comments,
          stamps_off: shut || store.stamps_off === true || p.stamps_off === true,
          comments_off: shut || store.comments_off === true || p.comments_off === true,
        });
      }
    }
    // P7: the posts of members on OTHER servers, kept here as copies
    // (lib/rooms.js), each read until its own expiry.
    if (remote?.copiesOf) {
      const authorOf = reactions.authorResolver(origin);
      for (const c of remote.copiesOf(r, nowMs)) posts.push(copyCard(c, r, authorOf));
    }
    posts.sort(newestFirst);
    return { posts: posts.slice(0, FEED_MAX), ends: true, ring: { id: r.id, name: r.name }, palette: STAMP_STYLES, me_page_off: mePageOff(viewer) };
  }

  /* A copy of another server's room post as a card (P7): rendered as a remote
   * card is (this server's own renderer for a Ring post's markdown), its
   * images the media cache's room copies, its stamps and comments the ring's
   * (recorded on the copy). */
  function copyCard(c, r, authorOf) {
    const who = authorOf(c.author);
    const v = renderParts(c);
    const images = (c.attachments || []).filter((a) => a.kind === 'image' && a.media);
    const kind = images.length ? 'image' : (v.ring_kind === 'link' || v.ring_kind === 'embed') ? v.ring_kind : 'note';
    const card = {
      id: c.id, kind, created_at: c.published || c.at, audience: r.id, url: c.url, origin: 'remote', expires_at: c.expires,
      author: { handle: who.handle, name: who.name, url: who.url, host: who.host },
      ...(c.updated ? { updated_at: c.updated } : {}),
      ...(c.sensitive ? { cw: c.summary || '…' } : {}),
      ...v,
      media: images.map((a) => ({ url: `/media/${a.media}/web`, thumb_url: `/media/${a.media}/thumb`, alt: a.alt, ...(a.width ? { width: a.width, height: a.height } : {}) })),
      links: (c.attachments || []).filter((a) => !(a.kind === 'image' && a.media)).map((a) => ({ kind: a.kind, url: a.url, alt: a.alt })),
      stamps: c.stamps.map((x) => { const a = authorOf(x.author); return { id: x.id, kaomoji: x.face, ...(x.custom ? { custom: true } : {}), at: x.at, author: { handle: a.handle, name: a.name, url: a.url, host: a.host } }; }),
      comments: c.comments.map((x) => { const a = authorOf(x.author); return { id: x.id, body: x.body, at: x.at, author: { handle: a.handle, name: a.name, url: a.url, host: a.host } }; }),
      stamps_off: false,
      comments_off: false,
    };
    if (images[0]) Object.assign(card, { image_url: card.media[0].url, thumb_url: card.media[0].thumb_url, alt: images[0].alt, ...(images[0].width ? { width: images[0].width, height: images[0].height } : {}) });
    return card;
  }

  function archive({ viewer, origin }) {
    const nowMs = clock.now();
    const rings = new Map(ringStore.load().filter((r) => isMember(r, viewer)).map((r) => [r.id, r.name]));
    const author = authorView(viewer, origin);
    const posts = [];
    for (const p of pages.load(viewer).posts) {
      const lapsed = isRoomAudience(p.audience) && !ringPostLive(p, nowMs);
      if (p.audience !== 'archive' && !lapsed) continue;
      const v = projection.viewOf(p, origin, viewer);
      if (!v) continue;
      const from = lapsed ? p.audience : (p.archived_from || '');
      posts.push({
        ...v, audience: 'archive', author, stamps: [], comments: [], stamps_off: true, comments_off: true,
        archived_from: from, archived_from_name: rings.get(from) || '',
        archived_at: lapsed ? new Date(ringPostExpiresAt(p) || nowMs).toISOString() : (p.archived_at || ''),
      });
    }
    posts.sort(newestFirst);
    return { posts, ends: true, palette: STAMP_STYLES, me_page_off: mePageOff(viewer) };
  }

  return { square, friends, ring, archive, remoteCard: (...a) => (remote ? remoteCard(...a) : null), bindRemote: (r) => { remote = r; } };
}

module.exports = { createFeeds, encodeCursor, decodeCursor, FEED_PAGE, FEED_MAX };
