'use strict';
/* ── Rings across servers, the member servers' half (spec 4.7, P7) ────────────
 * lib/groups.js is the HOME: the one authority for a ring's membership, code,
 * seats and approvals, and the Group that fans out. This module is everything
 * else a ring spanning servers needs, built only with FEDERATION=on:
 *
 * ASKING BY A LINK OF ANOTHER SERVER (askRemote, preview). The join link
 * `https://home/rings/join/<code>` is read with an AP `Accept`, signed by the
 * instance actor: the home answers the asker's view of the Group (name, the
 * hosts the members are on, its key; never the members). Only a RING server
 * hosts one (decision 7: its NodeInfo declares ringProtocol; a Mastodon host is
 * refused before anything is fetched from it), never a blocked domain (the
 * operator's BLOCKED_DOMAINS, or the member's own domain block). The member's
 * 3-ring cap is checked HERE before the Join goes; the ask is remembered
 * (`fed/ring-asks.json`: member, Group, the Join's id; 14 days, the link's
 * life), so the Group's answer is taken only about a Join this server sent.
 *
 * WHAT A GROUP SENDS (the `ring` table of lib/ap-inbound.js), taken only from a
 * Group this server has a replica of, or asked to join, and SIGNED BY THAT
 * GROUP'S KEY (the ring key on its home: lib/federation.js verified it, and a
 * `group` record of the actor cache is a Group, never a person):
 *   Accept{Join}   about a Join this server sent: the replica row is made from
 *                  the Group's members view (fetched now that a member here is
 *                  in it), and the live room is read from the Group's outbox.
 *                  Past the member's 3-ring cap (a race), Leave at once.
 *   Reject{Join}   the ask is forgotten
 *   Update{Group}  a higher `rev` replaces the replica whole; a lower or equal
 *                  one is ignored (reordering never rolls membership back). A
 *                  replica with no member here left is dropped, with its copies.
 *                  A member HERE is in it only if they asked (an open ask) or
 *                  already were: a home names no one here by itself (F1)
 *   Remove         a member here was removed: out of the replica at once, and
 *                  with no member here left, the ring, its copies and their
 *                  cached images go (the trust the home placed in this server)
 *   Delete{Group}  the replica, its copies and images go
 *   Announce       an activity of the room, applied by `applyInner` below
 *
 * THE ANNOUNCE CHECKS (4.7, the rules of P7). The inner activity is taken only
 * when its actor is a CURRENT MEMBER of the replica (a remote member here is a
 * bound handle; a member here is ignored: this server made it) and it is
 * ADDRESSED TO THE RING (its `to` or `audience` names the Group). A room Note
 * (a post or a comment) whose actor is NOT on the Group's host is never taken
 * from the Announce: it is fetched from its own host, signed as a member here
 * (spec 5.1), and only that copy lands (a Group can relay, never write, another
 * server's post). A reaction (a Like, its Undo, a comment, its Delete, a
 * Remove) relayed by the Group updates a COPY here only: what the members here
 * see of another server's post.
 *
 * THE AUTHORITY (P7 review F2). A reaction on a post of a member HERE is
 * applied only from the copy its REACTOR's server delivered to the author,
 * signed by the reactor (`reactionRoute`, and the member's and server's
 * tables for its Undo and a comment's Delete), by this server's own handlers
 * (lib/stamps.js, lib/comments.js: tiers, friendship, switches, blocks); the
 * Group's Announce of it changes nothing here. One they refuse is withdrawn on
 * every copy by a Remove from the post's author through the Group (`withdraw`).
 * A member here reacting to a copy sends to the Group and to the author
 * (`toRoom`). A reaction on a copy is recorded on the copy (lib/rooms.js).
 *
 * COPIES expire here at min(ring.expires, published + 7 days), Delete or not
 * (lib/rooms.js read-time expiry and the hourly sweep); the reset's Delete, a
 * Keep (the post left the room), the author leaving and the ring going all
 * remove them. Their images are fetched under the ring's read grant, only
 * from the author's host (or a media host recorded for it), as an id of THAT
 * ring, signed as a member here of that ring while a copy there names it
 * (`roomSigner`, F6, lib/remote-media.js), and served only to the ring's
 * members here (routes/remote.js). A copy is a Ring post (its markdown
 * source), within lib/rooms.js's caps (F7).
 *
 * WHAT A JOIN LINK SAYS (F3): the hosts of the asker's view are host names
 * (at most 6 of 255 chars each, else the link's own host), a members view's
 * join link is http(s) on the Group's host at the join path, and each row of
 * fed/ring-asks.json keeps bounded fields only.
 *
 * A REPLICA'S ACTS (`replica`): rename, the link, leave, kick, delete and
 * answering a request go to the Group as activities; the home decides, and its
 * Update{Group} is what the replica then shows. Leave and delete drop the
 * replica here at once.
 */
const clock = require('./clock');
const R = require('./rings');
const A = require('./activities');
const urls = require('./urls');
const { readJSON, writeJSON } = require('./store');
const { isHandle, normalizeHost, hostOfUrl: canonicalHostOfUrl } = require('./handles');
const { newRingId, newStampId, newCommentId } = require('./ids');
const { blocksHandle } = require('./ring');
const { settleObject, plainTextOf } = require('./remote-note');
const { paletteFace, normalizeCustomFace, normalizeCommentBody } = require('./reactions');
const { RING_POST_TTL_MS } = require('./ring-reset');

const ASK_TTL_MS = R.RING_JOIN_TTL_MS;
const ASKS_MAX = 2000;
const ASKS_PER_MEMBER = 10;
const RESOLVE_MAX = 12;   // actors an Update{Group} may make this server resolve (6 members, 6 requests)
const OUTBOX_MAX = 200;
const HOSTS_MAX = 6;      // the hosts a Group says hold its room (a ring has 6 seats)
const HOST_MAX = 255;     // one host, port included
const URL_MAX = 2000;     // a Group id, a Join id, a join link, kept in a row

const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const idOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.id === 'string' ? v.id : '');
// THE host normalizer's reading of a URL (lib/handles.js, P8 review F4).
const hostOf = canonicalHostOfUrl;
const JOIN_PATH = /^\/rings\/join\/([A-Za-z0-9_-]{8,64})$/;
const httpish = (u) => typeof u === 'string' && u.length <= URL_MAX && /^https?:\/\//i.test(u);

function createRingFed({ cfg, paths, members, pages, imageRow, ringStore, rooms, outbox, audit, groups, reactions, sent, follows, keys, federation, receive, logger = console }) {
  const origin = cfg.publicOrigin;
  const { actors, hosts, media, queue } = federation;
  const local = (h) => typeof h === 'string' && !!h && !h.includes('@');
  const activeHere = (h) => local(h) && members.get(h)?.status === 'active';
  const prepared = new WeakMap();   // activity -> what prepare() fetched for it

  // ── handles, keys, media ──

  const whoOf = (url) => actors.handleOf(url) || '';
  const actorOf = (handle) => (local(handle) ? urls.actorUrl(origin, handle) : actors.idOf(handle));
  const handleOfUrl = (url) => {
    const l = urls.parseLocal(url, origin);
    if (l) return l.kind === 'person' && members.get(l.name) ? l.name : '';
    return actors.handleOf(url) || '';
  };
  const isRingPeerHost = (h) => !!h && !federation.blockedHost(h) && Number(hosts.get(h)?.ring_protocol) >= 1;
  const isRingPeer = (handle) => !local(handle) && isRingPeerHost(handle.slice(handle.indexOf('@') + 1));
  const groupOf = (ring) => ring.ap_id || urls.groupUrl(origin, ring.id);
  /* The hosts a Group's document says hold the room (the asker's trust
   * notice, P7 review F3): each must be a host (the handle rules' shape, a
   * port only on the loopback test hook), at most HOST_MAX chars, at most
   * HOSTS_MAX of them; anything else is left out, and with nothing left the
   * link's own host stands for them. Never free text, never a length an
   * asker's file or screen pays for. */
  function hostsOfDoc(doc, linkHost) {
    const out = [];
    for (const x of arr(doc?.ring?.hosts)) {
      if (out.length >= HOSTS_MAX) break;
      if (typeof x !== 'string' || x.length > HOST_MAX) continue;
      const h = normalizeHost(x, { allowPort: cfg.fedTestLoopback });
      if (h && h === x.toLowerCase() && !out.includes(h)) out.push(h);
    }
    return out.length ? out : [linkHost].filter(Boolean);
  }
  /* A join link a Group's members view names: http(s), on the Group's own
   * host, the join path and nothing more (P7 review F3). */
  function joinUrlOk(u, groupId) {
    if (!httpish(u)) return '';
    let x;
    try { x = new URL(u); } catch { return ''; }
    if (!/^https?:$/.test(x.protocol) || x.search || x.hash || x.username || x.password || !JOIN_PATH.test(x.pathname)) return '';
    return x.host.toLowerCase() === hostOf(groupId) ? x.href : '';
  }
  const signerHere = (ring) => ring.members.map((m) => m.handle).find(activeHere) || '';
  const signAs = (name) => (name && keys.has(name) ? { keyId: urls.keyIdOf(origin, name), privateKey: keys.privateKey(name) } : null);
  const handleHost = (h) => (local(h) ? '' : h.slice(h.indexOf('@') + 1).toLowerCase());
  /* May a copy by `author` have its image fetched from `url` (P7 review F6)?
   * Only from the author's own host, or a media host recorded for it
   * (lib/hosts.js media_hosts: where its server's avatars already came from). */
  function mediaHostOk(author, url) {
    const h = hostOf(url);
    const own = handleHost(author);
    return !!h && !!own && (h === own || hosts.mediaHostsOf(own).includes(h));
  }
  /* The key a room image's fetch is signed with (lib/remote-media.js, at every
   * fetch): a member here of the ring the row is for, and only while a live
   * copy in THAT ring, by a current member whose host (or media host) serves
   * the URL, names this media id. Else null: nothing is fetched (F6). */
  function roomSigner(row, mediaId) {
    const ring = row?.ring ? ringStore.get(row.ring) : null;
    if (!ring) return [];
    const ok = rooms.mediaCopies(mediaId, ring.id).some((c) => R.isMember(ring, c.author) && mediaHostOk(c.author, row.url));
    // Each member here of THAT ring, in turn (one the author blocks gets a 404, F4).
    return ok ? localMembers(ring).map(signAs).filter(Boolean) : [];
  }
  const ringGone = (id) => {
    if (queue.hasSigner(`_ring:${id}`)) return;   // its last job removes it (lib/federation.js)
    keys.removeRing(id);
  };
  /* Room images go with their copy (spec 4.7), unless another copy names them. */
  function forgetMedia(ids) {
    if (!ids?.length) return 0;
    const still = rooms.mediaIds();
    return media.forget(ids, (id) => !still || still.has(id));
  }

  // ── the asks this server sent (fed/ring-asks.json) ──

  /* One row of fed/ring-asks.json, settled (P7 review F3): only its own
   * fields, each of a bounded size, so no Group's document can make the file
   * every ring activity reads grow past a few hundred bytes a row. */
  function settleAsk(a) {
    if (!a || !httpish(a.group) || !httpish(a.join_id) || !isHandle(a.member, { allowPort: true })) return null;
    const at = Date.parse(a.asked_at || '');
    if (!Number.isFinite(at)) return null;
    const hs = arr(a.hosts).filter((h) => typeof h === 'string' && h.length <= HOST_MAX && normalizeHost(h, { allowPort: cfg.fedTestLoopback }) === h).slice(0, HOSTS_MAX);
    return { member: a.member, group: a.group, join_id: a.join_id, name: R.normalizeRingName(a.name) || '', hosts: hs, asked_at: new Date(at).toISOString() };
  }
  function loadAsks() {
    const now = clock.now();
    const raw = readJSON(paths.fedRingAsks, []);
    return (Array.isArray(raw) ? raw.slice(-ASKS_MAX) : [])
      .map(settleAsk)
      .filter((a) => a && Date.parse(a.asked_at) + ASK_TTL_MS > now);
  }
  const saveAsks = (rows) => writeJSON(paths.fedRingAsks, rows.slice(-ASKS_MAX));
  const askOf = (member, group) => loadAsks().find((a) => a.member === member && a.group === group) || null;
  const asksFor = (group) => loadAsks().filter((a) => a.group === group);
  function dropAsks(pred) {
    const rows = loadAsks();
    const next = rows.filter((a) => !pred(a));
    if (next.length !== rows.length) saveAsks(next);
    return rows.length - next.length;
  }

  // ── replicas ──

  const replicaOf = (group) => ringStore.load().find((r) => !r.home && r.ap_id === group) || null;
  const localMembers = (ring) => ring.members.filter((m) => activeHere(m.handle)).map((m) => m.handle);

  /* The ring is gone for this server: the row, its copies and their images. */
  function dropReplica(ring, why) {
    ringStore.update((rings) => {
      const i = rings.findIndex((r) => r.id === ring.id);
      if (i < 0) return undefined;
      rings.splice(i, 1);
      return rings;
    });
    forgetMedia(rooms.drop(ring.id));
    audit('ring.replica_dropped', 'system', { ring: ring.id, group: ring.ap_id, why });
  }

  /* A Group document's members view as a replica row (handles resolved by
   * prepare; an actor this server could not resolve is left out until the next
   * Update). `prev` keeps the local id.
   * A HOME NAMES NO ONE HERE BY ITSELF (P7 review F1): a member of THIS server
   * enters a replica (or a request on it) only when they asked to join that
   * Group (`allow`: their open ask, fed/ring-asks.json), and stays only while
   * they are in the previous row; any other local handle a Group lists is left
   * out. So a home can never seat someone here who never asked, nor make their
   * server send a Leave for them. At most RING_MAX_MEMBERS seats. */
  function replicaFrom(doc, prev, names, allow) {
    const g = doc.ring || {};
    const handle = (u) => names.get(u) || handleOfUrl(u);
    const had = new Set(prev ? [...prev.members, ...prev.requests].map((m) => m.handle).filter(local) : []);
    const mayHold = (h) => !local(h) || had.has(h) || allow.has(h);
    const seen = new Set();
    const once = (h) => !!h && !seen.has(h) && seen.add(h);
    const membersOf = arr(g.members).map((m) => ({ handle: handle(idOf(m?.actor)), joined_at: typeof m?.joined_at === 'string' ? m.joined_at : '' }))
      .filter((m) => m.handle && mayHold(m.handle) && once(m.handle)).slice(0, R.RING_MAX_MEMBERS);
    const requests = arr(g.requests).map((q) => ({ handle: handle(idOf(q?.actor)), asked_at: typeof q?.asked_at === 'string' ? q.asked_at : '', join_id: typeof q?.join === 'string' ? q.join : '' }))
      .filter((q) => q.handle && mayHold(q.handle) && once(q.handle)).slice(0, Math.max(0, R.RING_MAX_MEMBERS - membersOf.length));
    const creator = handle(idOf(doc.attributedTo));
    return {
      id: prev?.id || newRingId(), ap_id: doc.id, home: false, name: R.normalizeRingName(doc.name) || prev?.name || '',
      created_by: membersOf.some((m) => m.handle === creator) ? creator : membersOf[0]?.handle || '', created_at: prev?.created_at || clock.iso(),
      members: membersOf, requests, kicked: [], join: null,
      join_url: joinUrlOk(g.join_url, doc.id),
      join_expires: typeof g.join_expires === 'string' && Number.isFinite(Date.parse(g.join_expires)) ? new Date(Date.parse(g.join_expires)).toISOString() : '',
      rev: Number.isSafeInteger(g.rev) && g.rev >= 0 ? g.rev : 0,
    };
  }

  /* Write a replica from the Group's document when its rev is higher. Returns
   * the row now held (or null when none, or none is wanted). `allow`: the
   * members here with an open ask to this Group (F1), read before the caller
   * forgets the ask it answers. */
  function applyGroupDoc(doc, names, { create = false, allow = null } = {}) {
    let saved = null;
    let made = false;
    let before = [];
    const may = allow || new Set(asksFor(doc.id).map((a) => a.member));
    ringStore.update((rings) => {
      const i = rings.findIndex((r) => !r.home && r.ap_id === doc.id);
      const prev = i >= 0 ? rings[i] : null;
      before = prev ? prev.members.map((m) => m.handle) : [];
      if (!prev && !create) return undefined;
      const next = replicaFrom(doc, prev, names, may);
      if (prev && next.rev <= prev.rev) return undefined;
      if (!next.members.some((m) => activeHere(m.handle))) {
        if (prev) rings.splice(i, 1); else return undefined;
        return rings;
      }
      if (prev) rings[i] = next; else { rings.push(next); made = true; }
      return rings;
    });
    saved = replicaOf(doc.id);
    if (!saved) {
      // No member here any more: the copies and their images go too.
      for (const id of rooms.ringIds()) if (!ringStore.get(id)) forgetMedia(rooms.drop(id));
      return null;
    }
    forgetMedia(rooms.keepAuthors(saved.id, (h) => R.isMember(saved, h)));
    if (made) audit('ring.replica_made', 'system', { ring: saved.id, group: saved.ap_id });
    // A member here newly in the ring (an Accept, or the Group's Update that
    // overtook it; only one who asked, above): the member's own 3-ring cap
    // (4.7). Past it (a race: they asked at 2 and joined another meanwhile),
    // Leave at once.
    for (const name of localMembers(saved)) {
      if (before.includes(name)) continue;
      audit('ring.joined', name, { ring: saved.id, group: saved.ap_id });
      if (R.ringsOf(ringStore.load(), name).length > R.RING_MAX_PER_MEMBER) {
        audit('ring.over_cap_left', name, { ring: saved.id });
        replica.leave(name, ringStore.get(saved.id) || saved);
      }
    }
    return replicaOf(doc.id);
  }

  // ── asking by a link of another server ──

  /* The Group behind a remote join link, read and checked. -> { doc, host } or
   * { error } (a status and a key). */
  async function readJoinLink(me, url) {
    let u;
    try { u = new URL(url); } catch { return { status: 404, error: 'not_found' }; }
    const h = u.host.toLowerCase();
    const m = JOIN_PATH.exec(u.pathname);
    if (!m || u.search || u.hash || !federation.isRemote(url)) return { status: 404, error: 'not_found' };
    if (federation.blockedHost(h) || blocksHandle(pages.settings(me), `_@${h}`)) return { status: 404, error: 'not_found' };
    const sw = await federation.softwareOf(h);
    if (!(Number(sw.ring_protocol) >= 1)) return { status: 400, error: 'ring_server_only' };
    let doc;
    try { ({ doc } = await actors.getDoc(url)); } catch { return { status: 404, error: 'not_found' }; }
    try { actors.acceptGroupDoc(doc, url); } catch { return { status: 404, error: 'not_found' }; }
    if (!httpish(doc.id)) return { status: 404, error: 'not_found' };
    return { doc, host: h, code: m[1] };
  }

  async function preview(me, url) {
    const r = await readJoinLink(me, url);
    if (r.error) return r;
    const rings = ringStore.load();
    const replica = rings.find((x) => !x.home && x.ap_id === r.doc.id);
    return {
      status: 200, type: 'join', local: false, url, name: R.normalizeRingName(r.doc.name),
      hosts: hostsOfDoc(r.doc, r.host),
      already_member: !!replica && R.isMember(replica, me), requested: !!askOf(me, r.doc.id),
      at_my_cap: R.ringsOf(rings, me).length >= R.RING_MAX_PER_MEMBER, max_members: R.RING_MAX_MEMBERS,
    };
  }

  async function askRemote(me, url) {
    const r = await readJoinLink(me, url);
    if (r.error) return r;
    // ── tick ──
    const rings = ringStore.load();
    const name = R.normalizeRingName(r.doc.name);
    const replica = rings.find((x) => !x.home && x.ap_id === r.doc.id);
    if (replica && R.isMember(replica, me)) return { status: 200, member: true, ring: replica };
    if (askOf(me, r.doc.id)) return { status: 200, requested: true, ring: { name } };
    if (R.ringsOf(rings, me).length >= R.RING_MAX_PER_MEMBER) return { status: 400, error: 'ring_limit' };
    const join = A.joinGroup({ origin, name: me, ringId: '', code: r.code, group: r.doc.id });
    const asks = loadAsks().filter((a) => !(a.member === me && a.group === r.doc.id));
    if (asks.filter((a) => a.member === me).length >= ASKS_PER_MEMBER) return { status: 429, error: 'rate_day' };
    asks.push({ member: me, group: r.doc.id, join_id: join.id, name, hosts: hostsOfDoc(r.doc, r.host), asked_at: clock.iso() });
    saveAsks(asks);
    audit('ring.asked_remote', me, { group: r.doc.id });
    outbox.emit(join, [r.doc.id], { origin });
    return { status: 200, requested: true, ring: { name } };
  }

  // ── a replica's acts: to the Group ──

  const sendTo = (ring, activity) => { outbox.emit(activity, [ring.ap_id], { origin }); return { status: 200, sent: true }; };
  const replica = {
    rename(me, ring, name) {
      if (!R.normalizeRingName(name)) return { status: 400, error: 'ring_name_required' };
      return sendTo(ring, A.renameGroup({ origin, name: me, ringId: ring.id, ringName: name, group: ring.ap_id }));
    },
    link: (me, ring, join) => sendTo(ring, A.linkGroup({ origin, name: me, ringId: ring.id, join, group: ring.ap_id })),
    leave(me, ring) {
      sendTo(ring, A.leaveGroup({ origin, name: me, ringId: ring.id, group: ring.ap_id }));
      dropLocalMember(ring.id, me, 'left');
      audit('ring.left', me, { ring: ring.id, group: ring.ap_id });
      return { status: 200, dissolved: false };
    },
    kick(me, ring, member) {
      if (ring.created_by !== me) return { status: 403, error: 'ring_creator_only' };
      if (member === me) return { status: 400, error: 'leave_instead' };
      const who = actorOf(member);
      if (!who || !R.isMember(ring, member)) return { status: 404, error: 'not_found' };
      return sendTo(ring, A.removeMember({ origin, name: me, ringId: ring.id, member, group: ring.ap_id, memberActor: who }));
    },
    destroy(me, ring) {
      if (ring.created_by !== me) return { status: 403, error: 'ring_creator_only' };
      sendTo(ring, A.deleteGroup({ origin, name: me, ringId: ring.id, group: ring.ap_id }));
      dropReplica(ring, 'deleted');
      return { status: 200 };
    },
    answer(me, ring, q, approve) {
      if (!q.join_id) return { status: 404, error: 'not_found' };
      sendTo(ring, A.answerJoin(approve ? 'Accept' : 'Reject', { origin, name: me, ringId: ring.id, joinId: q.join_id, group: ring.ap_id }));
      return { status: 200, admitted: approve, sent: true };
    },
  };

  /* A member here is out of a replica (left, removed, deleted); with nobody
   * here left in it, the ring goes from this server with its copies. */
  function dropLocalMember(ringId, name, why) {
    const ring = ringStore.get(ringId);
    if (!ring || ring.home || !R.isMember(ring, name)) return;
    const rest = ring.members.filter((m) => m.handle !== name);
    if (!rest.some((m) => activeHere(m.handle))) return dropReplica(ring, why);
    ringStore.update((rings) => {
      const i = rings.findIndex((r) => r.id === ringId);
      if (i < 0) return undefined;
      rings[i] = { ...rings[i], members: rest };
      return rings;
    });
  }

  /* The purge: a member here is gone from every replica (the home hears it
   * from the farewell's Delete{Person}), and their asks are forgotten. */
  function purgeLocal(name) {
    for (const r of ringStore.load()) if (!r.home && R.isMember(r, name)) dropLocalMember(r.id, name, 'member_deleted');
    dropAsks((a) => a.member === name);
  }

  // ── copies (a remote member's room post, here) ──

  /* Keep (or replace, or, re-addressed to Public by Keep, remove) a copy of
   * `activity`'s Note by `author` in `ring`. -> 'added'|'updated'|'removed'|
   * 'another'|'refused'|'expired'|'nobody' (no member here to keep it for). */
  function storeCopy(ring, activity, author, { note }) {
    const group = groupOf(ring);
    const signer = signerHere(ring);
    if (!signer) return 'nobody';
    const obj = settleObject(note, { actor: activity.actor });
    if (obj.refused || obj.type !== 'Note' || obj.in_reply_to) return 'refused';
    // A ring is Ring servers only (decision 7): a room copy is a Ring post, its
    // markdown source and Ring term, never another software's node tree (F7).
    if (!obj.ring || typeof obj.source !== 'string') return 'refused';
    if (obj.visibility !== 'private' || obj.audience !== group) {
      // Keep (4.9): the post left the room. Its copy goes; the author's
      // followers get it as a public Create, if this server follows them.
      if (activity.type === 'Update' && obj.visibility !== 'private') {
        const gone = rooms.remove(ring.id, obj.id, author);
        if (!gone) return 'refused';
        forgetMedia(gone);
        return 'removed';
      }
      return 'refused';
    }
    const published = Date.parse(obj.published || '');
    const term = Date.parse(note?.ring?.expires || '');
    if (!Number.isFinite(published) || published > clock.now() + 5 * 60_000) return 'refused';
    const expires = Math.min(Number.isFinite(term) ? term : published + RING_POST_TTL_MS, published + RING_POST_TTL_MS);
    // Its images (F6): only from the author's own host or a media host it is
    // known to use; the media id is this ring's, the fetch signed as a member
    // of THIS ring while a copy here names it (roomSigner). Any other image
    // URL stays a link the reader is never sent to fetch.
    const attachments = obj.attachments.map((a) => (a.kind === 'image' && mediaHostOk(author, a.url) ? { ...a, media: media.want(a.url, { room: ring.id }) || undefined } : a));
    return rooms.put(ring.id, { ...obj, attachments, author, expires: new Date(expires).toISOString() });
  }

  /* A reaction on a copy here, from a member of the ring (`from`, a handle).
   * `announce(activity)`: at the home, the Group passes it on. */
  function onCopy(ring, post, activity, from, { announce = null } = {}) {
    if (!R.isMember(ring, from)) return { status: 404, error: 'not_found' };
    const o = activity.object;
    let ok = false;
    switch (activity.type) {
      case 'Like': case 'EmojiReact': {
        const fromRing = activity.ring?.v === 1;
        const raw = fromRing && typeof activity.ring.face === 'string' ? activity.ring.face : activity.content;
        const custom = fromRing && activity.ring.custom === true;
        const face = custom ? normalizeCustomFace(raw) : paletteFace(raw);
        if (!face) return { status: 400, error: 'stamp_invalid' };
        ok = rooms.stamp(ring.id, post.id, { id: String(activity.id || ''), author: from, face, custom });
        break;
      }
      case 'Undo':
        ok = rooms.unstamp(ring.id, post.id, { id: idOf(o), author: from });
        break;
      case 'Create': {
        const note = prepared.get(activity)?.note || o;
        const text = note?.source?.mediaType === 'text/plain' && typeof note.source.content === 'string' ? note.source.content : plainTextOf(settleObject(note, { actor: activity.actor }));
        const body = normalizeCommentBody(text);
        if (!body) return { status: 400, error: 'comment_empty' };
        ok = rooms.comment(ring.id, post.id, { id: idOf(note), author: from, body });
        break;
      }
      case 'Delete':
        ok = rooms.uncomment(ring.id, post.id, { id: idOf(o), author: from });
        break;
      case 'Remove':
        if (post.author !== from) return { status: 403, error: 'forbidden' };
        ok = rooms.unreact(ring.id, post.id, idOf(o));
        break;
      default:
        return { status: 202, dropped: true };
    }
    if (ok && announce) announce(activity);
    return { status: ok ? 200 : 202, action: ok ? 'applied' : 'unchanged' };
  }

  /* The post's author withdraws a reaction its server refused, on every
   * server that holds a copy: Remove { object: reaction, target: post }. */
  function withdraw(ring, owner, postId, activity) {
    const reactionId = activity.type === 'Create' ? idOf(activity.object) : String(activity.id || '');
    if (!reactionId) return;
    const group = groupOf(ring);
    outbox.emit(A.removeReaction({ origin, name: owner, reactionId, postUrl: urls.postUrl(origin, owner, postId), group }), [group], { origin });
  }

  // ── what a Group sends (the `ring` table) ──

  const NOT = { status: 202, dropped: true };
  const fromGroup = (activity) => {
    const rec = actors.get(activity.actor);
    return rec?.group && !rec.gone_at ? activity.actor : '';
  };

  function onAccept(activity) {
    const group = fromGroup(activity);
    const joinId = idOf(activity.object);
    const ask = group ? loadAsks().find((a) => a.group === group && a.join_id === joinId) : null;
    if (!ask) return NOT;
    const p = prepared.get(activity);
    const allow = new Set(asksFor(group).map((a) => a.member));   // F1: read before the ask is forgotten
    dropAsks((a) => a.group === group && a.join_id === joinId);
    if (!p?.doc) {
      audit('ring.accept_unread', ask.member, { group });
      return NOT;
    }
    // applyGroupDoc holds the member's own 3-ring cap (Leave at once past it).
    const ring = applyGroupDoc(p.doc, p.names, { create: true, allow }) || replicaOf(group);
    if (!ring || !R.isMember(ring, ask.member)) return { status: 202 };
    setImmediate(() => { backfill(ring.id).catch((e) => logger.log(`[ring-fed] the room of ${group} was not read: ${e.message}`)); });
    return { status: 202, joined: true };
  }

  function onReject(activity) {
    const group = fromGroup(activity);
    const joinId = idOf(activity.object);
    if (!group) return NOT;
    const n = dropAsks((a) => a.group === group && a.join_id === joinId);
    if (n) audit('ring.ask_declined', 'system', { group });
    return { status: 202, forgot: n };
  }

  function onUpdateGroup(activity) {
    const group = fromGroup(activity);
    const doc = activity.object;
    if (!group || !doc || typeof doc !== 'object' || doc.id !== group || doc.type !== 'Group') return NOT;
    const names = prepared.get(activity)?.names || new Map();
    // A replica held here, or (an Accept still on its way) a ring a member here asked to join.
    const listed = arr(doc.ring?.members).map((m) => names.get(idOf(m?.actor)) || handleOfUrl(idOf(m?.actor)));
    const allow = new Set(asksFor(group).map((a) => a.member));
    const asked = [...allow].some((m) => listed.includes(m));
    const ring = applyGroupDoc(doc, names, { create: asked, allow });
    if (asked && ring) {
      dropAsks((a) => a.group === group && listed.includes(a.member));
      setImmediate(() => { backfill(ring.id).catch(() => {}); });
    }
    return { status: 202, rev: ring?.rev ?? null };
  }

  function onRemove(activity) {
    const group = fromGroup(activity);
    if (!group || activity.target !== group) return NOT;
    const ring = replicaOf(group);
    const l = urls.parseLocal(idOf(activity.object), origin);
    if (!ring || l?.kind !== 'person' || !R.isMember(ring, l.name)) return NOT;
    audit('ring.removed', l.name, { ring: ring.id, group });
    dropLocalMember(ring.id, l.name, 'removed');
    return { status: 202 };
  }

  function onDeleteGroup(activity) {
    const group = fromGroup(activity);
    if (!group || idOf(activity.object) !== group) return NOT;
    dropAsks((a) => a.group === group);
    const ring = replicaOf(group);
    if (ring) dropReplica(ring, 'group_deleted');
    return { status: 202 };
  }

  function onAnnounce(activity) {
    const group = fromGroup(activity);
    const ring = group ? replicaOf(group) : null;
    if (!ring || !localMembers(ring).length) return NOT;
    return applyInner(ring, activity.object, prepared.get(activity) || {});
  }

  /* One activity of the room, from the Group of `ring` (an Announce, or an
   * item of the Group's outbox). */
  function applyInner(ring, inner, p) {
    if (!inner || typeof inner !== 'object' || typeof inner.type !== 'string' || typeof inner.actor !== 'string') return NOT;
    const group = groupOf(ring);
    // Addressed to the ring (4.7), whatever it is.
    if (!arr(inner.to).includes(group) && inner.audience !== group) return NOT;
    if (urls.parseLocal(inner.actor, origin)) return { status: 202, ours: true };   // made here: nothing to copy
    const from = whoOf(inner.actor);
    if (!from || !R.isMember(ring, from)) return NOT;   // a current member of the ring, nobody else
    const onGroupHost = hostOf(inner.actor) === hostOf(group);
    const o = inner.object;
    const isNote = (inner.type === 'Create' || inner.type === 'Update') && o && typeof o === 'object' && o.type === 'Note';
    // A room Note from another host than the Group's is the fetched copy only.
    const note = isNote ? (onGroupHost ? o : p.note) : null;
    if (isNote && !note) return { status: 202, unfetched: true };
    if (isNote && (idOf(note) !== idOf(o) || idOf(arr(note.attributedTo)[0]) !== inner.actor)) return NOT;
    const act = note ? { ...inner, object: note } : inner;
    if (note) prepared.set(act, { note });

    if (isNote && !note.inReplyTo) {
      const r = storeCopy(ring, act, from, { note });
      return { status: 202, copy: r };
    }
    // A reaction: on a post of a member here (the authority) or on a copy.
    let postRef = '';
    if (inner.type === 'Like' || inner.type === 'EmojiReact') postRef = idOf(o);
    else if (inner.type === 'Undo') postRef = idOf(o?.object);
    else if (isNote) postRef = idOf(note.inReplyTo);
    else if (inner.type === 'Remove') postRef = idOf(inner.target);
    else if (inner.type === 'Delete') {
      const id = idOf(o);
      const copy = rooms.find(id);
      if (copy && copy.ringId === ring.id) {
        if (copy.post.author !== from) return NOT;
        forgetMedia(rooms.remove(ring.id, id, from) || []);
        return { status: 202, removed: true };
      }
      const held = rooms.findComment(ring.id, id);
      if (held) return onCopy(ring, held, inner, from);
      // A comment on a post of a member here: this server is its authority, and
      // takes the reactor's own signed Delete only (F2), never the Group's word.
      return NOT;
    }
    const l = urls.parseLocal(postRef, origin);
    // THE AUTHORITY TAKES NOTHING ON THE GROUP'S WORD (P7 review F2): a
    // reaction on a post of a member here was delivered to its author signed
    // by the reactor (routeOf, `reaction`), and that copy alone is applied
    // here. What the Group relays updates copies on member servers only.
    if (l?.kind === 'post') return { status: 202, authority: true };
    const copy = rooms.find(postRef);
    if (copy && copy.ringId === ring.id) return onCopy(ring, copy.post, act, from);
    return NOT;
  }

  /* The live room from the Group's outbox, once, when this server's replica is
   * made (an Announce may have arrived before the Accept: dropped then). */
  async function backfill(ringId) {
    const ring = ringStore.get(ringId);
    if (!ring || ring.home) return 0;
    const { doc } = await actors.getDoc(`${ring.ap_id}/outbox`);
    let n = 0;
    for (const item of arr(doc.orderedItems || doc.items).slice(0, OUTBOX_MAX)) {
      if (item?.type !== 'Announce' || item.actor !== ring.ap_id) continue;
      let p = {};
      try { p = await prepareAnnounce(item, ring); } catch { continue; }
      // ── tick ──
      const now = ringStore.get(ringId);
      if (!now) return n;
      const r = applyInner(now, item.object, p);
      if (r?.copy === 'added') n++;
    }
    if (n) logger.log(`[ring-fed] ${ring.ap_id}: ${n} room posts read from its outbox`);
    return n;
  }

  // ── prepare: what a handler needs fetched, BEFORE its synchronous tick ──

  /* Resolve remote actor URLs to handles (the actor cache), at most RESOLVE_MAX. */
  async function resolveAll(list) {
    const names = new Map();
    for (const u of [...new Set(list.filter((x) => typeof x === 'string' && x))].slice(0, RESOLVE_MAX)) {
      const l = urls.parseLocal(u, origin);
      if (l) { if (l.kind === 'person') names.set(u, l.name); continue; }
      if (federation.blockedHost(hostOf(u))) continue;
      try { const rec = await actors.resolve(u); if (rec?.handle) names.set(u, rec.handle); } catch { /* left out */ }
      // Its server's NodeInfo too (daily, cached): a member's reaction goes to
      // a ring-mate's server only when it is a Ring server (decision 7, F2).
      if (names.has(u)) await federation.softwareOf(hostOf(u));
    }
    return names;
  }
  const docActors = (doc) => [idOf(doc?.attributedTo), ...arr(doc?.ring?.members).map((m) => idOf(m?.actor)), ...arr(doc?.ring?.requests).map((q) => idOf(q?.actor))];

  async function prepareAnnounce(activity, ring) {
    const inner = activity.object;
    if (!inner || typeof inner !== 'object' || typeof inner.actor !== 'string') return {};
    const out = {};
    if (!urls.parseLocal(inner.actor, origin) && !federation.blockedHost(hostOf(inner.actor))) {
      try { await actors.resolve(inner.actor); } catch { return out; }
    }
    const o = inner.object;
    const isNote = (inner.type === 'Create' || inner.type === 'Update') && o && typeof o === 'object' && o.type === 'Note';
    if (isNote && hostOf(inner.actor) !== hostOf(activity.actor) && ring) {
      const id = idOf(o);
      if (id && hostOf(id) === hostOf(inner.actor) && !federation.blockedHost(hostOf(id))) {
        // Signed as a member here of the ring; one its author blocks reads
        // nothing there (F4), so the next member here is asked, in turn.
        for (const name of localMembers(ring)) {
          const as = signAs(name);
          if (!as) continue;
          try {
            const { doc } = await actors.getDoc(id, { signAs: as });
            if (doc.id === id && doc.type === 'Note') { out.note = doc; break; }
          } catch (e) { logger.log(`[ring-fed] room Note ${id} not fetched as ${name}: ${e.message}`); }
        }
      }
    }
    return out;
  }

  /* Called by lib/federation.js, after the signature, before the handler.
   * Never throws: what could not be fetched is simply absent. */
  async function prepare(activity, route) {
    try {
      if (route.inbox.kind === 'group') {
        // A Join from another server: its NodeInfo, so the home knows a Ring peer.
        if (activity.type === 'Join' && !urls.parseLocal(activity.actor, origin)) await federation.softwareOf(hostOf(activity.actor));
        return;
      }
      const group = fromGroup(activity);
      if (!group) return;
      if (activity.type === 'Accept' && asksFor(group).some((a) => a.join_id === idOf(activity.object))) {
        const { doc } = await actors.getDoc(group);
        if (doc?.id !== group || doc.type !== 'Group') return;
        prepared.set(activity, { doc, names: await resolveAll(docActors(doc)) });
      } else if (activity.type === 'Update' && activity.object?.type === 'Group') {
        prepared.set(activity, { names: await resolveAll(docActors(activity.object)) });
      } else if (activity.type === 'Announce') {
        prepared.set(activity, await prepareAnnounce(activity, replicaOf(group)));
      }
    } catch (e) { logger.log(`[ring-fed] prepare ${activity.type}: ${e.message}`); }
  }

  /* Where an inbound activity goes, if it is a ring's: { inbox, key } or null.
   * From a Group record: the `ring` table. To a Group whose home is here:
   * that Group's table. */
  function routeOf(activity) {
    if (fromGroup(activity)) return { inbox: { kind: 'ring' } };
    const candidates = [...arr(activity.to), activity.audience, activity.target, idOf(activity.object)];
    for (const c of candidates) {
      const l = typeof c === 'string' ? urls.parseLocal(c, origin) : null;
      if (l?.kind === 'group' && ringStore.get(l.id)?.home) return { inbox: { kind: 'group', id: l.id } };
    }
    return reactionRoute(activity);
  }

  /* A room reaction signed by its REACTOR, delivered to the author of a post
   * here in a ring hosted ELSEWHERE (P7 review F2: this server is that post's
   * authority, and this is the one copy it applies): a Like or EmojiReact, or
   * a comment's Create, addressed to that ring's Group, on a live room post of
   * a member here who is in it. -> the author's table, and after it, a refused
   * reaction withdrawn on every copy (its author's Remove, through the Group).
   * Its Undo and a comment's Delete need nothing more than the member's and
   * the server's tables already do (lib/federation.js), so they go there. */
  function reactionRoute(activity) {
    const t = activity.type;
    const o = activity.object;
    let postRef = '';
    if (t === 'Like' || t === 'EmojiReact') postRef = idOf(o);
    else if (t === 'Create' && o && typeof o === 'object' && o.type === 'Note') postRef = idOf(o.inReplyTo);
    if (!postRef) return null;
    const l = urls.parseLocal(postRef, origin);
    if (l?.kind !== 'post' || !activeHere(l.name)) return null;
    const post = pages.post(l.name, l.id);
    const ring = post ? ringStore.get(post.audience) : null;
    if (!ring || ring.home || !R.isMember(ring, l.name)) return null;
    const g = ring.ap_id;
    const addressed = (x) => !!x && (arr(x.to).includes(g) || x.audience === g);
    if (!addressed(activity) || (t === 'Create' && !addressed(o))) return null;
    return {
      inbox: { kind: 'person', name: l.name },
      reaction: true,
      after(result) {
        // Only a ring-mate's reaction can sit on a copy elsewhere: a stranger's
        // refusal is withdrawn nowhere (nothing to withdraw, nothing amplified).
        const now = ringStore.get(ring.id);
        if (result && result.status >= 400 && now && R.isMember(now, whoOf(activity.actor))) withdraw(now, l.name, l.id, activity);
      },
    };
  }

  /* A Group record that went 410 (its home deleted it): the replica goes. */
  function groupGone(group) {
    dropAsks((a) => a.group === group);
    const ring = replicaOf(group);
    if (ring) dropReplica(ring, 'group_gone');
  }

  /* Housekeeping (P7) and an admin's block (P8, lib/moderate.js): replicas of a
   * ring hosted on a blocked domain go; a blocked domain's people, and a person
   * the admin blocks server-wide, leave the home rings here; their copies in
   * a ring hosted elsewhere go from this server (the ring's home decides who
   * is in it; this server keeps none of theirs). -> how many rings changed. */
  function sweepBlocked() {
    let n = 0;
    const blocked = (h) => !local(h) && (federation.blockedHost(h.slice(h.indexOf('@') + 1)) || federation.handleBlocked(h));
    for (const r of ringStore.load()) {
      if (!r.home && federation.blockedHost(hostOf(r.ap_id))) { dropReplica(r, 'domain_blocked'); n++; continue; }
      if (!r.home) {
        const media = rooms.keepAuthors(r.id, (h) => !blocked(h));
        if (media.length) { forgetMedia(media); n++; }
        continue;
      }
      for (const h of [...r.members, ...r.requests].map((x) => x.handle)) {
        if (blocked(h)) { groups.dropHandle(h, origin); n++; }
      }
    }
    dropAsks((a) => federation.blockedHost(hostOf(a.group)));
    return n;
  }

  /* The Group's outbox at the home (routes/federation.js): the live room as
   * Announces. A member's post here is its Create; a copy (another server's
   * post) is named by its id alone, so a reader fetches it from its own host. */
  function outboxItems(ring, { host = '' } = {}) {
    const nowMs = clock.now();
    const items = [];
    const group = urls.groupUrl(origin, ring.id);
    const to = [group];
    for (const m of ring.members) {
      if (!activeHere(m.handle)) continue;
      // The block wins (F4): not to a server whose ring members the author all blocks.
      if (host && groups.withheldHosts(ring, m.handle).has(host)) continue;
      for (const p of pages.load(m.handle).posts) {
        if (p.audience !== ring.id || p.kind === 'divider' || Date.parse(p.created_at) + RING_POST_TTL_MS <= nowMs) continue;
        const create = A.createPost(p, { origin, name: m.handle, imageRow });
        if (create) items.push(A.bare(A.announce({ origin, ringId: ring.id, activity: create, to })));
      }
    }
    for (const c of rooms.metas(ring.id, nowMs)) {
      if (!R.isMember(ring, c.author)) continue;
      const author = actorOf(c.author);
      if (!author) continue;
      const create = { id: `${c.id}/activity`, type: 'Create', actor: author, to, audience: group, object: { id: c.id, type: 'Note', attributedTo: author, to, audience: group } };
      items.push(A.bare(A.announce({ origin, ringId: ring.id, activity: create, to })));
    }
    return items.slice(0, OUTBOX_MAX);
  }

  /* A room reaction of a member here goes to the Group (which passes it to
   * the members' servers, for their copies) AND, signed by its reactor, to the
   * post author's own actor (P7 review F2): the post's server is the authority
   * and applies only that copy. When the author is on the Group's host, the
   * Group's own inbox is that server: one delivery. */
  function toRoom(ring, activity, authorHandle) {
    const group = groupOf(ring);
    const author = actorOf(authorHandle);
    const to = [group];
    if (author && hostOf(author) !== hostOf(group)) to.push(author);
    outbox.emit(activity, to, { origin });
  }

  /* Before a reaction on a copy (routes/remote.js): the author's server's
   * NodeInfo is known, so toRoom can tell it is a Ring server. Never throws. */
  async function readyFor(found) {
    const h = handleHost(found?.post?.author || '');
    if (h && !federation.blockedHost(h)) { try { await federation.softwareOf(h); } catch { /* unknown: not sent */ } }
  }

  /* A local member's reaction on a COPY (routes/remote.js): to the Group and
   * the author (toRoom); a replica records it here first (the Group does not
   * announce it back to the server it came from); at the home the Group's own
   * handler records it. */
  function reactToCopy(me, found, { face, body }) {
    const ring = ringStore.get(found.ringId);
    if (!ring || !R.isMember(ring, me)) return { status: 404, error: 'not_found' };
    const post = found.post;
    const group = groupOf(ring);
    const author = actorOf(post.author);
    if (!author) return { status: 404, error: 'not_found' };
    if (face !== undefined) {
      let f = paletteFace(face);
      let custom = false;
      if (!f) { f = normalizeCustomFace(face); custom = true; }
      if (!f) return { status: 400, error: 'stamp_invalid' };
      const prev = post.stamps.find((s) => s.author === me);
      const mine = sent.load(me).find((r) => r.kind === 'stamp' && r.object === post.id);
      if (prev || mine) {
        const like = mine?.activity || { id: prev.id, type: 'Like', actor: urls.actorUrl(origin, me), object: post.id, to: [group], audience: group };
        const undo = A.undo({ origin, name: me, activity: like });
        if (!ring.home) rooms.unstamp(ring.id, post.id, { id: idOf(like), author: me });
        toRoom(ring, undo, post.author);
        if (mine) sent.remove(me, 'stamp', mine.id);
        if ((prev?.face || mine?.face) === f) return { status: 200, action: 'removed', mine: '' };
      }
      const stampId = newStampId();
      const like = A.like({ origin, name: me, stampId, postUrl: post.id, postAuthor: author, face: f, custom, group });
      const { '@context': _c, ...bare } = like;
      sent.put(me, { id: stampId, kind: 'stamp', object: post.id, author: post.author, face: f, ...(custom ? { custom: true } : {}), activity: bare, group, at: clock.iso() });
      if (!ring.home) rooms.stamp(ring.id, post.id, { id: like.id, author: me, face: f, custom });
      toRoom(ring, like, post.author);
      return { status: 200, action: prev || mine ? 'changed' : 'added', mine: f, id: stampId, sent_as: 'Like' };
    }
    if (!follows.friends(me, post.author)) return { status: 403, error: 'comments_friends_only' };
    const text = normalizeCommentBody(body);
    if (!text) return { status: 400, error: 'comment_empty' };
    const commentId = newCommentId();
    const create = A.createComment({ origin, name: me, commentId, postUrl: post.id, postAuthor: author, postAuthorHandle: post.author, body: text, published: clock.iso(), group });
    const { '@context': _c, ...bare } = create;
    sent.put(me, { id: commentId, kind: 'comment', object: post.id, author: post.author, body: text, activity: bare, group, at: clock.iso() });
    if (!ring.home) rooms.comment(ring.id, post.id, { id: create.object.id, author: me, body: text });
    toRoom(ring, create, post.author);
    return { status: 200, id: commentId };
  }

  /* Taking one back (routes/remote.js DELETE): the sent row names its Group. */
  function takeBackFromCopy(me, row) {
    const found = rooms.find(row.object);
    const ring = found ? ringStore.get(found.ringId) : null;
    // To the Group and the author (toRoom), or, with the copy gone, the Group alone.
    const send = (a) => (ring && found ? toRoom(ring, a, found.post.author) : outbox.emit(a, [row.group], { origin }));
    if (row.kind === 'stamp') {
      send(A.undo({ origin, name: me, activity: row.activity }));
      if (ring && !ring.home) rooms.unstamp(ring.id, row.object, { id: idOf(row.activity), author: me });
    } else {
      const objectId = row.activity?.object?.id || urls.commentUrl(origin, me, row.id);
      send(A.deleteComment({ origin, name: me, objectId, to: [row.group], audience: row.group, deleted: clock.iso() }));
      if (ring && !ring.home) rooms.uncomment(ring.id, row.object, { id: objectId, author: me });
    }
    sent.remove(me, row.kind, row.id);
    return { status: 200 };
  }

  /* The cards of a ring's copies, for its members here (lib/feeds.js). */
  const copiesOf = (ring, nowMs = clock.now()) => rooms.list(ring.id, nowMs).filter((c) => R.isMember(ring, c.author));

  return {
    whoOf, knownHandle: whoOf, actorOf, isRingPeer, isRingPeerHost, publicKeyPem: (id) => keys.ringPublicKeyPem(id), ensureKey: (id) => keys.ensureRing(id),
    forgetMedia, ringGone, storeCopy, onCopy, withdraw, purgeLocal, replica, askRemote, preview, prepare, routeOf, groupGone,
    sweepBlocked, outboxItems, reactToCopy, takeBackFromCopy, readyFor, copiesOf, backfill, askOf, loadAsks, applyInner, roomSigner,
    handlers: { 'Accept:Join': onAccept, 'Reject:Join': onReject, 'Update:Group': onUpdateGroup, Remove: onRemove, 'Delete:Group': onDeleteGroup, Announce: onAnnounce },
  };
}

module.exports = { createRingFed, ASK_TTL_MS };
