'use strict';
/* ── The member's Inbox (spec 11.1, 13.1) ─────────────────────────────────────
 * One read of what is waiting for a member:
 *   join_requests     on every ring they are in (counted), but a handle the
 *                     member blocks: their ask never shows here, in the dot or
 *                     in the ring view, as if it never came (spec 6.1)
 *   follow_requests   followers still pending (Befriend / Let follow / Decline),
 *                     here or (P5) on another server: `describe` names a remote
 *                     handle from the actor cache, with its host
 *   stamps, comments  received on their own posts, newest first, signed, with
 *                     `seen` (theirs alone); a blocked author's rows never show
 *   elsewhere         replies and mentions from outside that are not comments
 *                     (P6, lib/elsewhere.js): the owner's only, never the wall;
 *                     each with a PREVIEW of its node tree (never HTML; 2000
 *                     characters, `cut` and the source's url past it), the
 *                     author named from the actor cache, and the post it answers
 * `unseen` is the one number the app shows as a dot: unseen reactions and From
 * elsewhere rows, plus the requests waiting for an answer. Marking seen touches
 * reactions and From elsewhere; a request stays until it is answered.
 */
const { isMember, wasKicked } = require('./rings');
const { shortDisplayName, blocksHandle: blocksOwn } = require('./ring');
const urls = require('./urls');

const newest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/* P8: `serverBlocked(handle)` hides everything from a person or domain the admin
 * blocks server-wide, as a member's own block does (the purge removes the rows;
 * this holds for a row a damaged file kept); `notices` (lib/notices.js) are
 * what the server tells the member about their own things (a removed post). */
function createInbox({ members, pages, reactions, follows, ringStore, describe = null, elsewhere = null, serverBlocked = () => false, notices = null }) {
  const who = (handle, origin) => ({ handle, name: members.get(handle)?.display_name || handle, url: urls.pageUrl(origin, handle) });
  const whoFollows = (handle, origin) => (describe ? describe(handle, origin) : who(handle, origin));

  function gather(me, { away: withAway = true } = {}) {
    const settings = pages.settings(me);
    const blocksHandle = (st, h) => blocksOwn(st, h) || serverBlocked(h);
    const stamps = reactions.loadStamps(me).filter((s) => !blocksHandle(settings, s.author));
    const comments = reactions.loadComments(me).filter((c) => !blocksHandle(settings, c.author));
    const joins = [];
    for (const r of ringStore.load()) {
      if (!isMember(r, me)) continue;
      for (const q of r.requests) if (!blocksHandle(settings, q.handle)) joins.push({ ring: r, q });
    }
    const followReqs = follows.load(me).followers.filter((f) => f.state === 'pending' && !serverBlocked(f.handle));
    const away = elsewhere && withAway ? elsewhere.load(me).filter((r) => !blocksHandle(settings, r.author)) : [];
    const told = notices ? notices.load(me) : [];
    return { stamps, comments, joins, followReqs, away, told };
  }

  const count = (g) => g.stamps.filter((s) => !s.seen).length + g.comments.filter((c) => !c.seen).length + g.joins.length + g.followReqs.length + g.away.filter((r) => !r.seen).length + g.told.filter((n) => !n.seen).length;

  function view(me, origin) {
    const g = gather(me);
    const authorOf = reactions.authorResolver(origin);
    return {
      join_requests: g.joins.map(({ ring, q }) => {
        // P7: an asker on another server is named from the actor cache, with its host.
        const w = q.handle.includes('@') ? whoFollows(q.handle, origin) : who(q.handle, origin);
        return { ring: { id: ring.id, name: ring.name }, ...w, short_name: shortDisplayName(w.name || q.handle), asked_at: q.asked_at, ...(wasKicked(ring, q.handle) ? { kicked: true } : {}) };
      }),
      follow_requests: g.followReqs.map((f) => ({ ...whoFollows(f.handle, origin), at: f.at })),
      stamps: g.stamps.sort(newest).map((s) => ({ ...reactions.stampView(s, authorOf), post_id: s.post_id, seen: s.seen })),
      comments: g.comments.sort(newest).map((c) => ({ ...reactions.commentView(c, authorOf), post_id: c.post_id, seen: c.seen })),
      elsewhere: g.away.sort(newest).map((r) => ({
        id: r.id, kind: r.kind, author: whoFollows(r.author, origin), tree: r.tree, ...(r.cut ? { cut: true } : {}),
        summary: r.summary, url: r.url, at: r.at, published: r.published, seen: r.seen, ...(r.post_id ? { post_id: r.post_id } : {}),
      })),
      notices: [...g.told].reverse(),
      unseen: count(g),
    };
  }

  /* The dot (GET /api/me, every load): From elsewhere counted from its kept
   * per-author tally, never by reading its rows (F2). */
  function unseen(me) {
    const g = gather(me, { away: false });
    const settings = pages.settings(me);
    const away = elsewhere ? elsewhere.unseenCount(me, (author) => blocksOwn(settings, author) || serverBlocked(author)) : 0;
    return count(g) + away;
  }

  /* Mark every received stamp and comment seen. One tick; writes only on change. */
  function markSeen(me) {
    let n = 0;
    const s = reactions.loadStamps(me);
    for (const x of s) if (!x.seen) { x.seen = true; n++; }
    if (n) reactions.saveStamps(me, s);
    let m = 0;
    const c = reactions.loadComments(me);
    for (const x of c) if (!x.seen) { x.seen = true; m++; }
    if (m) reactions.saveComments(me, c);
    const k = elsewhere ? elsewhere.markSeen(me) : 0;
    const told = notices ? notices.markSeen(me) : 0;
    return n + m + k + told;
  }

  return { view, unseen, markSeen };
}

module.exports = { createInbox };
