'use strict';
/* ── A wall of this server, as data: GET /api/pages/:name (spec 11.1, 10.2) ───
 * Public. Reads the memoized projection (lib/projection.js): an unknown name, a
 * suspended member and a page that is OFF answer the SAME 404, `noindex`, for
 * everyone, the author included (they read their own store at /api/me/page).
 *
 * The payload: name, display name, actor and page URLs, theme, bio, avatar, links
 * (rel="me"), the public posts (pinned first, then newest) each with its stamps,
 * comments and effective switches (a blocked author's rows never show), the
 * palette, the confirmed friends `{ name, handle, url }`, and the odometer, which
 * counts anonymous reads only. All of it is the projection's (lib/projection.js),
 * dropped on every write that changes it.
 *
 * A signed-in viewer the owner BLOCKS reads the same wall with every switch shut
 * (stamps_off, comments_off): what their stamp or comment would be answered
 * anyway (403 stamps_closed), so the wall never says open to a door that is shut
 * for them. Built per read for that viewer only, never memoized.
 *
 * Cost (robustness-r1-07): a full wall is megabytes of JSON, so the serialized
 * body is memoized with the projection (a WeakMap on the view object, which the
 * projection replaces on every write) and only the odometer is spliced in per
 * read. Reads are limited to 60 a minute per IP (per member when signed in).
 */
const express = require('express');
const { fail } = require('../lib/http');
const { validName } = require('../lib/handles');
const { STAMP_STYLES } = require('../lib/palette');
const { blocksHandle } = require('../lib/ring');
const urls = require('../lib/urls');

module.exports = function pageRoutes(ctx) {
  const { cfg, projection, visits, limits, pages } = ctx;
  const router = express.Router();
  const serialized = new WeakMap();   // view -> the JSON body minus its closing `,"visits":n}`

  function bodyOf(view, name) {
    let s = serialized.get(view);
    if (s === undefined) {
      const pub = { ...view };
      delete pub.imageKeys;   // the gate's list, never served
      s = JSON.stringify({
        ...pub,
        handle: name,
        palette: STAMP_STYLES,
      }).slice(0, -1);
      serialized.set(view, s);
    }
    return s;
  }

  router.get('/api/pages/:name', limits.limit('pageview', { perMinute: 60, perDay: 5000 }), (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    const name = String(req.params.name || '');
    const view = validName(name) ? projection.get(name, urls.originOf(req, cfg)) : null;
    if (!view) {
      res.set('X-Robots-Tag', 'noindex');
      return fail(res, 404, 'not_found');
    }
    if (view.indexable) res.removeHeader('X-Robots-Tag');   // /api is noindex by default
    if (!req.member) visits.bump(name);
    const visitsTail = `,"visits":${Number(visits.count(name)) || 0}}`;
    if (req.member && blocksHandle(pages.settings(name), req.member.slug)) {
      const shut = { ...view, stamps_off: true, comments_off: true, posts: view.posts.map((p) => ({ ...p, stamps_off: true, comments_off: true })) };
      delete shut.imageKeys;
      return res.type('application/json').send(`${JSON.stringify({ ...shut, handle: name, palette: STAMP_STYLES }).slice(0, -1)}${visitsTail}`);
    }
    res.type('application/json').send(`${bodyOf(view, name)}${visitsTail}`);
  });

  return router;
};
