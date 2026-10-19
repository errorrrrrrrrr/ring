'use strict';
/* ── Named rings, the pure half (spec 3.6, 4.7) ───────────────────────────────
 * A named room of up to 6 members,
 * 3 rings per member, a 60-character name, one standing multi-use join link of
 * 14 days that ASKS (a member approves), and ONE permission: members read the
 * posts addressed to the ring, and their images. Membership implies nothing
 * pairwise; ring-gating anything else is forbidden. Pure: no storage, no clock
 * but the `now` a caller passes.
 *
 * The v2 row (spec 3.6), shaped like the Group it is on its home server:
 *   { id, ap_id, home, name, created_by, created_at,
 *     members[{ handle, joined_at }], requests[{ handle, asked_at, join_id }],
 *     kicked[handle], join: { code, created_by, created_at, expires_at } | null,
 *     join_url, rev }
 * `kicked` remembers who the creator removed: a kick sticks, so only the creator
 * re-admits a kicked handle (a member's approval of one is refused), and a
 * re-admission or the purge takes the handle off the list.
 * A HOME row is the ring itself (this server hosts its Group). A replica (home
 * false, P7) is a copy of a ring hosted elsewhere that a member here belongs to,
 * replaced whole by each higher `rev` of the Group's Update (lib/ring-fed.js),
 * never holding the code: only the `join_url` and `join_expires` the Group
 * shows its members. A handle is local (a bare name) or remote (`name@host`).
 *
 * Members are handles (spec 2.4: a handle is never cut, and
 * a value not in stored handle shape is dropped); `id` must be `ring_` + 20 hex
 * (lib/ids.js mints it from the CSPRNG); a request keeps
 * the id of the `Join` that filed it; `rev` counts every change a replica must
 * see. Requests hold a seat (a full room cannot queue a seventh).
 */
const { isHandle } = require('./handles');
const { RING_ID_RE } = require('./ids');
const { plainLine } = require('./ring');

const RING_MAX_MEMBERS = 6;     // HARD, pending requests included
const RING_MAX_PER_MEMBER = 3;  // a member belongs to at most 3 rings
const RING_NAME_MAX = 60;
const RING_MAX_RINGS = 2000;    // file bound, not a product limit
const RING_JOIN_TTL_MS = 14 * 24 * 3600_000;
const RING_MAX_KICKED = 100;    // file bound: the handles a ring remembers it kicked

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const handleOk = (h) => isHandle(h, { allowPort: true });

/* Member-authored name: plain bounded text (control characters and bidi
 * overrides out, lib/ring.js plainLine), rendered escaped, never public. */
const normalizeRingName = (raw) => plainLine(raw, RING_NAME_MAX);

function normalizeJoin(raw) {
  const code = typeof raw?.code === 'string' ? raw.code.slice(0, 64) : '';
  if (!code) return null;
  return {
    code,
    created_by: handleOk(raw.created_by) ? raw.created_by : '',
    created_at: str(raw.created_at, 40),
    expires_at: str(raw.expires_at, 40),
  };
}

/* ONE ring row; null for a husk (a bad id, or nobody in it). */
function normalizeRing(raw) {
  if (!raw || typeof raw.id !== 'string' || !RING_ID_RE.test(raw.id)) return null;
  const seen = new Set();
  const members = [];
  for (const m of (Array.isArray(raw.members) ? raw.members : []).slice(0, RING_MAX_MEMBERS)) {
    if (!handleOk(m?.handle) || seen.has(m.handle)) continue;
    seen.add(m.handle);
    members.push({ handle: m.handle, joined_at: str(m.joined_at, 40) });
  }
  if (!members.length) return null;
  const requests = [];
  for (const q of (Array.isArray(raw.requests) ? raw.requests : []).slice(0, RING_MAX_MEMBERS)) {
    if (!handleOk(q?.handle) || seen.has(q.handle)) continue;
    if (members.length + requests.length >= RING_MAX_MEMBERS) break;
    seen.add(q.handle);
    requests.push({ handle: q.handle, asked_at: str(q.asked_at, 40), join_id: str(q.join_id, 600) });
  }
  // Kicked handles (R3): only the creator re-admits one. Never a current member.
  const kicked = [];
  for (const k of (Array.isArray(raw.kicked) ? raw.kicked : []).slice(-RING_MAX_KICKED)) {
    if (handleOk(k) && !members.some((m) => m.handle === k) && !kicked.includes(k)) kicked.push(k);
  }
  const home = raw.home !== false;
  return {
    id: raw.id,
    ap_id: str(raw.ap_id, 600),
    home,
    name: normalizeRingName(raw.name),
    created_by: members.some((m) => m.handle === raw.created_by) ? raw.created_by : members[0].handle,
    created_at: str(raw.created_at, 40),
    members,
    requests,
    kicked,
    join: home ? normalizeJoin(raw.join) : null,   // a replica never holds the code
    join_url: str(raw.join_url, 700),
    ...(home ? {} : { join_expires: str(raw.join_expires, 40) }),   // a replica's: what the Group said
    rev: Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
  };
}

function normalizeRings(raw) {
  const out = [];
  const ids = new Set();
  for (const r of (Array.isArray(raw) ? raw : []).slice(0, RING_MAX_RINGS)) {
    const n = normalizeRing(r);
    if (n && !ids.has(n.id)) { ids.add(n.id); out.push(n); }
  }
  return out;
}

const isMember = (ring, handle) => ring.members.some((m) => m.handle === handle);
const hasRequested = (ring, handle) => ring.requests.some((q) => q.handle === handle);
const wasKicked = (ring, handle) => (ring.kicked || []).includes(handle);
const ringOccupancy = (ring) => ring.members.length + ring.requests.length;
const ringIsFull = (ring) => ringOccupancy(ring) >= RING_MAX_MEMBERS;
const ringsOf = (rings, handle) => rings.filter((r) => isMember(r, handle));

/* Do these two share a room? THE ring-permission predicate. */
const shareARing = (rings, a, b) => !!a && !!b && a !== b && rings.some((r) => isMember(r, a) && isMember(r, b));

/* A join link admits an ask only while present AND unexpired, checked at every use. */
function joinLinkLive(ring, nowMs) {
  const j = ring.join;
  if (!j?.code) return false;
  const exp = Date.parse(j.expires_at || '');
  return Number.isFinite(exp) && exp > nowMs;
}

/* The hosts a ring's members are on (spec 4.7: the header lists who holds the
 * room). `localHost` names this server for a bare (local) handle. */
function hostsOf(ring, localHost) {
  const out = new Set();
  for (const m of ring.members) out.add(m.handle.includes('@') ? m.handle.slice(m.handle.indexOf('@') + 1) : localHost);
  return [...out].sort();
}

const ringByJoinCode = (rings, code, nowMs) => (typeof code === 'string' && code
  ? rings.find((r) => r.home && r.join?.code === code && joinLinkLive(r, nowMs)) || null
  : null);

/* Drop a handle from a ring (leave, kick, purge): the creator role passes to the
 * OLDEST remaining member. null when the last member left (the ring dissolves). */
function dropFromRing(ring, handle) {
  const members = ring.members.filter((m) => m.handle !== handle);
  const requests = ring.requests.filter((q) => q.handle !== handle);
  if (!members.length) return null;
  const created_by = ring.created_by === handle ? members[0].handle : ring.created_by;
  return { ...ring, members, requests, created_by };
}

module.exports = {
  RING_MAX_MEMBERS, RING_MAX_PER_MEMBER, RING_NAME_MAX, RING_MAX_RINGS, RING_JOIN_TTL_MS, RING_MAX_KICKED,
  normalizeRingName, normalizeRing, normalizeRings, normalizeJoin,
  isMember, hasRequested, wasKicked, ringOccupancy, ringIsFull, ringsOf, shareARing,
  joinLinkLive, ringByJoinCode, dropFromRing, hostsOf,
};
