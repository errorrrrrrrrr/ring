'use strict';
/* ── What another server sends about nothing one member holds (spec 4.10) ─────
 * The `server` table of lib/ap-inbound.js: handlers for an activity from
 * ANOTHER server that is about the server's shared state, routed here by
 * lib/federation.js after the signature, the id and the ownership checks:
 *
 *   Create{Note|Article|Page}  a remote FRIEND's public or unlisted post: their
 *                              wall cache (lib/walls.js), which fills the
 *                              Friends feed of every member who is their
 *                              friend. A reply is a conversation, not a wall
 *                              post: it lands here only as a comment or From
 *                              elsewhere (lib/comments.js), never on a wall.
 *                              An Article or Page shows as a titled link.
 *   Update{Note|Article|Page}  the author's own edit: their wall entry, every
 *                              comment row they left here, every From
 *                              elsewhere row they wrote
 *   Delete{Note}               the same three, removed
 *   Update{Person}             the actor's own profile (lib/actors.js
 *                              applyUpdate: the same checks a fetch gets, the
 *                              handle never moves); the walls that show their
 *                              name are redrawn
 *   Delete{Person}             the actor itself: GONE (5.3, `forget`)
 *
 * OWNERSHIP (5.4) is held twice: lib/federation.js refuses an Update or Delete
 * whose object is not on the actor's host before any handler runs, and every
 * store here moves only rows whose stored author IS the signer. A remote server
 * can never write anything about another host's objects or people.
 *
 * F3: an Update or Delete of a Note reads ONLY what holds that id: the wall
 * that holds it (lib/walls.js's index) and the members lib/holders.js names
 * (their comments, their From elsewhere). An id nothing here holds costs no
 * member file and no parse. F1: an object is settled once per activity
 * (lib/remote-note.js settleCached), however many tables it reaches. F5: an
 * Update that makes a wall post followers-only or direct removes it; F11: a
 * Create whose id lies in another actor's path is dropped.
 *
 * Each member's file is its own tick: a damaged one is skipped and logged,
 * never a reason to stop the others (the purge's rule).
 */
const { settleCached, idUnderActor } = require('./remote-note');

function createRemoteIn({ members, actors, walls, comments, elsewhere, reactions, follows, sent, projection, audit, friendAnywhere, holders, logger = console }) {
  const each = (step, fn) => {
    for (const m of members.all()) {
      try { fn(m.slug); } catch (e) { logger.error(`[remote-in] ${step}: skipped ${m.slug}: ${e.message}`); }
    }
  };
  /* Only the members whose rows hold this remote object (lib/holders.js, F3). */
  const holding = (step, id, fn) => {
    for (const name of holders.of(id)) {
      if (!members.get(name)) continue;
      try { fn(name); } catch (e) { logger.error(`[remote-in] ${step}: skipped ${name}: ${e.message}`); }
    }
  };
  const handleOf = (activity) => actors.handleOf(activity.actor);
  const objectId = (activity) => (typeof activity.object === 'string' ? activity.object : typeof activity.object?.id === 'string' ? activity.object.id : '');

  function onCreate(activity) {
    const from = handleOf(activity);
    if (!from || !friendAnywhere(from)) return { status: 202, dropped: true };
    // F11: an id in another actor's path is never this actor's post.
    if (!idUnderActor(objectId(activity), activity.actor)) return { status: 202, dropped: true };
    const obj = settleCached(activity.object, { actor: activity.actor });
    if (obj.refused || obj.visibility === 'private') return { status: 202, dropped: true };
    if (obj.type === 'Note' && obj.in_reply_to) return { status: 202, dropped: true };
    return { status: 202, wall: walls.add(from, activity.actor, obj) };
  }

  /* An Update reaches only what holds the object (F3): the author's own wall
   * entry and the members whose comments or From elsewhere rows name it. An
   * id nothing here holds is dropped before it is parsed (F1). */
  function onUpdate(activity) {
    const from = handleOf(activity);
    const id = objectId(activity);
    if (!from || !id) return { status: 202, dropped: true };
    const onWall = walls.holderOf(id) === from;
    const names = holders.of(id);
    if (!onWall && !names.length) return { status: 202, dropped: true };
    const obj = settleCached(activity.object, { actor: activity.actor });
    if (obj.refused) return { status: 202, dropped: true };
    let n = 0;
    if (onWall) {
      // F5: an Update that makes the post followers-only or direct takes it off the wall.
      if (obj.visibility === 'private') { if (walls.remove(from, obj.id)) n++; }
      else if (walls.update(from, obj)) n++;
    }
    holding('update', id, (name) => {
      if (comments.updateRemote(name, from, obj, activity.object)) n++;
      if (elsewhere.update(name, from, obj)) n++;
    });
    return { status: 202, changed: n };
  }

  function onDeleteNote(activity) {
    const from = handleOf(activity);
    const id = objectId(activity);
    if (!from || !id) return { status: 202, dropped: true };
    let n = walls.remove(from, id) ? 1 : 0;
    holding('delete', id, (name) => {
      if (comments.removeRemote(name, from, id)) n++;
      n += elsewhere.removeObject(name, from, id);
    });
    return { status: 202, removed: n };
  }

  function onUpdatePerson(activity) {
    try {
      const rec = actors.applyUpdate(activity.object, activity.actor);
      projection.invalidate(rec.handle);   // walls that sign with their name
      return { status: 202 };
    } catch (e) {
      logger.log(`[remote-in] Update{Person} from ${activity.actor} refused: ${e.message}`);
      return { status: 202, dropped: true };
    }
  }

  /* The actor is gone (5.3): its follows, friendships, stamps, comments, From
   * elsewhere rows and wall here go, and the cache keeps only its id, handle
   * and `gone_at`. Also reached by a 410 for a cached actor (lib/actors.js). */
  function forget(handle) {
    if (!handle?.includes('@')) return;
    each('gone', (name) => {
      follows.dropHandle(name, handle);
      reactions.removeAuthor(name, handle);
      elsewhere.removeAuthor(name, handle);
      sent.removeAuthor(name, handle);
    });
    walls.drop(handle);
    projection.invalidate(handle);
    audit('federation.actor_gone', 'system', { handle });
  }

  function onDeletePerson(activity) {
    const id = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (id !== activity.actor) return { status: 403, dropped: true };
    actors.markGone(activity.actor);   // onGone runs forget()
    return { status: 202 };
  }

  return {
    forget,
    handlers: {
      'Create:Note': onCreate, 'Create:Article': onCreate, 'Create:Page': onCreate,
      'Update:Note': onUpdate, 'Update:Article': onUpdate, 'Update:Page': onUpdate,
      'Delete:Note': onDeleteNote,
      'Update:Person': onUpdatePerson, 'Delete:Person': onDeletePerson,
    },
  };
}

module.exports = { createRemoteIn };
