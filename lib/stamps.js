'use strict';
/* ── Stamps: press, take back, moderate (spec 3.7, 4.8) ───────────────────────
 * Carried on activities: a press is a `Like` (to the post's author, or to the
 * ring's Group on a room post), taking it back an `Undo` of that Like, and the
 * POST'S OWN SERVER IS THE AUTHORITY: onLike applies the tiers, friendship, the
 * owner's switches and blocks, whoever sent it.
 *
 * The tiers:
 *   - any signed-in member presses a NICE face on a post they can see;
 *   - confirmed friends, and ring-mates on a room post, get the full palette;
 *   - a ring-mate may press a CUSTOM face (one line, 20 characters) on a room
 *     post only, decided by the STORED audience, never the client;
 *   - one face per (sender, post): the same face again toggles it off;
 *   - the owner outranks all of it: stamps off per page or post, remove any
 *     stamp, block a sender. A closed post and a block answer the SAME opaque
 *     403 (`stamps_closed`), so a block cannot be detected.
 * Inbound from other software (P6) maps instead of refusing: a face outside the
 * sender's tier lands as ♥ (spec 4.8). A Like carrying the Ring term (`ring.v`)
 * came from a Ring server, which checks its own sender first, so out of tier it
 * is refused, as the local routes need. The face is `ring.face`, else
 * `content`, else `_misskey_reaction` (a Misskey Like), compared after NFC
 * with U+FE0F removed; free text, a custom emoji shortcode and an `Emoji` tag
 * (whose image is never fetched) land as ♥. A remote sender is its handle
 * (`sender`, lib/app.js: a member here by name, else the actor cache's
 * handle); it may only stamp a post it can see (5.4), and only its own Undo
 * takes a stamp back.
 */
const clock = require('./clock');
const { blocksHandle } = require('./ring');
const { newStampId } = require('./ids');
const { FALLBACK_FACE } = require('./palette');
const { paletteFace, normalizeCustomFace, isNice } = require('./reactions');
const A = require('./activities');
const urls = require('./urls');

function createStamps({ members, pages, reactions, audience, follows, outbox, audit, sender = null }) {
  const nameOf = (url, origin) => {
    const l = urls.parseLocal(url, origin);
    return l?.kind === 'person' && members.get(l.name)?.status === 'active' ? l.name : '';
  };
  /* Who sent it: an active member here, or (P6) a remote handle. */
  const senderOf = (url, origin) => nameOf(url, origin) || (sender && !urls.parseLocal(url, origin) ? sender(url) : '');
  const stampsOpen = (seen) => (seen.store.enabled === true || seen.room) && seen.store.stamps_off !== true && seen.post.stamps_off !== true;
  /* A ring's Group: its own URL here, or (P7) the `ap_id` of a ring hosted elsewhere. */
  const groupOf = (ring, origin) => ring.ap_id || urls.groupUrl(origin, ring.id);
  const recipientOf = (seen, owner, origin) => (seen?.room ? groupOf(seen.ring, origin) : urls.actorUrl(origin, owner));
  /* On a room post of a ring hosted ELSEWHERE (P7), the post's own server (this
   * one) is the authority: it applies the act first, in-process, and only what
   * it applied goes on to the Group, which passes it to the other members'
   * servers. On a home ring the Group here does both (lib/groups.js). */
  function viaAuthority(seen, activity, owner, origin) {
    if (!seen?.room || seen.ring.home !== false) return null;
    const r = outbox.emit(activity, [urls.actorUrl(origin, owner)], { origin })[0]?.result || { status: 404, error: 'not_found' };
    if (r.status < 400 && r.action !== 'unchanged') outbox.emit(activity, [groupOf(seen.ring, origin)], { origin });
    return r;
  }
  const postUrlOf = (activityObject, origin) => {
    const l = urls.parseLocal(typeof activityObject === 'string' ? activityObject : activityObject?.id, origin);
    return l?.kind === 'post' ? l : null;
  };

  // ── the authority (lib/ap-inbound.js) ──

  function onLike(activity, { inbox, origin }) {
    const owner = inbox.name;
    const target = postUrlOf(activity.object, origin);
    const signer = senderOf(activity.actor, origin);
    if (!target || target.name !== owner || !signer) return { status: 404, error: 'not_found' };
    const seen = audience.seeing(owner, target.id, signer);
    if (!seen) return { status: 404, error: 'not_found' };
    if (seen.own) return { status: 400, error: 'own_post' };
    const fromRing = activity.ring?.v === 1;
    const pick = (...vals) => vals.find((v) => typeof v === 'string' && v) ?? '';
    const raw = pick(fromRing ? activity.ring.face : undefined, activity.content, activity._misskey_reaction);
    let face;
    let custom = false;
    if (fromRing && activity.ring.custom === true) {
      if (!seen.room) return { status: 403, error: 'custom_room_only' };
      face = normalizeCustomFace(raw);
      if (!face) return { status: 400, error: 'stamp_invalid' };
      custom = true;
    } else {
      face = paletteFace(raw);
      if (!face && fromRing) return { status: 400, error: 'stamp_invalid' };
      if (face && !isNice(face) && !seen.room && !follows.friends(owner, signer)) {
        if (fromRing) return { status: 403, error: 'friends_only' };
        face = '';
      }
      if (!face) face = FALLBACK_FACE;   // never lost, never widened (spec 4.8)
    }
    if (!stampsOpen(seen) || blocksHandle(pages.settings(owner), signer)) return { status: 403, error: 'stamps_closed' };

    const rows = reactions.loadStamps(owner);
    const mine = rows.find((s) => s.author === signer && s.post_id === target.id);
    let action;
    if (mine) {
      if (mine.kaomoji === face && !!mine.custom === custom) return { status: 200, action: 'unchanged', id: mine.id };
      mine.kaomoji = face;
      if (custom) mine.custom = true; else delete mine.custom;
      mine.activity_id = String(activity.id || '');
      mine.at = clock.iso();
      mine.seen = false;
      action = 'changed';
    } else {
      rows.push({ id: newStampId(new Set(rows.map((s) => s.id))), post_id: target.id, author: signer, kaomoji: face, ...(custom ? { custom: true } : {}), activity_id: String(activity.id || ''), at: clock.iso(), seen: false });
      action = 'added';
    }
    reactions.saveStamps(owner, rows);
    audit(`stamp.${action}`, signer, { owner, post: target.id });
    return { status: 200, action, id: (mine || rows.at(-1)).id };
  }

  /* Undo of a Like: only by the Like's own actor (spec 16.3 fed-ownership). */
  function onUndoLike(activity, { inbox, origin }) {
    const owner = inbox.name;
    const inner = activity.object;
    const innerId = typeof inner === 'string' ? inner : inner?.id;
    if (!innerId) return { status: 400 };
    const rows = reactions.loadStamps(owner);
    const row = rows.find((s) => s.activity_id === innerId);
    if (!row) return { status: 404, error: 'not_found' };
    // Only the Like's own actor undoes it (5.4): the stored author, and the
    // embedded Like's actor when it names one.
    const who = senderOf(activity.actor, origin);
    if (!who || row.author !== who || (inner && typeof inner === 'object' && inner.actor !== undefined && inner.actor !== activity.actor)) return { status: 403, error: 'forbidden' };
    reactions.saveStamps(owner, rows.filter((s) => s !== row));
    audit('stamp.removed', row.author, { owner, post: row.post_id });
    return { status: 200, action: 'removed' };
  }

  // ── acts (the routes) ──

  /* Press `rawFace` on owner's post: add, change, or toggle off the same face. */
  function press({ me, owner, postId, rawFace, origin }) {
    const seen = audience.seeing(owner, postId, me);
    if (!seen) return { status: 404, error: 'not_found' };
    if (seen.own) return { status: 400, error: 'own_post' };
    let face = paletteFace(rawFace);
    let custom = false;
    if (!face) {
      face = normalizeCustomFace(rawFace);
      if (!face) return { status: 400, error: 'stamp_invalid' };
      custom = true;
      if (!seen.room) return { status: 403, error: 'custom_room_only' };
    } else if (!isNice(face) && !seen.room && !follows.friends(owner, me)) {
      return { status: 403, error: 'friends_only' };
    }
    const mine = reactions.loadStamps(owner).find((s) => s.author === me && s.post_id === postId);
    if (mine && mine.kaomoji === face && !!mine.custom === custom) return takeBack({ me, owner, postId, stampId: mine.id, origin });
    const group = seen.room ? groupOf(seen.ring, origin) : null;
    const activity = A.like({
      origin, name: me, stampId: newStampId(), postUrl: urls.postUrl(origin, owner, postId),
      postAuthor: urls.actorUrl(origin, owner), face, custom, group,
    });
    return viaAuthority(seen, activity, owner, origin)
      || outbox.emit(activity, [group || urls.actorUrl(origin, owner)], { origin })[0]?.result || { status: 404, error: 'not_found' };
  }

  /* DELETE a stamp: its author takes it back (Undo); the owner removes it (no
   * activity, but a Remove through the Group on a live room post); anyone else
   * gets the opaque 404. */
  function takeBack({ me, owner, postId, stampId, origin }) {
    if (members.get(owner)?.status !== 'active') return { status: 404, error: 'not_found' };
    const row = reactions.loadStamps(owner).find((s) => s.id === stampId && s.post_id === postId);
    if (!row) return { status: 404, error: 'not_found' };
    const seen = audience.seeing(owner, postId, me);
    if (row.author === me) {
      const to = recipientOf(seen, owner, origin);
      const like = { id: row.activity_id, type: 'Like', actor: urls.actorUrl(origin, me), object: urls.postUrl(origin, owner, postId), to: [to] };
      if (seen?.room) like.audience = to;
      const undo = A.undo({ origin, name: me, activity: like });
      const r = viaAuthority(seen, undo, owner, origin) || outbox.emit(undo, [to], { origin })[0]?.result;
      if (r && r.status < 400) return { status: 200, action: 'removed' };
      // Out of the room now (kicked, or it lapsed): the authority is the owner's server.
      if (seen?.room) return { status: 404, error: 'not_found' };
      return r || { status: 404, error: 'not_found' };
    }
    if (owner !== me) return { status: 404, error: 'not_found' };
    const rows = reactions.loadStamps(owner);
    reactions.saveStamps(owner, rows.filter((s) => s.id !== row.id));
    audit('stamp.owner_removed', me, { post: postId, author: row.author });
    if (seen?.room) {
      const group = groupOf(seen.ring, origin);
      outbox.emit(A.removeReaction({ origin, name: me, reactionId: row.activity_id, postUrl: urls.postUrl(origin, owner, postId), group }), [group], { origin });
    }
    return { status: 200, action: 'removed' };
  }

  /* The post's stamps as its viewer sees them (blocked authors out). */
  function viewsFor(owner, postId, origin) {
    const authorOf = reactions.authorResolver(origin);
    return reactions.decorate(owner, pages.settings(owner), [postId], authorOf).get(postId).stamps;
  }

  return {
    press, takeBack, viewsFor,
    handlers: { Like: onLike, EmojiReact: onLike, 'Undo:Like': onUndoLike, 'Undo:EmojiReact': onUndoLike },
  };
}

module.exports = { createStamps };
