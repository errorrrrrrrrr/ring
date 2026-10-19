'use strict';
/* ── The public projection, memoized (spec 3.9, 10.1, 10.2) ───────────────────
 * THE one answer to "what does this member show the world": their page when it
 * is ON and they are active, else nothing. `GET /api/pages/:name`, the image gate
 * (lib/images.js keys it lists are the only ones a stranger may fetch) and, from
 * P2 on, the square and the Friends feed all read through here, so a page switch
 * or a post audience cannot be honoured in one place and missed in another.
 *
 * Only the `public` audience travels; pinned first, then newest; every text is
 * rendered by lib/ring.js or is a plain string the client escapes; every URL and
 * embed validated. A post carries `cw`, `url` (the derived object URL),
 * `note_html` on every kind that carries a note, and a link post its image and
 * `sub`.
 *
 * Memoized per (member, origin) and dropped whenever the member's page store,
 * member row, follows or reactions are written (each store's onWrite). P2 adds to
 * each post its stamps and comments (lib/reactions.js decorate: a blocked
 * author's rows never show, whatever is on disk) and the effective switches, and
 * to the wall its friends `{ name, handle, url }`. A wall also SHOWS other
 * members' names and stamp tints: the projection records, per signer, the
 * signature it used (name, tint, status) and WHICH walls used it. A write that
 * changes a member's signature (a display name, a theme background, a deletion)
 * drops exactly those walls; one that leaves it as it was (any other theme or
 * page setting, a post) drops none but their own. Settings writes are rate
 * limited as well (60 a minute, routes/me.js).
 * `null` is the answer for an unknown, suspended or switched-off page: callers
 * turn it into the same 404 as an unknown name (spec 10.2).
 *
 * Cost (robustness-r1-07): a rendered post is cached by its content (and origin),
 * so a write re-renders only what changed, never the other 499 notes. The image
 * gate asks publicImageKeys(), which is computed WITHOUT rendering, once per
 * member (not per origin), and dropped with the rest.
 */
const crypto = require('node:crypto');
const { renderRingMarkdown, renderInline, ringResolveEmbed, ringSafeHref, postImageKey } = require('./ring');
const urls = require('./urls');

function createProjection({ members, pages, images, reactions, follows, describeRemote = null }) {
  const sigs = new Map();   // handle -> { sig, walls: Set of memo keys that rendered it }
  const recorder = (wallKey) => (handle, sig) => {
    const e = sigs.get(handle);
    if (e && e.sig === sig) e.walls.add(wallKey);
    else sigs.set(handle, { sig, walls: new Set([...(e?.walls || []), wallKey]) });
  };
  const memo = new Map();   // `${slug}\n${origin}` -> view
  const keysMemo = new Map();   // slug -> Set of public image keys
  const postMemo = new Map();   // `${origin}\n${digest of the stored post}` -> view (or null)
  const MAX_POST_MEMO = 20_000;

  const imgUrls = (key) => (key ? { image_key: key, image_url: urls.imagePath(key, 'web'), thumb_url: urls.imagePath(key, 'thumb') } : {});

  function postView(p, origin, name) {
    const base = {
      id: p.id,
      kind: p.kind,
      created_at: p.created_at || '',
      audience: 'public',
      url: urls.postUrl(origin, name, p.id),
    };
    if (p.updated_at) base.updated_at = p.updated_at;
    if (p.pinned) base.pinned = true;
    if (p.kaomoji) base.kaomoji = p.kaomoji;
    if (p.cw) base.cw = p.cw;
    if (p.kind !== 'note' && p.note) {
      const html = renderRingMarkdown(p.note);
      if (html) base.note_html = html;
    }
    const m = p.media || {};
    if (p.kind === 'note') {
      const html = renderRingMarkdown(p.note);
      if (!html) return null;
      base.html = html;
    } else if (p.kind === 'image') {
      if (!m.key) return null;
      Object.assign(base, imgUrls(m.key));
      const r = images.row(m.key);
      if (r) { base.width = r.width; base.height = r.height; }
      base.alt = m.alt || '';
      base.href = ringSafeHref(m.href);
    } else if (p.kind === 'link') {
      const href = ringSafeHref(m.href);
      const label = m.label || href;
      if (!label) return null;
      base.href = href;
      base.label = label;
      if (m.sub) base.sub = m.sub;
      if (m.key) Object.assign(base, imgUrls(m.key));
    } else if (p.kind === 'embed') {
      const e = ringResolveEmbed(m.url);
      if (!e) return null;
      base.provider = e.provider;
      base.src = e.src;
      base.media_kind = e.media_kind;
      base.page = e.page;
    } else if (p.kind === 'divider') {
      base.variant = m.variant || 'line';
    } else {
      return null;
    }
    return base;
  }

  function cachedPostView(p, origin, name) {
    const r = p.kind === 'image' && p.media?.key ? images.row(p.media.key) : null;
    const digest = crypto.createHash('sha1').update(JSON.stringify(p)).update(r ? `${r.width}x${r.height}` : '').digest('base64');
    const k = `${origin}\n${name}\n${digest}`;
    if (postMemo.has(k)) return postMemo.get(k);
    const v = postView(p, origin, name);
    if (postMemo.size >= MAX_POST_MEMO) postMemo.clear();
    postMemo.set(k, v);
    return v;
  }

  const sortPosts = (list) => list.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.created_at === b.created_at) return 0;
    if (!a.created_at) return 1;
    if (!b.created_at) return -1;
    return a.created_at < b.created_at ? 1 : -1;
  });

  function build(slug, origin, wallKey) {
    const record = recorder(wallKey);
    const member = members.get(slug);
    if (member?.status !== 'active') return null;
    const store = pages.load(slug);
    if (store.enabled !== true) return null;

    const mine = sortPosts(store.posts.filter((p) => p.audience === 'public'));
    const views = [];
    const imageKeys = new Set();
    for (const p of mine) {
      const v = cachedPostView(p, origin, slug);
      if (!v) continue;
      views.push([v, p]);
      const k = postImageKey(p);
      if (k) imageKeys.add(k);
    }
    const authorOf = reactions.authorResolver(origin, record);
    const deco = reactions.decorate(slug, store, views.map(([v]) => v.id), authorOf);
    // Shared across reads: no caller may edit the cache.
    const posts = views.map(([v, p]) => Object.freeze({
      ...v,
      stamps: deco.get(v.id).stamps,
      comments: deco.get(v.id).comments,
      stamps_off: store.stamps_off === true || p.stamps_off === true,
      comments_off: store.comments_off === true || p.comments_off === true,
    }));
    const friends = [];
    for (const h of follows.friendHandles(slug)) {
      if (h.includes('@')) {
        // A friend on another server (P6): their name and profile from the
        // actor cache, their host shown, so a remote name never passes as local.
        const r = describeRemote ? describeRemote(h) : null;
        if (!r || r.gone) continue;
        record(h, reactions.signatureOf(h));
        friends.push({ name: r.name, handle: h, url: r.url, host: r.host, remote: true });
        continue;
      }
      const m = members.get(h);
      if (m?.status !== 'active') continue;
      record(h, reactions.signatureOf(h));
      friends.push({ name: m.display_name, handle: h, url: urls.pageUrl(origin, h) });
    }
    const theme = { ...store.theme };
    if (theme.bg_image_key) { theme.bg_image_url = urls.imagePath(theme.bg_image_key, 'web'); imageKeys.add(theme.bg_image_key); }
    let avatar = null;
    if (store.avatar_key) {
      avatar = { key: store.avatar_key, url: urls.imagePath(store.avatar_key, 'web'), thumb_url: urls.imagePath(store.avatar_key, 'thumb') };
      imageKeys.add(store.avatar_key);
    }
    return {
      name: slug,
      display_name: member.display_name,
      actor: urls.actorUrl(origin, slug),
      page_url: urls.pageUrl(origin, slug),
      indexable: store.indexable === true,
      stamps_off: store.stamps_off === true,
      comments_off: store.comments_off === true,
      theme,
      bio: store.bio,
      bio_html: store.bio ? renderInline(store.bio) : '',
      avatar,
      links: store.links.map((l) => ({ label: l.label || l.href, href: l.href, rel: 'me nofollow noopener' })),
      posts,
      friends,
      imageKeys,
    };
  }

  const MAX_MEMO = 5000;   // a bound, not a tuning knob: origins vary only in development

  function get(slug, origin = '') {
    const k = `${slug}\n${origin}`;
    if (!memo.has(k)) {
      if (memo.size >= MAX_MEMO) { memo.clear(); sigs.clear(); }
      memo.set(k, build(slug, origin, k));
    }
    return memo.get(k);
  }

  function invalidate(slug) {
    const prefix = `${slug}\n`;
    for (const k of memo.keys()) if (k.startsWith(prefix)) memo.delete(k);
    keysMemo.delete(slug);
    // Other walls show this member's name or tint: a change drops those walls only.
    const e = sigs.get(slug);
    if (e && e.sig !== reactions.signatureOf(slug)) {
      for (const k of e.walls) memo.delete(k);
      sigs.delete(slug);
    }
  }

  /* Would postView() show this post's image? The same conditions, no rendering. */
  function shownKey(p) {
    const k = postImageKey(p);
    if (!k) return '';
    if (p.kind === 'link') {
      const m = p.media || {};
      if (!(m.label || ringSafeHref(m.href))) return '';
    }
    return k;
  }

  /* The keys a stranger may fetch for this member: empty when the page is off.
   * Exactly build()'s imageKeys (test/projection-cost.test.js holds that). */
  function publicImageKeys(slug) {
    if (keysMemo.has(slug)) return keysMemo.get(slug);
    const keys = new Set();
    const member = members.get(slug);
    if (member?.status === 'active') {
      const store = pages.load(slug);
      if (store.enabled === true) {
        for (const p of store.posts) {
          if (p.audience !== 'public') continue;
          const k = shownKey(p);
          if (k) keys.add(k);
        }
        if (store.theme?.bg_image_key) keys.add(store.theme.bg_image_key);
        if (store.avatar_key) keys.add(store.avatar_key);
      }
    }
    if (keysMemo.size >= MAX_MEMO) keysMemo.clear();
    keysMemo.set(slug, keys);
    return keys;
  }

  return { get, invalidate, publicImageKeys, postView, viewOf: cachedPostView, size: () => memo.size };
}

module.exports = { createProjection };
