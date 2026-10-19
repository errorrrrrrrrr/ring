'use strict';
/* ── The member's wall, /@name, and its feed, /@name.rss (spec 8.3, 8.4, 10.2, 13.2) ──
 *   GET /@name       a server-rendered shell: the head (title, description,
 *                    canonical, og:*, the RSS alternate), the owner's name tag
 *                    with avatar, bio and `rel="me"` links, and /assets/page.js,
 *                    which fetches GET /api/pages/:name and lays out the wall.
 *   GET /@name.rss   RSS 2.0 of the 20 newest public posts (spec 8.3).
 *
 * WHY THE WALL FETCHES ITS DATA instead of carrying it in a
 * `<script type="application/json">` block (which `script-src 'self'` would
 * allow, a data block never runs): GET /api/pages/:name is already THE door to a
 * wall, and keeping it the only one keeps four rules in one place: the odometer
 * counts an anonymous read there and only there (a crawler that never runs the
 * script is not a visitor), the blocked viewer's shut view is built there, the
 * read budget is spent there, and the serialized body is memoized there. The
 * shell renders only what must work without a script: the head tags and the
 * `rel="me"` links (a Mastodon server verifies those from the raw HTML).
 *
 * THE ABSENT PAGE (spec 10.2): an unknown name, a suspended member, a page that
 * is OFF and a malformed name all answer the site's one 404 page
 * (routes/site.js notFoundPage + sendPage): the same status, body and headers,
 * the author included, so nothing tells a switched-off page from a name never
 * taken. No og tag, no Link header, no odometer on that path. The RSS feed's
 * absent answer is the same page.
 *
 * PER VIEWER, NEVER A LEAK: the shell carries the signed-in viewer's own handle
 * and their friendship with the owner (none, pending, asked, friends, self), so
 * the befriend sticker and the stamp tiers need no second request. The owner's
 * own wall is the public wall plus an "edit in the app" link; nothing private
 * (posts in rooms, the archive, page settings) is read here at all, only the
 * projection (lib/projection.js). `Cache-Control: private, no-cache`.
 *
 * Indexing: `noindex` (header and meta) unless the page is `indexable`.
 * Reads spend 60 a minute, 5000 a day per client (the wall-read budget, 10.7),
 * the HTML and the feed each their own bucket.
 *
 * FEDERATION=on (P5): an ActivityPub Accept on `/@name` (activity+json or
 * ld+json) is redirected to the actor `/users/name` before the HTML branch, for
 * an active member (a page that is off included: the actor stays, spec 2.2), and
 * the head carries the `application/activity+json` alternate. Off, neither: the
 * actor does not answer, so nothing points at it. `Vary: Accept`.
 */
const fs = require('node:fs');
const express = require('express');
const { t } = require('../lib/strings');
const { escapeHtml } = require('../lib/security');
const { validName } = require('../lib/handles');
const urls = require('../lib/urls');
const { wantsAp } = require('../lib/http');
const { notFoundPage, sendPage } = require('./site');

const e = escapeHtml;

/* A wall path: `/@name` or `/@name.rss`, decoded, or null. A malformed escape
 * names nothing that exists. */
function wallTarget(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/@')) return null;
  let rest;
  try { rest = decodeURIComponent(rawPath.slice(2)); } catch { return { name: '', rss: false }; }
  const rss = rest.endsWith('.rss');
  return { name: rss ? rest.slice(0, -4) : rest, rss };
}

/* Plain text from the bio's inline markdown, for a meta description. */
function plainText(s, max = 200) {
  const flat = String(s || '')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufffe\uffff]/g, ' ')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

// ── RSS ──

/* XML text: escaped, and stripped of what XML 1.0 cannot carry at all (C0
 * controls but tab and newlines, U+FFFE/U+FFFF, lone surrogates), so a note with
 * a stray control character never breaks the feed. */
function xmlText(s) {
  return escapeHtml(String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ''));
}

/* Site-relative hrefs in our own rendered markup, made absolute (a feed reader
 * has no page to resolve them against). Our renderer emits `href="..."` with
 * the value escaped, so a quote can never sit inside one. */
const absolutize = (html, origin) => String(html || '').replace(/(\s(?:href|src))="\/(?!\/)/g, `$1="${origin}/`);

/* The first line of a note's text, for an item title. */
const firstLine = (md) => plainText(String(md || '').split(/\r?\n/).find((l) => l.trim()) || '', 120).replace(/^#+\s*/, '');

function itemOf(p, stored, origin, name, images) {
  const abs = (path) => (path ? `${origin}${path}` : '');
  const parts = [];
  let title = '';
  let enclosure = '';
  if (p.kind === 'note') {
    parts.push(p.html);
    title = firstLine(stored?.note);
  } else if (p.kind === 'image') {
    parts.push(`<p><img src="${e(abs(p.image_url))}" alt="${e(p.alt || '')}"${p.width ? ` width="${Number(p.width)}" height="${Number(p.height)}"` : ''}></p>`);
    if (p.note_html) parts.push(p.note_html);
    if (p.href) parts.push(`<p><a href="${e(p.href)}">${e(p.href)}</a></p>`);
    title = firstLine(stored?.note) || plainText(p.alt, 120);
    const f = images.variantFile(p.image_key, 'web');
    let length = 0;
    try { length = f ? fs.statSync(f).size : 0; } catch { length = 0; }
    enclosure = `<enclosure url="${xmlText(abs(p.image_url))}" length="${length}" type="image/webp"/>`;
  } else if (p.kind === 'link') {
    if (p.image_url) parts.push(`<p><img src="${e(abs(p.image_url))}" alt=""></p>`);
    parts.push(p.href ? `<p><a href="${e(p.href)}">${e(p.label)}</a></p>` : `<p><strong>${e(p.label)}</strong></p>`);
    if (p.sub) parts.push(`<p>${e(p.sub)}</p>`);
    if (p.note_html) parts.push(p.note_html);
    title = plainText(p.label, 120);
  } else if (p.kind === 'embed') {
    if (p.note_html) parts.push(p.note_html);
    parts.push(`<p><a href="${e(p.page)}">${e(p.page)}</a></p>`);
    title = firstLine(stored?.note) || p.page;
  } else {
    return '';   // dividers are wall furniture, never an item
  }
  if (p.kaomoji) parts.push(`<p>${e(p.kaomoji)}</p>`);
  if (p.cw) title = p.cw;
  const link = urls.wallAnchor(origin, name, p.id);
  const at = Date.parse(p.created_at);
  return [
    '<item>',
    `<title>${xmlText(title || t('page.wall.rss_untitled'))}</title>`,
    `<link>${xmlText(link)}</link>`,
    `<guid isPermaLink="false">${xmlText(p.url)}</guid>`,
    Number.isFinite(at) ? `<pubDate>${new Date(at).toUTCString()}</pubDate>` : '',
    `<description>${xmlText(absolutize(parts.filter(Boolean).join('\n'), origin))}</description>`,
    enclosure,
    '</item>',
  ].filter(Boolean).join('\n');
}

const RSS_ITEMS = 20;

function rssOf(view, store, origin, images) {
  const name = view.name;
  const byId = new Map(store.posts.map((p) => [p.id, p]));
  const newest = view.posts
    .filter((p) => p.kind !== 'divider')
    .slice()
    .sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1))
    .slice(0, RSS_ITEMS);
  const self = `${urls.pageUrl(origin, name)}.rss`;
  const built = newest.find((p) => Number.isFinite(Date.parse(p.created_at)));
  const desc = plainText(view.bio, 500) || t('page.wall.description', { name: view.display_name || name });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${xmlText(view.display_name || name)}</title>`,
    `<link>${xmlText(view.page_url)}</link>`,
    `<description>${xmlText(desc)}</description>`,
    `<atom:link href="${xmlText(self)}" rel="self" type="application/rss+xml"/>`,
    '<generator>Ring</generator>',
    built ? `<lastBuildDate>${new Date(Date.parse(built.created_at)).toUTCString()}</lastBuildDate>` : '',
    view.avatar ? `<image><url>${xmlText(origin + view.avatar.url)}</url><title>${xmlText(view.display_name || name)}</title><link>${xmlText(view.page_url)}</link></image>` : '',
    ...newest.map((p) => itemOf(p, byId.get(p.id), origin, name, images)),
    '</channel>',
    '</rss>',
    '',
  ].filter((l) => l !== '').join('\n');
}

// ── The HTML shell ──

function wallHtml({ view, origin, host, viewer, relation, federation = false }) {
  const name = view.name;
  const display = view.display_name || name;
  const handle = `@${name}@${host}`;
  const desc = plainText(view.bio) || t('page.wall.description', { name: display });
  const canonical = view.page_url;
  const rss = `/@${encodeURIComponent(name)}.rss`;
  const own = viewer && viewer === name;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    view.indexable ? '' : '<meta name="robots" content="noindex">',
    `<title>${e(t('page.wall.title', { name: display, handle: `@${name}` }))}</title>`,
    `<meta name="description" content="${e(desc)}">`,
    `<link rel="canonical" href="${e(canonical)}">`,
    `<link rel="alternate" type="application/rss+xml" title="${e(t('page.wall.rss_title', { name: display }))}" href="${e(rss)}">`,
    federation ? `<link rel="alternate" type="application/activity+json" href="${e(view.actor)}">` : '',
    '<meta property="og:type" content="profile">',
    `<meta property="og:title" content="${e(display)}">`,
    `<meta property="og:description" content="${e(desc)}">`,
    `<meta property="og:url" content="${e(canonical)}">`,
    `<meta property="og:site_name" content="${e(host)}">`,
    `<meta property="profile:username" content="${e(name)}">`,
    view.avatar ? `<meta property="og:image" content="${e(origin + view.avatar.url)}">` : '',
    '<link rel="stylesheet" href="/assets/page.css">',
    '<script src="/assets/page.js" defer></script>',
  ].filter(Boolean).join('\n');

  const avatar = view.avatar
    ? `<img class="wall-avatar" src="${e(view.avatar.thumb_url)}" alt="${e(t('page.wall.avatar_alt', { name: display }))}" width="96" height="96">`
    : '';
  const links = view.links.length
    ? `<ul class="wall-links">${view.links.map((l) => `<li><a href="${e(l.href)}" rel="me nofollow noopener">${e(l.label || l.href)}</a></li>`).join('')}</ul>`
    : '';
  const corner = own
    ? `<a class="wall-corner wall-edit" href="/app">${e(t('page.wall.edit'))}</a>`
    : '';   // the befriend sticker is page.js's (it answers the click)
  return `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body class="wall-page">
<div id="wall" class="wall" data-name="${e(name)}" data-viewer="${e(viewer || '')}" data-relation="${e(relation)}"${federation ? ` data-fed="1" data-actor="${e(view.actor)}"` : ''}>
${corner}
<header class="wall-head">
${avatar}
<h1 class="wall-nametag"><small>${e(t('page.wall.hello'))}</small> <span class="wall-display">${e(display)}</span></h1>
<p class="wall-handle">${e(handle)}</p>
${view.bio_html ? `<div class="wall-bio">${view.bio_html}</div>` : ''}
${links}
</header>
<div id="wall-board" class="log-wall"><p class="pg-empty" id="wall-loading">${e(t('page.wall.loading'))}</p></div>
<noscript><p class="pg-empty">${e(t('page.wall.noscript'))} <a href="${e(rss)}">${e(t('page.wall.rss'))}</a></p></noscript>
<p id="wall-status" class="wall-status" role="status" aria-live="polite"></p>
<div id="wall-remote" class="wall-remote" hidden></div>
<footer class="log-end">
<div id="wall-odometer" class="log-odometer"></div>
<p class="log-madewith"><a href="/">${e(t('page.wall.made_with', { host }))}</a> · <a href="${e(rss)}">${e(t('page.wall.rss'))}</a></p>
</footer>
</div>
</body>
</html>
`;
}

module.exports = function wallRoutes(ctx) {
  const { cfg, projection, pages, follows, limits, images, members } = ctx;
  const router = express.Router();
  const htmlLimit = limits.limit('wall', { perMinute: 60, perDay: 5000 });
  const rssLimit = limits.limit('rss', { perMinute: 60, perDay: 5000 });
  const absent = (res) => sendPage(res, 404, notFoundPage());

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const target = wallTarget(req.path);
    if (!target) return next();
    (target.rss ? rssLimit : htmlLimit)(req, res, () => {
      const origin = urls.originOf(req, cfg);
      if (cfg.federation && !target.rss) {
        res.set('Vary', 'Accept');
        if (wantsAp(req)) {
          if (!validName(target.name) || members.get(target.name)?.status !== 'active') return absent(res);
          return res.redirect(302, urls.actorUrl(origin, target.name));
        }
      }
      const view = validName(target.name) ? projection.get(target.name, origin) : null;
      if (!view) return absent(res);
      const host = urls.hostOf(origin);
      const rssPath = `/@${encodeURIComponent(view.name)}.rss`;
      if (!view.indexable) res.set('X-Robots-Tag', 'noindex');

      if (target.rss) {
        res.status(200).type('application/rss+xml; charset=utf-8');
        res.set('Cache-Control', 'public, no-cache');   // revalidated: a page switched off is gone at once
        res.set('Access-Control-Allow-Origin', '*');
        return res.send(rssOf(view, pages.load(view.name), origin, images));
      }

      const viewer = req.member?.slug || '';
      let relation = '';
      if (viewer === view.name) relation = 'self';
      else if (viewer) {
        const s = follows.status(viewer, view.name);
        relation = s.status === 'pending' ? (s.direction === 'in' ? 'asked' : 'pending') : s.status;
      }
      res.status(200).type('html');
      res.set('Cache-Control', 'private, no-cache');
      res.set('Link', `<${rssPath}>; rel="alternate"; type="application/rss+xml"`);
      res.send(wallHtml({ view, origin, host, viewer, relation, federation: cfg.federation }));
    });
  });

  return router;
};

module.exports.wallTarget = wallTarget;
module.exports.xmlText = xmlText;
