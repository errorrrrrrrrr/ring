'use strict';
/* ── The app: one process, one data dir (spec 1, 14) ──────────────────────────
 * createApp() builds every module over one config and one DATA_DIR and wires the
 * routers; server.js only reads the environment and listens. Tests call it with
 * their own env and a temp DATA_DIR, listen on port 0, and close().
 *
 * Middleware order, and why:
 *   1. security headers on every answer
 *   2. session-free routes: health, robots, assets, the composer's bundle
 *   3. the federation routes (FEDERATION=on only, routes/federation.js) mount
 *      HERE, before the session: they never read a session (spec 5.10), so a
 *      cookie can never act on an inbox and the inbox needs no CSRF check
 *   4. the session (`ring.sid`, httpOnly, SameSite=Lax, 30 days rolling; in
 *      production Secure and named `__Host-ring.sid`, so no sibling host can
 *      plant it for the parent domain) and `req.member`
 *   5. CSRF, then the JSON-only body rule on /api
 *   6. the routers, then the 404s and the error handler
 *
 * Timers (spec 7): housekeeping hourly and once at boot, the odometer flush each
 * minute, the room sweep (lib/ring-reset.js) 30 s after boot and then hourly.
 * All are unref'd and stopped by close().
 *
 * The social layer (P2): every act is an activity (lib/activities.js) that leaves
 * through lib/outbox.js emit() and lands, for a member here, through the one
 * inbound registry (lib/ap-inbound.js) the federation routes will feed from P5.
 * The stores below tell the projection on every write that changes a wall.
 *
 * Federation (P5, lib/federation.js): built only with FEDERATION=on. The actor
 * cache is made first (follows resolve remote handles through it), then the
 * social layer, then bound together; the outbox's remote part becomes fan-out
 * jobs (lib/queue.js), whose worker starts at listen() and stops at close().
 *
 * P6 adds what this server keeps of others (spec 3.10): remote friends' walls
 * (lib/walls.js), a member's reactions on remote posts (lib/sent.js), From
 * elsewhere (lib/elsewhere.js), the server-level inbound table
 * (lib/remote-in.js), and the glue between them: a remote FRIENDSHIP formed
 * reads their outbox once, one ended drops their wall when no member here is
 * still their friend (`edgeChanged`), and an account deletion sends
 * Delete{Person} to every server that knows the member (`farewell`).
 *
 * P8, moderation (spec 6): lib/moderation.js holds the admin's lists (domain
 * and actor blocks, reports) and is made FIRST, so every door asks the same
 * predicates (the fetcher, the queue, the inbox, the render-time filters);
 * BLOCKED_DOMAINS only seeds it at boot. lib/moderate.js applies a decision
 * (a block's purge, a suspension, a report's forward, an inbound Flag);
 * routes/admin.js is /admin and /api/admin/*, routes/reports.js the members'
 * reports. `deletePost` is THE delete of a member's post, the route's and the
 * admin's removal alike.
 */
const fs = require('node:fs');
const express = require('express');
const session = require('express-session');

const { loadConfig } = require('./config');
const { dataPaths } = require('./paths');
const { acquireLock, bootInstance, verifyDataFiles } = require('./instance');
const { createAudit } = require('./audit');
const { createMembers } = require('./members');
const { createInvites } = require('./invites');
const { createTokenFile } = require('./tokens');
const { createKeys } = require('./keys');
const { createMailer } = require('./mail');
const { FileSessionStore } = require('./session-store');
const { createImages } = require('./images');
const { createPageStore } = require('./page-store');
const { createProjection } = require('./projection');
const { createVisits } = require('./visits');
const { createLimits } = require('./rate-limit');
const { createLoginThrottle } = require('./login-throttle');
const { createAuth } = require('./auth');
const { createPurge } = require('./purge');
const { createRingStore } = require('./ring-store');
const { createOutbox } = require('./outbox');
const { createInbound } = require('./ap-inbound');
const { createReactions } = require('./reactions');
const { createFollows } = require('./follows');
const { createAudience } = require('./audience');
const { createStamps } = require('./stamps');
const { createComments } = require('./comments');
const { createGroups } = require('./groups');
const { createRooms } = require('./rooms');
const { createRingFed } = require('./ring-fed');
const { createPostDelivery } = require('./post-delivery');
const { createFeeds } = require('./feeds');
const { createInbox } = require('./inbox');
const { createWalls } = require('./walls');
const { createSent } = require('./sent');
const { createElsewhere } = require('./elsewhere');
const { createRemoteIn } = require('./remote-in');
const { createHolders } = require('./holders');
const { SERVER_KEYS } = require('./ap-inbound');
const { sweepRingResets } = require('./ring-reset');
const R = require('./rings');
const clock = require('./clock');
const { createHousekeeping } = require('./housekeeping');
const { createModeration } = require('./moderation');
const { createModerate } = require('./moderate');
const { createNotices } = require('./notices');
const { createSignupGuard } = require('./signup-guard');
const { pageImageKeys, postImageKey } = require('./ring');
const { createFederation } = require('./federation');
const { writeJSON } = require('./store');
const A = require('./activities');
const { securityHeaders, csrf, jsonOnly, errorHandler, fail } = require('./http');
const urls = require('./urls');
const site = require('../routes/site');
const appPage = require('../routes/app');

const SESSION_MAX_AGE = 30 * 24 * 3600 * 1000;

/* The session cookie's name: the __Host- prefix needs Secure, so production only. */
const cookieNameOf = (cfg) => (cfg.production ? '__Host-ring.sid' : 'ring.sid');

function createApp({ env = process.env, logger = console, limitScale = 1, timers = true, worker = timers } = {}) {
  const cfg = loadConfig(env);
  const paths = dataPaths(cfg.dataDir);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(paths.lock, { logger });
  try {
    verifyDataFiles(paths);   // a damaged data file refuses the boot (robustness-r1-01)
    return assemble({ cfg, paths, releaseLock, logger, limitScale, timers, worker });
  } catch (e) {
    releaseLock();   // a boot that fails leaves the data dir free
    throw e;
  }
}

function assemble({ cfg, paths, releaseLock, logger, limitScale, timers, worker }) {
  const instance = bootInstance(paths.instance, cfg, logger, paths);
  /* `federated_at` (spec 15.2): stamped once, at the first verified inbound
   * activity, the first verified signed GET or the first delivery. From then on
   * this origin is permanent. */
  function markFederated() {
    if (instance.federated_at) return;
    instance.federated_at = clock.iso();
    writeJSON(paths.instance, instance);
    logger.warn(`[instance] this server has federated as ${instance.origin}: that origin is now permanent (spec 15.2)`);
  }
  const audit = createAudit(paths.audit);
  // P8: the admin's lists, before anything that asks them. A damaged file
  // refuses the boot (reads fail closed, 3.11); BLOCKED_DOMAINS is a seed.
  const moderation = createModeration({ paths, cfg, logger });
  moderation.verify();
  moderation.seed(cfg.blockedDomains);
  const serverBlocked = (handle) => moderation.handleBlocked(handle);
  let projection = null;
  let federation = null;
  /* A member who is no longer active (suspended, by the admin or a hand edit
   * read in; or deleted) sends nothing more: every queued job they sign goes,
   * except Delete, Reject and Undo (spec 7, N3). Their in-flight job finishes.
   * P8 review: so does every queued Announce of a home ring's Group (`_ring:`)
   * carrying their room post (a Create or Update of theirs). */
  function memberChanged(name) {
    projection?.invalidate(name);
    if (!federation) return;
    let m = null;
    try { m = members.get(name); } catch { return; }
    if (m?.status === 'active') return;
    const reason = m ? 'signer_suspended' : 'signer_gone';
    if (federation.queue.hasSigner(name)) federation.cancelSigner(name, reason);
    federation.queue.cancelAnnouncesBy(urls.actorUrl(federation.origin, name), reason);
  }
  const members = createMembers(paths, { onWrite: memberChanged });
  const invites = createInvites(paths);
  // Keyed per email AND client, and full means refused: a stranger can neither push
  // the mailbox owner's own row out nor fill their slots (security-r1-01).
  const pending = createTokenFile(paths.pendingSignups, { ttlMs: 24 * 3600_000, perKey: 3, full: 'refuse' });
  const resets = createTokenFile(paths.passwordResets, { ttlMs: 3600_000, perKey: 3 });
  const keys = createKeys(paths.keysDir);
  const mailer = createMailer(cfg, paths, { logger });
  const sessionStore = new FileSessionStore({ dir: paths.sessionsDir, logger });
  // A write for a member who is gone never lands (robustness-r1-02): checked in the write's own tick.
  const images = createImages({ paths, cfg, memberLive: (name) => members.get(name)?.status === 'active' });
  const pages = createPageStore(paths, { onWrite: (name) => projection.invalidate(name), memberExists: (name) => !!members.get(name) });
  const ringStore = createRingStore(paths);
  const outbox = createOutbox({ logger });
  const limits = createLimits({ scale: limitScale });
  federation = cfg.federation ? createFederation({ cfg, paths, keys, members, pages, audit, markFederated, limits, moderation, logger }) : null;
  const invalidate = (name) => projection?.invalidate(name);
  let holders = null;   // lib/holders.js: remote object id -> the members holding it (F3)
  const reactions = createReactions({ paths, members, pages, onWrite: invalidate, onComments: (owner, rows) => holders?.noteComments(owner, rows), serverBlocked });
  const walls = createWalls({ paths, media: federation?.media || null, onMediaHost: (h, m) => federation?.hosts.addMediaHost(h, m), logger });
  const sent = createSent({ paths, members });
  const elsewhere = createElsewhere({ paths, members, onWrite: (name, rows) => holders?.noteElsewhere(name, rows) });
  holders = createHolders({ members, loadComments: reactions.loadComments, loadElsewhere: elsewhere.load, logger });
  /* A remote handle a member's rows now name (F7): its avatar may be fetched. */
  const named = (handle) => { if (federation && handle?.includes('@')) federation.actors.markNamed(handle); };
  let follows = null;
  /* Is any active member here a friend of this remote handle? */
  const friendAnywhere = (handle) => members.all().some((m) => {
    if (m.status !== 'active') return false;
    try { return follows.friends(m.slug, handle); } catch { return false; }
  });
  /* A remote handle's rows changed for `me` (P6): a friendship formed reads their
   * outbox once; one ended drops their wall when nobody here is their friend. */
  function edgeChanged(me, handle) {
    if (!federation) return;
    named(handle);
    if (follows.friends(me, handle)) { federation.backfill(handle).catch(() => {}); return; }
    if (!friendAnywhere(handle)) walls.drop(handle);
  }
  follows = createFollows({ paths, members, pages, outbox, audit, onWrite: invalidate, remote: federation?.actors || null, onEdge: edgeChanged });
  const sender = federation ? (url) => federation.actors.handleOf(url) : null;
  if (federation) reactions.bindRemote((h) => federation.actors.view(h));
  // A friend tag on a wall: never one the admin blocks server-wide (P8).
  projection = createProjection({ members, pages, images, reactions, follows, describeRemote: federation ? (h) => (serverBlocked(h) ? null : federation.actors.view(h)) : null });
  const audience = createAudience({ members, pages, ringStore });
  const stamps = createStamps({ members, pages, reactions, audience, follows, outbox, audit, sender });
  const comments = createComments({ members, pages, reactions, audience, follows, outbox, audit, sender, elsewhere, named });
  const remoteIn = federation ? createRemoteIn({ members, actors: federation.actors, walls, comments, elsewhere, reactions, follows, sent, projection, audit, friendAnywhere, holders, logger }) : null;
  // A remote actor gone (5.3): its rows here go, and (P7) its ring seats; a
  // ring's Group gone (its home answered 410): the replica here goes.
  if (remoteIn) {
    federation.actors.setOnGone((rec) => {
      if (rec.group || !rec.handle) { ringFed?.groupGone(rec.id); return; }
      remoteIn.forget(rec.handle);
      groups.dropHandle(rec.handle, defaultOrigin());
    });
  }
  // With FEDERATION=off nothing reaches the server table: a closed table of drops.
  let moderate = null;
  const serverHandlers = remoteIn
    ? { ...remoteIn.handlers, Flag: (a, c) => moderate.onFlag(a, c) }   // P8: a report from another server
    : Object.fromEntries(SERVER_KEYS.map((k) => [k, () => ({ status: 202, dropped: true })]));
  let inbound = null;
  // P7: rings across servers. The room copies (lib/rooms.js) and the member
  // servers' half (lib/ring-fed.js) exist only with FEDERATION=on.
  const rooms = federation ? createRooms({ paths, logger }) : null;
  const groups = createGroups({ members, pages, images, reactions, ringStore, outbox, audit, receive: (...a) => inbound.receive(...a), rooms });
  const ringFed = federation ? createRingFed({
    cfg, paths, members, pages, imageRow: images.row, ringStore, rooms, outbox, audit, groups, reactions, sent, follows, keys, federation,
    receive: (...a) => inbound.receive(...a), logger,
  }) : null;
  if (ringFed) groups.bind(ringFed);
  inbound = createInbound({
    handlers: {
      person: { ...follows.handlers, ...stamps.handlers, ...comments.handlers, ...groups.person },
      group: groups.group,
      server: serverHandlers,
      ring: ringFed ? ringFed.handlers : null,
    },
    logger,
  });
  outbox.bind(inbound.receive);
  if (federation) {
    federation.bind({ follows, inbound, walls, friendAnywhere, outbox, ringStore, ringFed });
    outbox.bindRemote(federation.remote);
  }
  const delivery = createPostDelivery({ pages, images, ringStore, outbox, remoteId: (h) => federation?.actors.idOf(h) || '' });
  const feeds = createFeeds({ members, pages, projection, reactions, follows, ringStore });
  if (federation) {
    feeds.bindRemote({
      walls, sent, describe: (h) => federation.actors.view(h), switchesOf: (h) => federation.actors.switchesOf(h), blocked: federation.blockedHost,
      handleBlocked: serverBlocked,
      copiesOf: (ring, ...rest) => ringFed.copiesOf(ring, ...rest).filter((c) => !serverBlocked(c.author)),
    });
  }
  const notices = createNotices({ paths, members });
  const inbox = createInbox({ members, pages, reactions, follows, ringStore, describe: whoIs, elsewhere, serverBlocked, notices });
  /* The origin a timer acts under (no request): PUBLIC_ORIGIN, else the first boot's. */
  const defaultOrigin = () => cfg.publicOrigin || instance.origin || `http://localhost:${cfg.port}`;
  const ringReset = {
    run(origin = defaultOrigin()) {
      // P7: copies of other servers' room posts expire here by themselves
      // (spec 4.7), with the same sweep, and a ring no longer held loses them.
      if (rooms) {
        try {
          const swept = rooms.sweep((id) => !!ringStore.get(id));
          if (swept.media.length) ringFed.forgetMedia(swept.media);
        } catch (e) { logger.error(`[ring-reset] room copies: ${e.stack || e.message}`); }
      }
      return sweepRingResets({
        nowMs: clock.now(),
        rings: ringStore.load(),
        memberNames: members.all().map((m) => m.slug),
        loadStore: pages.load, saveStore: pages.save,
        loadStamps: reactions.loadStamps, saveStamps: reactions.saveStamps,
        loadComments: reactions.loadComments, saveComments: reactions.saveComments,
        audit,
        onArchived: (owner, post, ringId) => delivery.reset(post, ringId, origin, owner),
        log: (l) => logger.error(l),
      });
    },
  };
  const visits = createVisits(paths);
  const throttle = createLoginThrottle();
  const auth = createAuth({ members, sessionStore });
  /* The account deletion's farewell (P6, spec 4.9): every remote handle the
   * member has an edge with, a reaction either way, or a From elsewhere row. */
  const farewell = federation ? (name) => {
    const handles = new Set(follows.edgesOf(name));
    for (const r of [...reactions.loadStamps(name), ...reactions.loadComments(name)]) handles.add(r.author);
    for (const h of sent.authors(name)) handles.add(h);
    for (const h of elsewhere.authors(name)) handles.add(h);
    // P7: every ring they were in elsewhere (its home drops them), and every
    // remote member of a ring hosted here (their servers hear it from the
    // Group's Update anyway, but the person is gone for them too).
    const ringGroups = ringStore.load().filter((r) => !r.home && R.isMember(r, name)).map((r) => r.ap_id);
    return federation.farewell(name, { handles: [...handles].filter((h) => h.includes('@')), groups: ringGroups });
  } : null;
  const purge = createPurge({ paths, members, invites, pending, resets, images, keys, sessionStore, projection, visits, audit, mailer, follows, groups, reactions, ringStore, defaultOrigin, logger, queue: federation?.queue || null, farewell });
  /* THE delete of a member's post (spec 4.9, 11.1): the route's, and the
   * admin's removal from a report (P8). -> false when there is no such post. */
  function deletePost(name, id, origin) {
    const store = pages.load(name);
    const post = store.posts.find((p) => p.id === id);
    if (!post) return false;
    store.posts = store.posts.filter((p) => p !== post);
    pages.save(name, store);
    pages.addTombstone(name, post);
    const reactors = [...new Set([...reactions.loadStamps(name), ...reactions.loadComments(name)].filter((r) => r.post_id === post.id).map((r) => r.author))];
    reactions.removeForPost(name, post.id);   // the crowd goes with the post
    const key = postImageKey(post);
    if (key && images.owns(key, name) && !pageImageKeys(store).has(key)) images.remove([key]);
    delivery.deleted(post, origin, name, reactors);
    return true;
  }
  const modCtx = { cfg, moderation, members, pages, follows, reactions, elsewhere, sent, walls, groups, ringStore, projection, outbox, audit, notices, limits, defaultOrigin, logger, deletePost, federation, ringFed, comments, stamps };
  moderate = createModerate(modCtx);
  const housekeeping = createHousekeeping({ paths, pending, resets, invites, images, pages, members, sessionStore, keys, audit, limits, throttle, logger, mailer, groups, defaultOrigin, federation, walls, sent, elsewhere, follows, reactions, ringStore, friendAnywhere, cfg, rooms, ringFed, moderation, moderate });

  /* How the app shows a handle: a member here, or (P5) a remote actor from the
   * cache. `live`: a member here who still exists, or any remote handle. */
  function whoIs(handle, origin) {
    if (handle.includes('@')) {
      const v = federation ? federation.actors.view(handle) : null;
      return v || { handle, name: handle.slice(0, handle.indexOf('@')), url: '', host: handle.slice(handle.indexOf('@') + 1), remote: true };
    }
    return { handle, name: members.get(handle)?.display_name || handle, url: urls.pageUrl(origin, handle), host: urls.hostOf(origin) };
  }
  const handleLive = (handle) => (handle.includes('@') ? !!federation && !federation.actors.view(handle).gone : !!members.get(handle));

  /* A change to what the Person shows (spec 4.9: name, bio, avatar, links,
   * theme, switches, page on or off, indexable, open_follows): Update{Person} to
   * the followers' servers, coalesced to one a minute by the queue. Nothing with
   * FEDERATION=off. */
  function profileChanged(name) {
    if (!federation) return;
    const person = federation.personOf(name);
    if (!person) return;
    // The followers' servers, and (P6) every remote account the member follows:
    // "every server with a follow either way" (4.9).
    const following = follows.load(name).following.filter((r) => r.state === 'accepted' && r.handle.includes('@')).map((r) => federation.actors.idOf(r.handle)).filter(Boolean);
    outbox.emit(A.updatePerson({ origin: cfg.publicOrigin, name, person }), [urls.collectionUrl(cfg.publicOrigin, name, 'followers'), ...following], { origin: cfg.publicOrigin });
  }

  /* Is this request's member still a signed-in, active member NOW? loadMember ran
   * before the body arrived; a write route asks again in its commit tick, so a
   * deletion, suspension or ended session in between stops the write. */
  function stillMember(req) {
    if (!req.member) return false;
    const m = members.get(req.member.slug);
    if (m?.status !== 'active') return false;
    const cutoff = m.sessions_from ? Date.parse(m.sessions_from) : 0;
    return (Number(req.session?.at) || 0) >= cutoff;
  }

  /* The member's own view of themselves (GET /api/me and every sign-in answer). */
  function meView(name, req) {
    const m = members.get(name);
    const store = pages.settings(name);   // the switches only, never the posts
    const origin = urls.originOf(req, cfg);
    return {
      name,
      handle: name,
      display_name: m.display_name,
      email: m.email,
      role: m.role,
      created_at: m.created_at,
      actor: urls.actorUrl(origin, name),
      page_url: urls.pageUrl(origin, name),
      page: {
        enabled: store.enabled,
        indexable: store.indexable,
        open_follows: store.open_follows,
        stamps_off: store.stamps_off,
        comments_off: store.comments_off,
      },
      invites: { live: invites.liveCount(name), limit: cfg.invitesPerMember },
      storage: { used: images.usage(name), limit: cfg.memberStorageBytes },
      unseen: inbox.unseen(name),
    };
  }

  /* A stored post as its author sees it: the row plus its derived URLs. */
  const ownPostView = (p, origin, name) => ({ ...p, url: urls.postUrl(origin, name, p.id), wall_url: urls.wallAnchor(origin, name, p.id) });

  const ctx = {
    cfg, paths, instance, audit, members, invites, pending, resets, keys, mailer, sessionStore, images,
    pages, projection, visits, limits, throttle, auth, purge, housekeeping, meView, ownPostView, logger, stillMember,
    ringStore, outbox, inbound, reactions, follows, audience, stamps, comments, groups, delivery, feeds, inbox, ringReset, defaultOrigin,
    federation, whoIs, handleLive, profileChanged, markFederated, walls, sent, elsewhere, remoteIn, friendAnywhere, holders, rooms, ringFed,
    moderation, moderate, notices, deletePost, signupGuard: createSignupGuard({ limits, pending, paths, audit, logger }),
    cookieName: cookieNameOf(cfg),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.use(securityHeaders(cfg));
  if (!cfg.trustProxy) {
    // Forwarded headers with trust proxy off: everyone behind that proxy shares ONE
    // bucket. Said once, never per request.
    let said = false;
    app.use((req, res, next) => {
      if (!said && req.get('x-forwarded-for') !== undefined) {
        said = true;
        logger.warn('[ring] a request carried X-Forwarded-For but TRUST_PROXY is off: every client behind that proxy shares one rate-limit bucket. Set TRUST_PROXY.');
      }
      next();
    });
  }
  app.use(site.publicRoutes());
  app.use(appPage.assets());   // the composer's bundle: hashed files, no session
  // Federation routes mount here, outside the session (spec 5.10). Off: not mounted, so they 404.
  if (federation) app.use(require('../routes/federation')(ctx));
  app.use(session({
    name: ctx.cookieName,
    store: sessionStore,
    secret: cfg.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: !!cfg.trustProxy,
    cookie: { httpOnly: true, sameSite: 'lax', secure: cfg.production, maxAge: SESSION_MAX_AGE, path: '/' },
  }));
  app.use(auth.loadMember);
  app.use(csrf(cfg));
  app.use('/api', (req, res, next) => { res.set('X-Robots-Tag', 'noindex'); next(); });
  app.use('/api', jsonOnly({ multipart: new Set(['/images']) }));

  app.use(require('../routes/auth')(ctx));
  app.use(require('../routes/me')(ctx));
  app.use(require('../routes/export')(ctx));
  app.use(require('../routes/invites')(ctx));
  app.use(require('../routes/posts')(ctx));
  app.use(require('../routes/pages')(ctx));
  app.use(require('../routes/images')(ctx));
  app.use(require('../routes/friends')(ctx));
  app.use(require('../routes/rings')(ctx));
  app.use(require('../routes/reactions')(ctx));
  app.use(require('../routes/feeds')(ctx));
  app.use(require('../routes/remote')(ctx));
  app.use(require('../routes/reports')(ctx));
  app.use(require('../routes/admin')(ctx));
  app.use(appPage(ctx));
  app.use(require('../routes/wall')(ctx));
  app.use(site(ctx));

  app.use('/api', (req, res) => fail(res, 404, 'not_found'));
  app.use((req, res) => site.sendPage(res, 404, site.notFoundPage()));
  app.use(errorHandler(logger));

  // ── lifecycle ──
  const intervals = [];
  const timeouts = [];
  let server = null;

  function start() {
    if (federation && worker) federation.start();
    if (!timers) return;
    try { housekeeping.run(); } catch (e) { logger.error('[housekeeping] boot run failed:', e.message); }
    intervals.push(setInterval(() => {
      try { housekeeping.run(); } catch (e) { logger.error('[housekeeping] failed:', e.message); }
    }, 3600_000).unref());
    intervals.push(setInterval(() => {
      try { visits.flush(); } catch (e) { logger.error('[visits] flush failed:', e.message); }
    }, 60_000).unref());
    const sweep = () => {
      try { ringReset.run(); } catch (e) { logger.error(`[ring-reset] failed: ${e.stack || e.message}`); }
    };
    timeouts.push(setTimeout(() => {
      sweep();
      intervals.push(setInterval(sweep, 3600_000).unref());
    }, 30_000).unref());
  }

  function listen(port = cfg.port, host) {
    return new Promise((resolve, reject) => {
      server = app.listen(port, host, (err) => {
        if (err) return reject(err);
        start();
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  /* Shutdown, bounded (robustness-r1-08): stop taking connections, drop the idle
   * ones, let requests in flight finish for up to `drainMs`, then cut the rest;
   * flush the odometer; wait for mail in flight for up to `mailMs`; release the
   * lock. Each wait has a deadline, so a stalled SMTP server or a hung request
   * cannot hold the process (and the lock) until a supervisor's SIGKILL. */
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref(); });
  let closing = null;
  function close({ drainMs = 8000, mailMs = 10_000 } = {}) {
    if (!closing) closing = (async () => {
      if (federation) federation.stop();
      for (const i of timeouts.splice(0)) clearTimeout(i);
      for (const i of intervals.splice(0)) clearInterval(i);
      if (server) {
        const s = server;
        const closed = new Promise((resolve) => s.close(() => resolve()));
        // A keep-alive connection that finishes its request goes idle: close it then,
        // not at its keep-alive timeout.
        s.closeIdleConnections?.();
        const idle = setInterval(() => s.closeIdleConnections?.(), 50);
        const drained = await Promise.race([closed.then(() => true), sleep(drainMs).then(() => false)]);
        clearInterval(idle);
        if (!drained) {
          logger.warn?.(`[ring] shutdown: requests still open after ${drainMs} ms were cut`);
          s.closeAllConnections?.();
          await closed;
        }
        server = null;
      }
      try { visits.flush(); } catch (e) { logger.error('[visits] flush failed:', e.message); }
      const sent = await Promise.race([Promise.resolve(mailer.flush()).then(() => true, () => true), sleep(mailMs).then(() => false)]);
      if (!sent) logger.error(`[ring] shutdown: mail still in flight after ${mailMs} ms was abandoned`);
      releaseLock();
    })();
    return closing;
  }

  /* The second signal: no more waiting. Synchronous. */
  function forceRelease() {
    if (federation) federation.stop();
    for (const i of timeouts.splice(0)) clearTimeout(i);
    for (const i of intervals.splice(0)) clearInterval(i);
    try { visits.flush(); } catch { /* best effort */ }
    releaseLock();
  }

  return { app, cfg, ctx, listen, close, forceRelease };
}

module.exports = { createApp };
