'use strict';
/* ── Federation: P5's read side and following, P6's write side (spec 4, 5, 7) ─
 * Built only with FEDERATION=on (lib/app.js); with it off nothing here exists,
 * nothing is delivered and every AP route 404s.
 *
 * OUT (lib/outbox.js bindRemote -> remote()): the part of an emit addressed to
 * other servers. What may leave (mayLeave), and nothing else:
 *   Follow of a remote actor, by a member (P6: befriending across servers)
 *   Accept / Reject of a Follow; Undo of a Follow, a Like or an EmojiReact
 *   Like / EmojiReact of a remote post (P6; shaped by the other side's
 *     software, lib/activities.js stampRemote)
 *   Create / Update of a PUBLIC Note (to as:Public, no audience, not a reply)
 *   Create of a COMMENT on a remote post (P6: a Note in reply, to its author,
 *     cc as:Public: an unlisted reply), and its Delete{Tombstone}
 *   Delete of a public post (to as:Public, the object one of the actor's posts)
 *   Add / Remove on the actor's own `featured`
 *   Update{Person} of the actor itself; Delete{Person} of the actor itself (P6,
 *     the account deletion's farewell)
 * A room post, a Group activity and an archive post (never an activity at all)
 * never become a job here: P7 widens this list for rings, with its own gate. A
 * followers collection expands to the author's ACCEPTED remote followers (local
 * ones read the author live), and the queue checks each of them against the
 * author's blocks again at send time (6.1). One fan-out job per emit
 * (lib/queue.js), written in the emit's own tick. A signer who is not an active
 * member (suspended) sends nothing.
 *
 * IN (inboxPost): the checks of spec 5.2 in order, then the registry (4.10):
 *   1   rate per client (the route, before anything); per VERIFIED remote host
 *       after step 8 (`fed-host-inbox`), so a stranger naming a host's keyId
 *       spends none of that host's budget
 *   2   content type and the 256 KB cap (the route)
 *   3-5 signature header, Date and Host, the signed Digest (lib/http-sig.js)
 *   6   domain blocks: the admin's list (P8, lib/moderation.js; BLOCKED_DOMAINS
 *       is only its seed): the keyId's host blocked answers 403 before any key
 *       is fetched. After step 8, a signer the admin blocks server-wide (an
 *       actor block, 6.3) answers 403 too, and so does a forwarded activity
 *       whose actor is blocked
 *   7   the key, from the actor cache or fetched (lib/actors.js), refetched once;
 *       a fetch costs the client's key-fetch budget (30 a minute, 4 in flight)
 *       and, for an IPv6 client, its /48's too (60 a minute, 8 in flight), waits
 *       on the INBOUND gate (never the deliveries'), 5 s at most per document,
 *       and a failed keyId is not fetched again for 5 minutes. A refusal of any
 *       of these (a spent budget, a full slot set, a full or slow gate: ERR_BUSY)
 *       is a 429 with Retry-After, never a 401: the sender is not wrong, this
 *       server is busy. An UNBOUND key (an instance actor whose WebFinger does
 *       not answer, lib/actors.js) never signs a POST: 401
 *   8   replay of a signature value inside the window (persisted, lib/http-sig.js)
 *   9   the body (depth 32, no prototype keys); the activity's actor must be the
 *       key's owner, else (a forwarded activity) it is fetched by its id from
 *       its own host, redirects off, and only that copy is processed, when the
 *       URL asked, the URL answered and its id are one string and its actor is
 *       on that host. That fetch is a key fetch's twin (N8): the same client
 *       budget and slots, the same gate and 5 s, the same negative cache
 *   10  an id on the actor's host, not seen within 7 days (lib/seen.js)
 *   11  OWNERSHIP (5.4, `ownership`), then the ROUTE (`targetsOf`: the members
 *       it is for, and/or the server's own table, lib/remote-in.js), then the
 *       handlers (lib/ap-inbound.js receive, the one door), each of which holds
 *       the member's blocks; only an activity actually handled is recorded as
 *       seen (N5)
 * THE REGISTRY from another server (P6, REMOTE_KEYS): Follow, Undo{Follow},
 * Accept and Reject of a Follow, Like, EmojiReact, Undo of either,
 * Create{Note|Article|Page}, Update{Note|Article|Page}, Delete{Note},
 * Update{Person}, Delete{Person}, Block. P7 adds the ring activities (Join,
 * Leave, Remove, Announce from a Group, Update and Delete of a Group), P8 Flag
 * (from any actor, to the server's table: lib/moderate.js files it in the
 * admin's queue, one report per member it names, budgeted per site, its
 * objects that are not ours dropped).
 * A member who is not ACTIVE (suspended, P8) is no target: what is for them
 * is dropped (spec 4.9).
 * Everything else answers 202 and is dropped: boosts (Announce), Move,
 * Question, and every object type but Note (a friend's Article or Page is a
 * titled link on their wall).
 * A `Follow` of the INSTANCE actor is answered `Reject` once per actor per day
 * (N2), as a courtesy job (refused past the queue's caps, lib/queue.js); a
 * repeat inside the day gets the 202 and nothing else.
 * A `Delete` of an actor this server never saw is answered 202 before any fetch
 * (Mastodon sends one for every deleted account to every server it knows).
 * Verified traffic from a host clears its failing marks (lib/hosts.js), and the
 * first verified inbound activity, first verified signed GET or first delivery
 * stamps `federated_at` (N11).
 *
 * STILL SENDABLE (N3): sendable(job), asked by the queue when a fan-out runs and
 * before every attempt. A signer who is no longer an active member (deleted,
 * suspended) sends only Delete, Reject and Undo; a Create, Update{Note}, Add or
 * Remove of a post goes only while the page is on and the post is still
 * public; a comment's Create goes while its author is active.
 *
 * SIGNED GETS (verifyGet): authorized fetch (5.10) for outbox, collections and
 * objects: the route spends the client's signed-GET budget first, then the
 * same steps 3, 4, 6 and 7 (the same key getter and budgets; an UNBOUND
 * instance-actor key may sign a read), then the verified host's own bucket
 * (`fed-host-get`, 120 a minute, apart from the inbox's).
 * Not 8: an RSA signature is deterministic, so two honest fetches of one URL inside
 * the same second carry the same value; a replayed read reads only what its
 * signer may read, and the one-hour Date window still bounds it.
 *
 * P6 ALSO: softwareOf(host) reads a host's NodeInfo once a day on use into
 * hosts.json (a stamp picks its activity by it, 4.8); fetchObject(url) reads a
 * remote post for a lookup or a stamp (signed by the instance actor, redirects
 * off, the id fetched once more on its own host when it differs); backfill(
 * handle) reads a new friend's outbox once (4.6); a blocked domain (the admin's
 * list, P8) refuses every fetch and delivery to it at the fetcher (lib/net.js
 * refuseHost);
 * visitorTemplate(handle) reads an anonymous visitor's subscribe template on
 * a gate of its own (2 at once, 1 per host, no line), 3 s, under one
 * server-wide budget for every visitor together (30 a minute, 300 an hour).
 */
const clock = require('./clock');
const urls = require('./urls');
const A = require('./activities');
const { createNet, createGate, parseJsonSafe } = require('./net');
const { verifyRequest, createReplayGuard, parseSignature } = require('./http-sig');
const { createActors } = require('./actors');
const { createHosts } = require('./hosts');
const { createSeen } = require('./seen');
const { createQueue, ESSENTIAL } = require('./queue');
const { createMedia } = require('./remote-media');
const { clientId, prefix48Of } = require('./rate-limit');
const { keyOf, RING_KEYS, GROUP_KEYS } = require('./ap-inbound');
const { blocksHandle } = require('./ring');
const { hostUnder, hostOfUrl: canonicalHostOfUrl } = require('./handles');
const { settleObject, idUnderActor } = require('./remote-note');
const { newActivityId } = require('./ids');

const AS_PUBLIC = urls.AS_PUBLIC;
// The inbound registry from another server (spec 4.10; P6). P7 adds the rings'.
const REMOTE_KEYS = new Set([
  'Follow', 'Undo:Follow', 'Accept:Follow', 'Reject:Follow',
  'Like', 'EmojiReact', 'Undo:Like', 'Undo:EmojiReact',
  'Create:Note', 'Create:Article', 'Create:Page',
  'Update:Note', 'Update:Article', 'Update:Page', 'Delete:Note',
  'Update:Person', 'Delete:Person', 'Block',
  'Flag',   // P8: the reports queue (spec 6.2)
]);
// Budgets (spec 5.9). Per VERIFIED remote host, spent only after the signature
// verifies (a stranger naming a host's keyId spends nothing of that host's):
const INBOX_RULE = { perMinute: 120, perHour: 3000 };       // fed-host-inbox
const SIGNED_GET_RULE = { perMinute: 120 };                 // fed-host-get
// Per CLIENT (the lib/rate-limit.js client id), before verification: a key this
// server must fetch to verify a request costs from KEY_FETCH_RULE, and one client
// has at most KEY_FETCH_PER_CLIENT such fetches in flight (the rest 429 at once).
const KEY_FETCH_RULE = { perMinute: 30 };                   // fed-key-fetch
const KEY_FETCH_PER_CLIENT = 4;
// An IPv6 client is a /64; its /48 (one site) has an aggregate budget on top, so
// 65 536 /64s of one allocation are not 65 536 budgets.
const KEY_FETCH_RULE_48 = { perMinute: 60 };                // fed-key-fetch, per /48
const KEY_FETCH_PER_48 = 8;
// What one document fetched for an INBOUND request may take (its key, a
// forwarded activity): a silent host holds a gate slot this long at most.
const INBOUND_FETCH_MS = 5000;
// The instance actor answers a Follow with Reject once per actor per window.
const INSTANCE_REJECT_WINDOW_MS = 24 * 3600_000;
const INSTANCE_REJECT_MAX = 10_000;
// Inbound key fetches wait on their own gate (lib/net.js), never the deliveries'.
const INBOUND_GATE = { perHost: 2, overall: 8, maxWaiting: 32 };
// An ANONYMOUS visitor's "from your server" (F4: /authorize_interaction/remote)
// makes this server read their server's WebFinger: on a gate of its own (never
// the deliveries' or the inbound one), refused at once when full, 3 s at most,
// and every visitor together spends one server-wide budget.
const ANON_GATE = { perHost: 1, overall: 2, maxWaiting: 0 };
const ANON_FETCH_MS = 3000;
const ANON_FETCH_RULE = { perMinute: 30, perHour: 300 };   // fed-anon-fetch, all visitors
// NodeInfo: once a day per host on use; a failed read is asked again after an hour.
const NODEINFO_FRESH_MS = 24 * 3600_000;
const NODEINFO_RETRY_MS = 3600_000;
// A lookup keeps what it fetched for an hour, so a stamp on it needs no refetch.
const LOOKED_TTL_MS = 3600_000;
const LOOKED_MAX = 2000;
const BACKFILL_ITEMS = 20;
const VERSION = require('../package.json').version;

// THE host normalizer's reading of a URL (lib/handles.js, P8 review F4).
const hostOf = canonicalHostOfUrl;
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const idOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.id === 'string' ? v.id : '');

function createFederation({ cfg, paths, keys, members, pages, audit, markFederated, limits, moderation, logger = console }) {
  const origin = cfg.publicOrigin;
  const host = urls.hostOf(origin).toLowerCase();
  keys.ensureInstance();
  /* The admin's domain blocks (P8, lib/moderation.js): a host under one of
   * them, port or not. Without the store (a unit test) the P6 env list. */
  const blockedHost = moderation ? moderation.hostBlocked : (h) => !!h && (cfg.blockedDomains || []).some((d) => hostUnder(h, d));
  /* A remote handle or actor URL the admin blocks server-wide (its domain, or
   * the person: an actor block, 6.3). */
  const handleBlocked = moderation ? moderation.handleBlocked : (h) => typeof h === 'string' && h.includes('@') && blockedHost(h.slice(h.indexOf('@') + 1));
  const actorBlocked = moderation ? moderation.actorBlocked : (id) => blockedHost(hostOf(id));
  const net = createNet({ allowLoopback: cfg.fedTestLoopback, userAgent: `Ring/${VERSION} (+${origin}/)`, refuseHost: blockedHost });
  // A room image (P7) is fetched signed as a member of the ring it is for,
  // while a copy there names it (lib/ring-fed.js roomSigner, P7 review F6).
  const media = createMedia({ paths, net, logger, roomSigner: (row, id) => (ringFed_ ? ringFed_.roomSigner(row, id) : null) });
  const hosts = createHosts(paths.fedHosts, { logger });
  const actors = createActors({ paths, net, keys, cfg, media, mediaHostsOf: (h) => hosts.mediaHostsOf(h), logger });
  const seen = createSeen(paths.fedSeenDir);
  const replay = createReplayGuard({ now: () => clock.now(), dir: paths.fedReplayDir });
  const inboundGate = createGate(INBOUND_GATE);
  const anonGate = createGate(ANON_GATE);
  const keyFetching = new Map();   // client id (or /48) -> key fetches in flight
  const instanceRejected = new Map();   // actor id -> when its last Follow was answered
  // Bound after the social layer is built (it needs the actor cache first).
  let follows_ = null;
  let inbound = null;
  let walls_ = null;
  let friendAnywhere_ = () => false;
  let outbox_ = null;
  let ringStore_ = null;   // P7: the rings (home rows and replicas)
  let ringFed_ = null;     // P7: lib/ring-fed.js

  const queue = createQueue({
    paths, net, keys, actors, hosts, cfg, audit, logger,
    onAttempt: () => markFederated(),
    onGone: (actorId) => dropRemoteActor(actorId),
    onSignerIdle: (name) => {
      // A deleted ring's key goes with its last job (P7, spec 2.6).
      if (name.startsWith('_ring:')) { const id = name.slice(6); if (!ringStore_?.get(id)) keys.removeRing(id); return; }
      if (!members.get(name) && members.isRetired(name)) keys.remove(name);
    },
    blocked: (signer, actorId) => blockedBy(signer, actorId),
    sendable: (job) => sendable(job),
    hostBlocked: blockedHost,
    // P8: a person the admin blocks server-wide gets nothing either: skipped at
    // fan-out, and a job to their personal inbox dropped before its attempt.
    actorBlocked: (id) => actorBlocked(id) || handleBlocked(actors.handleOf(id)),
    inboxBlocked: moderation ? moderation.inboxBlocked : () => false,
  });

  /* Still to go (N3)? '' when it may, else why not. */
  const POST_TYPES = new Set(['Create', 'Update', 'Add', 'Remove']);
  function objectTypeOf(job) {
    if (typeof job.object_type === 'string') return job.object_type;
    try { const o = JSON.parse(job.body).object; return o && typeof o === 'object' ? String(o.type || '') : ''; } catch { return ''; }
  }
  function sendable(job) {
    if (!job.signer || job.signer === '_instance' || job.signer.startsWith('_ring:')) return '';
    const m = members.get(job.signer);
    if (m?.status !== 'active') {
      if (!job.courtesy && ESSENTIAL.has(job.activity_type)) return '';
      return m ? 'signer_suspended' : 'signer_gone';
    }
    // An Update of a Person (the member's own profile) or (P7) of a ring's
    // Group (a rename or the link, to a ring hosted elsewhere) is no post.
    if (!POST_TYPES.has(job.activity_type) || (job.activity_type === 'Update' && ['Person', 'Group'].includes(objectTypeOf(job)))) return '';
    const l = urls.parseLocal(job.object_id, origin);
    // A comment on a remote post goes while its author is active (P6).
    if (job.activity_type === 'Create' && l?.kind === 'comment' && l.name === job.signer) return '';
    // P7: a Remove of a reaction on a room post (its author withdrawing one)
    // goes while its signer is active; a pin's Remove names a post (below).
    if (job.activity_type === 'Remove' && l?.kind !== 'post') return '';
    // P7: a ROOM post's Create or Update (to its Group) goes, page on or off,
    // while the post is still a live room post of a ring the signer is in.
    if (l?.kind === 'post' && l.name === job.signer) {
      const rp = pages.post(job.signer, l.id);
      if (rp && rp.audience !== 'public' && rp.audience !== 'archive') {
        const ring = ringStore_?.get(rp.audience);
        const live = Date.parse(rp.created_at) + 7 * 24 * 3600_000 > clock.now();
        return ring && live && ring.members.some((m) => m.handle === job.signer) ? '' : 'room_post_gone';
      }
    }
    if (pages.settings(job.signer).enabled !== true) return 'page_off';
    if (l?.kind !== 'post' || l.name !== job.signer) return 'not_a_post';
    const p = pages.post(job.signer, l.id);
    if (p?.audience !== 'public' || p.kind === 'divider') return 'post_not_public';
    return '';
  }

  /* Does member `signer` block the remote actor `actorId` (spec 6.1)? Its handle
   * from the cache, else its host alone (a domain block still holds). The
   * instance actor blocks no one. */
  function blockedBy(signer, actorId) {
    if (!signer || signer === '_instance' || !members.get(signer)) return false;
    const handle = actors.handleOf(actorId) || `_@${hostOf(actorId)}`;
    return blocksHandle(pages.settings(signer), handle);
  }

  /* A remote actor whose inbox answered 410: every follow row naming it goes. */
  function dropRemoteActor(actorId) {
    const handle = actors.handleOf(actorId);
    if (!handle?.includes('@')) return;
    for (const m of members.all()) {
      try { follows_.dropHandle(m.slug, handle); } catch (e) { logger.error(`[federation] dropping ${handle} from ${m.slug}: ${e.message}`); }
    }
    audit('federation.actor_gone', 'system', { handle });
  }

  // ── OUT ──

  const localPerson = (url) => {
    const l = urls.parseLocal(url, origin);
    return l?.kind === 'person' ? l.name : '';
  };
  const isRemote = (u) => typeof u === 'string' && /^https?:\/\//.test(u) && !urls.parseLocal(u, origin) && !u.startsWith(`${origin}/`);
  const publicAddressed = (o) => !!o && arr(o.to).includes(AS_PUBLIC) && o.audience === undefined && !o.inReplyTo;
  /* A comment on a remote post (P6): a Note by the actor, in reply to a remote
   * post, to its author, cc as:Public, never a room's. */
  const remoteComment = (a, o, name) => !!o && o.type === 'Note' && o.attributedTo === a.actor && isRemote(o.inReplyTo)
    && o.audience === undefined && a.audience === undefined && arr(o.cc).includes(AS_PUBLIC) && !arr(o.to).includes(AS_PUBLIC)
    && urls.parseLocal(o.id, origin)?.kind === 'comment' && urls.parseLocal(o.id, origin)?.name === name;

  // ── P7: what a ring may send across servers (spec 4.7) ──

  const localGroupId = (url) => { const l = urls.parseLocal(url, origin); return l?.kind === 'group' ? l.id : ''; };
  const noPublic = (x) => !arr(x?.to).includes(AS_PUBLIC) && !arr(x?.cc).includes(AS_PUBLIC);
  /* A Group of a ring hosted here, signing what only a Group sends: the ring as
   * it is (Update{Group}), its answers to a Join, the removal of a member, its
   * own deletion, and the room passed on (Announce of an activity addressed to
   * the ring). Nothing of it ever names Public or a followers collection. */
  function groupMayLeave(a, id) {
    const g = urls.groupUrl(origin, id);
    const o = a.object;
    if (!noPublic(a)) return false;
    switch (a.type) {
      case 'Update': return !!o && typeof o === 'object' && o.type === 'Group' && o.id === g;
      case 'Accept': case 'Reject': return !!o && typeof o === 'object' && o.type === 'Join' && o.object === g;
      case 'Remove': return a.target === g && typeof o === 'string';
      case 'Delete': return o === g;
      case 'Announce':
        return a.audience === g && !!o && typeof o === 'object' && typeof o.type === 'string' && (arr(o.to).includes(g) || o.audience === g);
      default: return false;
    }
  }
  /* A member here, to the Group of a ring hosted ELSEWHERE that they belong to
   * (or, for a Join, one they asked by link): the ring acts and the room's
   * activities, addressed to that Group alone. -> the ring (or a stand-in for
   * a Join), else null. */
  function remoteRingOf(a, name) {
    const to = arr(a.to);
    if (to.length !== 1 || !ringStore_) return null;
    const g = to[0];
    if (typeof g !== 'string') return null;
    // P7 review F2: a room reaction to a ring hosted HERE goes to its Group
    // in-process and, signed by its reactor, to the remote author of the post
    // (the authority): that member's activity is the ring's as well.
    const home = !!localGroupId(g);
    if (!home && !isRemote(g)) return null;
    const ring = ringStore_.load().find((r) => (home ? r.home : !r.home) && (r.ap_id || urls.groupUrl(origin, r.id)) === g && r.members.some((m) => m.handle === name));
    if (ring) return ring;
    if (!home && a.type === 'Join' && ringFed_?.askOf(name, g)) return { ap_id: g, asking: true };
    return null;
  }
  /* Where a member's ring activity may go (P7 review F2): the ring's Group;
   * and a reaction (a stamp, its Undo, a comment and its Delete), signed by
   * its reactor, to a CURRENT remote member of that ring too (the author of
   * the post: its server is the authority). Nobody outside the ring. */
  function memberRingRecipients(a, name, ring) {
    const g = ring.ap_id || '';
    const ok = new Set(isRemote(g) ? [g] : []);
    const ownComment = (id) => { const l = urls.parseLocal(id, origin); return l?.kind === 'comment' && l.name === name; };
    const reaction = ['Like', 'EmojiReact', 'Undo'].includes(a.type) || (['Create', 'Delete'].includes(a.type) && ownComment(idOf(a.object)));
    if (reaction && !ring.asking) for (const m of ring.members) if (m.handle.includes('@')) { const id = actors.idOf(m.handle); if (id) ok.add(id); }
    return ok;
  }
  function memberRingMayLeave(a, name, ring) {
    const g = ring.ap_id || (ring.id ? urls.groupUrl(origin, ring.id) : '');
    const o = a.object;
    if (arr(a.cc).length) return false;   // never Public, never a followers collection
    const ownPost = (id) => { const l = urls.parseLocal(id, origin); return l?.kind === 'post' && l.name === name; };
    const ownComment = (id) => { const l = urls.parseLocal(id, origin); return l?.kind === 'comment' && l.name === name; };
    if (ring.asking) return a.type === 'Join' && a.object === g && typeof a.ring?.code === 'string';
    switch (a.type) {
      case 'Leave': return a.object === g;
      case 'Accept': case 'Reject': return typeof o === 'string';
      case 'Remove': return a.target === g ? typeof o === 'string' : (typeof o === 'string' && ownPost(a.target) && a.audience === g);
      case 'Delete':
        if (o === g) return true;
        return !!o && typeof o === 'object' && o.type === 'Tombstone' && (ownPost(o.id) || ownComment(o.id)) && a.audience === g;
      case 'Update':
        if (o?.type === 'Group') return o.id === g;
        // A room Note's edit, or Keep's re-address of it to Public (4.9): to the Group only.
        return o?.type === 'Note' && o.attributedTo === a.actor && ownPost(o.id) && (o.audience === g || publicAddressed(o));
      case 'Create':
        return o?.type === 'Note' && o.attributedTo === a.actor && a.audience === g && o.audience === g && noPublic(o)
          && (ownPost(o.id) ? !o.inReplyTo && o.ring?.room === g : ownComment(o.id) && typeof o.inReplyTo === 'string');
      case 'Like': case 'EmojiReact': return a.audience === g && typeof o === 'string';
      case 'Undo': return !!o && typeof o === 'object' && ['Like', 'EmojiReact'].includes(o.type) && o.actor === a.actor && o.audience === g;
      default: return false;
    }
  }

  /* Is this activity among what may leave (the list above)? */
  function mayLeave(a) {
    const gid = localGroupId(a.actor);
    if (gid) return groupMayLeave(a, gid);
    const name = localPerson(a.actor);
    if (!name && a.actor !== `${origin}/actor`) return false;
    if (name) {
      const ring = remoteRingOf(a, name);
      if (ring) return memberRingMayLeave(a, name, ring);
    }
    const o = a.object;
    switch (a.type) {
      case 'Flag':
        // P8 (6.2): a report forwarded to the reported person's server, from the
        // INSTANCE actor only (the reporter's name never travels), naming only
        // that server's own actor and objects.
        return !name && a.actor === `${origin}/actor` && arr(o).length > 0 && arr(o).every((x) => typeof x === 'string' && isRemote(x) && hostOf(x) === hostOf(arr(o)[0]));
      case 'Follow':
        return !!name && isRemote(idOf(o));
      case 'Accept': case 'Reject':
        return !!o && typeof o === 'object' && o.type === 'Follow';
      case 'Undo':
        return !!o && typeof o === 'object' && ['Follow', 'Like', 'EmojiReact'].includes(o.type) && o.actor === a.actor
          && o.audience === undefined && (o.type === 'Follow' || isRemote(idOf(o.object)));
      case 'Like': case 'EmojiReact':
        return !!name && isRemote(idOf(o)) && a.audience === undefined && !a.ring?.custom;
      case 'Create':
        if (remoteComment(a, o, name)) return true;
        return o?.type === 'Note' && publicAddressed(o) && publicAddressed(a) && o.attributedTo === a.actor && !o.ring?.room;
      case 'Update':
        if (o?.type === 'Person') return o.id === a.actor;
        return o?.type === 'Note' && publicAddressed(o) && publicAddressed(a) && o.attributedTo === a.actor && !o.ring?.room;
      case 'Delete': {
        if (idOf(o) === a.actor) return !!name;   // Delete{Person}: the account itself
        const l = urls.parseLocal(o?.id, origin);
        if (o?.type === 'Tombstone' && l?.kind === 'comment' && l.name === name && a.audience === undefined) return true;
        return o?.type === 'Tombstone' && publicAddressed(a) && l?.kind === 'post' && l.name === name;
      }
      case 'Add': case 'Remove':
        return a.target === urls.collectionUrl(origin, name, 'featured') && urls.parseLocal(a.object, origin)?.name === name;
      default:
        return false;
    }
  }

  /* lib/outbox.js's remote part: expand, keep the list, write one fan-out job. */
  function remote(activity, recipients, opts = {}) {
    if (!mayLeave(activity)) {
      logger.log(`[federation] not sent to other servers: ${activity.type}${activity.object?.type ? `{${activity.object.type}}` : ''}`);
      return null;
    }
    const name = localPerson(activity.actor);
    if (name && members.get(name)?.status !== 'active') return null;
    // P7: what a ring sends goes only to Ring servers (decision 7: never
    // Mastodon, never a follower): a Group's to its members' servers, a
    // member's to the ring's Group, and a Group's room content (the ring as
    // it is, an Announce) only to a CURRENT member.
    const gid = localGroupId(activity.actor);
    const memberRing = !gid && name ? remoteRingOf(activity, name) : null;
    const ringScoped = !!gid || !!memberRing;
    if (ringScoped) {
      const allowedTo = memberRing ? memberRingRecipients(activity, name, memberRing) : null;
      const ring = gid ? ringStore_?.get(gid) : null;
      const current = new Set(ring ? ring.members.map((m) => (m.handle.includes('@') ? actors.idOf(m.handle) : '')).filter(Boolean) : []);
      const contentful = !!gid && (activity.type === 'Announce' || activity.type === 'Update');
      // The Group's answer to a Join carries nothing of the room: it goes to any
      // asker (a Mastodon account that tried is told no, as a courtesy).
      const answer = !!gid && (activity.type === 'Reject' || activity.type === 'Accept');
      const ok = recipients.filter((r) => {
        if (urls.parseLocal(r, origin) || !/^https?:\/\//.test(r)) return false;
        if (allowedTo && !allowedTo.has(r)) { logger.log(`[federation] not sent to ${r}: not the ring's Group, nor a member for a reaction`); return false; }
        if (!answer && !ringFed_?.isRingPeerHost(hostOf(r))) { logger.log(`[federation] not sent to ${r}: not a Ring server`); return false; }
        if (contentful && !current.has(r)) { logger.log(`[federation] not sent to ${r}: not a member of the ring`); return false; }
        return true;
      });
      if (!ok.length) return null;
      if (gid) keys.ensureRing(gid);   // a ring made before P7 gets its key now
      return queue.enqueue(activity, ok, { signer: gid ? `_ring:${gid}` : name, courtesy: answer && activity.type === 'Reject' && !ok.every((r) => ringFed_?.isRingPeerHost(hostOf(r))) });
    }
    const ids = [];
    const followers = [];
    for (const r of recipients) {
      const l = urls.parseLocal(r, origin);
      if (l?.kind === 'collection' && l.which === 'followers') {
        if (l.name !== name) continue;   // only one's own followers
        for (const f of follows_.load(name).followers) {
          if (f.state !== 'accepted' || !f.handle.includes('@')) continue;
          const id = actors.idOf(f.handle);
          if (id) { ids.push(id); followers.push(id); }
        }
      } else if (!l && /^https?:\/\//.test(r)) ids.push(r);
    }
    if (!ids.length) return null;
    // A comment and its Delete go to the author's own inbox (spec 7).
    const personal = (activity.type === 'Create' || activity.type === 'Delete') && urls.parseLocal(idOf(activity.object), origin)?.kind === 'comment';
    // `followers`: the recipients that came from the collection. The queue checks
    // them against the signer's blocks again at send time (lib/queue.js).
    // `courtesy`: an answer to a stranger (a Reject past a cap), never essential.
    return queue.enqueue(activity, ids, { signer: name || '_instance', followers, courtesy: opts.courtesy === true, personal });
  }

  /* The member's Person as it now is, for the actor route and Update{Person}. */
  function personOf(name) {
    const member = members.get(name);
    if (!member) return null;
    return A.personDoc({ origin, member, store: pages.load(name), publicKeyPem: keys.publicKeyPem(name) });
  }

  // ── IN ──

  /* The key getter for one client's request (5.2 step 7, 5.9). A cached key
   * costs nothing; a fetch spends the client's key-fetch budget and holds one of
   * its in-flight slots, and waits on the inbound gate. A spent budget or a full
   * slot set is a 429, never a fetch. */
  const tooBusy = (reason) => Object.assign(new Error(reason), { status: 429, reason });
  /* The budget an inbound fetch spends: the client's slots and minute budget,
   * and an IPv6 client's /48 aggregate. Throws a 429 error; else a release. */
  function budgetFor(client) {
    const id = client || 'unknown';
    const p48 = prefix48Of(id);
    const slot = (k) => keyFetching.get(k) || 0;
    const bump = (k, d) => { const n = slot(k) + d; if (n > 0) keyFetching.set(k, n); else keyFetching.delete(k); };
    return () => {
      if (slot(id) >= KEY_FETCH_PER_CLIENT || (p48 && slot(p48) >= KEY_FETCH_PER_48)) throw tooBusy('key_fetch_busy');
      if (limits.take(`fed-key-fetch:ip:${id}`, KEY_FETCH_RULE)) throw tooBusy('key_fetch_budget');
      if (p48 && limits.take(`fed-key-fetch:p48:${p48}`, KEY_FETCH_RULE_48)) throw tooBusy('key_fetch_budget');
      bump(id, 1);
      if (p48) bump(p48, 1);
      return () => { bump(id, -1); if (p48) bump(p48, -1); };
    };
  }
  /* A full or slow inbound gate (ERR_BUSY: the remote was never asked) is this
   * server's congestion: a 429, never an unknown key. */
  const busyIsTooBusy = (e) => (e?.code === 'ERR_BUSY' ? tooBusy('fetch_busy') : e);
  function keyGetter(client, { allowUnbound = false } = {}) {
    const beforeFetch = budgetFor(client);
    return async (keyId, { refresh = false } = {}) => {
      try { return await actors.keyFor(keyId, { refresh, gate: inboundGate, beforeFetch, timeoutMs: INBOUND_FETCH_MS, allowUnbound }); }
      catch (e) { throw busyIsTooBusy(e); }
    };
  }

  /* Step 6: is the signature's keyId on a blocked domain? */
  const keyIdBlocked = (headers) => {
    const sig = parseSignature(headers.signature);
    return !!sig && blockedHost(hostOf(sig.keyId));
  };

  /* After the signature: the verified host's budget (5.2 step 1, second half). */
  const hostBudget = (res, bucket, owner, rule) => limits.allow(res, bucket, hostOf(owner) || 'unknown', rule);

  /* Verify a signed GET (authorized fetch). -> { ok, actor, handle } | { ok: false, status }.
   * The route has spent the client's signed-GET budget before this. */
  async function verifyGet(req, res) {
    const headers = req.headers;
    if (!headers.signature) return { ok: false, status: 401, reason: 'unsigned' };
    if (keyIdBlocked(headers)) return { ok: false, status: 403, reason: 'domain_blocked' };
    // No replay check on a GET: RSA signatures are deterministic, so two honest
    // fetches of one URL in the same second carry the same value, and a replayed
    // read reads only what its signer could read anyway. The Date window holds.
    // An UNBOUND instance-actor key may sign a read (lib/actors.js): it reads
    // what a stranger reads, and no handle means no block can name it.
    const v = await verifyRequest({ method: 'GET', path: req.originalUrl, headers }, { host, getKey: keyGetter(clientId(req), { allowUnbound: true }), replay: null, nowMs: clock.now() });
    if (!v.ok) return v;
    if (actorBlocked(v.owner) || handleBlocked(actors.handleOf(v.owner))) return { ok: false, status: 403, reason: 'actor_blocked' };
    if (!hostBudget(res, 'fed-host-get', v.owner, SIGNED_GET_RULE)) return { ok: false, status: 429, answered: true };
    hosts.heard(hostOf(v.owner));
    markFederated();   // another server holds this origin now (N11)
    return { ok: true, actor: v.owner, handle: actors.handleOf(v.owner) };
  }

  /* An inbox POST: returns { status, reason? }. Personal, shared and instance
   * inboxes share it: who an activity is for is read from the activity itself
   * (targetsOf), never from the path it arrived on. */
  async function inboxPost(req, res, { client = '' } = {}) {
    const headers = req.headers;
    const body = req.body;
    if (!headers.signature) return { status: 401, reason: 'unsigned' };
    if (keyIdBlocked(headers)) return { status: 403, reason: 'domain_blocked' };

    // A Delete of an actor never seen: nothing to fetch a key for, nothing to do.
    const peek = parseJsonSafe(body);
    if (peek && peek.type === 'Delete' && typeof peek.actor === 'string' && (peek.object === peek.actor || peek.object?.id === peek.actor) && !actors.get(peek.actor)) {
      return { status: 202, reason: 'unknown_actor_delete' };
    }

    const v = await verifyRequest({ method: 'POST', path: req.originalUrl, headers, body }, { host, getKey: keyGetter(client), replay, nowMs: clock.now() });
    if (!v.ok) return { status: v.status, reason: v.reason };
    if (actors.get(v.owner)?.unbound) return { status: 401, reason: 'unbound_key' };   // reads only, never acts
    // P8: a person the admin blocks server-wide (6.3): refused like their domain.
    if (actorBlocked(v.owner) || handleBlocked(actors.handleOf(v.owner))) return { status: 403, reason: 'actor_blocked' };
    if (!hostBudget(res, 'fed-host-inbox', v.owner, INBOX_RULE)) return { status: 429, answered: true };

    let activity = peek;
    if (!activity || Array.isArray(activity) || typeof activity.type !== 'string') return { status: 400, reason: 'body' };
    hosts.heard(hostOf(v.owner));

    if (activity.actor !== v.owner) {
      // Forwarded: never trust the body; fetch it from its own host. The copy
      // counts only when the URL asked for, the URL that answered (redirects are
      // off, lib/actors.js getDoc) and its own id are ONE string, and its actor
      // resolves to exactly that id on the same host (F2).
      const id = typeof activity.id === 'string' ? activity.id : '';
      if (!id || !/^https?:\/\//.test(id)) return { status: 400, reason: 'id' };
      if (blockedHost(hostOf(id))) return { status: 403, reason: 'domain_blocked' };
      try {
        const check = (doc, url) => url === id && doc.id === id && typeof doc.actor === 'string' && hostOf(doc.actor) === hostOf(id);
        const f = await actors.fetchForwarded(id, { gate: inboundGate, beforeFetch: budgetFor(client), timeoutMs: INBOUND_FETCH_MS, check });
        if (f.mismatch || f.actor?.id !== f.doc.actor) return { status: 202, reason: 'forwarded_mismatch' };
        if (actorBlocked(f.doc.actor) || handleBlocked(actors.handleOf(f.doc.actor))) return { status: 403, reason: 'actor_blocked' };
        activity = f.doc;
      } catch (e) {
        const busy = busyIsTooBusy(e);
        if (busy?.status === 429) return { status: 429, reason: busy.reason };
        return { status: 202, reason: `forwarded_unfetchable: ${e.message}` };
      }
    }

    const id = typeof activity.id === 'string' ? activity.id : '';
    let idUrl = null;
    try { idUrl = new URL(id); } catch { idUrl = null; }
    const schemeOk = idUrl && (idUrl.protocol === 'https:' || (cfg.fedTestLoopback && idUrl.protocol === 'http:'));
    if (!schemeOk || hostOf(id) !== hostOf(activity.actor)) return { status: 400, reason: 'id' };
    if (seen.has(id)) return { status: 202, reason: 'seen' };
    markFederated();

    // A Follow of the instance actor (spec 4.3).
    if (activity.type === 'Follow' && idOf(activity.object) === `${origin}/actor`) {
      // Answered Reject once per actor per day, as a courtesy job (N2).
      const now = clock.now();
      const last = instanceRejected.get(activity.actor);
      if (last !== undefined && now - last < INSTANCE_REJECT_WINDOW_MS) return { status: 202, reason: 'instance_answered' };
      instanceRejected.delete(activity.actor);
      instanceRejected.set(activity.actor, now);
      if (instanceRejected.size > INSTANCE_REJECT_MAX) instanceRejected.delete(instanceRejected.keys().next().value);
      seen.add(id);
      const reject = A.doc({ id: `${origin}/actor/activities/${newActivityId()}`, type: 'Reject', actor: `${origin}/actor`, object: { id, type: 'Follow', actor: activity.actor, object: `${origin}/actor` } });
      queue.enqueue(reject, [activity.actor], { signer: '_instance', courtesy: true });
      return { status: 202, reason: 'instance' };
    }

    // P7: a ring's. To a Group whose home is here (its table, lib/groups.js),
    // or from a ring's Group elsewhere (the `ring` table, lib/ring-fed.js).
    const ringRoute = ringFed_ ? ringFed_.routeOf(activity) : null;
    if (ringRoute) return ringInbound(activity, ringRoute, id);

    // Only what is HANDLED is recorded as seen (N5): a drop costs nothing here.
    let key = keyOf(activity, { kind: 'person' }, origin);
    // A Delete naming a known ACTOR by its bare id is a Delete{Person}, whoever
    // sends it: only that actor itself may (ownership, below).
    if (key === 'Delete:Note' && actors.get(idOf(activity.object))) key = 'Delete:Person';
    if (!REMOTE_KEYS.has(key)) return { status: 202, reason: `dropped ${key}` };
    const why = ownership(key, activity);
    if (why) return { status: 403, reason: `ownership: ${why}` };
    const targets = targetsOf(key, activity);
    if (!targets.length) return { status: 202, reason: `not_for_us ${key}` };
    seen.add(id);
    const results = [];
    for (const t of targets) {
      const inbox = t === 'server' ? { kind: 'server' } : { kind: 'person', name: t };
      try {
        const r = inbound.receive(activity, { inbox, origin, signer: activity.actor });
        results.push(`${t}:${r?.status ?? ''}`);
      } catch (e) {
        logger.error(`[federation] ${key} for ${t}: ${e.stack || e.message}`);
        results.push(`${t}:failed`);
      }
    }
    return { status: 202, reason: `handled ${key} ${results.join(' ')}` };
  }

  /* A ring's activity, after the signature (spec 4.7, 5.4): the registry, the
   * ownership a remote member's Create, Update or Delete of a Note keeps (its
   * own object, on its own host), what must be fetched first (lib/ring-fed.js
   * prepare: a joiner's NodeInfo, a Group's members, a room Note from its own
   * host), then the table. The Group's own checks (a current member, the
   * creator, the code, the seats) are its handlers'. */
  async function ringInbound(activity, route, id) {
    const key = keyOf(activity, route.inbox, origin);
    // A room reaction signed by its reactor, to the author here (P7 review F2):
    // the member's own table, its reactions only, then the route's `after`.
    const allowed = route.reaction ? ['Like', 'EmojiReact', 'Create:Note'] : route.inbox.kind === 'ring' ? RING_KEYS : GROUP_KEYS;
    if (!allowed.includes(key)) return { status: 202, reason: `dropped ${key}` };
    if (route.inbox.kind === 'group' || route.reaction) {
      const why = ['Create:Note', 'Update:Note', 'Delete:Note'].includes(key) ? ownership(key, activity) : '';
      if (why) return { status: 403, reason: `ownership: ${why}` };
    }
    if (!route.reaction) await ringFed_.prepare(activity, route);
    // ── tick ──
    if (seen.has(id)) return { status: 202, reason: 'seen' };
    seen.add(id);
    let r;
    try { r = inbound.receive(activity, { inbox: route.inbox, origin, signer: activity.actor }); }
    catch (e) { logger.error(`[federation] ring ${key}: ${e.stack || e.message}`); return { status: 202, reason: 'failed' }; }
    if (route.after) {
      try { route.after(r); } catch (e) { logger.error(`[federation] ring ${key} after: ${e.stack || e.message}`); }
    }
    return { status: 202, reason: `handled ring ${key} ${r?.status ?? ''}${r?.error ? ` ${r.error}` : ''}` };
  }

  /* OWNERSHIP (5.4), before any handler: '' or why not. A remote server can
   * never write anything about another host's objects or people. */
  function ownership(key, a) {
    const actorHost = hostOf(a.actor);
    const o = a.object;
    const [type, objType] = key.split(':');
    if ((type === 'Create' || type === 'Update') && objType !== 'Person') {
      if (!o || typeof o !== 'object') return 'object must be embedded';
      if (hostOf(o.id) !== actorHost) return 'object on another host';
      if (idOf(arr(o.attributedTo)[0]) !== a.actor) return 'attributedTo is not the actor';
      return '';
    }
    if (key === 'Update:Person') return o && typeof o === 'object' && o.id === a.actor ? '' : 'a Person updates only itself';
    if (key === 'Delete:Person') return idOf(o) === a.actor ? '' : 'a Person deletes only itself';
    if (type === 'Delete') return idOf(o) && hostOf(idOf(o)) === actorHost ? '' : 'object on another host';
    if (type === 'Undo') {
      if (!o || typeof o !== 'object') return 'the undone activity must be embedded';
      if (o.actor !== undefined && idOf(o.actor) !== a.actor) return 'not its own activity';
      return '';
    }
    // A Like of something not here is not for us (targetsOf finds no one): 202.
    return '';
  }

  /* Which inboxes here an activity is for: member names, and/or 'server'. */
  function targetsOf(key, a) {
    // Only an ACTIVE member is anyone's target: what is for a suspended one is
    // dropped (spec 4.9; P8).
    const active = (n) => members.get(n)?.status === 'active';
    const person = (url) => { const l = urls.parseLocal(url, origin); return l?.kind === 'person' && active(l.name) ? l.name : ''; };
    const postOwner = (url) => { const l = urls.parseLocal(url, origin); return l?.kind === 'post' && active(l.name) ? l.name : ''; };
    const one = (n) => (n ? [n] : []);
    const o = a.object;
    switch (key) {
      case 'Follow': case 'Block': return one(person(idOf(o)));
      case 'Undo:Follow': return one(person(idOf(o?.object)));
      case 'Accept:Follow': case 'Reject:Follow': {
        if (typeof o === 'string') { const l = urls.parseLocal(o, origin); return one(l?.kind === 'activity' && members.get(l.name) ? l.name : ''); }
        return one(person(idOf(o?.actor)));
      }
      case 'Like': case 'EmojiReact': return one(postOwner(idOf(o)));
      case 'Undo:Like': case 'Undo:EmojiReact': return one(postOwner(idOf(o?.object)));
      case 'Create:Note': {
        const reply = postOwner(idOf(o?.inReplyTo));
        if (reply) return [reply];
        if (o?.inReplyTo === undefined || o?.inReplyTo === null) {
          const from = actors.handleOf(a.actor);
          if (from && friendAnywhere_(from)) return ['server'];
        }
        // A personal inbox names no one by itself: who a Note is for is in it.
        const mentioned = arr(o?.tag).filter((t) => t && t.type === 'Mention').map((t) => person(t.href)).filter(Boolean);
        return [...new Set(mentioned)];
      }
      default:
        return ['server'];
    }
  }

  // ── P6: software, remote objects, backfill, lookup ──

  const nodeinfoInflight = new Map();
  // Under the test hook a loopback host, or any *.localhost name (lib/net.js
  // resolves those to loopback; an IDN fake lives there), is asked over http.
  const schemeOf = (h) => (cfg.fedTestLoopback && (/^(127\.|localhost|\[::1\])/.test(h) || /\.localhost(:\d+)?$/.test(h)) ? 'http' : 'https');

  /* A host's software (spec 8.2, 4.8): its NodeInfo, read once a day on use
   * into hosts.json. -> { software, version, ring_protocol, kind }. Never throws. */
  async function softwareOf(h) {
    const row = hosts.get(h);
    const fresh = row?.nodeinfo_at && clock.now() - Date.parse(row.nodeinfo_at) < (row.software ? NODEINFO_FRESH_MS : NODEINFO_RETRY_MS);
    if (!fresh) {
      if (!nodeinfoInflight.has(h)) {
        nodeinfoInflight.set(h, readNodeinfo(h).finally(() => nodeinfoInflight.delete(h)));
      }
      await nodeinfoInflight.get(h);
    }
    const r = hosts.get(h) || {};
    return { software: r.software || '', version: r.version || '', ring_protocol: r.ring_protocol || 0, kind: A.softwareKind(r) };
  }
  async function readNodeinfo(h) {
    const getJson = async (url) => {
      const res = await net.fetchGuarded(url, { headers: { accept: 'application/json' }, maxBytes: 256 * 1024, timeoutMs: 10_000 });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const j = parseJsonSafe(res.body);
      if (!j || Array.isArray(j)) throw new Error('not a JSON object');
      return j;
    };
    try {
      const wk = await getJson(`${schemeOf(h)}://${h}/.well-known/nodeinfo`);
      const links = arr(wk.links).filter((l) => l && typeof l.href === 'string' && hostOf(l.href) === h);
      const pick = links.find((l) => /\/ns\/schema\/2\.1$/.test(String(l.rel))) || links.find((l) => /\/ns\/schema\/2\.0$/.test(String(l.rel)));
      if (!pick) throw new Error('no 2.x link');
      const ni = await getJson(pick.href);
      const sw = ni.software && typeof ni.software === 'object' ? ni.software : {};
      hosts.setSoftware(h, {
        software: String(sw.name || '').toLowerCase().replace(/[^a-z0-9._-]/g, ''),
        version: String(sw.version || '').replace(/[^\w.+-]/g, ''),
        ring_protocol: ni.metadata && typeof ni.metadata === 'object' ? ni.metadata.ringProtocol : 0,
      });
    } catch (e) {
      logger.log(`[federation] NodeInfo of ${h}: ${e.message}`);
      hosts.setSoftware(h, { software: '', version: '' });
    }
  }

  /* An AP document from another server, signed by the instance actor, redirects
   * off; a document whose id is another URL on the same host is fetched once more
   * by that id, which must then match. -> the document, or throws. */
  async function fetchDoc(url) {
    if (!/^https?:\/\//.test(url) || !isRemote(url)) throw new Error('not a remote URL');
    let { doc, url: at } = await actors.getDoc(url);
    if (doc.id !== at && typeof doc.id === 'string' && hostOf(doc.id) === hostOf(at)) ({ doc, url: at } = await actors.getDoc(doc.id));
    if (doc.id !== at) throw new Error('the id is not the URL');
    return doc;
  }

  const looked = new Map();   // object id -> { obj, handle, until }
  function remember(obj, handle) {
    if (looked.size >= LOOKED_MAX) looked.delete(looked.keys().next().value);
    looked.set(obj.id, { obj, handle, until: clock.now() + LOOKED_TTL_MS });
  }

  /* A remote post for a stamp or a comment: a friend's wall, a recent lookup,
   * else fetched. -> { obj, handle, actor } or null. Public or unlisted only. */
  async function remotePost(url) {
    if (!isRemote(url) || blockedHost(hostOf(url))) return null;
    const onWall = walls_?.entry(url);
    if (onWall) {
      const handle = walls_.holderOf(url);
      return { obj: onWall, handle, actor: actors.idOf(handle) };
    }
    const hit = looked.get(url);
    if (hit && hit.until > clock.now()) return handleBlocked(hit.handle) ? null : { obj: hit.obj, handle: hit.handle, actor: actors.idOf(hit.handle) };
    let doc;
    try { doc = await fetchDoc(url); } catch { return null; }
    const post = await settledPost(doc);
    return post && !handleBlocked(post.handle) ? post : null;
  }
  async function settledPost(doc) {
    const author = idOf(arr(doc.attributedTo)[0]);
    if (!author || hostOf(author) !== hostOf(doc.id)) return null;
    let rec;
    try { rec = await actors.resolve(author); } catch { return null; }
    const obj = settleObject(doc, { actor: rec.id });
    if (obj.refused || obj.visibility === 'private') return null;
    remember(obj, rec.handle);
    return { obj, handle: rec.handle, actor: rec.id };
  }

  /* GET /api/lookup (8.5): a handle, a profile URL or a post URL. -> a view
   * { type: 'person', handle, actor } | { type: 'post', obj, handle, actor },
   * or null. A ring join link of another server is P7's. Throws nothing. */
  async function lookup(q) {
    const s = String(q || '').trim();
    if (!s) return null;
    try {
      if (!/^https?:\/\//i.test(s)) {
        const handle = s.replace(/^acct:/i, '').replace(/^@/, '');
        const at = handle.indexOf('@');
        if (at < 1 || blockedHost(handle.slice(at + 1).toLowerCase()) || handleBlocked(handle.toLowerCase())) return null;
        const rec = await actors.lookupHandle(handle.toLowerCase());
        if (handleBlocked(rec.handle)) return null;
        return { type: 'person', handle: rec.handle, actor: rec.id };
      }
      if (!isRemote(s) || blockedHost(hostOf(s))) return null;
      const doc = await fetchDoc(s);
      if (['Person', 'Service', 'Application', 'Group', 'Organization'].includes(doc.type)) {
        const rec = await actors.resolve(doc.id);
        if (handleBlocked(rec.handle)) return null;
        return { type: 'person', handle: rec.handle, actor: rec.id };
      }
      const post = await settledPost(doc);
      return post && !handleBlocked(post.handle) ? { type: 'post', ...post } : null;
    } catch (e) {
      logger.log(`[federation] lookup ${s.slice(0, 120)}: ${e.message}`);
      return null;
    }
  }

  /* A visitor's server's subscribe template (8.5, F4): the server-wide
   * anonymous budget, then the anonymous gate and its short deadline. Throws
   * a 429-shaped error when the budget or the gate is spent, else whatever
   * the fetch throws. */
  async function visitorTemplate(handle) {
    if (limits.take('fed-anon-fetch:all', ANON_FETCH_RULE)) throw tooBusy('anon_fetch_budget');
    try { return await actors.subscribeTemplate(handle, { gate: anonGate, timeoutMs: ANON_FETCH_MS }); }
    catch (e) { throw busyIsTooBusy(e); }
  }

  /* A new remote friend's outbox, read ONCE (4.6): the first page's public
   * Creates fill their wall. Background, never throws. */
  const backfilling = new Set();
  async function backfill(handle) {
    if (!walls_ || backfilling.has(handle) || walls_.backfilledAt(handle)) return;
    backfilling.add(handle);
    try {
      const rec = await actors.resolve(actors.idOf(handle));
      if (!rec.outbox || hostOf(rec.outbox) !== hostOf(rec.id)) return;
      let col = await fetchDoc(rec.outbox);
      let items = arr(col.orderedItems || col.items);
      if (!items.length && col.first) {
        if (typeof col.first === 'string') {
          if (hostOf(col.first) !== hostOf(rec.id)) return;
          const { doc } = await actors.getDoc(col.first);
          col = doc;
        } else col = col.first;
        items = arr(col.orderedItems || col.items);
      }
      // ── tick ──
      if (!friendAnywhere_(handle)) return;
      let n = 0;
      for (const it of items.slice(0, BACKFILL_ITEMS)) {
        if (!it || typeof it !== 'object' || it.type !== 'Create' || it.actor !== rec.id) continue;
        if (!idUnderActor(idOf(it.object), rec.id)) continue;   // F11: never an id in another actor's path
        const obj = settleObject(it.object, { actor: rec.id });
        if (obj.refused || obj.visibility === 'private' || (obj.type === 'Note' && obj.in_reply_to)) continue;
        if (walls_.add(handle, rec.id, obj) === 'added') n++;
      }
      walls_.markBackfilled(handle, rec.id);
      if (n) logger.log(`[federation] ${handle}: ${n} posts read from their outbox`);
    } catch (e) {
      logger.log(`[federation] the outbox of ${handle} was not read: ${e.message}`);
    } finally { backfilling.delete(handle); }
  }

  /* The account deletion's farewell (4.9, 11.4): Delete{Person} to every server
   * that knows the member, queued while they are still active. */
  function farewell(name, { handles, groups = [] }) {
    // P7: and the Group of every ring hosted elsewhere they were in: its home
    // drops them from the ring (lib/remote-in.js forget).
    const ids = [...new Set([...handles.filter((h) => h.includes('@')).map((h) => actors.idOf(h)), ...groups.filter((g) => isRemote(g))].filter(Boolean))];
    if (!ids.length || !outbox_) return null;
    return outbox_.emit(A.deletePerson({ origin, name }), ids, { origin });
  }

  return {
    net, actors, hosts, queue, seen, replay, inboundGate, anonGate, host, origin, media, visitorTemplate, paths,
    remote, personOf, verifyGet, inboxPost, mayLeave,
    softwareOf, fetchDoc, remotePost, lookup, backfill, farewell, blockedHost, handleBlocked, actorBlocked, isRemote,
    bind: (deps) => {
      follows_ = deps.follows; inbound = deps.inbound; walls_ = deps.walls || null;
      friendAnywhere_ = deps.friendAnywhere || friendAnywhere_; outbox_ = deps.outbox || null;
      ringStore_ = deps.ringStore || null; ringFed_ = deps.ringFed || null;
    },
    start: () => queue.start(),
    stop: () => { queue.stop(); hosts.flush(); media.flush(); },
    cancelSigner: (name, reason) => queue.cancelSigner(name, reason ? { reason } : {}),
  };
}

module.exports = { createFederation, REMOTE_KEYS };
