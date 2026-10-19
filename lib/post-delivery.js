'use strict';
/* ── What a post's own changes send (spec 4.4, 4.5, 4.9) ──────────────────────
 * THE one place routes/posts.js and the sweep turn a change to a post into its
 * activity and its audience:
 *   create   Create{Note}: Public to the followers (only while the page is ON:
 *            "page off: nowhere new"), a room post to its ring's Group
 *   edit     Update{Note} to whom the Create reached, when what federates as the
 *            Note changed (note, cw, kaomoji, media); a pin or unpin is Add or
 *            Remove on `featured` to the followers instead (spec 4.9)
 *   delete   Delete{Tombstone} to that audience plus everyone who reacted, sent
 *            even with the page off when the post was ever SHOWN (public on an
 *            enabled page, lib/page-store.js): copies already delivered or read
 *            must be recalled. A post written and deleted while the page was
 *            off was never anyone's: no Delete (N10)
 *   keep     a live room post: Update{Note} re-addressed to Public, to the Group;
 *            then Create to the followers, who never had it. From the archive:
 *            only the Create
 *   reset    the sweep's Delete through the Group at expiry
 * Archive posts and dividers never become an activity. P2 delivers in-process
 * (local followers read the author live and need no copy); P5 turns the remote
 * followers into jobs at lib/outbox.js.
 */
const clock = require('./clock');
const A = require('./activities');
const { ringPostLive, isRoomAudience } = require('./ring-reset');
const urls = require('./urls');

function createPostDelivery({ pages, images, ringStore, outbox, remoteId = () => '' }) {
  /* A ring hosted elsewhere (P7) is addressed by its Group's `ap_id`. */
  const groupOf = (ringId) => ringStore.get(ringId)?.ap_id || '';
  const ctxOf = (origin, name) => ({ origin, name, imageRow: images.row, groupOf });
  const followers = (origin, name) => [urls.collectionUrl(origin, name, 'followers')];
  const pageOn = (name) => pages.settings(name).enabled === true;
  /* Who a post's activities reach, or null when it reaches nobody now. */
  function audienceOf(post, origin, name, { evenOff = false } = {}) {
    if (post.audience === 'public') return evenOff || pageOn(name) ? followers(origin, name) : null;
    if (isRoomAudience(post.audience) && ringPostLive(post, clock.now()) && ringStore.get(post.audience)) return [groupOf(post.audience) || urls.groupUrl(origin, post.audience)];
    return null;
  }

  function created(post, origin, name) {
    const to = audienceOf(post, origin, name);
    if (to) outbox.emit(A.createPost(post, ctxOf(origin, name)), to, { origin });
  }

  function edited(prev, next, origin, name, { contentChanged }) {
    if (contentChanged) {
      const to = audienceOf(next, origin, name);
      if (to) outbox.emit(A.updatePost(next, ctxOf(origin, name)), to, { origin });
    }
    if (!!prev.pinned !== !!next.pinned && next.audience === 'public' && next.kind !== 'divider' && pageOn(name)) {
      outbox.emit(A.pinPost(next, { origin, name, pinned: !!next.pinned }), followers(origin, name), { origin });
    }
  }

  function deleted(post, origin, name, reactorHandles = []) {
    if (post.kind === 'divider' || post.audience === 'archive') return;
    const to = audienceOf(post, origin, name, { evenOff: post.shown === true }) || [];
    // A reactor elsewhere (P6) is its cached actor id: their server holds the stamp.
    // A room post's Delete goes to its Group only (P7): the Group passes it to
    // the ring's servers, and nothing about a room goes anywhere else.
    const reactors = (isRoomAudience(post.audience) ? [] : reactorHandles).filter((h) => h !== name).map((h) => (h.includes('@') ? remoteId(h) : urls.actorUrl(origin, h))).filter(Boolean);
    if (!to.length && !reactors.length) return;
    outbox.emit(A.deletePost(post, { origin, name, deleted: clock.iso(), groupOf }), [...to, ...reactors], { origin });
  }

  /* `prev` the post before Keep, `next` it addressed to Public. */
  function kept(prev, next, origin, name) {
    if (next.kind === 'divider') return;
    const ctx = ctxOf(origin, name);
    if (isRoomAudience(prev.audience) && ringPostLive(prev, clock.now()) && ringStore.get(prev.audience)) {
      const group = groupOf(prev.audience) || urls.groupUrl(origin, prev.audience);
      outbox.emit(A.updatePost({ ...prev, updated_at: clock.iso() }, { ...ctx, addressAs: 'public' }, { deliverTo: [group] }), [group], { origin });
    }
    if (pageOn(name)) outbox.emit(A.createPost(next, ctx), followers(origin, name), { origin });
  }

  /* The weekly reset: the room post leaves its room (spec 3.8, 4.7). */
  function reset(post, ringId, origin, name) {
    if (!ringStore.get(ringId) || post.kind === 'divider') return;
    const group = groupOf(ringId) || urls.groupUrl(origin, ringId);
    outbox.emit(A.deletePost({ ...post, audience: ringId }, { origin, name, deleted: clock.iso(), groupOf }), [group], { origin });
  }

  return { created, edited, deleted, kept, reset };
}

module.exports = { createPostDelivery };
