'use strict';
/* ── The data directory layout (spec 3.11) ────────────────────────────────────
 * Every path under DATA_DIR is spelled here and nowhere else. Path-only: nothing
 * here creates a directory (writeJSON does, on the first write), so a read can
 * never resurrect a purged member. A member dir is only ever built from a name
 * that passed the name shape.
 */
const path = require('node:path');
const { validName } = require('./handles');

function dataPaths(dataDir) {
  const p = (...xs) => path.join(dataDir, ...xs);
  const membersDir = p('members');
  return {
    root: dataDir,
    instance: p('instance.json'),
    lock: p('.lock'),
    members: p('members.json'),
    invites: p('invites.json'),
    retired: p('retired-handles.json'),
    rings: p('rings.json'),
    audit: p('audit.log'),
    pendingSignups: p('pending-signups.json'),
    passwordResets: p('password-resets.json'),
    images: p('images.json'),
    imagesDir: p('images'),
    sessionsDir: p('sessions'),
    keysDir: p('keys'),
    mailOutbox: p('mail-outbox.jsonl'),
    // P5: what this server keeps from others (spec 3.10) and the delivery queue (spec 7)
    fedDir: p('fed'),
    fedActorsDir: p('fed', 'actors'),
    fedHosts: p('fed', 'hosts.json'),
    fedSeenDir: p('fed', 'seen'),
    fedReplayDir: p('fed', 'replay'),
    // P6: remote friends' walls, the remote media cache
    fedWallsDir: p('fed', 'walls'),
    fedMediaDir: p('fed', 'media'),
    fedMediaIndex: p('fed', 'media.json'),
    // P7: rings across servers (spec 3.10, 4.7): room copies and the asks sent
    fedRoomsDir: p('fed', 'rooms'),
    fedRingAsks: p('fed', 'ring-asks.json'),
    queueDir: p('queue'),
    // P8: moderation (spec 6.2, 6.3): domain-blocks.json, actor-blocks.json, reports.jsonl
    moderationDir: p('moderation'),
    membersDir,
    memberDir(name) {
      if (!validName(name)) throw new Error(`paths: not a member name: ${JSON.stringify(name)}`);
      return path.join(membersDir, name);
    },
    memberFile(name, file) { return path.join(this.memberDir(name), file); },
  };
}

module.exports = { dataPaths };
