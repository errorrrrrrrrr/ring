'use strict';
/* ── The member export (spec 12, 11.1) ────────────────────────────────────────
 *   GET  /api/me/export                     the export zip, never the key
 *   POST /api/me/export { password, key }   the same; with `key: true` and the
 *                                           password typed again, plus the
 *                                           signing key (`key.pem`)
 *
 * One STANDARD .zip, streamed (lib/zip.js), everything inside one folder named
 * `ring-<name>-<date>/`:
 *   README.txt      what each file is
 *   manifest.json   who, where from, when, counts, and every file's size and
 *                   SHA-256 (the key's too, when it is there)
 *   posts.json      every post, archive included, with its id, its derived URL
 *                   and the image file it shows
 *   settings.json   display name and the page store's settings: the switches,
 *                   theme, bio, avatar, links, blocked people and domains
 *   profile.json    the actor document as other servers read it
 *   friends.csv     confirmed friends    } Mastodon's follow-import format:
 *   following.csv   accepted follows     } `Account address,Show boosts,
 *                                        }  Notify on new posts,Languages`
 *   followers.csv   accepted followers, one `Account address` column (a
 *                   record, not a list to follow)
 *   images/<key>.<ext>  the stored original of every image the page names
 *                   (post images, link images, avatar, theme background), the
 *                   member's own only. An image whose original file is gone is
 *                   listed in the manifest's `missing`, never dropped silently,
 *                   and the export still answers 200.
 *   key.pem         ONLY on the POST with `key: true` and the right password
 * A handle of this server is written `name@<host>` everywhere (the lists and
 * `settings.blocked`), so every list reads the same on any server.
 *
 * The manifest is written LAST, from what the writer read: each image is read
 * once (lib/zip.js), and its SHA-256 is the hash of the bytes that went out.
 *
 * Bounds: the GET is refused to another site (Sec-Fetch-Site `cross-site`, or
 * a foreign Origin: 403 `csrf`) BEFORE the budget, so a third-party page
 * cannot spend a member's exports; the export budget (3 a minute, 20 a day per
 * member); EXPORT_MAX_ACTIVE (2) exports streaming at once on the whole server,
 * past it 503 `export_busy` with Retry-After; an answer whose reader stops
 * reading for EXPORT_IDLE_MS (60 s) is cut; a size cap (EXPORT_MAX_BYTES,
 * 2 GiB; 413 `export_too_large` before a byte is sent), well under the classic
 * zip's 4 GB. The key form checks the password through the bcrypt queue, then
 * in its own tick that the row and this session are still current (409
 * `password_changed`), as account deletion does; from there to the first byte
 * there is no await. The audit line says an export happened and whether it
 * carried the key, nothing more.
 */
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../lib/clock');
const A = require('../lib/activities');
const urls = require('../lib/urls');
const { fail, wrap, foreignRequest } = require('../lib/http');
const { verifyPassword } = require('../lib/auth');
const { pageImageKeys } = require('../lib/ring');
const { pipeline } = require('node:stream');
const { createZipStream } = require('../lib/zip');

const EXPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const EXPORT_MAX_ACTIVE = 2;
const EXPORT_IDLE_MS = 60_000;
const BUSY_RETRY_S = 30;
const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };
const MASTODON_HEADER = 'Account address,Show boosts,Notify on new posts,Languages';
const KEY_WARNING = 'Anyone with this file can sign as you until the server rotates your key. Keep it like a password.';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = function exportRoutes(ctx) {
  const { cfg, paths, members, pages, images, follows, keys, auth, limits, audit, logger } = ctx;
  const router = express.Router();
  const budget = limits.limit('export', { perMinute: 3, perDay: 20 });
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  /* Another site's request never reaches the budget (a top-level cross-site
   * GET carries the Lax cookie). Same-site and same-origin pass. */
  const ownSite = (req, res, next) => (foreignRequest(req, cfg) ? fail(res, 403, 'csrf') : next());

  /* The server-wide count of exports streaming now (spec 12). */
  let active = 0;
  ctx.exportsActive = () => active;
  const maxActive = () => ctx.exportMaxActive ?? EXPORT_MAX_ACTIVE;
  const busy = (res) => {
    res.set('Retry-After', String(BUSY_RETRY_S));
    return fail(res, 503, 'export_busy');
  };
  const notBusy = (req, res, next) => (active >= maxActive() ? busy(res) : next());

  /* Still the row the password was checked against, and still a live session? */
  const stillCurrent = (req, m) => {
    const fresh = members.get(m.slug);
    if (fresh?.status !== 'active' || fresh.password_hash !== m.password_hash) return false;
    const cutoff = fresh.sessions_from ? Date.parse(fresh.sessions_from) : 0;
    return (Number(req.session?.at) || 0) >= cutoff;
  };

  /* Everything the zip holds, built in one tick (no await): a consistent read. */
  function build(name, origin, withKey) {
    const member = members.get(name);
    const store = pages.load(name);
    const host = urls.hostOf(origin);
    const address = (h) => (String(h).includes('@') ? h : `${h}@${host}`);
    const day = clock.iso().slice(0, 10);
    const root = `ring-${name}-${day}`;
    const mtime = clock.now() / 1000;
    const entries = [];
    const files = {};
    const add = (rel, data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      files[rel] = { bytes: buf.length, sha256: sha256(buf) };
      entries.push({ name: `${root}/${rel}`, size: buf.length, data: buf, mtime });
    };
    const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

    // The images: the stored originals of the keys the page names, the member's own.
    // An original that is gone is listed in the manifest, never dropped silently.
    const imageFile = new Map();
    const imageEntries = [];
    const missing = [];
    for (const key of pageImageKeys(store)) {
      const row = images.row(key);
      if (!row || row.owner !== name) continue;
      const file = path.join(paths.imagesDir, key);
      const rel = `images/${key}.${EXT[row.source] || 'img'}`;
      let st;
      try { st = fs.statSync(file); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        st = null;
      }
      if (!st?.isFile()) { missing.push({ key, file: rel }); continue; }
      imageFile.set(key, rel);
      imageEntries.push({ rel, file, size: st.size, key });
    }

    const posts = store.posts.map((p) => {
      const out = { ...p, url: urls.postUrl(origin, name, p.id) };
      const k = (p.kind === 'image' || p.kind === 'link') && p.media?.key;
      if (k && imageFile.has(k)) out.image_file = imageFile.get(k);
      return out;
    });
    const settings = {
      display_name: member.display_name,
      enabled: store.enabled, indexable: store.indexable, open_follows: store.open_follows,
      stamps_off: store.stamps_off, comments_off: store.comments_off,
      theme: { ...store.theme, ...(imageFile.has(store.theme.bg_image_key) ? { bg_image_file: imageFile.get(store.theme.bg_image_key) } : {}) },
      bio: store.bio,
      avatar_key: store.avatar_key,
      ...(imageFile.has(store.avatar_key) ? { avatar_file: imageFile.get(store.avatar_key) } : {}),
      links: store.links,
      blocked: store.blocked.map(address),
      blocked_domains: store.blocked_domains,
    };
    const f = follows.load(name);
    const friends = follows.friendHandles(name).map(address);
    const following = f.following.filter((r) => r.state === 'accepted').map((r) => address(r.handle));
    const followers = f.followers.filter((r) => r.state === 'accepted').map((r) => address(r.handle));
    const mastodon = (list) => `${[MASTODON_HEADER, ...list.map((a) => `${a},true,false,`)].join('\n')}\n`;
    const profile = A.personDoc({ origin, member, store, publicKeyPem: keys.publicKeyPem(name) });

    add('README.txt', [
      `Your Ring export: ${address(name)}, ${clock.iso()}.`,
      '',
      'posts.json      every post, the archive included, with its id and URL',
      'settings.json   your display name and page settings',
      'profile.json    your profile as other servers read it',
      'friends.csv     your friends (Mastodon can import it as follows)',
      'following.csv   who you follow (Mastodon\'s follow-import format)',
      'followers.csv   who follows you',
      'images/         the originals of the images your page shows',
      ...(withKey ? ['key.pem         your signing key. ' + KEY_WARNING] : []),
      'manifest.json   the size and SHA-256 of every file here, and any image whose original was missing',
      '',
    ].join('\n'));
    add('posts.json', json(posts));
    add('settings.json', json(settings));
    add('profile.json', json(profile));
    add('friends.csv', mastodon(friends));
    add('following.csv', mastodon(following));
    add('followers.csv', `${['Account address', ...followers].join('\n')}\n`);
    if (withKey) add('key.pem', keys.exportPem(name));

    let bytes = entries.reduce((n, e) => n + e.size, 0);
    for (const im of imageEntries) {
      files[im.rel] = { bytes: im.size, sha256: '' };   // filled by the writer, from the bytes that go out
      bytes += im.size;
    }
    const manifest = {
      format: 'ring-export',
      version: 1,
      name,
      handle: address(name),
      actor: urls.actorUrl(origin, name),
      exported_at: clock.iso(),
      key: withKey,
      counts: { posts: posts.length, images: imageEntries.length, friends: friends.length, following: following.length, followers: followers.length },
      files,
      missing,
    };
    return { root, entries, imageEntries, manifest, bytes, mtime, day };
  }

  /* No await from the plan to the first byte: the checks made before the call
   * (the session, the key form's tick) still hold when the zip starts. */
  function send(req, res, withKey) {
    const name = req.member.slug;
    if (!ctx.stillMember(req)) return fail(res, 401, 'not_signed_in');
    if (active >= maxActive()) return busy(res);
    const origin = urls.originOf(req, cfg);
    const plan = build(name, origin, withKey);
    const cap = ctx.exportMaxBytes ?? EXPORT_MAX_BYTES;
    if (plan.bytes > cap) return fail(res, 413, 'export_too_large', { mb: Math.round(cap / 1048576) });
    const { manifest } = plan;
    const relOf = new Map(plan.imageEntries.map((im) => [im.file, im.rel]));
    const hooks = {
      onFile: ({ entry, sha256: hash }) => { manifest.files[relOf.get(entry.path)].sha256 = hash; },
      onMissing: (entry) => {
        const rel = relOf.get(entry.path);
        delete manifest.files[rel];
        manifest.missing.push({ key: path.basename(entry.path), file: rel });
        manifest.counts.images--;
      },
    };
    const entries = [
      ...plan.entries,
      ...plan.imageEntries.map((im) => ({ name: `${plan.root}/${im.rel}`, size: im.size, path: im.file, mtime: plan.mtime, optional: true })),
      { name: `${plan.root}/manifest.json`, data: () => Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mtime: plan.mtime },
    ];
    audit('member.exported', name, { key: withKey, images: plan.imageEntries.length, missing: plan.manifest.missing.length });
    active++;
    let counted = true;
    res.on('close', () => { if (counted) { counted = false; active--; } });
    res.status(200);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${plan.root}.zip"`);
    const zip = createZipStream(entries, hooks);
    // A reader that stops reading holds a slot: cut it after the idle bound.
    res.setTimeout(ctx.exportIdleMs ?? EXPORT_IDLE_MS, () => { zip.destroy(); res.destroy(); });
    pipeline(zip, res, (e) => {
      if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.error(`[export] ${name}: ${e.message}`);
    });
  }

  router.get('/api/me/export', auth.requireMember, noStore, ownSite, notBusy, budget, wrap((req, res) => send(req, res, false)));

  router.post('/api/me/export', auth.requireMember, noStore, notBusy, budget, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.key !== undefined && typeof b.key !== 'boolean') return fail(res, 400, 'invalid_field');
    if (b.key !== true) return send(req, res, false);
    const m = members.get(req.member.slug);
    if (typeof b.password !== 'string' || !(await verifyPassword(b.password, m.password_hash))) return fail(res, 403, 'wrong_password');
    // ── tick ──
    if (!stillCurrent(req, m)) return fail(res, 409, 'password_changed');
    return send(req, res, true);
  }));

  return router;
};

module.exports.EXPORT_MAX_BYTES = EXPORT_MAX_BYTES;
module.exports.EXPORT_MAX_ACTIVE = EXPORT_MAX_ACTIVE;
module.exports.EXPORT_IDLE_MS = EXPORT_IDLE_MS;
module.exports.KEY_WARNING = KEY_WARNING;
