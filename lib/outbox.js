'use strict';
/* ── THE delivery door: emit(activity, recipients) (spec 7) ───────────────────
 * Every social act on this server is an activity (lib/activities.js) that leaves
 * through here. A recipient on THIS server gets it applied in-process by the same
 * handler registry a remote one goes through (lib/ap-inbound.js), minus the
 * signature step: it never left the process, so its signer is its own actor. A
 * recipient elsewhere becomes a delivery job (P5): bindRemote(fn) hands every
 * emit's remote part to lib/federation.js, which keeps the P5 slice (what may
 * leave, and to whom) and writes ONE fan-out job into lib/queue.js in this same
 * tick. With FEDERATION=off nothing is bound and nothing leaves.
 *
 *   recipients   actor or Group URLs, or a member's `followers` collection
 *                (expanded, by the remote hook, to the remote followers; local
 *                followers read the author's posts live and need no copy).
 *                `as:Public` is an address, never an inbox.
 *   courtesy     (option) an answer to a stranger, such as a Reject of a Follow
 *                past a member's caps: its job is never essential, so the
 *                queue refuses it past its caps (lib/queue.js)
 *   returns      [{ to, result }] for each local recipient, in order: what its
 *                handler answered ({ status, error?, ... }). A route answers from
 *                it, so the post's own server stays the authority (spec 3.7).
 *
 * SYNCHRONOUS for local recipients: a follow between two members is written into
 * both files in one tick (spec 3.5). A handler that emits (an Accept answering a
 * Follow) re-enters here; the rule that keeps that safe lives in ap-inbound.js:
 * a handler saves BEFORE it emits and writes nothing after an emit returns.
 *
 * tap(fn): fn({ activity, to }) for every emit, before delivery. The activity-
 * shapes gate pins what goes out through it. A tap that throws is logged and
 * never stops a delivery.
 */
const urls = require('./urls');

function createOutbox({ logger = console } = {}) {
  let receive = null;
  let remote = null;
  const taps = new Set();
  let depth = 0;

  function bind(fn) { receive = fn; }
  function bindRemote(fn) { remote = fn; }

  function tap(fn) {
    taps.add(fn);
    return () => taps.delete(fn);
  }

  function emit(activity, recipients, { origin, courtesy = false }) {
    if (!activity) return [];
    const to = [...new Set((recipients || []).filter((r) => typeof r === 'string' && r && r !== urls.AS_PUBLIC))];
    for (const t of taps) {
      try { t({ activity, to }); } catch (e) { logger.error(`[outbox] a tap failed: ${e.message}`); }
    }
    if (depth > 16) throw new Error('outbox: delivery loop');   // a handler bug, never a real chain
    const results = [];
    const elsewhere = [];
    depth++;
    try {
      for (const r of to) {
        const local = urls.parseLocal(r, origin);
        if (!local) { elsewhere.push(r); continue; }   // a remote actor: a job
        let inbox = null;
        if (local.kind === 'person') inbox = { kind: 'person', name: local.name };
        else if (local.kind === 'group') inbox = { kind: 'group', id: local.id };
        else if (local.kind === 'collection' && local.which === 'followers') { elsewhere.push(r); continue; }   // its remote members
        else continue;
        results.push({ to: r, result: receive(activity, { inbox, origin, signer: activity.actor }) });
      }
    } finally { depth--; }
    if (remote && elsewhere.length) {
      try { remote(activity, elsewhere, { origin, courtesy }); }
      catch (e) { logger.error(`[outbox] the remote part of ${activity.type} was not queued: ${e.stack || e.message}`); }
    }
    return results;
  }

  return { emit, tap, bind, bindRemote };
}

module.exports = { createOutbox };
