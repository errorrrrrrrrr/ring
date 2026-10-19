'use strict';
/* ── Account deletion, the local purge (spec 11.4) ────────────────────────────
 * THE list of a member's traces on this server. P1 removes: every session, every
 * image they own (bytes and rows), their member dir (page store, tombstones,
 * visits), the invites they minted and the mark of the one they used, their reset
 * and signup tokens, every mail to their address still in the `log` provider's
 * outbox, their name in others' `invited_by`, their signing key, and
 * last the member row, retiring the name for good (lib/members.js).
 *
 * P2 adds, before the member dir goes: every follow either way is severed (Undo
 * of theirs, Reject of the other's: the other side's rows go in the same tick),
 * every ring membership, request and kicked mark is dropped (`dropFromRing`: a
 * ring passes the creator role on, or dissolves) and a join code they minted
 * rotates (lib/groups.js purgeMember), and every stamp and comment they left on
 * anyone's posts is removed (a return address must not outlive its name). Their
 * own posts' reactions go with the member dir. From P5 the key waits for the last
 * delivery job they sign (the Reject and Undo their severs send to other servers;
 * Delete{Person} from P6) instead of going here (spec 2.6): lib/queue.js removes
 * it when that job ends, and housekeeping sweeps a retired name's key with none.
 * Every OTHER job they sign (a Create still queued for a down server, an
 * Update{Person}) is cancelled here (queue.cancelSigner, N3): only Delete,
 * Reject and Undo still go.
 *
 * P6, THE FAREWELL (spec 4.9, 11.4, the 2.6 decision): Delete{Person} goes to
 * every server that knows the member (a follow either way, a reaction either
 * way, a From elsewhere row), queued just before that cancel while the member
 * is still active, and, being a Delete, it survives it. A REMOTE edge is NOT
 * severed with its own Undo and Reject any more: the Delete{Person} says it all
 * (Mastodon, Pleroma, Akkoma, Misskey and Ring all drop every follow, stamp and
 * comment of a deleted actor), and one Delete per server is the only job the
 * gone member's key still signs. A local edge is severed in-process as before.
 * The key waits for that job (lib/queue.js onSignerIdle); the actor answers 410
 * with a Tombstone that carries no key; a receiver verifies the Delete with the
 * key it already holds (every server that knows the member fetched it to
 * verify their earlier traffic; Mastodon also accepts a Delete from an actor it
 * finds gone).
 *
 * NEVER HALF-RUN (R6). Two phases, synchronous:
 *   1. READ AND VALIDATE, writing nothing: their own follows, rings.json, the
 *      invites and token files, the image rows. A damaged one of THESE throws
 *      here (a StoreReadError, the route's 500) and nothing has changed: their
 *      own data and the shared files are the operator's to fix, never guessed.
 *      Every OTHER member's follows and reaction files are read too: a damaged
 *      one is SKIPPED and logged (its rows naming the deleted member stay until
 *      it is restored; every reader drops a row whose member is gone), never a
 *      reason to refuse the deleter.
 *   2. THE PURGE. A per-other step that still throws (an I/O error since phase 1)
 *      is logged and skipped the same way. Each step is idempotent, and the
 *      sessions end and the row goes LAST, after the point of no return: a crash
 *      midway leaves a signed-in account whose DELETE runs again and finishes
 *      (a retry also sweeps every other member's file for a row naming them, so a
 *      sever cut short on the other side is finished too), never a half-account
 *      with a free name, nor one its owner can no longer reach.
 */
const fs = require('node:fs');

function createPurge({ paths, members, invites, pending, resets, images, keys, sessionStore, projection, visits, audit, mailer, follows, groups, reactions, ringStore, defaultOrigin, logger = console, queue = null, farewell = null }) {
  return function purge(name, { origin = defaultOrigin() } = {}) {
    const m = members.get(name);
    if (!m) return false;

    // ── 1. read and validate: nothing written yet ──
    const edges = follows.edgesOf(name);
    ringStore.load();
    invites.listFor(name);
    resets.all();
    pending.all();
    const imageKeys = images.keysOf(name);
    const readable = new Set();
    const skipped = [];
    for (const o of members.all()) {
      if (o.slug === name) continue;
      try {
        follows.load(o.slug);
        reactions.loadStamps(o.slug);
        reactions.loadComments(o.slug);
        readable.add(o.slug);
      } catch (e) {
        skipped.push(o.slug);
        logger.error(`[purge] ${name}: skipped ${o.slug}, a file could not be read: ${e.message}`);
      }
    }
    const each = (step, fn) => {
      for (const other of readable) {
        try { fn(other); }
        catch (e) {
          if (!skipped.includes(other)) skipped.push(other);
          logger.error(`[purge] ${name}: ${step} skipped ${other}: ${e.message}`);
        }
      }
    };

    // ── 2. the purge ──
    for (const other of edges) {
      if (other.includes('@')) continue;   // a remote edge: the farewell's Delete{Person} ends it
      if (members.get(other) && !readable.has(other)) continue;   // damaged: their side waits for a restore
      try { follows.sever(name, other, origin); }
      catch (e) { logger.error(`[purge] ${name}: sever skipped ${other}: ${e.message}`); }
    }
    each('follows', (other) => follows.dropHandle(other, name));
    // P6 (spec 4.9, 11.4): Delete{Person} to every server that knows them.
    if (farewell) {
      try { farewell(name, origin); }
      catch (e) { logger.error(`[purge] ${name}: the farewell was not queued: ${e.message}`); }
    }
    // Nothing else they signed goes now: what is still queued for other servers
    // (a Create waiting on a down host, an Update{Person}) is cancelled, Delete,
    // Reject and Undo excepted (N3). The queue's own send-time check holds too.
    if (queue) {
      try { queue.cancelSigner(name, { reason: 'signer_gone' }); }
      catch (e) { logger.error(`[purge] ${name}: queued jobs not cancelled (the send-time check still drops them): ${e.message}`); }
    }
    groups.purgeMember(name, origin);
    each('reactions', (other) => reactions.removeAuthor(other, name));
    images.remove(imageKeys);
    visits.drop(name);
    fs.rmSync(paths.memberDir(name), { recursive: true, force: true });
    invites.removeFor(name);
    resets.removeWhere((r) => r.slug === name);
    pending.removeWhere((r) => r.email_lc === m.email_lc);
    try { mailer?.forget(m.email_lc); }
    catch (e) { logger.error(`[purge] ${name}: the mail outbox was not trimmed (housekeeping's 24 h prune still will): ${e.message}`); }
    for (const other of members.all()) {
      if (other.invited_by === name) members.update(other.slug, { invited_by: null });
    }
    // The point of no return: only now do the sessions end, then the row.
    sessionStore.destroyFor(name);
    if (!queue?.hasSigner(name)) keys.remove(name);   // else its last job removes it
    members.remove(name);
    projection.invalidate(name);
    audit('member.deleted', name, skipped.length ? { skipped } : undefined);
    return true;
  };
}

module.exports = { createPurge };
