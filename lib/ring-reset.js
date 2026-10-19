'use strict';
/* ── The ring reset: a room post clears a week after it was posted (spec 3.8) ──
 * Always on. The post carries the clock, not the room: every room post lapses
 * at created_at + 7 days.
 *
 * The sweep is an ARCHIVE, never a delete: a room post lives in its AUTHOR's own
 * log.json, so aging out re-addresses it to the author-only 'archive' audience
 * (`archived_from` the room, `archived_at` THE EXPIRY INSTANT, not "now") and the
 * stamps and comments on it are deleted. Nothing else moves: membership, the join
 * link, public posts and younger room posts are untouched. A post addressed to a
 * ring that was since deleted ages the same way, onto its author's shelf.
 *
 * READ-TIME EXPIRY (spec 3.8): every read treats a lapsed room post as gone
 * (ringPostLive), so nothing shows in the hour before the sweep runs.
 *
 * Restart-safe: a lapse is a fixed instant, so a late sweep archives late, never
 * early, and a second sweep finds nothing. Reactions live per
 * owner (`log-stamps.json`, `log-comments.json`), and each owner's reactions are
 * cleared for EVERY post of theirs that is archived or gone, not only the ones this
 * run archived: a crash between the post write and the reaction write re-converges
 * on the next run instead of leaving rows behind for good.
 *
 * Pure: the IO is injected (lib/app.js wires the stores), so the destructive path
 * is testable without a server. `onArchived(owner, post, ringId)` lets the caller
 * send the reset's `Delete` through the Group (spec 4.7); it runs after the
 * owner's writes, never between a load and its save.
 */

const DAY_MS = 24 * 3600 * 1000;
const RING_POST_TTL_MS = 7 * DAY_MS;

/* 'public' and 'archive' are the only non-room audiences; anything else stored
 * is a ring id (lib/ring.js holds the shape). */
function isRoomAudience(audience) {
  return typeof audience === 'string' && audience !== '' && audience !== 'public' && audience !== 'archive';
}

/* created_at + 7 days; a room post with no readable created_at is already lapsed
 * (archive is the safe direction). */
function ringPostExpiresAt(post) {
  const born = Date.parse(post?.created_at || '');
  return Number.isFinite(born) ? born + RING_POST_TTL_MS : 0;
}

/* Is this room post still in its week at `nowMs`? */
const ringPostLive = (post, nowMs) => isRoomAudience(post?.audience) && ringPostExpiresAt(post) > nowMs;

/* One sweep. Deps:
 *   nowMs, rings (names for the audit line; not mutated)
 *   memberNames      every member to scan: an ex-member's room posts still carry
 *                    the ring's address
 *   loadStore(n) / saveStore(n, store)
 *   loadStamps(n) / saveStamps(n, rows), loadComments(n) / saveComments(n, rows)
 *   audit(event, actor, details), onArchived(owner, post, ringId), log(line)
 * An owner whose files cannot be read is skipped and logged, never treated as
 * empty. Returns { changed, resets: [{ ring, name, posts, stamps, comments }] }. */
function sweepRingResets({ nowMs, rings, memberNames, loadStore, saveStore, loadStamps, saveStamps,
  loadComments, saveComments, audit, onArchived, log = () => {} }) {
  const nameOf = new Map((rings || []).map((r) => [r.id, r.name]));
  const counts = new Map();
  const bump = (rid, key, n = 1) => {
    if (!counts.has(rid)) counts.set(rid, { posts: 0, stamps: 0, comments: 0 });
    counts.get(rid)[key] += n;
  };
  const archivedNow = [];
  for (const owner of memberNames) {
    try {
      const store = loadStore(owner);
      const fromRoom = new Map();   // post id -> the room it lapsed out of, this run
      for (const p of store.posts) {
        if (!isRoomAudience(p.audience)) continue;
        const lapse = ringPostExpiresAt(p);
        if (lapse > nowMs) continue;
        fromRoom.set(p.id, p.audience);
        bump(p.audience, 'posts');
        p.archived_from = p.audience;
        p.archived_at = new Date(lapse || nowMs).toISOString();
        p.audience = 'archive';
        archivedNow.push({ owner, post: { ...p }, ringId: p.archived_from });
      }
      if (fromRoom.size) saveStore(owner, store);

      // Reactions live only on a public post or a live room post.
      const keep = new Set(store.posts.filter((p) => p.audience === 'public' || (isRoomAudience(p.audience) && ringPostExpiresAt(p) > nowMs)).map((p) => p.id));
      const stamps = loadStamps(owner);
      const keptS = stamps.filter((s) => keep.has(s.post_id));
      if (keptS.length !== stamps.length) {
        for (const s of stamps) if (!keep.has(s.post_id) && fromRoom.has(s.post_id)) bump(fromRoom.get(s.post_id), 'stamps');
        saveStamps(owner, keptS);
      }
      const comments = loadComments(owner);
      const keptC = comments.filter((c) => keep.has(c.post_id));
      if (keptC.length !== comments.length) {
        for (const c of comments) if (!keep.has(c.post_id) && fromRoom.has(c.post_id)) bump(fromRoom.get(c.post_id), 'comments');
        saveComments(owner, keptC);
      }
    } catch (e) {
      log(`[ring-reset] skipped ${owner}: ${e.message}`);
    }
  }
  for (const a of archivedNow) {
    try { onArchived?.(a.owner, a.post, a.ringId); } catch (e) { log(`[ring-reset] delete for ${a.post.id} failed: ${e.message}`); }
  }
  const resets = [];
  for (const [rid, c] of counts) {
    resets.push({ ring: rid, name: nameOf.get(rid), ...c });
    audit?.('ring.reset', 'system', { ring: rid, name: nameOf.get(rid), posts: c.posts, stamps: c.stamps, comments: c.comments });
  }
  return { changed: archivedNow.length > 0, resets };
}

module.exports = { RING_POST_TTL_MS, isRoomAudience, ringPostExpiresAt, ringPostLive, sweepRingResets };
