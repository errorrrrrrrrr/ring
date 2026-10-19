'use strict';
/* ── THE inbound registry (spec 4.10) ─────────────────────────────────────────
 * What this server accepts, and the one function that applies it: receive(
 * activity, { inbox, origin, signer }). A closed registry (`HANDLERS`), one table
 * per kind of inbox: a member's (`person`) and a ring's Group (`group`). Anything
 * not listed answers 202 and is dropped. P2 runs it in-process, for activities
 * lib/outbox.js emit() delivers to members here; P5 puts the signature check in
 * front of the same call, and P6 to P8 add rows (Update/Delete of a Person, Block,
 * Flag, Add/Remove of pins, a remote friend's wall), never a second door.
 *
 * A key is `Type` or `Type:ObjectType`. The object type is the embedded object's
 * `type` (a Tombstone counts as the Note it was, and an actor of any type
 * counts as a Person), or for a bare id what that URL names on this server; in
 * a Group's inbox a bare Accept or Reject is about a Join (members answer
 * requests by the Join's id), and a Remove whose target is not the Group is
 * about a reaction. In a member's inbox a bare Accept or Reject naming one of
 * this server's activities is about a Follow (the only activity a member's
 * answer can name; other software sends the Follow's id alone). A Delete whose
 * bare object is its own actor is a Delete{Person}; any other remote bare id
 * under a Delete is read as a Note (the handlers find what they hold, if
 * anything).
 *
 * P7 adds a fourth, `ring`: what a ring's Group on another server sends
 * (RING_KEYS, lib/ring-fed.js), reached only from lib/federation.js.
 *
 * P6 adds a third table, `server`: what another server sends that is about
 * nothing ONE member holds (a remote friend's wall, which every friend here
 * reads; an actor's own Update or Delete; an Update or Delete of a Note held
 * wherever it is). lib/federation.js routes a remote activity to its members'
 * tables, to `server`, or both.
 *
 * THE SIGNER: in-process it is the activity's own actor (it never left the
 * process); from P5 the verified key owner. receive() refuses (401) an activity
 * whose actor is not its signer, before any handler runs.
 *
 * THE RE-ENTRANCY RULE, for every handler: load, change and SAVE in one tick
 * BEFORE emitting anything, and write nothing after an emit returns. A recipient
 * here answers in the same tick (a Follow's Accept, an Accept's Leave), and its
 * handler may write the very file the caller loaded.
 */
const urls = require('./urls');

const PERSON_KEYS = [
  'Follow', 'Accept:Follow', 'Reject:Follow', 'Undo:Follow',
  'Like', 'EmojiReact', 'Undo:Like', 'Undo:EmojiReact',
  'Create:Note', 'Delete:Note', 'Block',
  'Accept:Join', 'Reject:Join', 'Update:Group', 'Remove', 'Delete:Group', 'Announce',
];
const SERVER_KEYS = [
  'Create:Note', 'Create:Article', 'Create:Page',
  'Update:Note', 'Update:Article', 'Update:Page', 'Delete:Note',
  'Update:Person', 'Delete:Person',
  'Flag',   // P8: a report from another server, to the admin's queue (spec 6.2)
];
const ACTOR_TYPES = new Set(['Person', 'Service', 'Application', 'Organization']);
const GROUP_KEYS = [
  'Join', 'Accept:Join', 'Reject:Join', 'Leave', 'Remove', 'Update:Group', 'Delete:Group',
  'Create:Note', 'Update:Note', 'Delete:Note',
  'Like', 'EmojiReact', 'Undo:Like', 'Undo:EmojiReact', 'Remove:Reaction',
];

/* P7: what a ring's Group on ANOTHER server sends this one (lib/ring-fed.js),
 * routed here by lib/federation.js only when the signer is a Group record of
 * the actor cache (its key, the ring's): answers to a Join this server sent,
 * the ring as it now is, a member here removed, the ring deleted, and the
 * room's activities Announced. */
const RING_KEYS = ['Accept:Join', 'Reject:Join', 'Update:Group', 'Remove', 'Delete:Group', 'Announce'];

const KIND_TYPE = { person: 'Person', group: 'Group', post: 'Note', comment: 'Note', stamp: 'Like' };

/* The registry key of an activity arriving at `inbox`. */
function keyOf(activity, inbox, origin) {
  const type = activity.type;
  if (inbox.kind === 'ring') {
    const k = { Accept: 'Accept:Join', Reject: 'Reject:Join', Update: 'Update:Group', Remove: 'Remove', Delete: 'Delete:Group', Announce: 'Announce' }[type];
    return k || type;
  }
  const o = activity.object;
  let objType = '';
  if (o && typeof o === 'object') objType = o.type === 'Tombstone' ? 'Note' : ACTOR_TYPES.has(o.type) ? 'Person' : String(o.type || '');
  else if (typeof o === 'string') {
    const local = urls.parseLocal(o, origin);
    objType = KIND_TYPE[local?.kind] || '';
    if (inbox.kind === 'person' && (type === 'Accept' || type === 'Reject') && local?.kind === 'activity') return `${type}:Follow`;
    if (type === 'Delete' && !local) objType = o === activity.actor ? 'Person' : 'Note';
  }
  if (inbox.kind === 'group') {
    if ((type === 'Accept' || type === 'Reject') && typeof o === 'string') return `${type}:Join`;
    if (type === 'Remove') return activity.target === urls.groupUrl(origin, inbox.id) ? 'Remove' : 'Remove:Reaction';
  }
  if (['Join', 'Leave', 'Like', 'EmojiReact', 'Follow', 'Announce', 'Remove', 'Block'].includes(type)) return type;
  return objType ? `${type}:${objType}` : type;
}

function createInbound({ handlers, logger = console }) {
  const HANDLERS = { person: {}, group: {}, server: {}, ring: {} };
  for (const k of PERSON_KEYS) {
    if (typeof handlers.person[k] !== 'function') throw new Error(`ap-inbound: no person handler for ${k}`);
    HANDLERS.person[k] = handlers.person[k];
  }
  for (const k of GROUP_KEYS) {
    if (typeof handlers.group[k] !== 'function') throw new Error(`ap-inbound: no group handler for ${k}`);
    HANDLERS.group[k] = handlers.group[k];
  }
  for (const k of SERVER_KEYS) {
    if (typeof handlers.server?.[k] !== 'function') throw new Error(`ap-inbound: no server handler for ${k}`);
    HANDLERS.server[k] = handlers.server[k];
  }
  for (const k of RING_KEYS) {
    // With FEDERATION=off there is no other server: a closed table of drops.
    HANDLERS.ring[k] = typeof handlers.ring?.[k] === 'function' ? handlers.ring[k] : () => ({ status: 202, dropped: true });
  }
  Object.freeze(HANDLERS.ring);
  Object.freeze(HANDLERS.person);
  Object.freeze(HANDLERS.group);
  Object.freeze(HANDLERS.server);

  function receive(activity, { inbox, origin, signer }) {
    if (!activity || typeof activity !== 'object' || typeof activity.type !== 'string' || typeof activity.actor !== 'string') return { status: 400, dropped: true };
    if (signer !== activity.actor) return { status: 401, dropped: true };
    const table = HANDLERS[inbox?.kind];
    if (!table) return { status: 404, dropped: true };
    const fn = Object.hasOwn(table, keyOf(activity, inbox, origin)) ? table[keyOf(activity, inbox, origin)] : null;
    if (!fn) return { status: 202, dropped: true };
    try {
      return fn(activity, { inbox, origin, signer }) || { status: 202 };
    } catch (e) {
      if (e.code === 'MEMBER_GONE') return { status: 404, dropped: true };
      logger.error(`[inbound] ${activity.type} to ${inbox.kind}: ${e.stack || e.message}`);
      throw e;
    }
  }

  return { receive, HANDLERS, keyOf };
}

module.exports = { createInbound, keyOf, PERSON_KEYS, GROUP_KEYS, SERVER_KEYS, RING_KEYS };
