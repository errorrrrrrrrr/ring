'use strict';
/* ── The delivery queue and its worker (spec 7) ───────────────────────────────
 * Every activity that leaves this server for another one is a job file,
 * `DATA/queue/<job id>.json`, so a restart loses none:
 *   { id, kind: 'fanout'|'deliver', activity_id, activity_type, object_id,
 *     object_type, signer, recipients (fanout) | inbox + host (deliver), body
 *     (the exact string), attempts, next_at, created_at, last_status, courtesy? }
 *
 * FAN-OUT. lib/outbox.js enqueue()s ONE fan-out job, in the same synchronous tick
 * as the change it carries. The worker expands it: each recipient actor is
 * resolved (the cache, else a guarded fetch), and one deliver job is written per
 * target inbox: the actor's shared inbox (one per server) unless the activity has
 * one recipient by nature (Follow, Accept, Reject, Like, EmojiReact, Undo), which
 * goes to the personal inbox. A recipient that cannot be resolved stays in a
 * smaller fan-out job that retries; an unavailable host gets nothing.
 *
 * BLOCKS AT SEND TIME (spec 6.1). A recipient that came from the signer's
 * followers collection is checked against the signer's blocks again when the
 * fan-out runs, and a deliver job that serves only such followers is checked
 * again at each attempt: a follower blocked (by handle or domain) after the
 * emit gets nothing. An actor addressed by name (the Undo and Reject a block
 * itself sends) is not re-checked.
 *
 * STILL SENDABLE (spec 7, N3). `sendable(job)` (lib/federation.js) is asked when
 * a fan-out runs and before every attempt: a signer who is no longer an active
 * member (deleted, suspended) sends only Delete, Reject and Undo; a Create,
 * Update{Note}, Add or Remove goes only while the page is on and the post is
 * still public. Anything else is dropped with an audit line (`delivery_dropped`).
 * cancelSigner(name) drops every queued job of a member at once (the purge and
 * a suspension), keeping Delete, Reject and Undo (ESSENTIAL).
 *
 * CAPS (spec 7). At most MAX_JOBS jobs overall and MAX_PER_HOST deliver jobs per
 * remote host. Past a cap a new NON-ESSENTIAL job is refused (`delivery_refused`
 * audit and a log line). Delete, Reject and Undo signed by a member are never
 * refused: past a cap they are written anyway and the log says so. A job marked
 * `courtesy` (an answer to a stranger: the instance actor's Reject of a Follow, a
 * Reject of a Follow past a member's caps) is never essential.
 *
 * THE WORKER is one in-process loop over INDEXES, never a scan of every job:
 *   - a chain per (kind, object, inbox): only its HEAD (lowest seq) may run, so
 *     ordering costs O(1) per job, not a pass over the queue;
 *   - a timeline heap of runnable heads by (next_at, seq), and per-host READY
 *     heaps of the heads that are due;
 *   - indexes by signer, host, object and (activity, inbox).
 * At most 8 in flight, 2 per host, picked ROUND ROBIN across hosts. A SUSPECT
 * host (never yet answered a delivery with a 2xx, its last attempt failed
 * transiently, or it is marked failing) gets one slot, and suspect hosts
 * together at most SUSPECT_SLOTS (4): hosts that hang, or a crowd of new hosts
 * that never answer, can never hold every slot while a proven host waits. Each attempt is SIGNED
 * AFRESH (Date now, the Digest of the exact body, spec 5.1) and POSTed through
 * lib/net.js with no redirect followed (a 3xx is a failure), 10 s at most.
 *   2xx                       done: the job goes, the host's failing mark goes
 *   408, 429, 5xx, network    retry: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, then
 *                             daily, each with 10% jitter; 429's Retry-After is
 *                             honoured up to 24 h; given up 7 days after
 *                             creation (`delivery_gave_up` audit)
 *   410 from a personal inbox the job goes and that actor's follow rows go
 *   any other 4xx, a 3xx      the job goes, with an audit line
 * A host failing with no success for 7 days is unavailable (lib/hosts.js): its
 * queued jobs drop and none are written, until a verified inbound request from it.
 *
 * ORDER. Jobs about one object go to one inbox in the order they were made
 * (`seq`): the next waits while an earlier one is queued or in flight, so an
 * Update never overtakes its Create, and a receiver never drops an edit it saw
 * before the post. A Delete cancels queued Create and Update jobs for its object
 * (the Delete still goes). A newer Update replaces a queued Update of the same object
 * to the same inbox. An Update{Person} is coalesced to at most one a minute per
 * actor (spec 4.9): a newer one replaces the queued one's body.
 *
 * Restart: jobs are files; a job in flight at a crash is sent again (at least
 * once: receivers deduplicate by activity id). Jobs past 7 days at boot are
 * dropped with an audit line. A job file that cannot be read or has the wrong
 * shape is MOVED to `queue/damaged/` with a `delivery_damaged` audit line naming
 * its activity id when that is readable: never silently left, never deleted.
 *
 * DOMAIN BLOCKS (P6 BLOCKED_DOMAINS; P8 the admin's list, lib/moderation.js): a
 * recipient on a blocked host is skipped at fan-out and a deliver job to one is
 * dropped (`domain_blocked`); lib/net.js refuses the socket too. A new block
 * drops every queued deliver job to its hosts at once (dropHosts). P8: a person
 * the admin blocks server-wide (an actor block) is skipped at fan-out too, and
 * a job to their own inbox is dropped before its attempt (`actor_blocked`). A
 * `Flag` (a report forwarded to their server, signed by the instance actor) is
 * exempt from the PERSON block only: it is for their server's moderators. A comment and its Delete (`personal`, P6) go to the author's own
 * inbox, as the one-recipient types do.
 *
 * Signers: a member's name (their key, `<actor>#main-key`), `_instance`, or (P7)
 * `_ring:<ring id>`, a home ring's Group (its key, `<group>#main-key`). A
 * deleted member's key waits for their last job (spec 2.6): onSignerIdle(name)
 * fires when it ends.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { writeJSON } = require('./store');
const { signHeaders } = require('./http-sig');
const urls = require('./urls');

const MINUTE = 60_000;
const BACKOFF = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 360 * MINUTE, 720 * MINUTE];
const DAILY = 24 * 60 * MINUTE;
const GIVE_UP_MS = 7 * DAILY;
const RETRY_AFTER_MAX_MS = DAILY;
const IN_FLIGHT = 8;
const PER_HOST = 2;
const SUSPECT_SLOTS = 4;
const DELIVERY_TIMEOUT_MS = 10_000;
const PERSON_COALESCE_MS = MINUTE;
const MAX_JOBS = 20_000;
const MAX_PER_HOST = 1_000;
const PERSONAL = new Set(['Follow', 'Accept', 'Reject', 'Like', 'EmojiReact', 'Undo']);
const ESSENTIAL = new Set(['Delete', 'Reject', 'Undo']);
const JOB_RE = /^j[0-9a-z]+\.json$/;
const FANOUT_KEY = '(fanout)';

const objectIdOf = (a) => {
  const o = a?.object;
  if (typeof o === 'string') return o;
  return o && typeof o.id === 'string' ? o.id : '';
};
const { hostOfUrl: canonicalHostOfUrl } = require('./handles');
// THE host normalizer's reading of a URL (lib/handles.js, P8 review F4).
const hostOf = canonicalHostOfUrl;
const isEssential = (job) => !job.courtesy && ESSENTIAL.has(job.activity_type);

/* The delay before attempt n+1 after n failures, with 10% jitter. */
function backoffMs(attempts, random = Math.random) {
  const base = attempts <= BACKOFF.length ? BACKOFF[Math.max(0, attempts - 1)] : DAILY;
  return Math.round(base * (1 + (random() * 0.2 - 0.1)));
}

function retryAfterMs(v, nowMs) {
  if (v === undefined || v === null || v === '') return null;
  const s = Number(v);
  let ms = Number.isFinite(s) ? s * 1000 : Date.parse(String(v)) - nowMs;
  if (!Number.isFinite(ms)) return null;
  ms = Math.max(0, Math.min(ms, RETRY_AFTER_MAX_MS));
  return ms;
}

/* A binary min-heap of { job } entries by (next_at, seq). Entries are never
 * updated in place: a changed job gets a new entry and the old one is stale
 * (lazy deletion, checked when it reaches the top). */
class Heap {
  constructor(stats) { this.a = []; this.stats = stats; }
  get size() { return this.a.length; }
  static less(x, y) { return x.job.next_at < y.job.next_at || (x.job.next_at === y.job.next_at && x.job.seq < y.job.seq); }
  push(e) {
    const a = this.a;
    a.push(e);
    this.stats.entries++;
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  peek() { return this.a[0]; }
  pop() {
    const a = this.a;
    const top = a[0];
    if (a.length) this.stats.entries--;
    const last = a.pop();
    if (a.length && last !== top) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function createQueue({
  paths, net, keys, actors, hosts, cfg, audit, logger = console, random = Math.random,
  onAttempt = () => {}, onGone = () => {}, onSignerIdle = () => {}, blocked = () => false, sendable = () => '',
  maxJobs = MAX_JOBS, maxPerHost = MAX_PER_HOST, hostBlocked = () => false,
  actorBlocked = () => false, inboxBlocked = () => false,
}) {
  const dir = paths.queueDir;
  const damagedDir = path.join(dir, 'damaged');
  const jobs = new Map();          // id -> job (a new object on every write)
  const chains = new Map();        // chain key -> [ids, ascending seq]; the head may run
  const bySigner = new Map();      // signer -> Set of ids
  const byHost = new Map();        // host -> Set of deliver ids
  const byObject = new Map();      // object id -> Set of ids
  const byActivityInbox = new Map(); // `${activity_id}\n${inbox}` -> deliver id
  const heapStats = { entries: 0 }; // entries in every heap, stale ones included
  let timeline = new Heap(heapStats); // runnable heads, not yet due (or not yet moved)
  const ready = { fresh: new Map(), suspect: new Map() };   // host key -> Heap of due heads
  const suspectHosts = new Set();  // hosts whose last attempt failed transiently
  const inflight = new Set();
  const perHost = new Map();
  let suspectInFlight = 0;
  let timer = null;
  let running = false;
  let loaded = false;
  let loading = false;
  const personSentAt = new Map();
  let lastSeq = 0;
  const nextSeq = () => { lastSeq = Math.max(lastSeq + 1, Date.now() * 1000); return lastSeq; };
  const waiters = new Set();
  const origin = () => cfg.publicOrigin;
  const counters = { visited: 0 };   // heap and index entries touched (tests: no full scans)

  const fileOf = (id) => path.join(dir, `${id}.json`);
  const newId = () => `j${clock.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;

  // ── the indexes ──

  const chainKeyOf = (j) => (j.object_id ? (j.kind === 'fanout' ? `f\n${j.object_id}` : `d\n${j.object_id}\n${j.inbox}`) : '');
  const hostKeyOf = (j) => (j.kind === 'deliver' ? j.host : FANOUT_KEY);
  const addTo = (map, k, id) => { let s = map.get(k); if (!s) { s = new Set(); map.set(k, s); } s.add(id); };
  const dropFrom = (map, k, id) => { const s = map.get(k); if (s) { s.delete(id); if (!s.size) map.delete(k); } };

  function isHead(job) {
    const k = chainKeyOf(job);
    if (!k) return true;
    const c = chains.get(k);
    return !!c && c[0] === job.id;
  }

  function chainInsert(job) {
    const k = chainKeyOf(job);
    if (!k) return;
    let c = chains.get(k);
    if (!c) { c = []; chains.set(k, c); }
    // Usually the newest (highest seq): append. At boot, any order: binary insert.
    if (!c.length || jobs.get(c[c.length - 1]).seq < job.seq) { c.push(job.id); return; }
    let lo = 0;
    let hi = c.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (jobs.get(c[mid]).seq < job.seq) lo = mid + 1; else hi = mid; }
    c.splice(lo, 0, job.id);
  }

  function chainRemove(job) {
    const k = chainKeyOf(job);
    if (!k) return;
    const c = chains.get(k);
    if (!c) return;
    const i = c.indexOf(job.id);
    if (i < 0) return;
    c.splice(i, 1);
    if (!c.length) { chains.delete(k); return; }
    if (i === 0) offer(jobs.get(c[0]));   // the next in line may run now
  }

  function index(job) {
    chainInsert(job);
    if (job.signer) addTo(bySigner, job.signer, job.id);
    if (job.kind === 'deliver') { addTo(byHost, job.host, job.id); byActivityInbox.set(`${job.activity_id}\n${job.inbox}`, job.id); }
    if (job.object_id) addTo(byObject, job.object_id, job.id);
  }

  function unindex(job) {
    if (job.signer) dropFrom(bySigner, job.signer, job.id);
    if (job.kind === 'deliver') {
      dropFrom(byHost, job.host, job.id);
      const k = `${job.activity_id}\n${job.inbox}`;
      if (byActivityInbox.get(k) === job.id) byActivityInbox.delete(k);
    }
    if (job.object_id) dropFrom(byObject, job.object_id, job.id);
    chainRemove(job);
  }

  /* A head that is not in flight gets a timeline entry. */
  function offer(job) {
    if (loading || !job || inflight.has(job.id) || !isHead(job)) return;
    timeline.push({ job });
  }
  const valid = (e) => !!e && jobs.get(e.job.id) === e.job && !inflight.has(e.job.id) && isHead(e.job);

  /* Stale entries pile up when jobs are rewritten or removed: rebuild past twice
   * the live count. */
  function compact() {
    if (heapStats.entries <= 2 * jobs.size + 1000) return;
    heapStats.entries = 0;
    timeline = new Heap(heapStats);
    ready.fresh.clear();
    ready.suspect.clear();
    for (const j of jobs.values()) offer(j);
  }

  function write(job) {
    const prev = jobs.get(job.id);
    jobs.set(job.id, job);
    if (prev) {
      // Only these may change on a rewrite; the keys of every index stay.
      if (prev.activity_id !== job.activity_id && job.kind === 'deliver') {
        byActivityInbox.delete(`${prev.activity_id}\n${prev.inbox}`);
        byActivityInbox.set(`${job.activity_id}\n${job.inbox}`, job.id);
      }
    } else index(job);
    writeJSON(fileOf(job.id), job);
    offer(job);
  }

  function remove(job, why) {
    const cur = jobs.get(job.id);
    if (!cur) return;
    jobs.delete(job.id);
    unindex(cur);
    try { fs.unlinkSync(fileOf(job.id)); } catch { /* gone */ }
    if (why) audit(why.event, 'system', { activity: job.activity_id, inbox: job.inbox || '', status: job.last_status ?? '', reason: why.reason || '' });
    if (job.signer && job.signer !== '_instance' && !hasSigner(job.signer)) {
      try { onSignerIdle(job.signer); } catch (e) { logger.error(`[queue] onSignerIdle: ${e.message}`); }
    }
  }

  // ── boot ──

  /* The activity id a damaged job file still says, when it says one. */
  function idOfDamaged(job, raw) {
    try { const b = JSON.parse(job.body); if (typeof b?.id === 'string') return b.id.slice(0, 600); } catch { /* not readable */ }
    if (typeof job?.activity_id === 'string') return job.activity_id.slice(0, 600);
    const m = /"activity_id"\s*:\s*"([^"\\]{1,600})"/.exec(raw || '');
    return m ? m[1] : '';
  }

  function quarantine(f, raw, job, why) {
    const activity = idOfDamaged(job || {}, raw);
    try {
      fs.mkdirSync(damagedDir, { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(dir, f), path.join(damagedDir, f));
    } catch (e) { logger.error(`[queue] could not move the damaged ${f} aside: ${e.message}`); }
    audit('delivery_damaged', 'system', { file: f, activity, reason: why });
    logger.error(`[queue] ${f} is damaged (${why}): moved to queue/damaged/${activity ? `, activity ${activity}` : ''}`);
  }

  const shapeProblem = (job, f) => {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return 'not an object';
    if (typeof job.id !== 'string' || `${job.id}.json` !== f) return 'id';
    if (typeof job.body !== 'string') return 'body';
    if (job.kind === 'fanout') { if (!Array.isArray(job.recipients) || !job.recipients.every((r) => typeof r === 'string')) return 'recipients'; }
    else if (job.kind === 'deliver') { if (typeof job.inbox !== 'string' || !job.inbox || typeof job.host !== 'string' || !job.host) return 'inbox'; }
    else return 'kind';
    if (!Number.isFinite(Date.parse(job.created_at))) return 'created_at';
    return '';
  };

  function load() {
    if (loaded) return;
    loaded = true;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    const now = clock.now();
    const expired = [];
    loading = true;
    for (const f of files) {
      if (!JOB_RE.test(f)) continue;
      let raw = null;
      try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); }
      catch (e) { quarantine(f, '', null, `unreadable: ${e.code || e.message}`); continue; }
      let job = null;
      try { job = JSON.parse(raw); } catch { job = null; }
      const why = job ? shapeProblem(job, f) : 'not JSON';
      if (why) { quarantine(f, raw, job, why); continue; }
      if (!Number.isFinite(job.seq)) job.seq = 0;
      if (!Number.isFinite(job.attempts)) job.attempts = 0;
      if (!Number.isFinite(job.next_at)) job.next_at = now;
      lastSeq = Math.max(lastSeq, job.seq);
      jobs.set(job.id, job);
      index(job);
      if (now - Date.parse(job.created_at) > GIVE_UP_MS) expired.push(job);
    }
    for (const j of expired) remove(j, { event: 'delivery_gave_up', reason: 'expired_at_boot' });
    loading = false;
    for (const j of jobs.values()) offer(j);
  }

  const hasSigner = (name) => (bySigner.get(name)?.size || 0) > 0;

  /* Cancel what a Delete overtakes; coalesce Updates. Never a job in flight. */
  function cancelFor(objectId, types, { inbox } = {}) {
    for (const id of [...(byObject.get(objectId) || [])]) {
      counters.visited++;
      const j = jobs.get(id);
      if (!j || inflight.has(j.id) || !types.has(j.activity_type)) continue;
      if (inbox && j.inbox !== inbox) continue;
      remove(j);
    }
  }

  /* Every queued job a member signs, except what must still go (Delete, Reject,
   * Undo): the purge and a suspension (spec 7, 11.4). A job in flight finishes.
   * -> how many went. */
  function cancelSigner(name, { keep = ESSENTIAL, reason = 'signer_inactive' } = {}) {
    load();
    let n = 0;
    for (const id of [...(bySigner.get(name) || [])]) {
      const j = jobs.get(id);
      if (!j || inflight.has(j.id) || (!j.courtesy && keep.has(j.activity_type))) continue;
      remove(j, { event: 'delivery_dropped', reason });
      n++;
    }
    return n;
  }

  /* A member no longer active (P8 review): every queued Announce a home
   * ring's Group (`_ring:<id>`) signs that carries THEIR room post (a Create or
   * Update whose actor is `actorId`) goes, fan-out and deliver jobs alike; an
   * Announce of their Delete stays (essential). One in flight finishes.
   * -> how many. */
  function cancelAnnouncesBy(actorId, reason = 'signer_inactive') {
    load();
    let n = 0;
    for (const [signer, ids] of [...bySigner.entries()]) {
      if (!signer.startsWith('_ring:')) continue;
      for (const id of [...ids]) {
        const j = jobs.get(id);
        if (!j || inflight.has(j.id) || j.activity_type !== 'Announce' || !['Create', 'Update'].includes(j.object_type)) continue;
        let inner = null;
        try { inner = JSON.parse(j.body)?.object; } catch { inner = null; }
        if (!inner || inner.actor !== actorId) continue;
        remove(j, { event: 'delivery_dropped', reason });
        n++;
      }
    }
    return n;
  }

  /* Is this recipient blocked by the job's signer NOW (spec 6.1)? Only a
   * recipient that came from the signer's followers collection is checked: an
   * activity addressed to an actor by name (the Undo and Reject a block sends)
   * still goes to them. */
  function isBlocked(job, actorId) {
    try { return blocked(job.signer, actorId); }
    catch (e) { logger.error(`[queue] block check: ${e.message}`); return true; }   // fail closed
  }

  function refuse(what, reason, extra = {}) {
    audit('delivery_refused', 'system', { activity: what.activity_id || what.id || '', reason, ...extra });
    logger.error(`[queue] refused ${what.activity_type || what.type} ${what.activity_id || what.id || ''}: ${reason}`);
  }

  /* ONE fan-out job for `activity` to `recipients` (actor ids). Sync.
   * `followers`: the recipients that came from the signer's followers
   * collection (lib/federation.js remote), re-checked against blocks at send.
   * `courtesy`: an answer to a stranger, never essential (refused past a cap). */
  function enqueue(activity, recipients, { signer, followers = [], courtesy = false, personal = false }) {
    load();
    const to = [...new Set(recipients.filter((r) => typeof r === 'string' && r))];
    if (!to.length) return null;
    const fol = [...new Set(followers.filter((r) => to.includes(r)))];
    const now = clock.now();
    const type = activity.type;
    const objectId = objectIdOf(activity);
    const body = JSON.stringify(activity);
    if (type === 'Delete' && objectId) cancelFor(objectId, new Set(['Create', 'Update']));
    const isPerson = type === 'Update' && activity.object?.type === 'Person';
    if (isPerson) {
      const queued = [...(byObject.get(objectId) || [])].map((id) => jobs.get(id))
        .find((j) => j && j.kind === 'fanout' && j.activity_type === 'Update' && !inflight.has(j.id));
      if (queued) {
        write({ ...queued, activity_id: activity.id, body, recipients: [...new Set([...queued.recipients, ...to])], followers: [...new Set([...(queued.followers || []), ...fol])] });
        return queued;
      }
    }
    const essential = !courtesy && ESSENTIAL.has(type);
    if (jobs.size >= maxJobs) {
      if (!essential) { refuse(activity, 'queue_full', { depth: jobs.size }); return null; }
      logger.error(`[queue] over the cap (${jobs.size} jobs): kept ${type} ${activity.id} (Delete, Reject and Undo are never refused)`);
    }
    let nextAt = now;
    if (isPerson) {
      const last = personSentAt.get(objectId) || 0;
      nextAt = Math.max(now, last + PERSON_COALESCE_MS);
      personSentAt.set(objectId, nextAt);
    }
    const objectType = typeof activity.object === 'object' && activity.object ? String(activity.object.type || '') : '';
    const job = {
      id: newId(), seq: nextSeq(), kind: 'fanout', activity_id: activity.id, activity_type: type, object_id: objectId,
      ...(objectType ? { object_type: objectType } : {}), signer, recipients: to, ...(fol.length ? { followers: fol } : {}),
      ...(courtesy ? { courtesy: true } : {}), ...(personal ? { personal: true } : {}), body, attempts: 0, next_at: nextAt, created_at: clock.iso(now), last_status: null,
    };
    write(job);
    schedule();
    return job;
  }

  /* `via`: { actor (personal), followers (the collection's actors this inbox
   * serves), direct (an actor named outright is served here too) }. */
  function addDeliver(fan, inbox, host, via) {
    if (byActivityInbox.has(`${fan.activity_id}\n${inbox}`)) return;
    const n = byHost.get(host)?.size || 0;
    if (n >= maxPerHost) {
      if (!isEssential(fan)) { refuse(fan, 'host_queue_full', { host }); return; }
      logger.error(`[queue] ${host} is over its cap (${n} jobs): kept ${fan.activity_type} ${fan.activity_id} (Delete, Reject and Undo are never refused)`);
    }
    if (fan.activity_type === 'Update') cancelFor(fan.object_id, new Set(['Update']), { inbox });
    const onlyFollowers = !via.direct && via.followers.length;
    write({
      id: newId(), seq: nextSeq(), kind: 'deliver', activity_id: fan.activity_id, activity_type: fan.activity_type, object_id: fan.object_id,
      ...(fan.object_type ? { object_type: fan.object_type } : {}),
      signer: fan.signer, inbox, host, ...(via.actor ? { actor: via.actor } : {}), ...(onlyFollowers ? { followers: via.followers } : {}),
      ...(fan.courtesy ? { courtesy: true } : {}), body: fan.body, attempts: 0, next_at: clock.now(), created_at: fan.created_at, last_status: null,
    });
  }

  /* After a failure: the next attempt, or give up. */
  function retry(job, status, { afterMs = null } = {}) {
    const attempts = job.attempts + 1;
    const now = clock.now();
    if (now - Date.parse(job.created_at) >= GIVE_UP_MS) return remove({ ...job, last_status: status }, { event: 'delivery_gave_up' });
    const delay = afterMs !== null ? afterMs : backoffMs(attempts, random);
    write({ ...job, attempts, last_status: status, next_at: now + delay });
  }

  function dropHost(host, reason = 'host_unavailable') {
    for (const id of [...(byHost.get(host) || [])]) {
      const j = jobs.get(id);
      if (j && !inflight.has(j.id)) remove(j, { event: 'delivery_dropped', reason });
    }
  }
  /* A new domain block (P8): every queued deliver job to a host it covers goes
   * now (one in flight finishes; its retry meets the check). -> how many. */
  function dropHosts(pred) {
    load();
    let n = 0;
    for (const h of [...byHost.keys()]) {
      if (!pred(h)) continue;
      n += byHost.get(h)?.size || 0;
      dropHost(h, 'domain_blocked');
    }
    return n;
  }

  /* Still to go? '' or why not (lib/federation.js sendable). */
  function stillSendable(job) {
    const why = sendable(job);
    if (why) { remove(job, { event: 'delivery_dropped', reason: why }); return false; }
    return true;
  }

  async function runFanout(job) {
    if (!stillSendable(job)) return;
    const personal = PERSONAL.has(job.activity_type) || job.personal === true;
    const targets = new Map();
    const failed = [];
    const fol = new Set(job.followers || []);
    for (const id of job.recipients) {
      // A blocked domain gets nothing and is never asked; a person the admin
      // blocks server-wide gets nothing either, except a Flag for their server.
      if (hostBlocked(hostOf(id))) { logger.log(`[queue] not sent to ${id}: a blocked domain`); continue; }
      if (job.activity_type !== 'Flag' && actorBlocked(id)) { logger.log(`[queue] not sent to ${id}: blocked server-wide`); continue; }
      try {
        // A follower the signer has blocked since the emit gets nothing (6.1).
        if (fol.has(id) && isBlocked(job, id)) { logger.log(`[queue] not sent to ${id}: blocked by ${job.signer}`); continue; }
        const rec = await actors.resolve(id);
        if (fol.has(id) && isBlocked(job, rec.id)) continue;
        const inbox = actors.inboxOf(rec, { personal });
        const host = hostOf(inbox);
        if (!host || hosts.unavailable(host)) continue;
        const t = targets.get(inbox) || { host, actor: personal ? rec.id : '', followers: [], direct: false };
        if (fol.has(id)) t.followers.push(rec.id); else t.direct = true;
        targets.set(inbox, t);
      } catch (e) {
        failed.push(id);
        logger.error(`[queue] could not resolve ${id}: ${e.message}`);
      }
    }
    // ── tick: the job may have been cancelled while we resolved ──
    if (!jobs.has(job.id)) return;
    const cur = jobs.get(job.id);
    if (!stillSendable(cur)) return;
    for (const [inbox, t] of targets) addDeliver(cur, inbox, t.host, t);
    if (failed.length) retry({ ...cur, recipients: failed }, 'unresolved');
    else remove(cur);
  }

  function signerOf(job) {
    if (job.signer === '_instance') return { keyId: `${origin()}/actor#main-key`, privateKey: keys.instancePrivateKey() };
    // A ring's Group (P7): `_ring:<ring id>`, its own key, `<group>#main-key`.
    if (job.signer.startsWith('_ring:')) {
      const id = job.signer.slice(6);
      if (!keys.hasRing(id)) return null;
      return { keyId: `${urls.groupUrl(origin(), id)}#main-key`, privateKey: keys.ringPrivateKey(id) };
    }
    if (!keys.has(job.signer)) return null;
    return { keyId: urls.keyIdOf(origin(), job.signer), privateKey: keys.privateKey(job.signer) };
  }

  function markSuspect(host, on) {
    if (on === suspectHosts.has(host)) return;
    if (on) suspectHosts.add(host); else suspectHosts.delete(host);
    // Its due heads move with it.
    const [from, to] = on ? [ready.fresh, ready.suspect] : [ready.suspect, ready.fresh];
    const hp = from.get(host);
    if (hp) { from.delete(host); to.set(host, hp); }
  }

  async function runDeliver(job) {
    if (hostBlocked(job.host)) return remove(job, { event: 'delivery_dropped', reason: 'domain_blocked' });
    if (job.activity_type !== 'Flag' && inboxBlocked(job.inbox)) return remove(job, { event: 'delivery_dropped', reason: 'actor_blocked' });
    if (hosts.unavailable(job.host)) return remove(job, { event: 'delivery_dropped', reason: 'host_unavailable' });
    if (!stillSendable(job)) return;
    // Every follower this inbox was serving, blocked since (a retry can come days
    // later): nothing goes (6.1).
    if (job.followers?.length && job.followers.every((id) => isBlocked(job, id))) return remove(job, { event: 'delivery_dropped', reason: 'blocked' });
    let key;
    try { key = signerOf(job); } catch { key = null; }
    if (!key) return remove(job, { event: 'delivery_dropped', reason: 'no_key' });
    try { onAttempt(job); } catch (e) { logger.error(`[queue] onAttempt: ${e.message}`); }
    let res = null;
    let err = null;
    try {
      res = await net.fetchGuarded(job.inbox, {
        method: 'POST',
        body: job.body,
        headers: { 'content-type': 'application/activity+json', accept: 'application/activity+json' },
        sign: (url, method, headers) => signHeaders({ method, url, headers, body: job.body, keyId: key.keyId, privateKey: key.privateKey, nowMs: clock.now() }),
        maxBytes: 64 * 1024,
        timeoutMs: DELIVERY_TIMEOUT_MS,
      });
    } catch (e) { err = e; }
    // ── tick ──
    const status = res ? res.status : (err?.code || 'network');
    const transient = !res || status === 408 || status === 429 || status >= 500;
    if (transient) markSuspect(job.host, true);
    else if (res && status >= 200 && status < 300) markSuspect(job.host, false);
    if (!jobs.has(job.id)) return;
    const cur = jobs.get(job.id);
    if (res && status >= 200 && status < 300) {
      hosts.success(job.host);
      return remove(cur);
    }
    if (transient) {
      if (hosts.failure(job.host)) { dropHost(job.host); return remove(cur, { event: 'delivery_dropped', reason: 'host_unavailable' }); }
      const after = status === 429 ? retryAfterMs(res.headers['retry-after'], clock.now()) : null;
      return retry(cur, status, { afterMs: after });
    }
    if (status === 410 && cur.actor) {
      remove({ ...cur, last_status: 410 }, { event: 'delivery_dropped', reason: 'gone' });
      try { onGone(cur.actor); } catch (e) { logger.error(`[queue] onGone: ${e.message}`); }
      return;
    }
    return remove({ ...cur, last_status: status }, { event: 'delivery_dropped', reason: status >= 300 && status < 400 ? 'redirect' : 'refused' });
  }

  // ── the loop ──

  const isSuspect = (hk) => {
    if (hk === FANOUT_KEY) return false;
    if (suspectHosts.has(hk)) return true;
    const row = hosts.get?.(hk);
    return !row?.last_success_at || !!row.failing_since || row.unavailable === true;
  };

  /* Move every due head from the timeline to its host's ready heap. */
  function promote() {
    const now = clock.now();
    while (timeline.size) {
      const e = timeline.peek();
      counters.visited++;
      if (!valid(e)) { timeline.pop(); continue; }
      if (e.job.next_at > now) break;
      timeline.pop();
      const hk = hostKeyOf(e.job);
      let hp = ready.fresh.get(hk) || ready.suspect.get(hk);
      if (!hp) {
        hp = new Heap(heapStats);
        let sus = false;
        try { sus = isSuspect(hk); } catch { sus = false; }
        if (sus) suspectHosts.add(hk);
        (sus ? ready.suspect : ready.fresh).set(hk, hp);
      }
      hp.push(e);
    }
  }

  /* The next runnable job of a host's ready heap, stale entries dropped. */
  function topOf(map, hk) {
    const hp = map.get(hk);
    while (hp?.size) {
      counters.visited++;
      if (valid(hp.peek())) return hp.peek().job;
      hp.pop();
    }
    map.delete(hk);
    return null;
  }

  function start(job, hk, suspect) {
    inflight.add(job.id);
    perHost.set(hk, (perHost.get(hk) || 0) + 1);
    if (suspect) suspectInFlight++;
    const run = job.kind === 'fanout' ? runFanout(job) : runDeliver(job);
    run.catch((e) => {
      // A fault (a damaged store, a full disk): this job waits a minute, never a
      // hot loop of the same failure.
      logger.error(`[queue] ${job.id}: ${e.stack || e.message}`);
      try { if (jobs.has(job.id)) write({ ...jobs.get(job.id), next_at: clock.now() + MINUTE, last_status: 'error' }); }
      catch (e2) { const j = jobs.get(job.id); if (j) j.next_at = clock.now() + MINUTE; logger.error(`[queue] ${job.id}: ${e2.message}`); }
    }).finally(() => {
      inflight.delete(job.id);
      if (suspect) suspectInFlight--;
      const n = (perHost.get(hk) || 1) - 1;
      if (n) perHost.set(hk, n); else perHost.delete(hk);
      offer(jobs.get(job.id));
      pump();
      settle();
    });
  }

  /* Start what may start, round robin over the hosts with due work: a host gets
   * one job per turn, then goes to the back of the line. */
  function fill(map, suspect) {
    let turns = map.size;
    for (const hk of map.keys()) {
      if (turns-- <= 0 || inflight.size >= IN_FLIGHT) break;
      if (suspect && suspectInFlight >= SUSPECT_SLOTS) break;
      const cap = hk === FANOUT_KEY ? IN_FLIGHT : suspect ? 1 : PER_HOST;
      if ((perHost.get(hk) || 0) >= cap) continue;
      const job = topOf(map, hk);
      if (!job) continue;
      map.get(hk).pop();
      const hp = map.get(hk);
      map.delete(hk);
      if (hp.size) map.set(hk, hp);   // to the back of the line
      start(job, hk, suspect);
    }
  }

  function pump() {
    if (!running) return;
    promote();
    let before = -1;
    while (inflight.size < IN_FLIGHT && inflight.size !== before) {
      before = inflight.size;
      fill(ready.fresh, false);
      fill(ready.suspect, true);
    }
    compact();
    schedule();
  }

  /* Is any due head waiting to start? Stale tops go as they are met, so this is
   * amortized O(1), never a pass over every host. */
  function anyReady() {
    for (const m of [ready.fresh, ready.suspect]) for (const hk of m.keys()) if (topOf(m, hk)) return true;
    return false;
  }

  function schedule() {
    if (!running) return;
    if (timer) { clearTimeout(timer); timer = null; }
    let next = Infinity;
    while (timeline.size && !valid(timeline.peek())) timeline.pop();
    if (timeline.size) next = timeline.peek().job.next_at;
    if (!inflight.size && (ready.fresh.size || ready.suspect.size)) next = clock.now();
    if (next === Infinity) return;
    const wait = Math.max(0, Math.min(next - clock.now(), 60_000));
    timer = setTimeout(() => { timer = null; pump(); }, wait);
    timer.unref();
  }

  /* Anything due now that has not started? */
  function hasDue() {
    promote();
    return anyReady();
  }

  function settle() {
    if (inflight.size || hasDue()) return;
    for (const w of [...waiters]) { waiters.delete(w); w(); }
  }

  function start_() { load(); running = true; pump(); }
  function stop() { running = false; if (timer) clearTimeout(timer); timer = null; }

  /* Tests and the clock: run what is due now, and wait until nothing due is left. */
  async function drain({ timeoutMs = 20_000 } = {}) {
    load();
    const wasRunning = running;
    running = true;
    const end = Date.now() + timeoutMs;
    try {
      for (;;) {
        pump();
        if (!inflight.size && !hasDue()) return;
        await new Promise((resolve) => {
          waiters.add(resolve);
          setTimeout(() => { waiters.delete(resolve); resolve(); }, 50).unref();
        });
        if (Date.now() > end) throw new Error('queue: drain timed out');
      }
    } finally {
      if (!wasRunning) stop();
    }
  }

  return {
    enqueue, start: start_, stop, drain, kick: () => { load(); pump(); }, hasSigner, cancelSigner, cancelAnnouncesBy, dropHosts,
    list: () => { load(); return [...jobs.values()].map((j) => ({ ...j })); },
    depth: () => { load(); return jobs.size; },
    inflight: () => inflight.size,
    hostDepth: (host) => { load(); return byHost.get(host)?.size || 0; },
    counters: () => ({ ...counters }),
  };
}

module.exports = {
  createQueue, backoffMs, retryAfterMs, BACKOFF, DAILY, GIVE_UP_MS, PERSONAL, ESSENTIAL,
  IN_FLIGHT, PER_HOST, SUSPECT_SLOTS, DELIVERY_TIMEOUT_MS, MAX_JOBS, MAX_PER_HOST,
};
