'use strict';
/* ── Hourly housekeeping (spec 7, "what runs on a timer") ─────────────────────
 * One in-process pass, hourly (and once at boot): expired signup and reset
 * tokens, expired invites, expired session files, unposted uploads past 24 h
 * (spec 11.4), image files with no row and hidden write temps past an hour (crash
 * leftovers), key staging leftovers, the audit log past 90 days, the log-provider
 * mail outbox past 7 days, idle rate buckets, and (P2) expired ring join codes:
 * the code is switched off and the requests it filed go with it, as a rotation
 * would (they are re-checked at approval anyway), each answered with Reject and
 * the members sent Update{Group} (lib/groups.js expireLinks, the one door for a
 * ring change). P5, with FEDERATION=on: inbound activity-id day files past 7
 * days (lib/seen.js), replay-guard hour files past the Date window
 * (lib/http-sig.js), and the key of a retired name whose last delivery job has
 * ended (spec 2.6; lib/queue.js also removes it the moment that job ends, this
 * catches a restart in between). P6, with FEDERATION=on: From elsewhere past 30
 * days; remote walls no friendship holds any more, and their posts past 90
 * days; the remote media cache trimmed to REMOTE_MEDIA_MB (least recently used
 * out) and its rows no store names dropped; the actor cache's 90-day prune
 * (an actor unused that long and named by no row here; once a day); and
 * the blocked domains' cached walls and media. P8: closed reports past 90
 * days (lib/moderation.js), and `moderation`: every admin block re-applied to
 * what this server holds (lib/moderate.js sweep: rows a skipped file kept,
 * queued jobs, cached actors and media, ring seats and copies), which also
 * covers what P7's `rings_blocked` step did. Tests call run() directly with
 * the clock moved. The room sweep has its own timer (lib/ring-reset.js).
 *
 * Every step runs on its own: one that throws is logged by name with its stack,
 * and the rest still run (a stuck invites file must not stop sessions expiring or
 * the rate buckets that bound memory from being pruned). A run that removed
 * anything says what in one line; an empty run logs nothing.
 *
 * The image sweep reads each owner's references and, when it cannot (a damaged
 * members.json or log.json), SKIPS that owner: "could not read" is never
 * "references nothing". lib/images.js also brakes a sweep that would remove a
 * large share of all rows.
 */
const fs = require('node:fs');
const path = require('node:path');
const clock = require('./clock');
const { pageImageKeys } = require('./ring');
const { sweepTemps, filterLines } = require('./store');

const OUTBOX_RETENTION_MS = 7 * 24 * 3600_000;

const ACTOR_PRUNE_EVERY_MS = 24 * 3600_000;

function createHousekeeping(ctx) {
  const { paths, pending, resets, invites, images, pages, members, sessionStore, keys, audit, limits, throttle, groups, defaultOrigin, federation } = ctx;
  let lastActorPrune = 0;
  const logger = ctx.logger || console;

  /* Throws when it cannot tell (the caller skips this owner). */
  function referencedBy(owner) {
    if (!members.get(owner)) return new Set();   // a readable file without them: they are gone
    return pageImageKeys(pages.load(owner));
  }

  function tempDirs() {
    if (!paths) return [];
    const dirs = [paths.root, paths.imagesDir, paths.keysDir, paths.membersDir];
    try {
      for (const e of fs.readdirSync(paths.membersDir, { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push(path.join(paths.membersDir, e.name));
      }
    } catch { /* no members dir yet */ }
    return dirs;
  }

  function trimOutbox() {
    // The mailer owns the outbox's 24 h rule (lib/mail.js prune): run it hourly here too,
    // or with no new mail and no restart a live link would sit in clear for days.
    if (ctx.mailer && typeof ctx.mailer.prune === 'function') return ctx.mailer.prune();
    if (!paths?.mailOutbox) return 0;
    const cutoff = clock.now() - OUTBOX_RETENTION_MS;
    return filterLines(paths.mailOutbox, (line) => {
      const m = line.match(/"at":"([^"]+)"/);
      return !m || !(Date.parse(m[1]) <= cutoff);
    });
  }

  const STEPS = [
    ['pending', () => pending.sweep()],
    ['resets', () => resets.sweep()],
    ['invites', () => invites.sweep()],
    ['images', () => images.sweepUnreferenced(referencedBy, { log: (l) => logger.error(l) })],
    ['image_files', () => images.sweepOrphanFiles()],
    ['temps', () => sweepTemps(tempDirs(), clock.now())],
    ['sessions', () => sessionStore.sweep()],
    ['staged_keys', () => keys.sweepStaged()],
    ['audit', () => audit.prune()],
    ['mail_outbox', () => trimOutbox()],
    ['limits', () => { limits.prune(); return 0; }],
    ['throttle', () => { throttle.prune(); return 0; }],
    ['join_codes', () => (groups ? groups.expireLinks(defaultOrigin()) : 0)],
  ];
  if (ctx.moderation) STEPS.push(['reports', () => ctx.moderation.pruneReports()]);
  if (ctx.moderate && federation) STEPS.push(['moderation', () => ctx.moderate.sweep(defaultOrigin())]);
  if (federation) {
    STEPS.push(['seen_ids', () => federation.seen.sweep()]);
    STEPS.push(['retired_keys', () => {
      let n = 0;
      for (const name of keys.names()) {
        if (members.get(name) || !members.isRetired(name) || federation.queue.hasSigner(name)) continue;
        keys.remove(name);
        n++;
      }
      return n;
    }]);
    STEPS.push(['replay_window', () => federation.replay.prune()]);
    const { walls, sent, elsewhere, follows, reactions, ringStore, friendAnywhere, cfg } = ctx;
    if (elsewhere) {
      STEPS.push(['elsewhere', () => {
        let n = 0;
        for (const m of members.all()) {
          try { n += elsewhere.prune(m.slug); } catch (e) { logger.error(`[housekeeping] elsewhere: skipped ${m.slug}: ${e.message}`); }
        }
        return n;
      }]);
    }
    if (walls) {
      STEPS.push(['remote_walls', () => walls.sweep((h) => !federation.blockedHost(h.slice(h.indexOf('@') + 1)) && friendAnywhere(h))]);
      STEPS.push(['remote_media', () => {
        const named = walls.mediaIds();
        let n = 0;
        // P7: a room copy's images are named by the copy (lib/rooms.js); a
        // store that cannot be read names everything (never "names nothing").
        const roomMedia = ctx.rooms ? ctx.rooms.mediaIds() : new Set();
        if (named && roomMedia) {
          for (const id of roomMedia) named.add(id);
          for (const r of federation.actors.all()) if (r.avatar) named.add(r.avatar);
          n += federation.media.sweep((id) => named.has(id));
        }
        n += federation.media.dropHosts(federation.blockedHost);
        n += federation.media.trim(cfg.remoteMediaBytes);
        return n;
      }]);
    }
    // P7: rings across servers. A blocked domain's people leave the home rings
    // here and a ring hosted on one goes (BLOCKED_DOMAINS); a deleted ring's key
    // goes once no job it signs is left.
    if (ctx.ringFed) {
      STEPS.push(['rings_blocked', () => ctx.ringFed.sweepBlocked()]);
      STEPS.push(['ring_keys', () => {
        let n = 0;
        for (const id of keys.ringNames()) {
          if (ringStore.get(id) || federation.queue.hasSigner(`_ring:${id}`)) continue;
          keys.removeRing(id);
          n++;
        }
        return n;
      }]);
    }
    if (follows) {
      STEPS.push(['actor_cache', () => {
        if (lastActorPrune && clock.now() - lastActorPrune < ACTOR_PRUNE_EVERY_MS) return 0;
        // Every handle a row here names (3.10): follows, reactions, sent, From
        // elsewhere, blocks, rings, walls. A file that cannot be read stops the
        // prune ("could not read" is never "names nothing").
        const named = new Set(walls ? walls.handles() : []);
        for (const m of members.all()) {
          const f = follows.load(m.slug);
          for (const r of [...f.following, ...f.followers]) named.add(r.handle);
          for (const r of [...reactions.loadStamps(m.slug), ...reactions.loadComments(m.slug)]) named.add(r.author);
          for (const h of sent.authors(m.slug)) named.add(h);
          for (const h of elsewhere.authors(m.slug)) named.add(h);
          for (const h of pages.settings(m.slug).blocked || []) named.add(h);
        }
        for (const r of ringStore.load()) {
          for (const x of [...r.members, ...r.requests]) named.add(x.handle);
          if (!r.home) named.add(r.ap_id);   // P7: the Group record a replica needs
        }
        if (ctx.ringFed) for (const a of ctx.ringFed.loadAsks()) named.add(a.group);
        lastActorPrune = clock.now();
        return federation.actors.prune((h) => named.has(h));
      }]);
    }
  }

  function run() {
    const out = {};
    const failed = [];
    for (const [name, fn] of STEPS) {
      try { out[name] = fn(); }
      catch (e) {
        out[name] = 0;
        failed.push(name);
        logger.error(`[housekeeping] ${name} failed: ${e.stack || e.message}`);
      }
    }
    const did = Object.entries(out).filter(([, n]) => Number(n) > 0);
    if (did.length) logger.log(`[housekeeping] removed ${did.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    out.failed = failed;
    return out;
  }

  return { run, STEPS: STEPS.map(([n]) => n) };
}

module.exports = { createHousekeeping, OUTBOX_RETENTION_MS };
