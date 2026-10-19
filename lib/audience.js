'use strict';
/* ── Who may see a post (spec 3.4, 3.6, 10.1, 10.6) ───────────────────────────
 * THE one answer to "may this viewer see this post of this owner?", for every
 * verb that hangs off seeing it (a stamp, a comment) and for the image gate's
 * ring branch. Reads are live: a page switch, a kick or a lapse shows at once.
 *
 *   public   the owner is an active member and their page is ON: anyone
 *   room     the ring exists here, the owner AND the viewer are members, and the
 *            post is inside its week (READ-TIME EXPIRY, lib/ring-reset.js: a lapsed
 *            room post is gone before the sweep runs): that ring's members only,
 *            page on or off (the one read grant, spec 3.6)
 *   archive  the author only
 * The owner always sees their own post. Nothing else widens this: no friend, no
 * follower and no ring-mate sees anything more (spec 3.5, 3.6).
 *
 * roomImageVisible(key, owner, viewer): the ring half of the walled-image rule
 * (spec 10.6): the viewer shares a ring with the owner and the key is on a live
 * post addressed to that ring. A kicked member loses it at once; so does
 * everyone, the moment the post lapses.
 */
const clock = require('./clock');
const { isMember } = require('./rings');
const { ringPostLive, isRoomAudience } = require('./ring-reset');
const { postImageKey } = require('./ring');

function createAudience({ members, pages, ringStore }) {
  const active = (name) => members.get(name)?.status === 'active';

  /* { post, store, ring|null, room } or null. `viewer` may be null (anonymous). */
  function seeing(owner, postId, viewer, nowMs = clock.now()) {
    if (!active(owner)) return null;
    const store = pages.load(owner);
    const post = store.posts.find((p) => p.id === postId);
    if (!post) return null;
    if (viewer && viewer === owner) {
      const ring = isRoomAudience(post.audience) && ringPostLive(post, nowMs) ? ringStore.get(post.audience) : null;
      return { post, store, ring, room: !!ring, own: true };
    }
    if (post.audience === 'public') return store.enabled === true ? { post, store, ring: null, room: false } : null;
    if (!viewer || !isRoomAudience(post.audience) || !ringPostLive(post, nowMs)) return null;
    const ring = ringStore.get(post.audience);
    if (!ring || !isMember(ring, owner) || !isMember(ring, viewer)) return null;
    return { post, store, ring, room: true };
  }

  function roomImageVisible(key, owner, viewer, nowMs = clock.now()) {
    if (!viewer || viewer === owner || !active(owner)) return false;
    const shared = new Set(ringStore.load().filter((r) => isMember(r, owner) && isMember(r, viewer)).map((r) => r.id));
    if (!shared.size) return false;
    return pages.load(owner).posts.some((p) => shared.has(p.audience) && ringPostLive(p, nowMs) && postImageKey(p) === key);
  }

  return { seeing, roomImageVisible };
}

module.exports = { createAudience };
