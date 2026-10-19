'use strict';
/* ── Comments: write, take back, moderate (spec 3.7, 4.8) ─────────────────────
 * Carried on activities: a comment is a `Create{Note}` in reply to the post (to
 * its author, or to the ring's Group on a room post), taking it back a `Delete`
 * of that Note. The POST'S OWN SERVER IS THE AUTHORITY: onCreateNote applies the
 * rules whoever sent it.
 *
 * The rules: CONFIRMED FRIENDS ONLY, on a post they can see;
 * plain text, whitespace collapsed, 280 characters (a decision, not a
 * placeholder); comments off per page or post, and a block, answer the SAME
 * opaque 403 (`comments_closed`); the author takes their own back, the owner
 * removes any (locally: the reply stays on its own server), anyone else gets the
 * opaque 404. A ring-mate who is not a friend cannot comment: membership implies
 * nothing pairwise.
 *
 * A Ring reader settles the text from the Note's `source` (plain text), never
 * from another server's HTML. A reply from a non-friend elsewhere lands in the
 * owner's From elsewhere (P6), never on the wall; locally it is refused.
 *
 * P6, a reply from ANOTHER server (spec 4.8, 4.10): only a public or unlisted
 * Note by its own actor (5.4: `attributedTo` is the signer, the Note on its
 * host), on a post the sender can see. From a confirmed friend, comments open,
 * not blocked: a comment row whose text is the Ring sender's plain `source`, or
 * for other software the node tree of `content` (lib/remote-html.js) flattened
 * to plain text, a leading mention of the owner removed, cut at 280 with
 * `truncated: true` and `source_url` (the card links "more at source"). From
 * anyone else (not blocked): From elsewhere (lib/elsewhere.js), never the wall.
 * A public Note that only MENTIONS a member lands there too. A followers-only
 * or direct reply is dropped: a private reply must never become a public
 * comment. A Delete by its author removes the row (the stored author must be
 * the signer); the owner removes locally, with no activity.
 */
const clock = require('./clock');
const { blocksHandle } = require('./ring');
const { newCommentId } = require('./ids');
const { normalizeCommentBody, COMMENT_MAX } = require('./reactions');
const { settleCached, plainTextOf } = require('./remote-note');
const A = require('./activities');
const urls = require('./urls');

function createComments({ members, pages, reactions, audience, follows, outbox, audit, sender = null, elsewhere = null, named = () => {} }) {
  const nameOf = (url, origin) => {
    const l = urls.parseLocal(url, origin);
    return l?.kind === 'person' && members.get(l.name)?.status === 'active' ? l.name : '';
  };
  const senderOf = (url, origin) => nameOf(url, origin) || (sender && !urls.parseLocal(url, origin) ? sender(url) : '');
  const commentsOpen = (seen) => (seen.store.enabled === true || seen.room) && seen.store.comments_off !== true && seen.post.comments_off !== true;
  const groupOf = (ring, origin) => ring.ap_id || urls.groupUrl(origin, ring.id);
  /* A room post of a ring hosted ELSEWHERE (P7): this server is the authority;
   * it applies first and only what it applied goes on to the Group. */
  function viaAuthority(seen, activity, owner, origin) {
    if (!seen?.room || seen.ring.home !== false) return null;
    const r = outbox.emit(activity, [urls.actorUrl(origin, owner)], { origin })[0]?.result || { status: 404, error: 'not_found' };
    if (r.status < 400 && r.action !== 'unchanged') outbox.emit(activity, [groupOf(seen.ring, origin)], { origin });
    return r;
  }

  // ── the authority (lib/ap-inbound.js) ──

  /* A comment's text from another server: a Ring sender's plain source, else
   * the tree flattened; a leading mention of the owner out; 280 with the cut. */
  function remoteBody(obj, owner, fromRing, rawSource) {
    let text = fromRing && typeof rawSource === 'string' ? rawSource : plainTextOf(obj);
    text = text.replace(new RegExp(`^\\s*@${owner}(?:@[^\\s]+)?[\\s,:]*`, 'i'), '');
    const flat = normalizeCommentBody(text.slice(0, 20_000).replace(/\n+/g, ' '));
    const all = text.replace(/\s+/g, ' ').trim();
    return { body: flat, truncated: Array.from(all).length > COMMENT_MAX || obj.cut === true };
  }

  /* A Note from ANOTHER server for `owner` (P6, spec 4.8, 4.10). */
  function onRemoteNote(activity, { owner, origin, from }) {
    const raw = activity.object;
    const obj = settleCached(raw, { actor: activity.actor });   // once per activity, however many members it names (F1)
    if (obj.refused || obj.type !== 'Note') return { status: 202, dropped: true };
    if (obj.visibility === 'private') {
      // Never a public comment; P7: unless it is a ROOM reply, addressed to the
      // ring of the room post it answers (it shows in that room only).
      const t = obj.in_reply_to ? urls.parseLocal(obj.in_reply_to, origin) : null;
      const room = t?.kind === 'post' && t.name === owner ? audience.seeing(owner, t.id, from) : null;
      if (!room?.room || obj.audience !== groupOf(room.ring, origin)) return { status: 202, dropped: true };
    }
    if (blocksHandle(pages.settings(owner), from)) return { status: 202, dropped: true };
    const target = obj.in_reply_to ? urls.parseLocal(obj.in_reply_to, origin) : null;
    const reply = target?.kind === 'post' && target.name === owner;
    if (!reply) {
      const me = urls.actorUrl(origin, owner);
      if (!obj.mentions.includes(me) || !elsewhere) return { status: 202, dropped: true };
      const r = elsewhere.add(owner, { kind: 'mention', author: from, obj });
      named(from);
      return { status: 202, elsewhere: r };
    }
    const seen = audience.seeing(owner, target.id, from);
    if (!seen) return { status: 404, error: 'not_found' };
    const friend = follows.friends(owner, from);
    // P7: a reply on a ROOM post is the room's: a comment, or refused (and
    // withdrawn through the Group); never From elsewhere, which is the owner's
    // view of the open web.
    if (seen.room && !(friend && commentsOpen(seen) && !blocksHandle(pages.settings(owner), from))) return { status: 403, error: friend ? 'comments_closed' : 'comments_friends_only' };
    if (friend && commentsOpen(seen)) {
      const rows = reactions.loadComments(owner);
      if (rows.some((c) => c.object_id === obj.id)) return { status: 200, action: 'unchanged' };
      const fromRing = raw.ring?.v === 1 && raw.source?.mediaType === 'text/plain';
      const { body, truncated } = remoteBody(obj, owner, fromRing, raw.source?.content);
      if (!body) return { status: 400, error: 'comment_empty' };
      const row = { id: newCommentId(new Set(rows.map((c) => c.id))), post_id: target.id, author: from, body, object_id: obj.id, at: clock.iso(), seen: false };
      if (truncated) { row.truncated = true; row.source_url = obj.url; }
      rows.push(row);
      reactions.saveComments(owner, rows);
      named(from);
      audit('comment.added', from, { owner, post: target.id, chars: body.length });
      return { status: 201, id: row.id };
    }
    if (!elsewhere) return { status: 202, dropped: true };
    const r = elsewhere.add(owner, { kind: 'reply', author: from, obj, postId: target.id });
    named(from);
    return { status: 202, elsewhere: r };
  }

  function onCreateNote(activity, { inbox, origin }) {
    const owner = inbox.name;
    const o = activity.object && typeof activity.object === 'object' ? activity.object : null;
    if (o?.type !== 'Note') return { status: 202, dropped: true };
    if (sender && !urls.parseLocal(activity.actor, origin)) {
      const from = senderOf(activity.actor, origin);
      if (!from || members.get(owner)?.status !== 'active') return { status: 202, dropped: true };
      return onRemoteNote(activity, { owner, origin, from });
    }
    if (!o.inReplyTo) return { status: 202, dropped: true };
    const target = urls.parseLocal(o.inReplyTo, origin);
    if (target?.kind !== 'post' || target.name !== owner) return { status: 202, dropped: true };
    const signer = nameOf(activity.actor, origin);
    if (!signer || o.attributedTo !== activity.actor) return { status: 403, error: 'forbidden' };
    const seen = audience.seeing(owner, target.id, signer);
    if (!seen) return { status: 404, error: 'not_found' };
    if (seen.own) return { status: 400, error: 'own_post' };
    if (!follows.friends(owner, signer)) return { status: 403, error: 'comments_friends_only' };
    if (!commentsOpen(seen) || blocksHandle(pages.settings(owner), signer)) return { status: 403, error: 'comments_closed' };
    const body = normalizeCommentBody(typeof o.source?.content === 'string' ? o.source.content : '');
    if (!body) return { status: 400, error: 'comment_empty' };
    const rows = reactions.loadComments(owner);
    if (rows.some((c) => c.object_id === o.id)) return { status: 200, action: 'unchanged' };   // delivered twice: once
    const row = { id: newCommentId(new Set(rows.map((c) => c.id))), post_id: target.id, author: signer, body, object_id: String(o.id || ''), at: clock.iso(), seen: false };
    rows.push(row);
    reactions.saveComments(owner, rows);
    audit('comment.added', signer, { owner, post: target.id, chars: body.length });
    return { status: 201, id: row.id };
  }

  /* Delete of a comment Note: only by its author. A Delete of anything else
   * (a post's own Delete reaching a member here) changes nothing in P2. */
  function onDeleteNote(activity, { inbox, origin }) {
    const owner = inbox.name;
    const id = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (typeof id !== 'string' || !id) return { status: 400 };
    const rows = reactions.loadComments(owner);
    const row = rows.find((c) => c.object_id === id);
    if (!row) return { status: 202 };
    // Only its author (5.4): the stored author is the signer, and the object is
    // on the signer's host (a local comment's URL is under its author's actor).
    const who = senderOf(activity.actor, origin);
    const local = urls.parseLocal(id, origin);
    const onHost = local ? id.startsWith(`${activity.actor}/comments/`) : urls.hostOf(id) === urls.hostOf(activity.actor);
    if (!activity.actor || !who || row.author !== who || !onHost) return { status: 403, error: 'forbidden' };
    reactions.saveComments(owner, rows.filter((c) => c !== row));
    audit('comment.removed', row.author, { owner, post: row.post_id });
    return { status: 200, action: 'removed' };
  }

  /* P6: an Update or Delete by a REMOTE author of a comment they left on any
   * member's post (lib/remote-in.js asks the members lib/holders.js names;
   * each file is its own tick). Only rows whose stored author is `from` move
   * (5.4). F5: the comment's own rules hold for an edit as for the Create: an
   * Update that is not public or unlisted REMOVES the comment (a private reply
   * never shows on a wall); one from someone who is no longer a friend, a
   * blocked one, or on a post whose comments are now off (or that they can no
   * longer see) changes nothing. */
  function updateRemote(owner, from, obj, raw) {
    const rows = reactions.loadComments(owner);
    const row = rows.find((c) => c.object_id === obj.id && c.author === from);
    if (!row) return false;
    if (obj.visibility === 'private') {
      reactions.saveComments(owner, rows.filter((c) => c !== row));
      audit('comment.removed', from, { owner, post: row.post_id, why: 'made_private' });
      return true;
    }
    if (!follows.friends(owner, from) || blocksHandle(pages.settings(owner), from)) return false;
    const seen = audience.seeing(owner, row.post_id, from);
    if (!seen || !commentsOpen(seen)) return false;
    const fromRing = raw?.ring?.v === 1 && raw?.source?.mediaType === 'text/plain';
    const { body, truncated } = remoteBody(obj, owner, fromRing, raw?.source?.content);
    if (!body) return false;
    row.body = body;
    if (truncated) { row.truncated = true; row.source_url = obj.url; } else { delete row.truncated; delete row.source_url; }
    reactions.saveComments(owner, rows);
    return true;
  }
  function removeRemote(owner, from, objectId) {
    const rows = reactions.loadComments(owner);
    const next = rows.filter((c) => !(c.object_id === objectId && c.author === from));
    if (next.length === rows.length) return false;
    reactions.saveComments(owner, next);
    audit('comment.removed', from, { owner });
    return true;
  }

  // ── acts (the routes) ──

  function write({ me, owner, postId, body: raw, origin }) {
    const seen = audience.seeing(owner, postId, me);
    if (!seen) return { status: 404, error: 'not_found' };
    if (seen.own) return { status: 400, error: 'own_post' };
    if (!follows.friends(owner, me)) return { status: 403, error: 'comments_friends_only' };
    const body = normalizeCommentBody(raw);
    if (!body) return { status: 400, error: 'comment_empty' };
    const group = seen.room ? groupOf(seen.ring, origin) : null;
    const activity = A.createComment({
      origin, name: me, commentId: newCommentId(), postUrl: urls.postUrl(origin, owner, postId),
      postAuthor: urls.actorUrl(origin, owner), postAuthorHandle: owner, body, published: clock.iso(), group,
    });
    return viaAuthority(seen, activity, owner, origin)
      || outbox.emit(activity, [group || urls.actorUrl(origin, owner)], { origin })[0]?.result || { status: 404, error: 'not_found' };
  }

  function takeBack({ me, owner, postId, commentId, origin }) {
    if (members.get(owner)?.status !== 'active') return { status: 404, error: 'not_found' };
    const row = reactions.loadComments(owner).find((c) => c.id === commentId && c.post_id === postId);
    if (!row) return { status: 404, error: 'not_found' };
    const seen = audience.seeing(owner, postId, me);
    if (row.author === me) {
      const group = seen?.room ? groupOf(seen.ring, origin) : null;
      const to = group || urls.actorUrl(origin, owner);
      const activity = A.deleteComment({ origin, name: me, objectId: row.object_id, to: [to], audience: group, deleted: clock.iso() });
      const r = viaAuthority(seen, activity, owner, origin) || outbox.emit(activity, [to], { origin })[0]?.result;
      return r && r.status < 400 ? { status: 200, action: 'removed' } : (r || { status: 404, error: 'not_found' });
    }
    if (owner !== me) return { status: 404, error: 'not_found' };
    reactions.saveComments(owner, reactions.loadComments(owner).filter((c) => c.id !== row.id));
    audit('comment.owner_removed', me, { post: postId, author: row.author });
    if (seen?.room) {
      const group = groupOf(seen.ring, origin);
      outbox.emit(A.removeReaction({ origin, name: me, reactionId: row.object_id, postUrl: urls.postUrl(origin, owner, postId), group }), [group], { origin });
    }
    return { status: 200, action: 'removed' };
  }

  function viewsFor(owner, postId, origin) {
    const authorOf = reactions.authorResolver(origin);
    return reactions.decorate(owner, pages.settings(owner), [postId], authorOf).get(postId).comments;
  }

  return {
    write, takeBack, viewsFor, updateRemote, removeRemote,
    handlers: { 'Create:Note': onCreateNote, 'Delete:Note': onDeleteNote },
  };
}

module.exports = { createComments };
