'use strict';
/* ── Follows, friends and followers (spec 3.5, 4.6) ───────────────────────────
 * Friendship (request, confirm, sever) on the edge ActivityPub has.
 * `members/<name>/follows.json`:
 *   { following: [{ handle, state: 'pending'|'accepted', follow_id, at, accepted_at }],
 *     followers: [same] }
 * FRIENDS ARE TWO ACCEPTED FOLLOWS, one each way: nothing else is stored, and both
 * rows sit in the member's own file, so friendHandles() reads one file.
 *
 * The rules:
 *   - request; ONLY the recipient confirms. Befriend sends Follow; confirm sends
 *     Accept and a Follow back. A CROSSING request confirms at once: a Follow from
 *     someone the member already follows, or has asked to, is accepted unasked.
 *   - either side severs: Undo of its own follow, Reject of theirs. A friend who
 *     unfollows has severed, so this side undoes its own follow too.
 *   - followers are one-way: Let follow (Accept), Decline or remove (Reject);
 *     `open_follows` accepts as follower unasked; friendship still needs the
 *     member's own follow back.
 *   - ZERO PERMISSION: friendship widens the stamp palette, opens comments on what
 *     the viewer could already see and fills the Friends feed. No read is ever
 *     friend- or follower-gated.
 *   - a blocked handle's Follow is DROPPED SILENTLY (spec 6.1): no row, no
 *     Reject, nothing in the blocker's inbox. On the asker's side it stays a
 *     pending request that is never answered, so the answer to a Follow is the
 *     same whether or not they are blocked (a Reject would tell them at once).
 *   - caps (file bounds, never shown): following 1000, ACCEPTED followers
 *     10 000, friends 500; past one a new follow is refused with Reject (a
 *     courtesy job: refused itself past the delivery queue's caps). PENDING
 *     requests have their own caps and never count toward the 10 000 (N7): at
 *     most 500, oldest out (the oldest request is forgotten, unanswered, as any
 *     unanswered request is), and at most 20 from one remote host (past that a
 *     new one from it is dropped silently, as a blocked handle's is).
 *   - a Follow from someone ALREADY accepted (a remote server re-sending it) is
 *     re-Accepted at most once an hour per follower (N2): the rest get the 202.
 *
 * P6, across servers: a member befriends a remote account (Mastodon included):
 * their Follow goes out, and the other side's Accept or Reject comes back
 * through the same handlers, only from the followee itself, about a Follow
 * this server sent (by the embedded Follow, or by its id alone: other
 * software sends either). An inbound `Block` of a member drops the edges both
 * ways and shows nothing. `onEdge(me, handle)` (lib/app.js) hears every
 * change to the rows naming a REMOTE handle, after the save: a friendship
 * formed reads their outbox once, one gone drops their wall when no member
 * here is still their friend.
 *
 * Acts (befriend, confirm, letFollow, decline, sever) are what the routes and the
 * purge call; each runs in ONE tick: write this side, then emit. The handlers
 * (Follow, Accept, Reject, Undo of a Follow) are the other side, applied by
 * lib/ap-inbound.js; between two members here both files change in that tick.
 * Rows are matched by handle: a follow_id is kept for the activity's shape.
 */
const clock = require('./clock');
const { readJSON, writeJSON } = require('./store');
const { isHandle } = require('./handles');
const { blocksHandle } = require('./ring');
const { MemberGone } = require('./page-store');
const A = require('./activities');
const urls = require('./urls');

const MAX_FOLLOWING = 1000;
const MAX_FOLLOWERS = 10_000;   // accepted
const MAX_PENDING = 500;
const MAX_PENDING_PER_HOST = 20;
const MAX_FRIENDS = 500;
const REACCEPT_MS = 3600_000;
const REACCEPT_KEYS = 10_000;
const STATES = new Set(['pending', 'accepted']);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function normalizeRows(raw, max) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || !isHandle(r.handle, { allowPort: true }) || seen.has(r.handle) || !STATES.has(r.state)) continue;
    seen.add(r.handle);
    const row = { handle: r.handle, state: r.state, follow_id: str(r.follow_id, 600), at: str(r.at, 40) };
    if (r.state === 'accepted') row.accepted_at = str(r.accepted_at, 40);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

/* Followers: the accepted ones up to their cap, the pending ones up to theirs
 * (the newest kept), in stored order. */
function normalizeFollowers(raw) {
  const rows = normalizeRows(raw, MAX_FOLLOWERS + MAX_PENDING);
  let pendingLeft = rows.filter((r) => r.state === 'pending').length - MAX_PENDING;
  let accepted = 0;
  return rows.filter((r) => {
    if (r.state === 'accepted') return ++accepted <= MAX_FOLLOWERS;
    if (pendingLeft > 0) { pendingLeft--; return false; }
    return true;
  });
}

function normalizeFollows(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { following: normalizeRows(r.following, MAX_FOLLOWING), followers: normalizeFollowers(r.followers) };
}

const hostOfHandle = (h) => (h.includes('@') ? h.slice(h.indexOf('@') + 1) : '');
const acceptedIn = (rows) => rows.filter((r) => r.state === 'accepted').length;

const rowOf = (list, handle) => list.find((r) => r.handle === handle) || null;
const isFriend = (f, handle) => rowOf(f.following, handle)?.state === 'accepted' && rowOf(f.followers, handle)?.state === 'accepted';
const friendsIn = (f) => f.following.filter((r) => r.state === 'accepted' && rowOf(f.followers, r.handle)?.state === 'accepted').map((r) => r.handle);

/* `remote` (P5, lib/federation.js; absent with FEDERATION=off): { handleOf(url),
 * idOf(handle) } over the actor cache, so a Follow or Undo from another server
 * lands as a row naming its handle, and an answer to it goes to its actor. */
function createFollows({ paths, members, pages, outbox, audit, onWrite = () => {}, remote = null, onEdge = () => {} }) {
  const file = (name) => paths.memberFile(name, 'follows.json');
  const accepts = new Map();   // `${me}\n${remote handle}` -> when an Accept last went (N2)
  function acceptedRecently(me, handle) {
    if (!handle.includes('@')) return false;   // in-process: no job, nothing to bound
    const k = `${me}\n${handle}`;
    const last = accepts.get(k);
    return last !== undefined && clock.now() - last < REACCEPT_MS;
  }
  function noteAccept(me, handle) {
    if (!handle.includes('@')) return;
    const k = `${me}\n${handle}`;
    accepts.delete(k);
    accepts.set(k, clock.now());
    if (accepts.size > REACCEPT_KEYS) accepts.delete(accepts.keys().next().value);
  }
  const load = (name) => normalizeFollows(readJSON(file(name), {}));
  function save(name, f) {
    if (!members.get(name)) throw new MemberGone(name);   // the purge must stay a purge
    const before = remote ? load(name) : null;
    writeJSON(file(name), normalizeFollows(f));
    onWrite(name);
    if (before) {
      // Tell the app about every remote handle whose rows changed (P6).
      const sig = (x) => JSON.stringify([...x.following, ...x.followers].filter((r) => r.handle.includes('@')).map((r) => [r.handle, r.state]).sort());
      const after = load(name);
      if (sig(before) !== sig(after)) {
        const hs = new Set([...before.following, ...before.followers, ...after.following, ...after.followers].map((r) => r.handle).filter((h) => h.includes('@')));
        for (const h of hs) {
          const was = JSON.stringify([rowOf(before.following, h)?.state, rowOf(before.followers, h)?.state]);
          const now = JSON.stringify([rowOf(after.following, h)?.state, rowOf(after.followers, h)?.state]);
          if (was !== now) { try { onEdge(name, h); } catch (e) { console.error(`[follows] onEdge ${h}: ${e.message}`); } }
        }
      }
    }
  }

  const activeMember = (name) => members.get(name)?.status === 'active';
  /* A handle's actor URL: a member here, or a remote handle's cached actor id. */
  const actor = (origin, handle) => (handle.includes('@') ? (remote?.idOf(handle) || '') : urls.actorUrl(origin, handle));
  /* The local member an actor URL names, or ''. */
  const nameOf = (url, origin) => {
    const l = urls.parseLocal(url, origin);
    return l?.kind === 'person' && members.get(l.name) ? l.name : '';
  };
  /* Who sent it: a member here by name, or (P5) a remote actor by its handle. */
  const senderOf = (url, origin) => nameOf(url, origin) || (remote && !urls.parseLocal(url, origin) ? remote.handleOf(url) : '');

  // ── reads ──
  const friendHandles = (name) => friendsIn(load(name));
  const friends = (a, b) => !!a && !!b && a !== b && isFriend(load(a), b);
  /* none | pending | friends, from `me`'s side, plus who asked. */
  function status(me, other) {
    const f = load(me);
    if (isFriend(f, other)) return { status: 'friends' };
    const out = rowOf(f.following, other);
    const inn = rowOf(f.followers, other);
    if (out) return { status: 'pending', direction: 'out' };
    if (inn?.state === 'pending') return { status: 'pending', direction: 'in' };
    return { status: 'none' };
  }

  // ── acts (each one tick: this side, then the activity) ──

  /* `me` sends a Follow to `other` (a fresh one, or again while pending). In
   * process the same Follow goes again; to ANOTHER server a new one does (P6):
   * the receiver drops an activity id it has seen for 7 days (5.5), so the
   * same id would never land after a block is lifted. Their side keeps one row
   * either way (rows match by handle), and this row keeps the newest id. */
  function sendFollow(me, other, origin) {
    const f = load(me);
    const prev = rowOf(f.following, other);
    const reuse = prev?.follow_id && !other.includes('@') ? prev.follow_id : undefined;
    const activity = A.follow({ origin, name: me, object: actor(origin, other), id: reuse });
    if (!prev) f.following.push({ handle: other, state: 'pending', follow_id: activity.id, at: clock.iso() });
    else if (!reuse) prev.follow_id = activity.id;
    save(me, f);
    outbox.emit(activity, [actor(origin, other)], { origin });
  }

  /* Accept the pending (or accepted) follower `other`, by `me`. */
  function acceptFollower(me, other, origin) {
    const f = load(me);
    const row = rowOf(f.followers, other);
    if (!row) return false;
    if (row.state !== 'accepted') { row.state = 'accepted'; row.accepted_at = clock.iso(); }
    save(me, f);
    noteAccept(me, other);
    outbox.emit(A.acceptFollow({ origin, name: me, follow: { id: row.follow_id, actor: actor(origin, other), object: actor(origin, me) } }), [actor(origin, other)], { origin });
    return true;
  }

  /* Befriend: confirms a crossing request, else asks. Returns the status after. */
  function befriend(me, other, origin) {
    const f = load(me);
    if (isFriend(f, other)) return { status: 'friends' };
    if (rowOf(f.followers, other)) return confirm(me, other, origin);
    const mine = rowOf(f.following, other);
    if (!mine) {
      if (f.following.length >= MAX_FOLLOWING) return { error: 'follow_limit' };
      if (friendsIn(f).length >= MAX_FRIENDS) return { error: 'friend_limit' };
      sendFollow(me, other, origin);
    } else if (mine.state === 'pending') {
      // Again while pending: the same Follow is sent again (a request dropped by a
      // block that has since been lifted lands now; the other side keeps one row).
      sendFollow(me, other, origin);
    }
    audit('friend.requested', me, { to: other });
    return status(me, other);
  }

  /* Confirm `other`'s request: Accept their Follow, then Follow back (their side
   * accepts that at once: it crosses their own accepted follow). */
  function confirm(me, other, origin) {
    const f = load(me);
    const row = rowOf(f.followers, other);
    if (!row) return { error: 'not_found' };
    if (!isFriend(f, other) && friendsIn(f).length >= MAX_FRIENDS) return { error: 'friend_limit' };
    if (row.state !== 'accepted' && acceptedIn(f.followers) >= MAX_FOLLOWERS) return { error: 'follower_limit' };
    acceptFollower(me, other, origin);
    if (rowOf(load(me).following, other)?.state !== 'accepted') sendFollow(me, other, origin);
    const s = status(me, other);
    if (s.status === 'friends') audit('friend.confirmed', me, { with: other });
    return s;
  }

  /* Let follow: accept as a follower only. */
  function letFollow(me, other, origin) {
    const f = load(me);
    const row = rowOf(f.followers, other);
    if (!row) return { error: 'not_found' };
    if (row.state !== 'accepted' && acceptedIn(f.followers) >= MAX_FOLLOWERS) return { error: 'follower_limit' };
    acceptFollower(me, other, origin);
    audit('follower.accepted', me, { follower: other });
    return { ok: true };
  }

  /* Decline a request, or remove a follower: Reject their Follow. */
  function decline(me, other, origin) {
    const f = load(me);
    const row = rowOf(f.followers, other);
    if (!row) return { error: 'not_found' };
    f.followers = f.followers.filter((r) => r !== row);
    save(me, f);
    outbox.emit(A.rejectFollow({ origin, name: me, follow: { id: row.follow_id, actor: actor(origin, other), object: actor(origin, me) } }), [actor(origin, other)], { origin });
    audit('follower.removed', me, { follower: other, was: row.state });
    return { ok: true };
  }

  /* Sever: undo my follow, reject theirs. Either side, any state. */
  function sever(me, other, origin) {
    const f = load(me);
    const out = rowOf(f.following, other);
    const inn = rowOf(f.followers, other);
    if (!out && !inn) return { error: 'not_found' };
    f.following = f.following.filter((r) => r !== out);
    f.followers = f.followers.filter((r) => r !== inn);
    save(me, f);
    const to = [actor(origin, other)];
    if (out) outbox.emit(A.undoFollow({ origin, name: me, follow: { id: out.follow_id, actor: actor(origin, me), object: actor(origin, other) } }), to, { origin });
    if (inn) outbox.emit(A.rejectFollow({ origin, name: me, follow: { id: inn.follow_id, actor: actor(origin, other), object: actor(origin, me) } }), to, { origin });
    audit('friend.removed', me, { with: other });
    return { ok: true };
  }

  /* The purge's sweep of ANOTHER member's file: drop every row naming `gone`
   * (one a crashed purge's sever left behind on this side). No activity: `gone`
   * is being deleted. Writes only on a change. */
  function dropHandle(me, gone) {
    const f = load(me);
    const following = f.following.filter((r) => r.handle !== gone);
    const followers = f.followers.filter((r) => r.handle !== gone);
    if (following.length === f.following.length && followers.length === f.followers.length) return false;
    save(me, { following, followers });
    return true;
  }

  /* Every handle `me` has an edge with, either way. */
  const edgesOf = (me) => { const f = load(me); return [...new Set([...f.following, ...f.followers].map((r) => r.handle))]; };

  // ── handlers (the other side, lib/ap-inbound.js) ──

  /* A Follow arrives for `me`. */
  function onFollow(activity, { inbox, origin }) {
    const me = inbox.name;
    const from = senderOf(activity.actor, origin);
    if (!activeMember(me) || nameOf(activity.object, origin) !== me) return { status: 404 };
    if (!from || from === me) return { status: 400 };
    const f = load(me);
    // An answer to a stranger: a courtesy job, refused past the queue's caps.
    const reject = () => {
      outbox.emit(A.rejectFollow({ origin, name: me, follow: { id: activity.id, actor: activity.actor, object: activity.object } }), [activity.actor], { origin, courtesy: true });
      return { status: 202, rejected: true };
    };
    const acceptIt = () => {
      noteAccept(me, from);
      outbox.emit(A.acceptFollow({ origin, name: me, follow: { id: activity.id, actor: activity.actor, object: activity.object } }), [activity.actor], { origin });
    };
    if (blocksHandle(pages.settings(me), from)) return { status: 202, dropped: true };   // silently: never a Reject
    const followId = str(activity.id, 600);
    const row = rowOf(f.followers, from);
    if (row?.state === 'accepted') {
      // Already a follower: their server sent it again. Re-Accept at most once an
      // hour (N2), and write only a changed id.
      if (followId && followId !== row.follow_id) { row.follow_id = followId; save(me, f); }
      if (acceptedRecently(me, from)) return { status: 202, accepted: true, repeated: true };
      acceptIt();
      return { status: 202, accepted: true };
    }
    const crossing = !!rowOf(f.following, from);
    const accept = crossing || pages.settings(me).open_follows === true;
    if (accept && acceptedIn(f.followers) >= MAX_FOLLOWERS) return reject();
    if (crossing && friendsIn(f).length >= MAX_FRIENDS) return reject();
    if (!row) {
      if (!accept) {
        // A new request (N7): its own caps, never the accepted followers'.
        const host = hostOfHandle(from);
        const pending = f.followers.filter((r) => r.state === 'pending');
        if (host && pending.filter((r) => hostOfHandle(r.handle) === host).length >= MAX_PENDING_PER_HOST) return { status: 202, dropped: true };
        if (pending.length >= MAX_PENDING) {
          const oldest = pending[0];
          f.followers = f.followers.filter((r) => r !== oldest);
        }
      }
      if (!accept && acceptedIn(f.followers) >= MAX_FOLLOWERS) return reject();
      f.followers.push({ handle: from, state: 'pending', follow_id: followId, at: clock.iso() });
    }
    const r = rowOf(f.followers, from);
    // A request already pending, sent again with nothing new, writes nothing.
    const changed = !row || accept || (!!followId && followId !== r.follow_id);
    r.follow_id = followId || r.follow_id;
    if (accept) { r.state = 'accepted'; r.accepted_at = clock.iso(); }
    if (changed) save(me, f);
    if (accept) acceptIt();
    return { status: 202, accepted: accept };
  }

  /* The followee's answer to `me`'s Follow: only from the followee, about a
   * Follow whose actor is `me` (spec 5.4, 16.3 fed-ownership). The Follow is
   * embedded (its actor is me, its object the answering actor), or named by its
   * id alone: then it must be the id of the Follow this member sent the
   * answering actor (P6: other software answers either way). */
  function answerOf(activity, { inbox, origin }) {
    const me = inbox.name;
    const followee = senderOf(activity.actor, origin);
    if (!followee || followee === me) return null;
    const o = activity.object;
    if (typeof o === 'string') {
      const row = rowOf(load(me).following, followee);
      return row?.follow_id && row.follow_id === o ? { me, followee } : null;
    }
    if (!o || typeof o !== 'object' || nameOf(o.actor, origin) !== me) return null;
    const target = typeof o.object === 'string' ? o.object : o.object?.id;
    if (target !== activity.actor) return null;
    return { me, followee };
  }

  function onAccept(activity, ctx) {
    const a = answerOf(activity, ctx);
    if (!a) return { status: 403 };
    const f = load(a.me);
    const row = rowOf(f.following, a.followee);
    if (!row) return { status: 202 };   // withdrawn meanwhile: nothing to accept
    if (row.state !== 'accepted') { row.state = 'accepted'; row.accepted_at = clock.iso(); save(a.me, f); }
    return { status: 202 };
  }

  function onReject(activity, ctx) {
    const a = answerOf(activity, ctx);
    if (!a) return { status: 403 };
    const f = load(a.me);
    if (!rowOf(f.following, a.followee)) return { status: 202 };
    f.following = f.following.filter((r) => r.handle !== a.followee);
    save(a.me, f);
    return { status: 202 };
  }

  /* Undo of a Follow: only by its own actor. A friend who unfollows has severed. */
  function onUndo(activity, { inbox, origin }) {
    const me = inbox.name;
    const o = activity.object && typeof activity.object === 'object' ? activity.object : null;
    const from = senderOf(activity.actor, origin);
    if (!o || !from || o.actor !== activity.actor || nameOf(o.object, origin) !== me) return { status: 403 };
    const f = load(me);
    const wasFollower = !!rowOf(f.followers, from);
    const mine = rowOf(f.following, from);
    if (!wasFollower && !mine) return { status: 202 };
    f.followers = f.followers.filter((r) => r.handle !== from);
    const severs = mine?.state === 'accepted';
    if (severs) f.following = f.following.filter((r) => r !== mine);
    save(me, f);
    if (severs) outbox.emit(A.undoFollow({ origin, name: me, follow: { id: mine.follow_id, actor: actor(origin, me), object: activity.actor } }), [activity.actor], { origin });
    return { status: 202 };
  }

  /* A remote actor Blocks `me` (spec 4.10): the follow edges between them go,
   * both ways, and nothing is shown or sent (they blocked; there is no one to
   * tell). Only about the member the Block names. */
  function onBlock(activity, { inbox, origin }) {
    const me = inbox.name;
    const target = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (nameOf(target, origin) !== me) return { status: 202, dropped: true };
    const from = senderOf(activity.actor, origin);
    if (!from?.includes('@')) return { status: 202, dropped: true };
    const changed = dropHandle(me, from);
    if (changed) audit('friend.blocked_by', me, { by: from });
    return { status: 202 };
  }

  return {
    load, friendHandles, friends, status, edgesOf, dropHandle,
    befriend, confirm, letFollow, decline, sever,
    handlers: { Follow: onFollow, 'Accept:Follow': onAccept, 'Reject:Follow': onReject, 'Undo:Follow': onUndo, Block: onBlock },
  };
}

module.exports = { createFollows, normalizeFollows, MAX_FOLLOWING, MAX_FOLLOWERS, MAX_PENDING, MAX_PENDING_PER_HOST, MAX_FRIENDS, REACCEPT_MS };
