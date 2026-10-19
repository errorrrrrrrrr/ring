'use strict';
/* ── Reaching other servers from the app (spec 4.8, 5.7, 8.5, 11.1; P6) ───────
 *   POST   /api/remote/stamp {object, face}   press a stamp on a remote post
 *                                             seen in a feed or by lookup;
 *                                             the same face again takes it back
 *   DELETE /api/remote/stamp/:id              take it back (Undo)
 *   POST   /api/remote/comment {object, body} a comment on a remote FRIEND's post
 *   DELETE /api/remote/comment/:id            take it back (Delete)
 *   GET    /api/lookup?q=                     `name@host`, a profile URL, a post
 *                                             URL or a join link -> a view
 *   GET    /media/:id/web|thumb               the remote media cache's copies,
 *                                             to SIGNED-IN MEMBERS only (5.7)
 *   GET    /authorize_interaction?uri=        WebFinger's subscribe template:
 *                                             a member goes to /app?open=<uri>
 *   GET    /authorize_interaction/remote?uri=&handle=
 *                                             the visitor's form only (a link
 *                                             from anywhere fetches nothing)
 *   POST   /authorize_interaction/remote {handle, uri}
 *                                             a VISITOR from another server
 *                                             (the wall's "from your server"),
 *                                             from THIS site's form only
 *                                             (Sec-Fetch-Site same-origin or
 *                                             our Origin): a page naming their
 *                                             server's host with a link to its
 *                                             subscribe template (https, on
 *                                             their host), never a redirect.
 *                                             The WebFinger read runs on the
 *                                             anonymous gate, 3 s, under one
 *                                             server-wide budget (F4, F9)
 *
 * The rules a stamp on a remote post keeps (3.7, 4.8): a palette face only (a
 * custom face is a room's, P7), the nice shelf unless the author is a confirmed
 * friend, never on a blocked author, never while their Ring server says stamps
 * are off; the activity is shaped by the other side's software (its NodeInfo,
 * lib/activities.js stampRemote): the exact face to a Ring server, an
 * EmojiReact to Pleroma and Akkoma, a Misskey reaction, a favourite to Mastodon.
 * A comment: confirmed friends only, plain text, 280. Each is kept in the
 * member's sent.json (lib/sent.js) so it can be taken back. Stamps spend the
 * stamp budget (20 a minute, 200 a day), comments theirs (6, 100), lookups 30 a
 * minute and 300 a day (5.9); a visitor's "from your server" 10 a minute. A
 * /media miss that puts a new fetch in the cache's line spends the member's
 * media-fetch budget (30 a minute, 600 a day) and waits in that line (F8).
 *
 * A remote post is found on a friend's wall, in what a lookup fetched this past
 * hour, or fetched now (signed by the instance actor, lib/federation.js
 * remotePost): only a public or unlisted Note by its own author is a target.
 * With FEDERATION=off every route here answers 404.
 */
const express = require('express');
const { fail, wrap } = require('../lib/http');
const { toHandle, validName, hostOfUrl } = require('../lib/handles');
const { blocksHandle } = require('../lib/ring');
const { newStampId, newCommentId } = require('../lib/ids');
const { paletteFace, normalizeCustomFace, normalizeCommentBody, isNice } = require('../lib/reactions');
const { POST_ID_RE } = require('../lib/ids');
const clock = require('../lib/clock');
const A = require('../lib/activities');
const urls = require('../lib/urls');
const { t } = require('../lib/strings');
const { escapeHtml: e } = require('../lib/security');
const { shell } = require('./site');

/* Where a visitor's own server's subscribe template sends them (8.5, F9): the
 * URL, or null. Their own host only, https only (`loopbackHttp`: the test
 * hook's http on a loopback host), no credentials in it. */
function interactTarget(template, uri, theirHost, { loopbackHttp = false } = {}) {
  let target;
  try { target = new URL(String(template).replace('{uri}', encodeURIComponent(uri))); } catch { return null; }
  const httpOk = loopbackHttp && target.protocol === 'http:' && /^(127\.|localhost$|\[::1\]$)/.test(target.hostname);
  if (target.host.toLowerCase() !== theirHost || (target.protocol !== 'https:' && !httpOk) || target.username || target.password) return null;
  return target;
}

module.exports = function remoteRoutes(ctx) {
  const { cfg, members, pages, follows, sent, auth, limits, stillMember, whoIs, feeds, federation, audience, audit } = ctx;
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  const fedOnly = (req, res, next) => (federation ? next() : fail(res, 404, 'not_found'));
  const origin = () => cfg.publicOrigin;

  /* The remote post a request names, or answers the refusal and returns null. */
  async function target(req, res) {
    const object = typeof req.body?.object === 'string' ? req.body.object.trim() : '';
    if (!object || object.length > 2000 || !federation.isRemote(object)) { fail(res, 404, 'not_found'); return null; }
    const found = await federation.remotePost(object);
    if (!found) { fail(res, 404, 'not_found'); return null; }
    return found;
  }

  const emitTo = (activity, actor) => ctx.outbox.emit(activity, [actor], { origin: origin() });

  /* P7: a COPY of another server's room post, held here for a ring the member
   * is in: the stamp or comment goes to the ring's Group (lib/ring-fed.js), and
   * the answer carries the copy's reactions as the ring sees them. */
  const copyOf = (req) => {
    const object = typeof req.body?.object === 'string' ? req.body.object.trim() : '';
    return object && ctx.rooms ? ctx.rooms.find(object) : null;
  };
  function copyReactions(found, origin_) {
    const c = ctx.rooms.find(found.post.id);
    if (!c) return { stamps: [], comments: [] };
    const authorOf = ctx.reactions.authorResolver(origin_);
    const who = (h) => { const a = authorOf(h); return { handle: a.handle, name: a.name, url: a.url, host: a.host }; };
    return {
      stamps: c.post.stamps.map((x) => ({ id: x.id, kaomoji: x.face, ...(x.custom ? { custom: true } : {}), at: x.at, author: who(x.author) })),
      comments: c.post.comments.map((x) => ({ id: x.id, body: x.body, at: x.at, author: who(x.author) })),
    };
  }

  router.post('/api/remote/stamp', fedOnly, auth.requireMember, noStore, limits.limit('stamp', { perMinute: 20, perDay: 200 }), wrap(async (req, res) => {
    const me = req.member.slug;
    const copy = copyOf(req);
    if (copy) {
      await ctx.ringFed.readyFor(copy);
      if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
      const r = ctx.ringFed.reactToCopy(me, copy, { face: req.body?.face });
      if (r.status >= 400) return fail(res, r.status, r.error);
      audit(`stamp.${r.action}`, me, { object: copy.post.id, room: true });
      const { status: _s, ...rest } = r;
      return res.json({ ok: true, ...rest, ...copyReactions(copy, origin()) });
    }
    const found = await target(req, res);
    if (!found) return;
    const { obj, handle, actor } = found;
    const face = paletteFace(req.body?.face);
    if (!face) return fail(res, normalizeCustomFace(req.body?.face) ? 403 : 400, normalizeCustomFace(req.body?.face) ? 'custom_room_only' : 'stamp_invalid');
    if (!isNice(face) && !follows.friends(me, handle)) return fail(res, 403, 'friends_only');
    if (blocksHandle(pages.settings(me), handle)) return fail(res, 409, 'blocked_them');
    if (federation.actors.switchesOf(handle)?.stamps_off) return fail(res, 403, 'stamps_closed');
    const software = await federation.softwareOf(new URL(actor).host.toLowerCase());
    // ── tick ──
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    const prev = sent.stampOn(me, obj.id);
    if (prev) {
      emitTo(A.undo({ origin: origin(), name: me, activity: prev.activity }), actor);
      sent.remove(me, 'stamp', prev.id);
      if (prev.face === face) {
        audit('stamp.removed', me, { object: obj.id });
        return res.json({ ok: true, action: 'removed', mine: '' });
      }
    }
    const id = newStampId();
    const activity = A.stampRemote({ origin: origin(), name: me, stampId: id, postUrl: obj.id, postAuthor: actor, face, kind: software.kind });
    const { '@context': _c, ...bare } = activity;
    sent.put(me, { id, kind: 'stamp', object: obj.id, author: handle, face, activity: bare, at: clock.iso() });
    emitTo(activity, actor);
    audit(prev ? 'stamp.changed' : 'stamp.added', me, { object: obj.id, as: activity.type });
    res.json({ ok: true, action: prev ? 'changed' : 'added', mine: face, id, sent_as: activity.type });
  }));

  router.delete('/api/remote/stamp/:id', fedOnly, auth.requireMember, noStore, (req, res) => {
    const me = req.member.slug;
    const row = sent.byId(me, 'stamp', String(req.params.id));
    if (!row) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    if (row.group) { ctx.ringFed.takeBackFromCopy(me, row); audit('stamp.removed', me, { object: row.object, room: true }); return res.json({ ok: true }); }
    const actor = federation.actors.idOf(row.author);
    sent.remove(me, 'stamp', row.id);
    if (actor) emitTo(A.undo({ origin: origin(), name: me, activity: row.activity }), actor);
    audit('stamp.removed', me, { object: row.object });
    res.json({ ok: true });
  });

  router.post('/api/remote/comment', fedOnly, auth.requireMember, noStore, limits.limit('comment', { perMinute: 6, perDay: 100 }), wrap(async (req, res) => {
    const me = req.member.slug;
    const copy = copyOf(req);
    if (copy) {
      await ctx.ringFed.readyFor(copy);
      if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
      const r = ctx.ringFed.reactToCopy(me, copy, { body: req.body?.body });
      if (r.status >= 400) return fail(res, r.status, r.error);
      audit('comment.added', me, { object: copy.post.id, room: true });
      const views = copyReactions(copy, origin());
      return res.json({ ok: true, id: r.id, comments: views.comments });
    }
    const found = await target(req, res);
    if (!found) return;
    const { obj, handle, actor } = found;
    if (!follows.friends(me, handle)) return fail(res, 403, 'comments_friends_only');
    if (blocksHandle(pages.settings(me), handle)) return fail(res, 409, 'blocked_them');
    if (federation.actors.switchesOf(handle)?.comments_off) return fail(res, 403, 'comments_closed');
    const body = normalizeCommentBody(req.body?.body);
    if (!body) return fail(res, 400, 'comment_empty');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    const id = newCommentId();
    const activity = A.createComment({ origin: origin(), name: me, commentId: id, postUrl: obj.id, postAuthor: actor, postAuthorHandle: handle, body, published: clock.iso() });
    const { '@context': _c, ...bare } = activity;
    sent.put(me, { id, kind: 'comment', object: obj.id, author: handle, body, activity: bare, at: clock.iso() });
    emitTo(activity, actor);
    audit('comment.added', me, { object: obj.id, chars: body.length });
    res.json({ ok: true, id, comments: sent.commentsOn(me, obj.id).map((r) => ({ id: r.id, body: r.body, at: r.at })) });
  }));

  router.delete('/api/remote/comment/:id', fedOnly, auth.requireMember, noStore, (req, res) => {
    const me = req.member.slug;
    const row = sent.byId(me, 'comment', String(req.params.id));
    if (!row) return fail(res, 404, 'not_found');
    if (!stillMember(req)) return fail(res, 401, 'not_signed_in');
    if (row.group) { ctx.ringFed.takeBackFromCopy(me, row); audit('comment.removed', me, { object: row.object, room: true }); return res.json({ ok: true }); }
    const actor = federation.actors.idOf(row.author);
    sent.remove(me, 'comment', row.id);
    if (actor) emitTo(A.deleteComment({ origin: origin(), name: me, objectId: row.activity?.object?.id || urls.commentUrl(origin(), me, row.id), to: [actor], deleted: clock.iso() }), actor);
    audit('comment.removed', me, { object: row.object });
    res.json({ ok: true });
  });

  // ── lookup (8.5) ──

  router.get('/api/lookup', auth.requireMember, noStore, limits.limit('lookup', { perMinute: 30, perDay: 300 }), wrap(async (req, res) => {
    const me = req.member.slug;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 2000) : '';
    if (!q) return fail(res, 400, 'invalid_field');
    const o = urls.originOf(req, cfg);
    const host = urls.hostOf(o);
    // This server's own: a name, name@this-host, a profile, a post or a join link.
    const localName = toHandle(q, host, { allowPort: cfg.fedTestLoopback });
    const local = urls.parseLocal(q, o);
    const wall = q.startsWith(`${o}/@`) ? (() => { try { return decodeURIComponent(q.slice(o.length + 2).split('#')[0]); } catch { return ''; } })() : '';
    const localPerson = (localName && !localName.includes('@') ? localName : '') || (local?.kind === 'person' ? local.name : '') || wall;
    if (localPerson) {
      if (!validName(localPerson) || members.get(localPerson)?.status !== 'active') return fail(res, 404, 'not_found');
      return res.json({ type: 'person', local: true, ...whoIs(localPerson, o), status: localPerson === me ? 'self' : follows.status(me, localPerson).status });
    }
    if (local?.kind === 'post') {
      if (!POST_ID_RE.test(local.id) || !audience.seeing(local.name, local.id, me)) return fail(res, 404, 'not_found');
      return res.json({ type: 'post', local: true, owner: local.name, id: local.id, url: urls.wallAnchor(o, local.name, local.id) });
    }
    if (local?.kind === 'join') return res.json({ type: 'join', local: true, code: local.id });
    if (!federation) return fail(res, 404, 'not_found');
    if (/^https?:\/\/[^/]+\/rings\/join\/[^/?#]+$/.test(q) && federation.isRemote(q)) {
      // P7: another Ring server's ring: its name and the hosts that hold it
      // (the trust notice), read from the link; never a Mastodon host.
      const p = await ctx.ringFed.preview(me, q);
      if (p.status >= 400) return fail(res, p.status, p.error);
      const { status: _s, ...view } = p;
      return res.json(view);
    }
    // A host the member blocks is never asked (P8 review F4): its name read
    // through THE host normalizer before any fetch, as the admin's list is.
    const qHost = /^https?:\/\//i.test(q) ? hostOfUrl(q) : (q.replace(/^acct:/i, '').replace(/^@/, '').split('@')[1] || '');
    if (qHost && blocksHandle(pages.settings(me), `_@${qHost}`)) return fail(res, 404, 'not_found');
    const found = await federation.lookup(q);
    if (!found) return fail(res, 404, 'not_found');
    if (blocksHandle(pages.settings(me), found.handle)) return fail(res, 404, 'not_found');
    if (found.type === 'person') {
      return res.json({ type: 'person', local: false, ...whoIs(found.handle, o), actor: found.actor, status: follows.status(me, found.handle).status });
    }
    const card = feeds.remoteCard(found.obj, found.handle, me, o);
    res.json({ type: 'post', local: false, post: card, friends: follows.friends(me, found.handle) });
  }));

  // ── the remote media cache (5.7): members of this server only ──

  const mediaMiss = limits.missLimit('mediamiss', { perMinute: 100, perDay: 1500 });
  // F8: a miss that puts a NEW fetch in the media cache's line spends the
  // member's own budget (a miss waiting on a fetch already in line spends none).
  const MEDIA_FETCH_RULE = { perMinute: 30, perDay: 600 };
  const mayFetch = (slug) => () => !limits.take(`media-fetch:m:${slug}`, MEDIA_FETCH_RULE);
  for (const v of ['web', 'thumb']) {
    router.get(`/media/:id/${v}`, mediaMiss, auth.requireMember, wrap(async (req, res) => {
      if (!federation) return fail(res, 404, 'not_found');
      const id = String(req.params.id || '');
      // P7: a room image is the ring's: only a member here of a ring whose live
      // copies hold it (spec 4.7, 10.6); anyone else the 404 a miss gets.
      // Its id is its ring's (P7 review F6): that ring, the member in it, a live copy naming it.
      const row = federation.media.row(id);
      if (row?.room) {
        const mine = ctx.ringStore.load().filter((r) => r.members.some((m) => m.handle === req.member.slug)).map((r) => r.id);
        if (!mine.includes(row.ring) || !ctx.rooms?.mediaRings(id, [row.ring]).length) return fail(res, 404, 'not_found');
      }
      let file = federation.media.file(id, v);
      if (!file && (await federation.media.ensure(id, { mayStart: mayFetch(req.member.slug) }))) file = federation.media.file(id, v);
      if (!file) return fail(res, 404, 'not_found');
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('X-Robots-Tag', 'noindex');
      res.sendFile(file, { dotfiles: 'allow', lastModified: false, cacheControl: false }, (err) => {
        if (err && !res.headersSent) fail(res, 404, 'not_found');
      });
    }));
  }

  // ── remote interaction (8.5) ──

  router.get('/authorize_interaction', (req, res) => {
    const uri = typeof req.query.uri === 'string' ? req.query.uri.slice(0, 2000) : '';
    const target = uri ? `/app?open=${encodeURIComponent(uri)}` : '/app';
    res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'private, no-store');
    if (!federation) return fail(res, 404, 'not_found');
    if (req.member) return res.redirect(302, target);
    res.redirect(302, `/login?next=${encodeURIComponent(target)}`);
  });

  /* A person or a post of THIS server, active: what a visitor may act on from
   * their own server (never anything else: no open redirect, 8.5). */
  const localTarget = (uri) => {
    const l = urls.parseLocal(uri, origin());
    // P7: a live join link of a ring hosted here (4.7: a visitor from another
    // Ring server asks from home).
    if (l?.kind === 'join') return require('../lib/rings').ringByJoinCode(ctx.ringStore.load(), l.id, clock.now()) ? l : null;
    return l && ['person', 'post'].includes(l.kind) && members.get(l.name)?.status === 'active' ? l : null;
  };
  const sendHtml = (res, status, html) => {
    res.status(status).type('html');
    res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'private, no-store');
    res.send(html);
  };
  /* The visitor's form: their handle, POSTed here (F4). Fetches nothing. */
  function interactForm(res, status, { uri, handle = '', note = '' }) {
    const join = urls.parseLocal(uri, origin())?.kind === 'join';
    sendHtml(res, status, shell({
      title: t('page.interact.title'),
      body: `<main><h1>${e(t('page.interact.title'))}</h1>
${note ? `<p role="alert">${e(note)}</p>\n` : ''}<p>${e(t(join ? 'page.interact.join_body' : 'page.interact.body'))}</p>
${join ? `<p><a href="/login?next=${e(encodeURIComponent(`/app?ring=${encodeURIComponent(uri.split('/').pop())}`))}">${e(t('page.interact.join_here'))}</a></p>\n` : ''}
<form method="post" action="/authorize_interaction/remote">
<input type="hidden" name="uri" value="${e(uri)}">
<p><label>${e(t('page.interact.label'))}<br><input type="text" name="handle" value="${e(handle)}" maxlength="330" autocomplete="username" required></label></p>
<p><button type="submit">${e(t('page.interact.submit'))}</button></p>
</form></main>`,
    }));
  }
  const interactLimit = limits.limit('interact', { perMinute: 10, perDay: 100 });
  const field = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

  /* GET only renders the form (a link from anywhere fetches nothing). */
  router.get('/authorize_interaction/remote', interactLimit, (req, res) => {
    if (!federation) return fail(res, 404, 'not_found');
    const uri = field(req.query.uri, 2000);
    if (!localTarget(uri)) return fail(res, 404, 'not_found');
    interactForm(res, 200, { uri, handle: field(req.query.handle, 330) });
  });

  /* POST, from this site's own form only (F4: Sec-Fetch-Site same-origin or
   * an Origin of this site; a request that carries neither is refused too):
   * read their server's subscribe template on the anonymous gate (lib/
   * federation.js visitorTemplate), then show the page that NAMES their host
   * and links there (F9): never a redirect, and only an https template on the
   * handle's own host. */
  const sameOrigin = (req) => req.get('sec-fetch-site') === 'same-origin' || (req.get('origin') !== undefined && req.get('origin') === urls.originOf(req, cfg));
  router.post('/authorize_interaction/remote', express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 8 }), (req, res, next) => {
    if (!federation) return fail(res, 404, 'not_found');
    if (!sameOrigin(req)) return fail(res, 403, 'interact_origin');
    next();
  }, interactLimit, wrap(async (req, res) => {
    const o = origin();
    const uri = field(req.body?.uri, 2000);
    if (!localTarget(uri)) return fail(res, 404, 'not_found');
    const typed = field(req.body?.handle, 330).trim();
    const handle = toHandle(typed, urls.hostOf(o), { allowPort: cfg.fedTestLoopback });
    if (!handle?.includes('@')) return interactForm(res, 400, { uri, handle: typed, note: t('page.interact.invalid') });
    const theirHost = handle.slice(handle.indexOf('@') + 1);
    const unknown = () => interactForm(res, 404, { uri, handle: typed, note: t('page.interact.unknown') });
    if (federation.blockedHost(theirHost)) return unknown();
    let template;
    try { template = await federation.visitorTemplate(handle); }
    catch (err) {
      if (err?.status === 429) { res.set('Retry-After', '60'); return interactForm(res, 429, { uri, handle: typed, note: t('busy') }); }
      return unknown();
    }
    const target = interactTarget(template, uri, theirHost, { loopbackHttp: cfg.fedTestLoopback });
    if (!target) return unknown();
    sendHtml(res, 200, shell({
      title: t('page.interact.go_title', { host: target.host }),
      body: `<main><h1>${e(t('page.interact.go_title', { host: target.host }))}</h1>
<p>${e(t('page.interact.go_body', { host: target.host, handle }))}</p>
<p><a href="${e(target.href)}" rel="noopener noreferrer">${e(t('page.interact.go', { host: target.host }))}</a></p>
<p><a href="${e(uri)}">${e(t('page.interact.back'))}</a></p></main>`,
    }));
  }));

  return router;
};

module.exports.interactTarget = interactTarget;
