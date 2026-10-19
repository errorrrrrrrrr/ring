'use strict';
/* ── What a moderation decision DOES (spec 6.2, 6.3, 4.9; P8) ─────────────────
 * lib/moderation.js keeps the lists; this applies them. Every act is one
 * synchronous pass (the routes await what must be fetched first), and every
 * per-member step is its own try: a damaged member file is skipped and logged,
 * never a reason to stop the rest (the purge's rule). The render-time filters
 * (lib/reactions.js decorate, lib/inbox.js, lib/feeds.js, the wall's friends)
 * hide whatever a skipped file kept, so a block shows at once everywhere.
 *
 * A DOMAIN BLOCK (blockDomain) of a host and its subdomains:
 *   - the list first, so every door refuses from this tick on: inbound 403
 *     (before any key fetch, 5.2 step 6), nothing fetched (lib/net.js), nothing
 *     delivered (lib/queue.js; the queued deliver jobs to its hosts go now);
 *   - every follow either way, friendship, request, stamp, comment, From
 *     elsewhere row and reaction sent (`sent.json`) naming one of its handles
 *     goes from every member here, its walls go, its people leave the home
 *     rings here (their requests answered, a code they minted closed: the
 *     purge's door, lib/groups.js dropHandle), a replica of a ring hosted on it
 *     goes with its copies, and their copies elsewhere go from this server
 *     (lib/ring-fed.js sweepBlocked);
 *   - its cached actors go (lib/actors.js forget; a gone record stays, it keeps
 *     the handle bound) and its cached media (lib/remote-media.js dropHosts).
 *   NOTHING IS SENT TO IT, not even an Undo or a Reject (P8 decision): the block
 *   says nothing is delivered there, and a follow its server still lists is
 *   inert, since every activity from it is refused. Mastodon's suspension does
 *   the same.
 * AN ACTOR BLOCK (blockActor) is the same for one remote person: inbound from
 * them 403 after the signature (their key is fetched to know who signed), no
 * delivery to them (fan-out skips them, a job to their own inbox is dropped),
 * their rows, wall, ring seats, copies and cached record purged. A `Flag` to
 * their server is the one thing still sent (a report is for its moderators).
 * Lifting either block restores nothing: the follows were ended, and a person
 * befriends again from scratch.
 *
 * SUSPENSION (suspend) of a member here (spec 4.9): `status: 'suspended'` on
 * the row. lib/app.js memberChanged cancels every queued job they sign at once
 * (Delete, Reject and Undo excepted); their actor and objects answer 404, every
 * inbound activity for them is dropped (lib/federation.js targetsOf), their
 * sessions stop being sessions (lib/auth.js loadMember reads active only), and
 * their wall is the unknown name's 404. NOTHING IS SENT on suspension (P8
 * decision): a Delete{Person} would be final on every server and a suspension
 * can be lifted; an Update{Person} saying so has no common reading. Lifting it
 * restores everything but the cancelled deliveries. The last active admin
 * cannot be suspended, nor step down (409 last_admin).
 *
 * REPORTS. A member's report (report) names its target and objects as THIS
 * server resolved them (the route never takes a client's word for a handle or
 * a URL's owner), and in their own fields the reported post (`post`) and, for
 * a comment or a stamp, which one (`ref`: owner, post id, id). With `forward`,
 * or later the admin's forward, a remote target's server gets a `Flag` from
 * the INSTANCE actor (5.1): `object` is the reported actor and the reported
 * objects on that host, `content` the comment; the reporter's name never
 * travels.
 * AN INBOUND FLAG (onFlag) files ONE REPORT PER MEMBER IT NAMES (P8 review F2,
 * decided): a member is named by their actor or by a post of theirs; each
 * report keeps only that member's objects (their actor, their posts, their
 * comments), at most 5 members per Flag; a report naming a post of theirs is
 * kind `post` with that post (the first named) as its `post`, else `person`.
 * Budgeted per reporting SITE (lib/handles.js siteOf, the registrable domain:
 * subdomains and ports share one; P8 review F3): 10 reports an hour, 50 a day,
 * then dropped (202); at most 20 open per site and 1000 open from all other
 * servers (lib/moderation.js); its objects that are not ours dropped (5.4) and
 * none left meaning dropped; its comment one plain line of 1000 characters
 * (5.8). A domain block closes every open report from a host it covers, an
 * actor block every open report that person signed (dismissed, the note
 * saying which block), so the caps open again.
 * THE REMOVALS act on a report's own fields, never on `objects` (P8 review
 * F1): `remove_post` only on a kind `post` report, only the post in `post`,
 * only when it is this server's and its owner IS the report's target;
 * `remove_comment` and `remove_stamp` only on their kind, only the row `ref`
 * names, only when its author IS the target (the owner's removal: lib/comments.js
 * and lib/stamps.js takeBack, as the post's owner). The notice goes to that
 * author when they are a member here, and names no reporter.
 */
const clock = require('./clock');
const urls = require('./urls');
const A = require('./activities');
const { newActivityId } = require('./ids');
const { hostUnder, siteOf, hostOfUrl: canonicalHostOfUrl } = require('./handles');
const { plainLine } = require('./ring');

const FLAG_RULE = { perHour: 10, perDay: 50 };   // fed-flag, per reporting SITE (siteOf)
const FLAG_OBJECTS_READ = 50;
const FLAG_TARGETS = 5;   // members one Flag may name (one report each)

const hostOfHandle = (h) => (typeof h === 'string' && h.includes('@') ? h.slice(h.indexOf('@') + 1) : '');
// THE host normalizer's reading of a URL (lib/handles.js, P8 review F4).
const hostOfUrl = canonicalHostOfUrl;
const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const idOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.id === 'string' ? v.id : '');

function createModerate(ctx) {
  const { cfg, moderation, members, pages, follows, reactions, elsewhere, sent, walls, groups, ringStore, projection, outbox, audit, notices, limits, defaultOrigin, comments, stamps } = ctx;
  const logger = ctx.logger || console;
  const fed = () => ctx.federation || null;
  const ringFed = () => ctx.ringFed || null;
  const originOf = (o) => o || cfg.publicOrigin || defaultOrigin();

  const eachMember = (step, fn) => {
    for (const m of members.all()) {
      try { fn(m.slug); } catch (e) { logger.error(`[moderate] ${step}: skipped ${m.slug}: ${e.message}`); }
    }
  };
  const invalidateAll = () => { for (const m of members.all()) projection.invalidate(m.slug); };

  /* Every remote handle a row here names: the actor cache, walls, every
   * member's follows, reactions, reactions sent and From elsewhere, the rings. */
  function remoteHandles() {
    const hs = new Set();
    if (fed()) for (const r of fed().actors.all()) if (r.handle?.includes('@')) hs.add(r.handle);
    if (walls) for (const h of walls.handles()) hs.add(h);
    eachMember('collect', (name) => {
      const f = follows.load(name);
      for (const r of [...f.following, ...f.followers]) hs.add(r.handle);
      for (const r of [...reactions.loadStamps(name), ...reactions.loadComments(name)]) hs.add(r.author);
      if (sent) for (const h of sent.authors(name)) hs.add(h);
      if (elsewhere) for (const h of elsewhere.authors(name)) hs.add(h);
    });
    for (const r of ringStore.load()) for (const x of [...r.members, ...r.requests]) hs.add(x.handle);
    return [...hs].filter((h) => typeof h === 'string' && h.includes('@'));
  }

  /* Every row naming a remote handle `match(handle)` accepts goes. -> handles. */
  function purgeHandles(match, origin) {
    const hit = remoteHandles().filter(match);
    if (!hit.length) return [];
    const set = new Set(hit);
    eachMember('purge', (name) => {
      const f = follows.load(name);
      for (const h of new Set([...f.following, ...f.followers].map((r) => r.handle))) if (set.has(h)) follows.dropHandle(name, h);
      reactions.removeWhere(name, (r) => set.has(r.author));
      if (elsewhere) for (const h of elsewhere.authors(name)) if (set.has(h)) elsewhere.removeAuthor(name, h);
      if (sent) for (const h of sent.authors(name)) if (set.has(h)) sent.removeAuthor(name, h);
    });
    for (const h of hit) {
      try { walls?.drop(h); } catch (e) { logger.error(`[moderate] wall of ${h}: ${e.message}`); }
      try { groups.dropHandle(h, origin); } catch (e) { logger.error(`[moderate] rings of ${h}: ${e.message}`); }
    }
    return hit;
  }

  function sweepRings() {
    if (!ringFed()) return 0;
    try { return ringFed().sweepBlocked(); } catch (e) { logger.error(`[moderate] rings: ${e.stack || e.message}`); return 0; }
  }

  /* Re-apply every block to what this server holds (housekeeping, hourly; and
   * after a block): rows a skipped file kept, a BLOCKED_DOMAINS seed. Cheap
   * when nothing matches. -> handles purged. */
  function sweep(origin) {
    if (!moderation.listDomains().length && !moderation.listActors().length) return 0;
    const f = fed();
    const hit = purgeHandles((h) => moderation.handleBlocked(h), originOf(origin));
    if (f) {
      f.queue.dropHosts((h) => moderation.hostBlocked(h));
      f.media.dropHosts((h) => moderation.hostBlocked(h));
      f.actors.forget((rec) => (rec.handle ? moderation.handleBlocked(rec.handle) : moderation.hostBlocked(hostOfUrl(rec.id))));
    }
    sweepRings();
    if (hit.length) invalidateAll();
    return hit.length;
  }

  // ── domain and actor blocks ──

  /* -> { host, added, purged } or { error }. */
  function blockDomain(raw, { reason = '', by = '', origin } = {}) {
    const r = moderation.addDomain(raw, { reason, by });
    if (r.error) return r;
    if (fed() && hostUnder(fed().host, r.host)) { moderation.removeDomain(r.host); return { error: 'own_host' }; }
    const host = r.host;
    const covers = (h) => hostUnder(h, host);
    const purged = purgeHandles((h) => covers(hostOfHandle(h)), originOf(origin));
    const f = fed();
    let jobs = 0;
    if (f) {
      jobs = f.queue.dropHosts(covers);
      f.media.dropHosts(covers);
      f.actors.forget((rec) => covers(hostOfUrl(rec.id)));
    }
    sweepRings();
    invalidateAll();
    // That origin's open reports close (P8 review F3): a blocked host's Flags
    // are not left holding the caps shut.
    const closed = moderation.closeWhere((x) => x.remote && hostUnder(x.from, host), { by: by || 'system', note: 'domain_blocked' });
    audit('moderation.domain_blocked', by || 'system', { host, purged: purged.length, jobs, added: r.added, reports_closed: closed });
    return { host, added: r.added, purged: purged.length, reports_closed: closed };
  }

  function unblockDomain(raw, { by = '' } = {}) {
    const ok = moderation.removeDomain(raw);
    if (ok) { invalidateAll(); audit('moderation.domain_unblocked', by || 'system', { host: String(raw).slice(0, 260) }); }
    return ok;
  }

  /* `rec`: the actor record when the route could resolve it (id, inbox). */
  function blockActor(handle, { reason = '', by = '', origin, rec = null } = {}) {
    const f = fed();
    const cached = rec || (f ? f.actors.get(f.actors.idOf(handle)) : null);
    const r = moderation.addActor(handle, { id: cached?.id || '', inbox: cached?.inbox || '', reason, by });
    if (r.error) return r;
    const purged = purgeHandles((h) => h === handle, originOf(origin));
    if (f) f.actors.forget((x) => x.handle === handle);
    sweepRings();
    invalidateAll();
    const closed = moderation.closeWhere((x) => x.remote && x.actor === handle, { by: by || 'system', note: 'actor_blocked' });
    audit('moderation.actor_blocked', by || 'system', { handle, purged: purged.length, added: r.added, reports_closed: closed });
    return { handle, added: r.added, purged: purged.length, reports_closed: closed };
  }

  function unblockActor(handle, { by = '' } = {}) {
    const ok = moderation.removeActor(handle);
    if (ok) { invalidateAll(); audit('moderation.actor_unblocked', by || 'system', { handle }); }
    return ok;
  }

  // ── members ──

  const lastActiveAdmin = (name) => {
    const admins = members.admins();
    return admins.length === 1 && admins[0] === name;
  };

  /* -> { ok } or { status, error }. */
  function setStatus(name, status, { by = '' } = {}) {
    const m = members.get(name);
    if (!m) return { status: 404, error: 'not_found' };
    if (m.status === status) return { ok: true, member: m };
    if (status === 'suspended') {
      if (name === by) return { status: 400, error: 'own_handle' };
      if (m.role === 'admin' && lastActiveAdmin(name)) return { status: 409, error: 'last_admin' };
    }
    const next = members.update(name, { status });   // memberChanged: cancels their queue, drops the projection
    audit(status === 'suspended' ? 'member.suspended' : 'member.unsuspended', by || 'system', { member: name });
    return { ok: true, member: next };
  }

  function setRole(name, role, { by = '' } = {}) {
    const m = members.get(name);
    if (!m) return { status: 404, error: 'not_found' };
    if (m.role === role) return { ok: true, member: m };
    if (role === 'admin' && m.status !== 'active') return { status: 409, error: 'suspended' };
    if (role === 'member' && m.role === 'admin' && lastActiveAdmin(name)) return { status: 409, error: 'last_admin' };
    const next = members.update(name, { role });
    audit(role === 'admin' ? 'member.made_admin' : 'member.stepped_down', by || 'system', { member: name });
    return { ok: true, member: next };
  }

  // ── reports ──

  /* A member's report, its target resolved by the route. -> the row or null. */
  function report({ from, kind, target, post = '', ref = null, objects, comment = '', forward = false, origin }) {
    const row = moderation.addReport({ kind, from, target, post, ref, objects, comment });
    if (!row) return null;
    audit('report.filed', from, { id: row.id, kind, remote: target.includes('@') });
    if (forward && target.includes('@')) return forwardReport(row.id, { origin }) || row;
    return row;
  }

  /* The Flag to a remote target's server (6.2). -> the updated row, or null
   * when there is nothing to send (a local target, no federation, unknown). */
  function forwardReport(id, { by = '', origin } = {}) {
    const f = fed();
    const row = moderation.getReport(id);
    if (!f || !row || row.remote || !row.target.includes('@') || row.forwarded) return null;
    const actorId = f.actors.idOf(row.target) || moderation.listActors().find((b) => b.handle === row.target)?.id || '';
    if (!actorId) return null;
    const h = hostOfUrl(actorId);
    const objs = [actorId, ...row.objects.filter((u) => u !== actorId && hostOfUrl(u) === h)];
    const o = originOf(origin);
    const flag = A.doc({
      id: `${o}/actor/activities/${newActivityId()}`, type: 'Flag', actor: `${o}/actor`,
      object: [...new Set(objs)], content: row.comment || '',
    });
    outbox.emit(flag, [actorId], { origin: o });
    audit('report.forwarded', by || row.from, { id, host: h });
    return moderation.updateReport(id, { forwarded: true });
  }

  /* An inbound Flag (the server's table, lib/ap-inbound.js). Sync. One report
   * per member it names, each with only that member's objects (header). */
  function onFlag(activity, { origin }) {
    const host = hostOfUrl(activity.actor);
    if (!host) return { status: 202, dropped: true };
    const site = siteOf(host);
    const o = originOf(origin);
    // Only what is ours, grouped by the member it belongs to.
    const per = new Map();   // name -> { named, post, objects }
    const of = (name) => {
      if (!per.has(name)) per.set(name, { named: false, post: '', objects: [urls.actorUrl(o, name)] });
      return per.get(name);
    };
    let total = 0;
    for (const u of arr(activity.object).slice(0, FLAG_OBJECTS_READ).map(idOf)) {
      const l = urls.parseLocal(u, o);
      if (!l || members.get(l.name)?.status !== 'active') continue;
      if (!per.has(l.name) && per.size >= FLAG_TARGETS) continue;
      if (l.kind === 'person') of(l.name).named = true;
      else if (l.kind === 'post' && pages.post(l.name, l.id)) {
        const g = of(l.name);
        const url = urls.postUrl(o, l.name, l.id);
        g.named = true;
        if (!g.post) g.post = url;
        if (!g.objects.includes(url) && g.objects.length < 20) { g.objects.push(url); total++; }
      } else if (l.kind === 'comment') {
        const g = of(l.name);
        const url = urls.commentUrl(o, l.name, l.id);
        if (!g.objects.includes(url) && g.objects.length < 20) { g.objects.push(url); total++; }
      }
      if (total >= 40) break;
    }
    const targets = [...per.entries()].filter(([, g]) => g.named);
    if (!targets.length) return { status: 202, dropped: true };
    const signer = fed()?.actors.handleOf(activity.actor) || '';
    const comment = typeof activity.content === 'string' ? plainLine(activity.content, 1000) : '';
    const filed = [];
    let why = '';
    for (const [name, g] of targets) {
      if (limits.take(`fed-flag:${site}`, FLAG_RULE)) { why = 'flag_budget'; break; }
      const row = moderation.addReport({
        kind: g.post ? 'post' : 'person', from: host, actor: signer, remote: true, target: name, post: g.post, objects: g.objects, comment,
      });
      if (!row) { why = 'reports_full'; break; }
      filed.push(row.id);
      audit('report.received', 'system', { id: row.id, from: host });
    }
    if (!filed.length) return { status: 202, dropped: true, reason: why };
    return { status: 202, reports: filed.length };
  }

  /* The admin removes a reported LOCAL post (6.3): only a kind `post` report,
   * only its `post`, only when that post's owner is the report's target. The
   * one delete (its Delete federates); its author is told in Inbox.
   * -> how many went (0 or 1). */
  function removeReportedPost(id, { by = '', origin } = {}) {
    const row = moderation.getReport(id);
    if (row?.kind !== 'post' || !row.post) return 0;
    const o = originOf(origin);
    const l = urls.parseLocal(row.post, o);
    if (l?.kind !== 'post' || l.name !== row.target || !members.get(l.name)) return 0;
    if (!ctx.deletePost(l.name, l.id, o)) return 0;
    tell(l.name, 'post_removed');
    audit('post.removed_by_admin', by || 'system', { owner: l.name, post: l.id, report: id });
    return 1;
  }

  /* The admin removes the reported comment or stamp (`ref`), only when its
   * author is the report's target: the post owner's removal (takeBack as the
   * owner; their own comment is their own Delete). -> 0 or 1. */
  function removeReportedReaction(id, { by = '', origin } = {}) {
    const row = moderation.getReport(id);
    if (!row || (row.kind !== 'comment' && row.kind !== 'stamp') || !row.ref) return 0;
    const { owner, post_id: postId, id: itemId } = row.ref;
    if (members.get(owner)?.status !== 'active') return 0;
    const isComment = row.kind === 'comment';
    const rows = isComment ? reactions.loadComments(owner) : reactions.loadStamps(owner);
    const item = rows.find((x) => x.id === itemId && x.post_id === postId);
    if (!item || item.author !== row.target) return 0;
    const o = originOf(origin);
    const r = isComment
      ? comments.takeBack({ me: owner, owner, postId, commentId: itemId, origin: o })
      : stamps.takeBack({ me: owner, owner, postId, stampId: itemId, origin: o });
    if (!r || r.status >= 400) return 0;
    if (!item.author.includes('@')) tell(item.author, isComment ? 'comment_removed' : 'stamp_removed');
    audit(isComment ? 'comment.removed_by_admin' : 'stamp.removed_by_admin', by || 'system', { owner, post: postId, author: item.author, report: id });
    return 1;
  }

  /* A notice to a member here about their own thing; it names no reporter. */
  function tell(name, kind) {
    if (!members.get(name)) return;
    try { notices.add(name, kind); } catch (e) { logger.error(`[moderate] notice for ${name}: ${e.message}`); }
  }

  function closeReport(id, state, { by = '', note = '' } = {}) {
    return moderation.updateReport(id, { state, resolved_by: by, note: plainLine(note, 1000), resolved_at: clock.iso() });
  }
  /* A closed report back in the queue (the admin's `reopen`): its closing
   * fields cleared, an audit line kept. */
  function reopenReport(id, { by = '' } = {}) {
    const row = moderation.updateReport(id, { state: 'open', resolved_by: '', note: '', resolved_at: '' });
    if (row) audit('report.reopened', by || 'system', { id });
    return row;
  }

  return {
    blockDomain, unblockDomain, blockActor, unblockActor, sweep,
    setStatus, setRole,
    report, forwardReport, onFlag, removeReportedPost, removeReportedReaction, closeReport, reopenReport,
    remoteHandles,
  };
}

module.exports = { createModerate, FLAG_RULE };
