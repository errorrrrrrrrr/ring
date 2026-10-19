'use strict';
/* ── The federation routes (spec 8.1, 8.2, 11.2; P5) ──────────────────────────
 * Mounted ONLY with FEDERATION=on, and BEFORE the session (spec 5.10): nothing
 * here reads or writes a session, so a cookie can never act on an inbox and the
 * inbox needs no CSRF check; it has its own checks (lib/federation.js inboxPost).
 * Off, none of these paths exists: they fall through to the site's 404.
 *
 *   GET  /.well-known/webfinger?resource=   JRD for acct:name@host, the actor URL
 *                                           or the /@name URL; acct:host@host is
 *                                           the instance actor. Every ACTIVE member,
 *                                           page on or off; unknown, retired and
 *                                           suspended names 404
 *   GET  /.well-known/nodeinfo, /nodeinfo/2.1, /nodeinfo/2.0
 *                                           `ring`, ringProtocol 1, NO usage numbers
 *   GET  /actor                             the instance actor (Application)
 *   GET  /users/:name                       the Person: full when the page is on,
 *                                           minimal when off (keys and rings need
 *                                           it), 404 suspended, 410 deleted; an
 *                                           HTML Accept goes to /@name
 *   POST /users/:name/inbox, /inbox, /actor/inbox   (signed; 5.2)
 *   GET  /users/:name/outbox                public Creates, newest first, 20 a page
 *   GET  /users/:name/followers, following  no items, no counts
 *   GET  /users/:name/featured              pinned public posts, embedded, at most 10
 *   GET  /users/:name/posts/:id             a public post on an enabled page: the
 *                                           Note; deleted: 410 Tombstone; a room or
 *                                           archive post, a divider, a page that is
 *                                           off: 404; an HTML Accept goes to
 *                                           /@name#id for a public post
 *   GET  /users/:name/comments/:id          P6: a comment this member left on a
 *                                           post of ANOTHER server (lib/sent.js):
 *                                           its Note, to any signer the member
 *                                           does not block (the post was public;
 *                                           the reply is unlisted). A comment on
 *                                           a post of THIS server never left it,
 *                                           so nothing elsewhere holds its URL:
 *                                           404, as an unknown one
 *   GET  /rings/:id                         P7: the Group (4.7), to a signed GET of
 *                                           a member or a pending requester (or
 *                                           their server's instance actor);
 *                                           members get the members view, an
 *                                           asker the asker's (no members, the
 *                                           hosts); its `publicKey` is the
 *                                           ring's own. Anyone else: 404
 *   GET  /rings/:id/members, /outbox        P7: the member actors; the live
 *                                           room as Announces (members only)
 *   POST /rings/:id/inbox                   P7: the Group's inbox (5.2)
 *   GET  /rings/join/:code                  P7, with an AP Accept and signed:
 *                                           the asker's view of a live code's
 *                                           Group (a browser goes to the page)
 *   GET  /api/images/:key/web|thumb         P7, SIGNED only: a room image to a
 *                                           current member of the ring of a
 *                                           live post holding it (10.6); an
 *                                           unsigned request goes on to the
 *                                           session's image gate
 * and GET /users/:name/posts/:id serves a ROOM post to a current member of its
 * ring (signed as that member), while it is live.
 *
 * AUTHORIZED FETCH (AUTHORIZED_FETCH=1, the default): outbox, collections and
 * posts answer only signed GETs (401 unsigned); a signer the member blocks (the
 * handle, or its domain on their list) gets the 404 a stranger to that object
 * gets, and so does an UNBOUND key (an instance actor, no handle) whose host
 * the member's domain blocks cover (F6). Actors, WebFinger and NodeInfo answer unsigned: a verifier needs a key
 * before it can sign. EVERY answer of a signer-dependent route (outbox,
 * collections, posts), 401 and 404 included, is `Cache-Control: private,
 * no-store` with `Vary: Signature` (and Accept where negotiated, N9): a shared
 * cache must never hand one signer's answer, or a blocked signer's 404, to
 * another. A WebFinger 404 is `no-store`. Negotiated URLs `Vary: Accept`, and the
 * negotiation honours q (an AP type at q=0 is refused, N13). WebFinger, NodeInfo
 * and actors send CORS `*`.
 *
 * Budgets (5.9), by client (lib/rate-limit.js client id) BEFORE verification:
 * unsigned GETs 60 a minute; inbox POSTs 300 a minute; signed GETs 120 a minute;
 * a key fetch a request needs 30 a minute and 4 in flight (lib/federation.js);
 * an IPv6 client's /48 has an aggregate bucket on top (inbox POSTs 1200,
 * signed GETs 480 a minute). By VERIFIED remote host, AFTER the signature
 * verifies (two buckets): inbox POSTs 120 a minute and 3000 an hour, signed GETs
 * 120 a minute. `GET /users/:name/posts/:id` spends its budget (unsigned, or the
 * signed one) BEFORE it reads anything, and reads one post from the page
 * store's by-id index (N4), never the whole log.
 *
 * ARCHIVE AND ROOMS NEVER APPEAR HERE: the outbox and `featured` are built from
 * `public` posts only (lib/activities.js noteOf answers null for a divider and
 * an archive post), and a room post's URL is a 404 until P7 serves it to its
 * ring's members only.
 */
const express = require('express');
const { fail, wantsHtml, wantsAp } = require('../lib/http');
const { clientId, prefix48Of } = require('../lib/rate-limit');
const { validName, hostOfUrl } = require('../lib/handles');
const { blocksHandle } = require('../lib/ring');
const { POST_ID_RE, COMMENT_ID_RE } = require('../lib/ids');
const A = require('../lib/activities');
const urls = require('../lib/urls');
const { notFoundPage, sendPage } = require('./site');

const AP_TYPE = 'application/activity+json; charset=utf-8';
const PAGE = 20;
const FEATURED_MAX = 10;
const INBOX_MAX = 256 * 1024;
const INBOX_TYPES = /^application\/(activity\+json|ld\+json|json)\b/i;
const VERSION = require('../package.json').version;
const REPO = 'https://github.com/errorrrrrrrrr/ring';


const newestFirst = (a, b) => {
  if (a.created_at === b.created_at) return a.id < b.id ? 1 : -1;
  if (!a.created_at) return 1;
  if (!b.created_at) return -1;
  return a.created_at < b.created_at ? 1 : -1;
};

module.exports = function federationRoutes(ctx) {
  const { cfg, members, pages, images, keys, federation, limits, logger } = ctx;
  const origin = cfg.publicOrigin;
  const host = urls.hostOf(origin);
  const router = express.Router();

  const unsignedLimit = limits.limit('fed-get', { perMinute: 60 });
  const inboxIpLimit = limits.limit('fed-inbox', { perMinute: 300 });
  const signedIpLimit = limits.limit('fed-signed-get', { perMinute: 120 });
  /* The aggregate bucket of an IPv6 client's /48 (spec 5.9), on top of its own. */
  const p48Limit = (name, rule) => (req, res, next) => {
    const p = prefix48Of(clientId(req));
    if (p && !limits.allow(res, name, p, rule)) return;
    next();
  };
  const inbox48Limit = p48Limit('fed-inbox-48', { perMinute: 1200 });
  const signed48Limit = p48Limit('fed-signed-get-48', { perMinute: 480 });
  /* A signer-dependent route (N9): no shared cache may keep any of its answers. */
  const signerDependent = (negotiated) => (req, res, next) => {
    if (cfg.authorizedFetch) {
      res.set('Cache-Control', 'private, no-store');
      res.set('Vary', negotiated ? 'Accept, Signature' : 'Signature');
    } else if (negotiated) res.set('Vary', 'Accept');
    next();
  };
  const cors = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); };

  function ap(res, status, body, { cache = 'no-cache' } = {}) {
    res.status(status).type(AP_TYPE);
    res.set('Cache-Control', cache);
    res.set('X-Robots-Tag', 'noindex');
    return res.send(JSON.stringify(body));
  }
  /* A key fetch this request needed was refused (its client's budget or slots). */
  const busy = (res) => { res.set('Retry-After', '60'); return fail(res, 429, 'rate_minute'); };
  const notFound = (req, res) => (wantsHtml(req) ? sendPage(res, 404, notFoundPage()) : fail(res, 404, 'not_found'));

  /* An active member by name, or null. */
  const active = (name) => (validName(name) ? members.get(name) : null)?.status === 'active' ? members.get(name) : null;

  /* Authorized fetch: a signed GET, or (AUTHORIZED_FETCH=0) anyone. Answers the
   * refusal itself and returns null; else { handle } (empty when unsigned). */
  async function reader(req, res) {
    if (!cfg.authorizedFetch) return { handle: '', signed: false };
    if (!req.get('signature')) {
      // The unsigned budget is spent here too; a spent one has answered 429 itself.
      unsignedLimit(req, res, () => fail(res, 401, 'signature_invalid'));
      return null;
    }
    // The client's signed-GET budget (and its /48's), before any key is looked up or fetched.
    let within = false;
    signedIpLimit(req, res, () => { signed48Limit(req, res, () => { within = true; }); });
    if (!within) return null;
    const v = await federation.verifyGet(req, res);
    if (v.answered) return null;
    if (v.status === 429) { busy(res); return null; }
    if (!v.ok) { fail(res, v.status || 401, 'signature_invalid'); return null; }
    return { handle: v.handle || '', signed: true, actor: v.actor || '' };
  }
  const readerCache = () => (cfg.authorizedFetch ? 'private, no-store' : 'no-cache');
  /* Does the member's block shut this reader out? By handle; and a signer with
   * NO handle (an unbound instance-actor key, F6) by its key owner's host
   * against the member's domain blocks. */
  const shut = (name, r) => {
    if (r.handle) return blocksHandle(pages.settings(name), r.handle);
    if (!r.signed || !r.actor) return false;
    const h = hostOfUrl(r.actor);   // THE normalizer's host (P8 review F4)
    return !!h && blocksHandle(pages.settings(name), `_@${h}`);
  };

  // ── WebFinger (8.1) ──
  router.get('/.well-known/webfinger', cors, unsignedLimit, (req, res) => {
    const raw = typeof req.query.resource === 'string' ? req.query.resource.trim() : '';
    if (!raw) { res.set('Cache-Control', 'no-store'); return fail(res, 400, 'resource_required'); }
    let name = '';
    let instanceActor = false;
    const lower = raw.toLowerCase();
    if (lower.startsWith('acct:')) {
      const s = lower.slice(5).replace(/^@/, '');
      const at = s.lastIndexOf('@');
      if (at < 1 || s.slice(at + 1) !== host.toLowerCase()) return fail(res, 404, 'not_found');
      name = s.slice(0, at);
      if (name === host.toLowerCase()) instanceActor = true;
    } else if (raw === `${origin}/actor`) {
      instanceActor = true;
    } else {
      const l = urls.parseLocal(raw, origin);
      if (l?.kind === 'person') name = l.name;
      else if (raw.startsWith(`${origin}/@`)) {
        try { name = decodeURIComponent(raw.slice(origin.length + 2)); } catch { name = ''; }
      }
    }
    // Only a found answer may be cached: a 404 must not outlive the member's arrival.
    res.set('Cache-Control', 'no-store');
    if (instanceActor) {
      res.set('Cache-Control', 'max-age=300');
      const id = `${origin}/actor`;
      return res.status(200).type('application/jrd+json; charset=utf-8').send(JSON.stringify({
        subject: `acct:${host}@${host}`, aliases: [id],
        links: [{ rel: 'self', type: 'application/activity+json', href: id }],
      }));
    }
    if (!active(name)) return fail(res, 404, 'not_found');
    const actor = urls.actorUrl(origin, name);
    const page = urls.pageUrl(origin, name);
    res.set('Cache-Control', 'max-age=300');
    res.status(200).type('application/jrd+json; charset=utf-8').send(JSON.stringify({
      subject: `acct:${name}@${host}`,
      aliases: [actor, page],
      links: [
        { rel: 'self', type: 'application/activity+json', href: actor },
        { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: page },
        { rel: 'http://ostatus.org/schema/1.0/subscribe', template: `${origin}/authorize_interaction?uri={uri}` },
      ],
    }));
  });

  // ── NodeInfo (8.2) ──
  router.get('/.well-known/nodeinfo', cors, unsignedLimit, (req, res) => {
    res.set('Cache-Control', 'max-age=1800');
    res.type('application/json').send(JSON.stringify({
      links: [
        { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${origin}/nodeinfo/2.1` },
        { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${origin}/nodeinfo/2.0` },
      ],
    }));
  });
  function nodeinfo(version) {
    const software = { name: 'ring', version: VERSION };
    // 2.0's schema closes `software` to name and version; 2.1 adds the links.
    if (version === '2.1') Object.assign(software, { repository: REPO, homepage: REPO });
    return {
      version,
      software,
      protocols: ['activitypub'],
      services: { inbound: [], outbound: ['rss2.0'] },
      openRegistrations: cfg.signup === 'open',
      usage: { users: {} },   // schema-valid, and no numbers: Ring publishes no counts
      metadata: { nodeName: cfg.nodeName || host, ringProtocol: 1 },
    };
  }
  for (const v of ['2.1', '2.0']) {
    router.get(`/nodeinfo/${v}`, cors, unsignedLimit, (req, res) => {
      res.set('Cache-Control', 'max-age=1800');
      res.type(`application/json; profile="http://nodeinfo.diaspora.software/ns/schema/${v}#"`).send(JSON.stringify(nodeinfo(v)));
    });
  }

  // ── The instance actor (4.3) ──
  router.get('/actor', cors, unsignedLimit, (req, res) => {
    res.set('Vary', 'Accept');
    ap(res, 200, A.instanceActorDoc({ origin, publicKeyPem: keys.instancePublicKeyPem() }), { cache: 'max-age=300' });
  });
  router.get('/actor/outbox', cors, unsignedLimit, (req, res) => ap(res, 200, A.collectionDoc({ id: `${origin}/actor/outbox`, items: [] })));

  // ── Inboxes (5.2) ──
  const rawBody = express.raw({ type: () => true, limit: INBOX_MAX, inflate: false });
  function inbox(personal) {
    return [inboxIpLimit, inbox48Limit, (req, res, next) => {
      if (personal && !active(req.params.name)) return fail(res, 404, 'not_found');
      if (!INBOX_TYPES.test(req.get('content-type') || '')) return fail(res, 400, 'activity_media_type');
      if (Number(req.get('content-length') || 0) > INBOX_MAX) return fail(res, 413, 'too_large');
      next();
    }, rawBody, async (req, res, next) => {
      try {
        if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'bad_request');
        const r = await federation.inboxPost({ headers: req.headers, body: req.body, originalUrl: req.originalUrl }, res, { personal: personal ? req.params.name : '', client: clientId(req) });
        if (r.answered || res.headersSent) return;
        if (r.status === 202) return res.status(202).end();
        if (r.reason) logger.log(`[federation] inbox refused (${r.status} ${r.reason})`);
        if (r.status === 429) return busy(res);
        if (r.status === 401) return fail(res, 401, 'signature_invalid');
        if (r.status === 400) return fail(res, 400, 'bad_request');
        return fail(res, r.status, 'forbidden');
      } catch (e) { next(e); }
    }];
  }
  router.post('/users/:name/inbox', ...inbox(true));
  router.post('/inbox', ...inbox(false));
  router.post('/actor/inbox', ...inbox(false));

  // ── The Person (4.3) ──
  router.get('/users/:name', cors, (req, res, next) => {
    const name = req.params.name;
    res.set('Vary', 'Accept');
    if (wantsHtml(req)) {
      // The read budget first, as every unsigned read (N4).
      return unsignedLimit(req, res, () => {
        if (!active(name)) return notFound(req, res);
        res.redirect(302, urls.pageUrl(origin, name));
      });
    }
    unsignedLimit(req, res, () => {
      if (validName(name) && !members.get(name) && members.isRetired(name)) {
        return ap(res, 410, A.doc({ id: urls.actorUrl(origin, name), type: 'Tombstone', formerType: 'Person' }));
      }
      if (!active(name)) return fail(res, 404, 'not_found');
      try { ap(res, 200, federation.personOf(name)); } catch (e) { next(e); }
    });
  });

  /* The public, federable posts of a member: page ON, `public`, newest first. */
  function publicPosts(name) {
    const store = pages.load(name);
    if (store.enabled !== true) return [];
    return store.posts.filter((p) => p.audience === 'public' && p.kind !== 'divider').sort(newestFirst);
  }
  const noteCtx = (name) => ({ origin, name, imageRow: images.row });

  router.get('/users/:name/outbox', signerDependent(false), async (req, res, next) => {
    try {
      const name = req.params.name;
      if (!active(name)) return fail(res, 404, 'not_found');
      const r = await reader(req, res);
      if (!r) return;
      if (shut(name, r)) return fail(res, 404, 'not_found');
      const id = urls.collectionUrl(origin, name, 'outbox');
      const posts = publicPosts(name);
      if (req.query.page === undefined) {
        return ap(res, 200, A.collectionDoc({ id, first: posts.length ? `${id}?page=1` : undefined, items: posts.length ? undefined : [] }), { cache: readerCache(r) });
      }
      const n = Math.max(1, Math.min(10_000, Number.parseInt(req.query.page, 10) || 1));
      const slice = posts.slice((n - 1) * PAGE, n * PAGE);
      const items = slice.map((p) => A.createPost(p, noteCtx(name))).filter(Boolean).map(A.bare);
      ap(res, 200, A.collectionPageDoc({
        id: `${id}?page=${n}`, partOf: id, items,
        next: posts.length > n * PAGE ? `${id}?page=${n + 1}` : undefined,
        prev: n > 1 ? `${id}?page=${n - 1}` : undefined,
      }), { cache: readerCache(r) });
    } catch (e) { next(e); }
  });

  router.get('/users/:name/featured', signerDependent(false), async (req, res, next) => {
    try {
      const name = req.params.name;
      if (!active(name)) return fail(res, 404, 'not_found');
      const r = await reader(req, res);
      if (!r) return;
      if (shut(name, r)) return fail(res, 404, 'not_found');
      const items = publicPosts(name).filter((p) => p.pinned).map((p) => A.noteOf(p, noteCtx(name))).filter(Boolean).slice(0, FEATURED_MAX);
      ap(res, 200, A.collectionDoc({ id: urls.collectionUrl(origin, name, 'featured'), items }), { cache: readerCache(r) });
    } catch (e) { next(e); }
  });

  for (const which of ['followers', 'following']) {
    router.get(`/users/:name/${which}`, signerDependent(false), async (req, res, next) => {
      try {
        const name = req.params.name;
        if (!active(name)) return fail(res, 404, 'not_found');
        const r = await reader(req, res);
        if (!r) return;
        if (shut(name, r)) return fail(res, 404, 'not_found');
        // No items and no counts (spec 3.5, 4.3): the lists are the member's own.
        ap(res, 200, A.collectionDoc({ id: urls.collectionUrl(origin, name, which) }), { cache: readerCache(r) });
      } catch (e) { next(e); }
    });
  }

  /* A tombstone that may say "gone": the post was once shown (N10). A tombstone
   * written before the mark existed keeps the old rule (a public post). */
  const wasShown = (t) => (t.shown === undefined ? (t.audience || 'public') === 'public' && t.kind !== 'divider' : t.shown === true);

  router.get('/users/:name/posts/:id', signerDependent(true), async (req, res, next) => {
    try {
      const { name, id } = req.params;
      // The post, read from the page store's by-id index, never the whole log,
      // and only AFTER this request's budget is spent (N4).
      const lookup = () => {
        const post = active(name) && POST_ID_RE.test(id) ? pages.post(name, id) : null;
        const on = !!post && pages.settings(name).enabled === true;
        return { post, shown: on && post.audience === 'public' && post.kind !== 'divider' };
      };
      if (wantsHtml(req)) {
        return unsignedLimit(req, res, () => {
          const { shown } = lookup();
          if (!shown) return notFound(req, res);
          res.redirect(302, urls.wallAnchor(origin, name, id));
        });
      }
      if (!active(name)) return fail(res, 404, 'not_found');
      const r = await reader(req, res);
      if (!r) return;
      if (shut(name, r)) return fail(res, 404, 'not_found');
      const { post, shown } = lookup();
      if (!post) {
        // A deleted post that was once shown, of an enabled page, answers 410;
        // nothing else says it existed.
        const tomb = POST_ID_RE.test(id) && pages.settings(name).enabled === true ? pages.tombstone(name, id) : null;
        if (tomb && wasShown(tomb)) return ap(res, 410, A.tombstoneDoc({ origin, name, id, deleted: tomb.deleted_at }), { cache: readerCache(r) });
        return fail(res, 404, 'not_found');
      }
      if (!shown) {
        // A room post needs its member's signature, AUTHORIZED_FETCH or not.
        let rr = r;
        if (!rr.signed && post && post.audience !== 'public' && post.audience !== 'archive' && req.get('signature')) { rr = await ringReader(req, res); if (!rr) return; }
        const room = roomNoteFor(name, post, rr);
        return room ? ap(res, 200, A.doc(room), { cache: readerCache(r) }) : fail(res, 404, 'not_found');
      }
      const note = A.noteOf(post, noteCtx(name));
      if (!note) return fail(res, 404, 'not_found');
      ap(res, 200, A.doc(note), { cache: readerCache(r) });
    } catch (e) { next(e); }
  });

  router.get('/users/:name/comments/:id', signerDependent(false), async (req, res, next) => {
    try {
      const { name, id } = req.params;
      if (!active(name)) return fail(res, 404, 'not_found');
      const r = await reader(req, res);
      if (!r) return;
      if (shut(name, r)) return fail(res, 404, 'not_found');
      const row = COMMENT_ID_RE.test(id) ? ctx.sent.byId(name, 'comment', id) : null;
      const note = row?.activity?.object;
      if (!note || typeof note !== 'object' || note.id !== urls.commentUrl(origin, name, id)) return fail(res, 404, 'not_found');
      // P7: a comment in a ROOM (its Group in `group`) is the ring's: only a
      // current member of that ring reads it, while the post it answers is live.
      // Signed, AUTHORIZED_FETCH or not (P7 review F4: both modes), and never
      // to a signer the commenter blocks.
      if (row.group) {
        let rr = r;
        if (!rr.signed && req.get('signature')) { rr = await ringReader(req, res); if (!rr) return; }
        const ring = ringStore.load().find((x) => x.ap_id === row.group);
        const live = ctx.rooms?.find(row.object);
        if (!ring || !rr.handle || shut(name, rr) || !R.isMember(ring, rr.handle) || !R.isMember(ring, name) || !live) return fail(res, 404, 'not_found');
      }
      ap(res, 200, A.doc(note), { cache: readerCache(r) });
    } catch (e) { next(e); }
  });

  // ── Rings (P7, spec 4.7, 11.2) ──
  // The Group, its members and its room answer SIGNED GETs only, whatever
  // AUTHORIZED_FETCH says: a ring's existence is its members' business. Every
  // answer is signer-dependent (`private, no-store`, Vary: Signature), and a
  // stranger, a blocked domain, a ring that is not hosted here and a ring that
  // does not exist all get one opaque 404.
  const { ringStore, ringFed } = ctx;
  const R = require('../lib/rings');
  const { RING_ID_RE } = require('../lib/ids');
  async function ringReader(req, res) {
    if (!req.get('signature')) {
      unsignedLimit(req, res, () => fail(res, 401, 'signature_invalid'));
      return null;
    }
    let within = false;
    signedIpLimit(req, res, () => { signed48Limit(req, res, () => { within = true; }); });
    if (!within) return null;
    const v = await federation.verifyGet(req, res);
    if (v.answered) return null;
    if (v.status === 429) { busy(res); return null; }
    if (!v.ok) { fail(res, v.status || 401, 'signature_invalid'); return null; }
    return { handle: v.handle || '', actor: v.actor || '', signed: true };
  }
  const ringSigned = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('Vary', 'Accept, Signature'); next(); };
  const handleHost = (h) => (h.includes('@') ? h.slice(h.indexOf('@') + 1) : host.toLowerCase());
  /* What a signer may see of a home ring (4.7): 'members' (a member, or that
   * member's server's instance actor), 'asker' (a pending requester, or theirs),
   * or '' (the opaque 404). */
  function ringViewFor(ring, r) {
    if (r.handle && R.isMember(ring, r.handle)) return 'members';
    if (r.handle && R.hasRequested(ring, r.handle)) return 'asker';
    const h = hostOfUrl(r.actor);
    if (!r.handle && h && r.actor === `${new URL(r.actor).origin}/actor`) {
      if (ring.members.some((m) => m.handle.includes('@') && handleHost(m.handle) === h)) return 'members';
      if (ring.requests.some((q) => q.handle.includes('@') && handleHost(q.handle) === h)) return 'asker';
    }
    return '';
  }
  const homeRing = (id) => (RING_ID_RE.test(String(id)) ? ringStore.get(id) : null);
  const groupDocOf = (ring, view) => A.doc(A.groupDoc(ring, { origin, view, actorOf: (h) => ctx.groups.actorOf(origin, h), publicKeyPem: keys.ringPublicKeyPem(ring.id) }));

  router.get('/rings/:id', ringSigned, async (req, res, next) => {
    try {
      if (wantsHtml(req)) return notFound(req, res);
      const r = await ringReader(req, res);
      if (!r) return;
      const ring = homeRing(req.params.id);
      const view = ring?.home ? ringViewFor(ring, r) : '';
      if (!view) return fail(res, 404, 'not_found');
      ap(res, 200, groupDocOf(ring, view), { cache: 'private, no-store' });
    } catch (e) { next(e); }
  });
  for (const which of ['members', 'outbox']) {
    router.get(`/rings/:id/${which}`, ringSigned, async (req, res, next) => {
      try {
        const r = await ringReader(req, res);
        if (!r) return;
        const ring = homeRing(req.params.id);
        if (!ring?.home || ringViewFor(ring, r) !== 'members') return fail(res, 404, 'not_found');
        const id = `${urls.groupUrl(origin, ring.id)}/${which}`;
        const items = which === 'members'
          ? ring.members.map((m) => ctx.groups.actorOf(origin, m.handle)).filter(Boolean)
          : ringFed.outboxItems(ring, { host: hostOfUrl(r.actor) });
        ap(res, 200, A.collectionDoc({ id, items }), { cache: 'private, no-store' });
      } catch (e) { next(e); }
    });
  }
  router.post('/rings/:id/inbox', ...inbox(false));
  /* A join link read by another Ring server (4.7): a live code shows the
   * asker's view (name, hosts, the ring's key), signed reads only. A browser
   * goes on to the page (routes/app.js). */
  router.get('/rings/join/:code', async (req, res, next) => {
    if (!wantsAp(req)) return next();   // a browser: the page (routes/app.js)
    try {
      res.set('Cache-Control', 'private, no-store');
      res.set('Vary', 'Accept, Signature');
      const r = await ringReader(req, res);
      if (!r) return;
      const ring = R.ringByJoinCode(ringStore.load(), String(req.params.code || ''), require('../lib/clock').now());
      if (!ring) return fail(res, 404, 'not_found');
      ap(res, 200, groupDocOf(ring, 'asker'), { cache: 'private, no-store' });
    } catch (e) { next(e); }
  });

  /* A ROOM post (P7, spec 11.2): to a signer who is a current member of its
   * ring (a member's server fetching it, signed as that member, 5.1), while
   * the post is live; anything else the 404 a stranger gets. Routed here from
   * GET /users/:name/posts/:id below. */
  function roomNoteFor(name, post, r) {
    if (!post || !r.handle || post.audience === 'public' || post.audience === 'archive' || post.kind === 'divider') return null;
    // The block wins wherever this server answers (P7 review F4), whichever
    // AUTHORIZED_FETCH mode let the reader this far.
    if (shut(name, r)) return null;
    if (Date.parse(post.created_at) + 7 * 24 * 3600_000 <= require('../lib/clock').now()) return null;
    const ring = ringStore.get(post.audience);
    if (!ring || !R.isMember(ring, name) || !R.isMember(ring, r.handle) || r.handle === name) return null;
    return A.noteOf(post, { ...noteCtx(name), groupOf: (rid) => ringStore.get(rid)?.ap_id || '' });
  }

  /* A room image (P7, spec 10.6): the image gate's signed branch. A request
   * that carries a Signature is answered here, before any session is read
   * (5.10): its signer must be a current member of the ring of a live room
   * post that holds the key. Anything else goes on to the session gate. */
  router.get(['/api/images/:key/web', '/api/images/:key/thumb'], async (req, res, next) => {
    if (!req.get('signature')) return next();
    try {
      res.set('Cache-Control', 'private, no-store');
      const r = await ringReader(req, res);
      if (!r) return;
      const key = String(req.params.key || '');
      const variant = req.path.endsWith('/thumb') ? 'thumb' : 'web';
      const row = images.row(key);
      const file = row && images.variantFile(key, variant);
      // The block wins here too (P7 review F4): the image's owner blocks the signer, 404.
      if (!file || !r.handle || shut(row.owner, r) || !ctx.audience.roomImageVisible(key, row.owner, r.handle)) return fail(res, 404, 'not_found');
      res.set('Content-Type', images.VARIANT_TYPE);
      res.sendFile(file, { dotfiles: 'deny', lastModified: false, cacheControl: false }, (err) => {
        if (err && !res.headersSent) fail(res, 404, 'not_found');
      });
    } catch (e) { next(e); }
  });

  // Unique ids that are never served (2.5), and what later phases add: 404.
  router.all(['/users/:name/posts/:id/activity', '/users/:name/activities/:id', '/users/:name/stamps/:id', '/users/:name/comments/:id', '/actor/activities/:id'], (req, res) => fail(res, 404, 'not_found'));

  return router;
};
