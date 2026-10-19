'use strict';
/* ── A member's report (spec 6.2, 11.1; P8) ───────────────────────────────────
 *   POST /api/reports   { kind, comment?, forward?, ... } -> 201 { id, forwarded }
 *     kind 'person'   { handle }               a member here, or a remote actor
 *                                              this server knows
 *     kind 'post'     { url }                  a post here the reporter can see,
 *                                              a remote post (a friend's wall,
 *                                              a lookup, else fetched), or a
 *                                              room copy in a ring of theirs
 *     kind 'comment'  { owner, post_id, id }   a comment on a post here the
 *     kind 'stamp'    { owner, post_id, id }   reporter can see; or a stamp
 *     kind 'reply'    { id }                   one of the reporter's own From
 *                                              elsewhere rows
 * THE SERVER RESOLVES THE TARGET: who is reported, which object URLs are
 * named, the reported post (`post`) and, for a comment or stamp, which one
 * (`ref`) come from this server's own rows, never from the client's word, so a
 * report can never pin a stranger's post on someone else, nor name a post the
 * reporter cannot see (that is the unknown one's 404). Reporting oneself, or
 * one's own post, is 400 `own_post` / `own_handle`.
 * `forward: true` on a remote target sends a Flag to its server at once, from
 * the instance actor, without the reporter's name (lib/moderate.js).
 * Budget: 5 a minute, 30 a day per member (spec 5.9). The comment is one plain
 * line of 1000 characters.
 */
const express = require('express');
const { fail, wrap } = require('../lib/http');
const { toHandle } = require('../lib/handles');
const { isMember } = require('../lib/rings');
const urls = require('../lib/urls');

const KINDS = new Set(['person', 'post', 'comment', 'stamp', 'reply']);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

module.exports = function reportRoutes(ctx) {
  const { cfg, members, auth, limits, reactions, elsewhere, audience, moderate, ringStore, rooms } = ctx;
  const router = express.Router();
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };

  /* A handle's actor URL: a member here, or a remote actor this server knows. */
  function actorOf(handle, origin) {
    if (!handle.includes('@')) return members.get(handle)?.status === 'active' ? urls.actorUrl(origin, handle) : '';
    const f = ctx.federation;
    return f ? f.actors.idOf(handle) || '' : '';
  }

  /* -> { target, objects } or { status, error }. */
  async function resolve(me, b, origin) {
    const host = urls.hostOf(origin);
    const nf = { status: 404, error: 'not_found' };
    switch (b.kind) {
      case 'person': {
        const h = toHandle(b.handle, host, { allowPort: cfg.fedTestLoopback });
        if (!h) return nf;
        if (h === me) return { status: 400, error: 'own_handle' };
        const a = actorOf(h, origin);
        return a ? { target: h, objects: [a] } : nf;
      }
      case 'post': {
        const url = str(b.url, 2000);
        const l = urls.parseLocal(url, origin);
        if (l) {
          if (l.kind !== 'post') return nf;
          const seen = audience.seeing(l.name, l.id, me);
          if (!seen) return nf;
          if (l.name === me) return { status: 400, error: 'own_post' };
          const post = urls.postUrl(origin, l.name, l.id);
          return { target: l.name, post, objects: [urls.actorUrl(origin, l.name), post] };
        }
        const f = ctx.federation;
        if (!f || !/^https?:\/\//.test(url)) return nf;
        // A room copy in a ring of the reporter's (P7): its author from the copy.
        const copy = rooms ? rooms.find(url) : null;
        if (copy) {
          const ring = ringStore.get(copy.ringId);
          if (!ring || !isMember(ring, me)) return nf;
          const a = actorOf(copy.post.author, origin);
          return a ? { target: copy.post.author, post: url, objects: [a, url] } : nf;
        }
        const post = await f.remotePost(url);
        return post?.handle && post.actor ? { target: post.handle, post: post.obj.id || url, objects: [post.actor, post.obj.id || url] } : nf;
      }
      case 'comment': case 'stamp': {
        const owner = str(b.owner, 64);
        const postId = str(b.post_id, 64);
        const id = str(b.id, 64);
        if (!members.get(owner) || !audience.seeing(owner, postId, me)) return nf;
        const rows = b.kind === 'comment' ? reactions.loadComments(owner) : reactions.loadStamps(owner);
        const row = rows.find((r) => r.id === id && r.post_id === postId);
        if (!row) return nf;
        if (row.author === me) return { status: 400, error: 'own_post' };
        const a = actorOf(row.author, origin);
        if (!a) return nf;
        const post = urls.postUrl(origin, owner, postId);
        const objects = [a, post];
        if (row.object_id && /^https?:\/\//.test(row.object_id)) objects.push(row.object_id);
        // The post it is on, and WHICH comment or stamp, each in its own field
        // (P8 review F1): the admin's removal acts on `ref`, never on `post`.
        return { target: row.author, post, ref: { owner, post_id: postId, id }, objects };
      }
      case 'reply': {
        if (!elsewhere) return nf;
        const row = elsewhere.load(me).find((r) => r.id === str(b.id, 64));
        if (!row) return nf;
        const a = actorOf(row.author, origin);
        if (!a) return nf;
        return { target: row.author, objects: [a, ...(row.url && /^https?:\/\//.test(row.url) ? [row.url] : [])] };
      }
      default:
        return { status: 400, error: 'bad_request' };
    }
  }

  router.post('/api/reports', auth.requireMember, noStore, limits.limit('reports', { perMinute: 5, perDay: 30 }), wrap(async (req, res) => {
    const b = req.body || {};
    if (!KINDS.has(b.kind)) return fail(res, 400, 'bad_request');
    if (b.comment !== undefined && typeof b.comment !== 'string') return fail(res, 400, 'bad_request');
    const origin = urls.originOf(req, cfg);
    const me = req.member.slug;
    const r = await resolve(me, b, origin);
    if (r.error) return fail(res, r.status, r.error);
    // ── tick ──
    if (!ctx.stillMember(req)) return fail(res, 401, 'not_signed_in');
    const row = moderate.report({ from: me, kind: b.kind, target: r.target, post: r.post || '', ref: r.ref || null, objects: r.objects, comment: b.comment || '', forward: b.forward === true, origin });
    if (!row) return fail(res, 503, 'reports_full');
    res.status(201).json({ id: row.id, forwarded: row.forwarded === true });
  }));

  return router;
};
