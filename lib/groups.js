'use strict';
/* ── Rings as Groups: the home's authority and the members' acts (spec 3.6, 4.7) ─
 * Carried on activities. Every ring act is an activity TO THE GROUP, and only the Group's
 * inbox (the HOME, this server, for every ring P2 knows) decides:
 *
 *   Join {ring: {code}}       a live code asks: a request, never a seat
 *   Accept / Reject {Join id} a member approves or declines; code, seats and the
 *                             request are re-checked HERE, at approval
 *   Leave                     any member; the creator role passes to the oldest
 *                             member; the last to leave dissolves the ring
 *   Remove {member}           the creator only. A kick STICKS: the link rotates
 *                             (the kicked member held the old code), the pending
 *                             requests drop, and the handle is kept on the ring's
 *                             `kicked` list, so only the creator re-admits it
 *   Update {name} | {ring: {join: rotate|off}}   any member; rotate and off drop
 *                             the pending requests (a request was authorised by
 *                             the code that filed it)
 * EVERY DROPPED REQUEST is answered: the Group sends Reject{Join} to its
 * requester (rotate, off, a kick, an expiry, the purge rotating a gone member's
 * code, a ring dissolved or deleted), so the asker's side never waits on a
 * request the ring no longer holds.
 *   Delete {Group}            the creator only
 *   Create/Update/Delete of a room Note, and every reaction on one: from a current
 *                             member; a reaction goes on to the post's own server
 *                             (the authority) and, applied, is Announced
 * Each change bumps `rev` and sends `Update{Group}` to the members (P7's replicas
 * apply only a higher rev). Non-members get the opaque 404 everywhere.
 *
 * The member's own server keeps the 3-ring cap: it refuses to send a Join past
 * it, and on an Accept past it (a race) sends Leave at once (onAdmitted).
 *
 * THE RE-ENTRANCY RULE (lib/ap-inbound.js): a handler saves before it emits and
 * writes nothing after an emit returns, because a recipient here may answer in
 * the same tick (an Accept answered by a Leave).
 *
 * Creating a ring is local (a home row, and from P7 the Group's own key,
 * keys/rings/<id>.pem, made at once with FEDERATION=on and lazily for a ring
 * made before).
 *
 * P7, RINGS ACROSS SERVERS (spec 4.7). A handle in a ring may be remote
 * (`name@host`): the home stays THE authority for membership, the code, the
 * 6 seats (pending requests included) and approvals, every check in ONE tick,
 * so concurrent asks and approvals from any number of servers can never seat a
 * seventh. What the home does for its remote members:
 *   - a Join from another server is taken only from a Ring server (its NodeInfo
 *     declares ringProtocol, lib/hosts.js); a full ring, or one a non-Ring
 *     server asks, answers Reject{Join} so the asker's server never waits
 *   - an approval is refused (and the request answered Reject) when any member
 *     here blocks the asker, by handle or domain: a blocked person never gets
 *     the room's read grant over the blocker's posts (spec 6.1)
 *   - the Group fans out to remote members' servers (signed with the ring's
 *     key, lib/federation.js); a remote member's room post is kept as a COPY
 *     here (lib/rooms.js) for the members here, and a reaction on a copy is
 *     recorded on it and Announced to every member server for their copies.
 *     The post's own server, THE AUTHORITY, applies only the copy its
 *     reactor's server sent the author signed by the reactor (P7 review F2,
 *     lib/ring-fed.js), never the Announce, and withdraws a refused one by
 *     Remove
 *   - a member here's room post is never Announced to a server whose ring
 *     members the author all blocks (withheldHosts, P7 review F4)
 *   - a member who leaves or is removed takes their copies out of the room;
 *     a deleted ring takes every copy and (once its last job is sent) its key
 * A ring hosted ELSEWHERE that a member here belongs to is a REPLICA row: its
 * acts go to its Group as activities (lib/ring-fed.js, `fed.replica`), and its
 * Group's answers land through lib/ring-fed.js.
 */
const clock = require('./clock');
const R = require('./rings');
const { newRingId, newJoinCode } = require('./ids');
const { ringPostLive } = require('./ring-reset');
const { blocksHandle } = require('./ring');
const A = require('./activities');
const urls = require('./urls');

function createGroups({ members, pages, images, reactions, ringStore, outbox, audit, receive, rooms = null }) {
  let fed = null;   // lib/ring-fed.js, bound with FEDERATION=on (P7)
  const local = (h) => typeof h === 'string' && !!h && !h.includes('@');
  /* An actor URL as a ring handle: an active member here, or (P7) a remote
   * actor the cache has bound. '' otherwise. */
  const whoOf = (url, origin) => {
    const l = urls.parseLocal(url, origin);
    if (l) return l.kind === 'person' && members.get(l.name)?.status === 'active' ? l.name : '';
    return fed ? fed.whoOf(url) : '';
  };
  const actor = (origin, h) => (local(h) ? urls.actorUrl(origin, h) : fed ? fed.actorOf(h) : '');
  const docCtx = (origin, ring) => ({ origin, actorOf: (h) => actor(origin, h), publicKeyPem: fed && ring ? fed.publicKeyPem(ring.id) : undefined });
  const mintJoin = (by) => ({ code: newJoinCode(), created_by: by, created_at: clock.iso(), expires_at: clock.iso(clock.now() + R.RING_JOIN_TTL_MS) });
  const joinUrlOf = (origin, join) => (join ? urls.joinUrl(origin, join.code) : '');
  /* Does a member HERE block this handle (by handle or its domain)? */
  const blockedHere = (ring, handle) => ring.members.some((m) => local(m.handle) && members.get(m.handle) && blocksHandle(pages.settings(m.handle), handle));

  /* Save one ring (or remove it when `next` is null), bumping rev. */
  function commit(id, next) {
    ringStore.update((rings) => {
      const i = rings.findIndex((r) => r.id === id);
      if (i < 0) return undefined;
      if (next === null) rings.splice(i, 1);
      else rings[i] = { ...next, rev: rings[i].rev + 1 };
      return rings;
    });
    return next === null ? null : ringStore.get(id);
  }
  /* The copies follow the membership (P7): a member gone from the ring takes
   * their copies with them; a ring gone takes every copy. */
  function syncCopies(id, ring) {
    if (!rooms) return;
    let dropped = [];
    try {
      const anyoneHere = ring?.members.some((m) => local(m.handle) && members.get(m.handle)?.status === 'active');
      dropped = !ring || !anyoneHere ? rooms.drop(id) : rooms.keepAuthors(id, (h) => R.isMember(ring, h));
    } catch { return; }
    if (dropped.length && fed) fed.forgetMedia(dropped);
  }
  const tellMembers = (ring, origin) => outbox.emit(A.updateGroup(ring, docCtx(origin, ring)), ring.members.map((m) => actor(origin, m.handle)).filter(Boolean), { origin });
  /* The Group answers each request it dropped with Reject{Join}. Call AFTER the save. */
  function rejectDropped(ringId, dropped, origin) {
    for (const q of dropped) answerAsker(ringId, q, 'Reject', origin);
  }
  function answerAsker(ringId, q, type, origin) {
    const who = actor(origin, q.handle);
    if (!who || !q.join_id) return;
    const join = { id: q.join_id, actor: who, object: urls.groupUrl(origin, ringId) };
    outbox.emit(A.groupAnswerJoin(type, { origin, ringId, join }), [join.actor], { origin });
  }

  // ── acts (the routes) ──

  function create(me, name, origin) {
    const clean = R.normalizeRingName(name);
    if (!clean) return { status: 400, error: 'ring_name_required' };
    let made = null;
    ringStore.update((rings) => {
      if (R.ringsOf(rings, me).length >= R.RING_MAX_PER_MEMBER) return undefined;
      const id = newRingId();
      const join = mintJoin(me);
      made = {
        id, ap_id: urls.groupUrl(origin, id), home: true, name: clean, created_by: me, created_at: clock.iso(),
        members: [{ handle: me, joined_at: clock.iso() }], requests: [], join, join_url: joinUrlOf(origin, join), rev: 1,
      };
      rings.push(made);
      return rings;
    });
    if (!made) return { status: 400, error: 'ring_limit' };
    if (fed) fed.ensureKey(made.id);   // the Group's own key (spec 2.6), made with the ring
    audit('ring.created', me, { ring: made.id });
    return { status: 201, ring: ringStore.get(made.id) };
  }

  const toGroup = (activity, ringId, origin) => outbox.emit(activity, [urls.groupUrl(origin, ringId)], { origin })[0]?.result || { status: 404, error: 'not_found' };
  /* A ring hosted elsewhere (P7): the act goes to its Group (lib/ring-fed.js). */
  const homeOrNot = (ringId, here, away) => {
    const r = ringStore.get(ringId);
    if (r && !r.home) return fed ? away(r) : { status: 404, error: 'not_found' };
    return here();
  };

  const rename = (me, ringId, name, origin) => homeOrNot(ringId, () => toGroup(A.renameGroup({ origin, name: me, ringId, ringName: name }), ringId, origin), (r) => fed.replica.rename(me, r, name, origin));
  const link = (me, ringId, join, origin) => homeOrNot(ringId, () => toGroup(A.linkGroup({ origin, name: me, ringId, join }), ringId, origin), (r) => fed.replica.link(me, r, join, origin));
  const leave = (me, ringId, origin) => homeOrNot(ringId, () => toGroup(A.leaveGroup({ origin, name: me, ringId }), ringId, origin), (r) => fed.replica.leave(me, r, origin));
  const kick = (me, ringId, member, origin) => homeOrNot(ringId, () => toGroup(A.removeMember({ origin, name: me, ringId, member, memberActor: actor(origin, member) || undefined }), ringId, origin), (r) => fed.replica.kick(me, r, member, origin));
  const destroy = (me, ringId, origin) => homeOrNot(ringId, () => toGroup(A.deleteGroup({ origin, name: me, ringId }), ringId, origin), (r) => fed.replica.destroy(me, r, origin));

  /* Ask by link. The joiner's server keeps the 3-ring cap before it sends. */
  function ask(me, code, origin) {
    const rings = ringStore.load();
    const ring = R.ringByJoinCode(rings, code, clock.now());
    if (!ring) return { status: 404, error: 'not_found' };
    if (R.isMember(ring, me)) return { status: 200, member: true, ring };
    if (R.hasRequested(ring, me)) return { status: 200, requested: true, ring };
    if (R.ringsOf(rings, me).length >= R.RING_MAX_PER_MEMBER) return { status: 400, error: 'ring_limit' };
    return { ...toGroup(A.joinGroup({ origin, name: me, ringId: ring.id, code }), ring.id, origin), ring };
  }

  /* A member answers a request (by the requester's handle). */
  function answer(me, ringId, handle, approve, origin) {
    const ring = ringStore.get(ringId);
    const q = ring?.requests.find((x) => x.handle === handle);
    if (!q) return { status: 404, error: 'not_found' };
    if (!ring.home) return fed ? fed.replica.answer(me, ring, q, approve, origin) : { status: 404, error: 'not_found' };
    return toGroup(A.answerJoin(approve ? 'Accept' : 'Reject', { origin, name: me, ringId, joinId: q.join_id }), ringId, origin);
  }

  /* A handle gone from every HOME ring here (a member's purge, P2; a remote
   * actor gone, P7): out of members, requests and the kicked list (a ring passes
   * on or dissolves, spec 11.4), and the join code they minted closes: it
   * rotates to the ring's creator, its requests dropped and answered. Direct:
   * the handle can sign nothing now. Idempotent: a second run finds nothing. */
  function dropHandle(handle, origin) {
    for (const ring of ringStore.load()) {
      if (!ring.home) continue;
      const theirCode = ring.join?.created_by === handle;
      if (!R.isMember(ring, handle) && !R.hasRequested(ring, handle) && !R.wasKicked(ring, handle) && !theirCode) continue;
      let next = R.dropFromRing(ring, handle);
      let dropped = next ? [] : ring.requests.filter((q) => q.handle !== handle);   // a dissolved ring answers its askers
      if (next) {
        next = { ...next, kicked: (next.kicked || []).filter((k) => k !== handle) };
        if (theirCode) {
          const join = R.joinLinkLive(ring, clock.now()) && local(next.created_by) ? mintJoin(next.created_by) : null;
          dropped = next.requests;
          next = { ...next, join, join_url: joinUrlOf(origin, join), requests: [] };
        }
      }
      const saved = commit(ring.id, next);
      if (R.isMember(ring, handle)) audit('ring.left', handle, { ring: ring.id, dissolved: !next, purge: true });
      syncCopies(ring.id, saved);
      if (!saved && fed) fed.ringGone(ring.id);
      rejectDropped(ring.id, dropped, origin);
      if (saved) tellMembers(saved, origin);
    }
  }
  /* The purge (P2) drops a member from the home rings here; P7 also takes them
   * out of the replicas of rings hosted elsewhere (lib/ring-fed.js). */
  function purgeMember(handle, origin) {
    dropHandle(handle, origin);
    if (fed && local(handle)) fed.purgeLocal(handle, origin);
  }

  /* Housekeeping: an expired join code is switched off and the requests it filed
   * go with it, as a rotation would: each answered with Reject, the members told
   * (Update{Group}, the rev moved). Returns how many links closed. */
  function expireLinks(origin) {
    const nowMs = clock.now();
    const closed = [];
    ringStore.update((rings) => {
      for (const r of rings) {
        if (!r.home || !r.join || R.joinLinkLive(r, nowMs)) continue;
        closed.push({ id: r.id, dropped: r.requests });
        r.join = null;
        r.join_url = '';
        r.requests = [];
        r.rev += 1;
      }
      return closed.length ? rings : undefined;
    });
    for (const { id, dropped } of closed) {
      rejectDropped(id, dropped, origin);
      const saved = ringStore.get(id);
      if (saved) tellMembers(saved, origin);
    }
    return closed.length;
  }

  // ── the Group's inbox (the home) ──

  const homeRing = (inbox) => {
    const r = ringStore.get(inbox.id);
    return r?.home ? r : null;
  };
  /* The ring and the signing member, or null (the opaque 404). */
  function memberCtx(activity, { inbox, origin }) {
    const ring = homeRing(inbox);
    const signer = whoOf(activity.actor, origin);
    return ring && signer && R.isMember(ring, signer) ? { ring, signer } : null;
  }
  const NOPE = { status: 404, error: 'not_found' };

  function onJoin(activity, { inbox, origin }) {
    const ring = homeRing(inbox);
    const signer = whoOf(activity.actor, origin);
    const code = typeof activity.ring?.code === 'string' ? activity.ring.code : '';
    if (!ring || !signer || !R.joinLinkLive(ring, clock.now()) || ring.join.code !== code) return NOPE;
    if (R.isMember(ring, signer)) return { status: 200, member: true };
    if (R.hasRequested(ring, signer)) return { status: 200, requested: true };
    const ask = { handle: signer, join_id: String(activity.id || '') };
    // P7: only a Ring server joins a ring (decision 7): its NodeInfo said so.
    if (!local(signer) && !fed?.isRingPeer(signer)) {
      answerAsker(ring.id, ask, 'Reject', origin);
      return { status: 403, error: 'forbidden' };
    }
    if (R.ringIsFull(ring)) {
      if (!local(signer)) answerAsker(ring.id, ask, 'Reject', origin);   // every dropped ask is answered
      return { status: 400, error: 'ring_full' };
    }
    const saved = commit(ring.id, { ...ring, requests: [...ring.requests, { handle: signer, asked_at: clock.iso(), join_id: ask.join_id }] });
    audit('ring.requested', signer, { ring: ring.id, via: ring.join.created_by });
    tellMembers(saved, origin);
    return { status: 200, requested: true };
  }

  function onAnswer(approve) {
    return (activity, ctx) => {
      const { origin } = ctx;
      const m = memberCtx(activity, ctx);
      if (!m) return NOPE;
      const joinId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
      const q = m.ring.requests.find((x) => x.join_id && x.join_id === joinId);
      if (!q) return NOPE;
      const rest = m.ring.requests.filter((x) => x !== q);
      if (approve && !R.joinLinkLive(m.ring, clock.now())) {
        // The code that filed it has lapsed: the request is spent (re-checked at approval).
        const saved = commit(m.ring.id, { ...m.ring, requests: rest });
        answerAsker(m.ring.id, q, 'Reject', origin);
        tellMembers(saved, origin);
        return { status: 400, error: 'join_expired' };
      }
      if (approve && m.ring.members.length >= R.RING_MAX_MEMBERS) return { status: 400, error: 'ring_full' };
      // A kick sticks: only the creator re-admits a kicked handle (declining stays anyone's).
      if (approve && R.wasKicked(m.ring, q.handle) && m.ring.created_by !== m.signer) return { status: 403, error: 'ring_creator_only' };
      // P7: a member here blocks them (handle or domain): never admitted, so a
      // block never hands the blocked the room's read grant (spec 6.1).
      if (approve && blockedHere(m.ring, q.handle)) {
        const saved = commit(m.ring.id, { ...m.ring, requests: rest });
        audit('ring.declined', m.signer, { ring: m.ring.id, who: q.handle, why: 'blocked' });
        answerAsker(m.ring.id, q, 'Reject', origin);
        tellMembers(saved, origin);
        return { status: 409, error: 'ring_blocked' };
      }
      const next = approve
        ? { ...m.ring, requests: rest, members: [...m.ring.members, { handle: q.handle, joined_at: clock.iso() }] }
        : { ...m.ring, requests: rest };
      const saved = commit(m.ring.id, next);
      audit(approve ? 'ring.approved' : 'ring.declined', m.signer, { ring: m.ring.id, who: q.handle });
      answerAsker(m.ring.id, q, approve ? 'Accept' : 'Reject', origin);
      const now = ringStore.get(m.ring.id);
      if (now) tellMembers(now, origin);
      if (approve && now && R.isMember(now, q.handle)) announceRoomTo(now, q.handle, origin);
      return { status: 200, admitted: approve && !!now && R.isMember(now, q.handle), handle: q.handle, ring: saved };
    };
  }

  /* The live room, Announced to a newcomer (4.7): the posts of the members
   * here (their server backfills the rest from the Group's outbox). */
  function announceRoomTo(ring, handle, origin) {
    const nowMs = clock.now();
    const to = actor(origin, handle);
    if (!to) return;
    for (const m of ring.members) {
      if (m.handle === handle || !local(m.handle) || members.get(m.handle)?.status !== 'active') continue;
      for (const p of pages.load(m.handle).posts) {
        if (p.audience !== ring.id || !ringPostLive(p, nowMs)) continue;
        const create = A.createPost(p, { origin, name: m.handle, imageRow: images.row });
        if (create) outbox.emit(A.announce({ origin, ringId: ring.id, activity: create, to: [to] }), [to], { origin });
      }
    }
  }

  function onLeave(activity, ctx) {
    const m = memberCtx(activity, ctx);
    if (!m) return NOPE;
    const next = R.dropFromRing(m.ring, m.signer);
    const saved = commit(m.ring.id, next);
    audit('ring.left', m.signer, { ring: m.ring.id, dissolved: !next });
    syncCopies(m.ring.id, saved);
    if (!next) {
      rejectDropped(m.ring.id, m.ring.requests, ctx.origin);   // dissolved: its askers are answered
      if (fed) fed.ringGone(m.ring.id);
    }
    if (saved) tellMembers(saved, ctx.origin);
    return { status: 200, dissolved: !next };
  }

  function onRemoveMember(activity, ctx) {
    const { origin } = ctx;
    const m = memberCtx(activity, ctx);
    if (!m) return NOPE;
    if (m.ring.created_by !== m.signer) return { status: 403, error: 'ring_creator_only' };
    const who = whoOf(typeof activity.object === 'string' ? activity.object : '', origin)
      || (fed && typeof activity.object === 'string' ? fed.knownHandle(activity.object) : '');
    if (who === m.signer) return { status: 400, error: 'leave_instead' };
    if (!who || !R.isMember(m.ring, who)) return NOPE;
    const whoActor = actor(origin, who);
    // The kicked member held the code: it rotates (a dead one closes), the requests
    // it filed drop, and the handle is remembered (only the creator re-admits it).
    const join = R.joinLinkLive(m.ring, clock.now()) ? mintJoin(m.signer) : null;
    const dropped = m.ring.requests;
    const next = {
      ...R.dropFromRing(m.ring, who), requests: [], join, join_url: joinUrlOf(origin, join),
      kicked: [...(m.ring.kicked || []).filter((k) => k !== who), who].slice(-R.RING_MAX_KICKED),
    };
    const saved = commit(m.ring.id, next);
    audit('ring.kicked', m.signer, { ring: m.ring.id, member: who });
    syncCopies(m.ring.id, saved);
    if (whoActor) outbox.emit(A.groupRemoveMember({ origin, ringId: m.ring.id, member: who, memberActor: whoActor }), [whoActor], { origin });
    rejectDropped(m.ring.id, dropped, origin);
    tellMembers(saved, origin);
    return { status: 200, ring: saved };
  }

  function onUpdateGroup(activity, ctx) {
    const { origin } = ctx;
    const m = memberCtx(activity, ctx);
    if (!m) return NOPE;
    const o = activity.object;
    if (!o || o.id !== urls.groupUrl(origin, m.ring.id)) return { status: 400, error: 'bad_request' };
    let next;
    let event;
    let dropped = [];
    if (o.name !== undefined) {
      const name = R.normalizeRingName(o.name);
      if (!name) return { status: 400, error: 'ring_name_required' };
      next = { ...m.ring, name };
      event = 'ring.renamed';
    } else if (o.ring?.join === 'rotate') {
      if (R.ringIsFull({ ...m.ring, requests: [] })) return { status: 400, error: 'ring_full' };
      const join = mintJoin(m.signer);
      next = { ...m.ring, join, join_url: joinUrlOf(origin, join), requests: [] };
      dropped = m.ring.requests;
      event = 'ring.link_rotated';
    } else if (o.ring?.join === 'off') {
      next = { ...m.ring, join: null, join_url: '', requests: [] };
      dropped = m.ring.requests;
      event = 'ring.link_revoked';
    } else {
      return { status: 400, error: 'bad_request' };
    }
    const saved = commit(m.ring.id, next);
    audit(event, m.signer, { ring: m.ring.id });
    rejectDropped(m.ring.id, dropped, origin);
    tellMembers(saved, origin);
    return { status: 200, ring: saved };
  }

  function onDeleteGroup(activity, ctx) {
    const m = memberCtx(activity, ctx);
    if (!m) return NOPE;
    if (m.ring.created_by !== m.signer) return { status: 403, error: 'ring_creator_only' };
    commit(m.ring.id, null);
    audit('ring.deleted', m.signer, { ring: m.ring.id });
    syncCopies(m.ring.id, null);
    const to = m.ring.members.map((x) => actor(ctx.origin, x.handle)).filter(Boolean);
    outbox.emit(A.groupDeleted({ origin: ctx.origin, ringId: m.ring.id, to }), to, { origin: ctx.origin });
    rejectDropped(m.ring.id, m.ring.requests, ctx.origin);
    if (fed) fed.ringGone(m.ring.id);
    return { status: 200 };
  }

  /* THE BLOCK WINS AT THE HOME (P7 review F4): the hosts where EVERY member of
   * this ring is someone `author` (a member here) blocks, by handle or domain.
   * The Group sends that author's room posts to none of them. A host that also
   * holds a member the author does not block still gets them (one delivery
   * per server): the blocked member there can read that copy, the limit spec
   * 6.1 names; kick or leave is the remedy. */
  function withheldHosts(ring, author) {
    if (!local(author) || !members.get(author)) return new Set();
    const settings = pages.settings(author);
    const byHost = new Map();
    for (const m of ring.members) {
      if (local(m.handle)) continue;
      const h = m.handle.slice(m.handle.indexOf('@') + 1).toLowerCase();
      byHost.set(h, (byHost.get(h) ?? true) && blocksHandle(settings, m.handle));
    }
    return new Set([...byHost].filter(([, all]) => all).map(([h]) => h));
  }

  /* The Group hands an activity to every member's server: in-process to the
   * members here (a no-op: they read the ring live), and (P7) one fan-out to
   * the remote members, never to the server the activity came from (it has
   * it), and a member's post here never to a server whose ring members there
   * the author all blocks (withheldHosts). */
  const announceToMembers = (ring, activity, origin) => {
    let fromHost = '';
    try { fromHost = urls.parseLocal(activity.actor, origin) ? '' : new URL(activity.actor).host.toLowerCase(); } catch { fromHost = ''; }
    const o = activity.object;
    const l = urls.parseLocal(activity.actor, origin);
    const post = (activity.type === 'Create' || activity.type === 'Update') && o && typeof o === 'object' && o.type === 'Note' && !o.inReplyTo;
    const withheld = post && l?.kind === 'person' ? withheldHosts(ring, l.name) : new Set();
    const to = ring.members.map((x) => actor(origin, x.handle)).filter((u) => {
      if (!u) return false;
      try {
        const h = new URL(u).host.toLowerCase();
        return (!fromHost || h !== fromHost) && !withheld.has(h);
      } catch { return false; }
    });
    if (to.length) outbox.emit(A.announce({ origin, ringId: ring.id, activity, to }), to, { origin });
  };

  /* A room Note from a member: checked, then Announced (4.7 checks at the home). */
  function onRoomNote(activity, ctx) {
    const { origin } = ctx;
    const m = memberCtx(activity, ctx);
    if (!m) return NOPE;
    const o = activity.object;
    const group = urls.groupUrl(origin, m.ring.id);
    if (activity.type === 'Delete') {
      const id = typeof o === 'string' ? o : o?.id;
      const l = urls.parseLocal(id, origin);
      if (l?.kind === 'comment') return toAuthority(activity, ctx);   // a comment taken back
      if (l?.kind === 'post') {
        if (l.name !== m.signer) return { status: 403, error: 'forbidden' };
        announceToMembers(m.ring, activity, origin);
        return { status: 202 };
      }
      // P7: a remote member's post (a copy here), or a comment taken back.
      const copy = fed && rooms ? rooms.find(id) : null;
      if (copy && copy.ringId === m.ring.id) {
        if (copy.post.author !== m.signer) return { status: 403, error: 'forbidden' };
        const media = rooms.remove(m.ring.id, id, m.signer) || [];
        fed.forgetMedia(media);
        announceToMembers(m.ring, activity, origin);
        return { status: 202 };
      }
      return toAuthority(activity, ctx);
    }
    if (o?.type !== 'Note' || o.attributedTo !== activity.actor) return { status: 403, error: 'forbidden' };
    if (o.inReplyTo) return toAuthority(activity, ctx);   // a comment on a room post
    const published = Date.parse(o.published || '');
    const expires = Date.parse(o.ring?.expires || '');
    const addressed = Array.isArray(o.to) && o.to.includes(group);
    if (activity.type === 'Create' && (!addressed || !Number.isFinite(published) || published > clock.now() + 5 * 60_000
      || !Number.isFinite(expires) || expires > published + 7 * 24 * 3600_000)) return { status: 400, error: 'bad_request' };
    // P7: a remote member's room post is kept here as a copy for the members
    // here (signed by its own author: the embedded Note is theirs).
    if (!local(m.signer) && fed) {
      const r = fed.storeCopy(m.ring, activity, m.signer, { note: o });
      if (r === 'another' || r === 'refused') return { status: 403, error: 'forbidden' };
    }
    // Update: a room Note, or Keep's re-address of one to Public (the one move).
    announceToMembers(m.ring, activity, origin);
    return { status: 202 };
  }

  /* A reaction on a room post: from a member, about a post addressed to THIS
   * ring; the post's own server decides, and what it applied is Announced.
   * P7: on a remote member's post (a COPY here) the reaction is recorded on the
   * copy and Announced to every member server for their copies; the post's
   * own server (the authority) applies only the copy the reactor's server
   * sent it directly (P7 review F2), and withdraws a refused one by Remove. */
  function toAuthority(activity, ctx) {
    const { origin } = ctx;
    const m = memberCtx(activity, ctx);
    if (!m) return NOPE;
    const o = activity.object;
    let postRef = '';
    if (activity.type === 'Like' || activity.type === 'EmojiReact') postRef = o;
    else if (activity.type === 'Undo') postRef = typeof o === 'object' ? o?.object : '';
    else if (activity.type === 'Create') postRef = o?.inReplyTo;
    else if (activity.type === 'Remove') postRef = activity.target;
    let owner = '';
    let postId = '';
    const l = urls.parseLocal(typeof postRef === 'string' ? postRef : '', origin);
    if (l?.kind === 'post') { owner = l.name; postId = l.id; }
    if (activity.type === 'Delete') {
      // A comment's Tombstone names no post: find the member's post that holds it.
      const id = typeof o === 'string' ? o : o?.id;
      for (const x of m.ring.members) {
        if (!local(x.handle) || members.get(x.handle)?.status !== 'active') continue;
        const row = reactions.loadComments(x.handle).find((c) => c.object_id === id);
        if (row) { owner = x.handle; postId = row.post_id; break; }
      }
      if (!owner && fed && rooms) {
        const copy = rooms.findComment(m.ring.id, id);
        if (copy) return fed.onCopy(m.ring, copy, activity, m.signer, { announce: (a) => announceToMembers(m.ring, a, origin) });
      }
    } else if (!owner && fed && rooms && typeof postRef === 'string') {
      const copy = rooms.find(postRef);
      if (copy && copy.ringId === m.ring.id) return fed.onCopy(m.ring, copy.post, activity, m.signer, { announce: (a) => announceToMembers(m.ring, a, origin) });
    }
    if (!owner || !R.isMember(m.ring, owner)) return NOPE;
    const post = pages.load(owner).posts.find((p) => p.id === postId);
    if (!post || post.audience !== m.ring.id) return NOPE;
    if (activity.type === 'Remove') {
      if (m.signer !== owner) return { status: 403, error: 'forbidden' };
      announceToMembers(m.ring, activity, origin);
      return { status: 202 };
    }
    const result = receive(activity, { inbox: { kind: 'person', name: owner }, origin, signer: activity.actor });
    if (result && result.status < 400 && result.action !== 'unchanged') announceToMembers(m.ring, activity, origin);
    // P7: a remote member's reaction the authority (here) refused: their server
    // recorded it on its copy, so the post's author withdraws it by Remove.
    else if (result && result.status >= 400 && !local(m.signer) && fed) fed.withdraw(m.ring, owner, postId, activity, origin);
    return result;
  }

  // ── a member's own inbox, for what a Group sends (P7 keeps replicas in lib/ring-fed.js) ──

  /* Admitted: past the 3-ring cap (a race), Leave at once and tell the member. */
  function onAdmitted(activity, { inbox, origin }) {
    const l = urls.parseLocal(activity.actor, origin);
    if (l?.kind !== 'group') return { status: 202, dropped: true };
    const me = inbox.name;
    const rings = ringStore.load();
    const ring = rings.find((r) => r.id === l.id);
    if (!ring || !R.isMember(ring, me)) return { status: 202 };
    if (R.ringsOf(rings, me).length > R.RING_MAX_PER_MEMBER) {
      audit('ring.over_cap_left', me, { ring: ring.id });
      outbox.emit(A.leaveGroup({ origin, name: me, ringId: ring.id }), [urls.groupUrl(origin, ring.id)], { origin });
      return { status: 202, left: true };
    }
    return { status: 202 };
  }

  /* Update{Group}, Remove, Reject{Join}, Delete{Group}, Announce: from a home
   * ring here, the row IS the ring and members read live: nothing to copy. */
  function fromHomeGroup(activity, { origin }) {
    const l = urls.parseLocal(activity.actor, origin);
    return { status: 202, dropped: l?.kind !== 'group' };
  }

  return {
    create, rename, link, leave, kick, destroy, ask, answer, purgeMember, dropHandle, expireLinks, tellMembers,
    commit, syncCopies, whoOf, actorOf: actor, announceToMembers, withheldHosts,
    bind: (f) => { fed = f; },
    group: {
      Join: onJoin, 'Accept:Join': onAnswer(true), 'Reject:Join': onAnswer(false), Leave: onLeave,
      Remove: onRemoveMember, 'Update:Group': onUpdateGroup, 'Delete:Group': onDeleteGroup,
      'Create:Note': onRoomNote, 'Update:Note': onRoomNote, 'Delete:Note': onRoomNote,
      Like: toAuthority, EmojiReact: toAuthority, 'Undo:Like': toAuthority, 'Undo:EmojiReact': toAuthority,
      'Remove:Reaction': toAuthority,
    },
    person: {
      'Accept:Join': onAdmitted, 'Reject:Join': fromHomeGroup, 'Update:Group': fromHomeGroup,
      Remove: fromHomeGroup, 'Delete:Group': fromHomeGroup, Announce: fromHomeGroup,
    },
  };
}

module.exports = { createGroups };
