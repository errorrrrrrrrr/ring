/* ── The member's wall, /@name (spec 13.2) ────────────────────────────────────
 * The wall: the chaos, the cards, the friends strip, the stickers, the stamp
 * tray, the notes, the befriend sticker and the odometer. Vanilla JS, `var`,
 * plain DOM, no build.
 *
 * Two halves in one file:
 *   THE CORE (pure, no DOM): the chaos, the stamp tiers, the notes rule, the
 *     theme's style, the age. Each is app/wall.ts's (and app/datetime.ts's)
 *     BYTE FOR BYTE in behaviour, so a card leans the same way on the wall as on
 *     the board and the wall offers exactly the faces the board does. Node
 *     requires this file for that proof (test/wall-parity.test.js); the
 *     browser gets it as `window.RingWall`.
 *   THE WALL (browser only): reads the shell's data-* (the wall's name, the
 *     signed-in viewer, their friendship with the owner), fetches
 *     GET /api/pages/:name and /assets/strings.en.json, lays the wall out, and
 *     answers stamps, notes and the befriend sticker through the app's own JSON
 *     routes. The server is the authority for every rule; this only decides
 *     what to offer.
 *
 * The rules: seeded from the post's OBJECT URL (p.url), not its id; a face is
 * text, always; a `cw` card stays
 * shut until opened; embeds are click-to-play (nothing loads from YouTube,
 * Vimeo or SoundCloud until asked); notes for confirmed friends only; no
 * window.confirm (taking back a note arms first, then goes on the second tap);
 * the theme goes through themeStyle's hex-only and enum-only rules.
 *
 * Every string the script writes is escaped (esc) or set as textContent; the
 * only HTML taken as is is the server's sanitized markdown (lib/ring.js
 * renderRingMarkdown, escape-first). Every URL is checked again here: images
 * from /api/images/ only, frames from the three embed origins only, links
 * http(s), mailto or site-relative only.
 */
(function (root, factory) {
  var core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else {
    root.RingWall = core;
    if (typeof document !== 'undefined') core.start(document, root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ══ THE CORE ══════════════════════════════════════════════════════════════

  // ── The chaos (app/wall.ts wallHash, wallRng, wallChaos, chaosSeed) ──
  function wallHash(s) {
    var h = 2166136261 >>> 0;
    var i;
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function wallRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var WALL_TAPE = ['rgba(150,205,195,.7)', 'rgba(245,196,182,.72)', 'rgba(196,181,253,.68)', 'rgba(253,224,138,.72)', 'rgba(147,197,253,.66)', 'rgba(244,171,196,.68)'];
  var WALL_STICKY = ['#fdf0a8', '#ffd6e0', '#c9f2d4', '#cfe4ff', '#ffe6c7', '#e7dcff'];

  function wallChaos(seed) {
    var r = wallRng(wallHash(seed));
    return {
      tilt: (r() * 7 - 3.5).toFixed(2),
      risoX: (3 + r() * 3).toFixed(1),
      risoY: (4 + r() * 3).toFixed(1),
      tape: WALL_TAPE[Math.floor(r() * WALL_TAPE.length)],
      tapeRot: (r() * 10 - 5).toFixed(1),
      sticky: WALL_STICKY[Math.floor(r() * WALL_STICKY.length)],
      w: Math.round(46 + r() * 32),
      xf: r().toFixed(3),
      mt: Math.round(r() * 40 - 8),
      z: 1 + Math.floor(r() * 9),
      rng: r,
    };
  }

  /* The seed of a card: its object URL (the same on every server), else author and id. */
  function chaosSeed(p) { return p.url || (p.author.handle + ':' + p.id); }

  var DIVIDER_GLYPHS = { line: '───────', dots: '· · · · ·', stars: '✦ ✦ ✦', wave: '∿∿∿∿∿∿' };
  function dividerGlyph(variant) { return DIVIDER_GLYPHS[variant || 'line'] || DIVIDER_GLYPHS.line; }

  // ── Stamp tiers and the notes rule (app/wall.ts stampTier, stampShelf, canComment) ──
  function isRoom(audience) { return typeof audience === 'string' && audience.indexOf('ring_') === 0; }

  function stampTier(p, ctx) {
    if (ctx.archive || p.audience === 'archive' || p.stamps_off) return 'none';
    if (p.author.handle === ctx.viewer) return 'none';
    if (isRoom(p.audience)) return 'full';
    return ctx.friends.has(p.author.handle) ? 'full' : 'nice';
  }

  function stampShelf(palette, p, ctx) {
    var tier = stampTier(p, ctx);
    if (tier === 'none') return { tier: tier, styles: [], custom: false };
    var styles = palette
      .map(function (s) {
        var out = {};
        for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
        out.groups = s.groups.filter(function (g) { return tier === 'full' || g.nice; });
        return out;
      })
      .filter(function (s) { return s.groups.length > 0; });
    return { tier: tier, styles: styles, custom: isRoom(p.audience) };
  }

  function canComment(p, ctx) {
    if (ctx.archive || p.audience === 'archive' || p.comments_off) return false;
    if (p.author.handle === ctx.viewer) return false;
    return ctx.friends.has(p.author.handle);
  }

  // ── The theme (app/wall.ts FONT_STACKS, safeHex, themeStyle: hex only, enums only) ──
  var FONT_STACKS = {
    serif: 'Georgia, "Times New Roman", serif',
    sans: '"Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, Menlo, Consolas, monospace',
    cursive: '"Comic Sans MS", "Comic Neue", cursive',
    fantasy: 'Impact, fantasy',
    system: 'system-ui, sans-serif',
  };

  function safeHex(c) { return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '').trim()) ? String(c).trim() : ''; }

  function themeStyle(theme, imageUrl) {
    var s = {};
    if (!theme) return s;
    var bg = safeHex(theme.bg);
    if (bg) { s.backgroundColor = bg; s.backgroundImage = 'none'; }
    if (theme.bg_image_key) { s.backgroundImage = 'url("' + imageUrl(theme.bg_image_key) + '")'; s.backgroundRepeat = 'repeat'; s.backgroundSize = 'auto'; }
    if (Object.prototype.hasOwnProperty.call(FONT_STACKS, theme.font) && FONT_STACKS[theme.font]) s.fontFamily = FONT_STACKS[theme.font];
    if (/^[a-z]+$/.test(theme.cursor || '')) s.cursor = theme.cursor;
    return s;
  }

  // ── The age (app/datetime.ts fmtAge: today, Nd under three weeks, then Nw) ──
  var DAY = 86400000;
  function fmtAge(iso, now) {
    var t = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return '';
    var ms = (now === undefined ? Date.now() : now) - t;
    if (!(ms >= 0)) return 'today';
    var days = Math.floor(ms / DAY);
    if (days < 1) return 'today';
    if (days < 21) return days + 'd';
    return Math.floor(days / 7) + 'w';
  }

  // ── Escaping and URL checks ──
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /* http(s), mailto, or a site-relative path; anything else is '' (lib/ring.js ringSafeHref). */
  function safeHref(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^mailto:[^\s]+@[^\s]+$/i.test(s)) return s;
    if (/^\/(?!\/)/.test(s)) return s;
    return '';
  }
  /* An image of this server's image door, or ''. */
  function safeImage(u) { return /^\/api\/images\/[A-Za-z0-9_%-]+\/(web|thumb)$/.test(String(u || '')) ? u : ''; }
  var EMBED_ORIGINS = ['https://www.youtube-nocookie.com/', 'https://player.vimeo.com/', 'https://w.soundcloud.com/'];
  function safeFrame(u) {
    var s = String(u || '');
    var i;
    for (i = 0; i < EMBED_ORIGINS.length; i++) if (s.indexOf(EMBED_ORIGINS[i]) === 0) return s;
    return '';
  }
  var TINT_RE = /^#[0-9a-fA-F]{6}$/;

  // ══ THE WALL (browser only) ═══════════════════════════════════════════════

  function start(doc, win) {
    var wallEl = doc.getElementById('wall');
    if (!wallEl) return;
    var board = doc.getElementById('wall-board');
    var statusEl = doc.getElementById('wall-status');
    var odometerEl = doc.getElementById('wall-odometer');
    var NAME = wallEl.getAttribute('data-name') || '';
    var VIEWER = wallEl.getAttribute('data-viewer') || '';
    var relation = wallEl.getAttribute('data-relation') || '';
    // P6: with federation on, a visitor from another server can follow or stamp
    // from THEIR server: they type their handle, the form POSTS it here (same
    // origin, /authorize_interaction/remote), and this server shows the page
    // that names their server and links to its own subscribe template (F4, F9).
    var FED = wallEl.getAttribute('data-fed') === '1';
    var ACTOR = wallEl.getAttribute('data-actor') || '';
    var remoteFor = '';   // the URL the "from your server" form is for
    var enc = encodeURIComponent;

    var S = {};          // the wall's words (/assets/strings.en.json)
    var data = null;     // GET /api/pages/:name
    var friends = new Set();
    var open = { tray: '', note: '', armed: '' };   // which card's tray / note box is open; an armed take-back
    var shown = {};      // post id -> a cw card the viewer opened
    var playing = {};    // post id -> an embed the viewer started
    var activeStyle = 0; // the stamp style tab last used
    var fresh = {};      // post ids that are new to this browser

    function s(key, vars) {
      var v = Object.prototype.hasOwnProperty.call(S, key) ? S[key] : key;
      if (vars) v = v.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] === undefined ? m : String(vars[k]); });
      return v;
    }
    function say(text) { if (statusEl) statusEl.textContent = text || ''; }

    function getJSON(url) {
      return fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
      }, function () { return { ok: false, status: 0, body: null }; });
    }
    function send(method, url, body) {
      var init = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
      if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
      return fetch(url, init).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j || {} }; });
      }, function () { return { ok: false, status: 0, body: {} }; });
    }
    function refused(r) {
      if (r.status === 401) return s('wall.signed_out');
      return (r.body && r.body.message) || s('wall.failed');
    }

    var ctx = function () { return { viewer: VIEWER, friends: friends }; };
    var who = function (author) { return author && author.handle === VIEWER ? s('wall.you') : ((author && author.name) || ''); };
    var postPath = function (p) { return '/api/pages/' + enc(NAME) + '/posts/' + enc(p.id); };
    var findPost = function (id) {
      var i;
      for (i = 0; i < data.posts.length; i++) if (data.posts[i].id === id) return data.posts[i];
      return null;
    };

    // ✷ new is per viewer: a post under three days old that this browser has not
    // seen before blinks once, remembered in localStorage (fails quiet).
    function markFresh(posts) {
      var key = 'ring_seen:' + NAME;
      var seen = [];
      try { seen = JSON.parse(win.localStorage.getItem(key) || '[]') || []; } catch (e) { seen = []; }
      if (!Array.isArray(seen)) seen = [];
      var had = {};
      var i;
      for (i = 0; i < seen.length; i++) had[seen[i]] = 1;
      var add = [];
      posts.forEach(function (p) {
        var t = Date.parse(p.created_at);
        if (!Number.isFinite(t) || Date.now() - t >= 3 * DAY) return;
        if (!had[p.id]) { fresh[p.id] = 1; add.push(p.id); }
      });
      try { win.localStorage.setItem(key, JSON.stringify(seen.concat(add).slice(-400))); } catch (e) { /* private mode */ }
    }

    // ── one card ──

    function stickersHtml(p, c, shelf) {
      var faces = (p.stamps || []).map(function (st) {
        var rot = (c.rng() * 16 - 8).toFixed(1);
        var style = '--s-rot:' + rot + 'deg' + (typeof st.tint === 'string' && TINT_RE.test(st.tint) ? ';background:' + st.tint : '');
        var name = (st.author && st.author.name) || '';
        if (st.author && st.author.handle === VIEWER) {
          return '<button type="button" class="log-sticker log-sticker--mine" style="' + style + '" data-act="unstamp" data-sid="' + esc(st.id) + '"'
            + ' aria-label="' + esc(s('stamp.take_back_aria', { face: st.kaomoji })) + '">' + esc(st.kaomoji)
            + '<span class="log-tip" aria-hidden="true">' + esc(s('stamp.yours')) + '</span></button>';
        }
        var href = safeHref(st.author && st.author.url) || '#';
        return '<a class="log-sticker" style="' + style + '" href="' + esc(href) + '" aria-label="' + esc(s('stamp.from', { face: st.kaomoji, name: name })) + '">'
          + esc(st.kaomoji) + '<span class="log-tip" aria-hidden="true">' + esc(name) + '</span></a>';
      }).join('');
      var add = shelf.tier !== 'none'
        ? '<button type="button" class="log-stamp-add" data-act="tray" aria-expanded="' + (open.tray === p.id) + '" aria-label="' + esc(s('stamp.leave')) + '" title="' + esc(s('stamp.leave')) + '">＋</button>'
        : (!VIEWER && FED && p.url && !p.stamps_off
          ? '<button type="button" class="log-stamp-add" data-act="remote-stamp" aria-label="' + esc(s('remote.stamp')) + '" title="' + esc(s('remote.stamp')) + '">＋</button>'
          : '');
      if (!faces && !add) return '';
      return '<div class="log-stickers">' + faces + add + '</div>';
    }

    function trayHtml(p, shelf) {
      if (shelf.tier === 'none' || open.tray !== p.id) return '';
      var styles = shelf.styles;
      var si = Math.min(activeStyle, styles.length - 1);
      var mine = '';
      (p.stamps || []).forEach(function (st) { if (st.author && st.author.handle === VIEWER && !st.custom) mine = st.kaomoji; });
      var tabs = styles.map(function (st, i) {
        return '<button type="button" role="tab" class="log-stamp-tab' + (i === si ? ' is-active' : '') + '" aria-selected="' + (i === si) + '" data-act="style" data-si="' + i + '">' + esc(st.label || st.style) + '</button>';
      }).join('');
      var faces = [];
      (styles[si] ? styles[si].groups : []).forEach(function (g) { g.faces.forEach(function (f) { faces.push(f); }); });
      var opts = faces.map(function (f) {
        return '<button type="button" class="log-stamp-opt' + (mine === f ? ' is-mine' : '') + '" data-act="press" data-face="' + esc(f) + '" aria-pressed="' + (mine === f) + '"'
          + ' aria-label="' + esc(mine === f ? s('stamp.face_mine', { face: f }) : s('stamp.face', { face: f })) + '">' + esc(f) + '</button>';
      }).join('');
      return '<div class="log-stamp-tray open" role="group" aria-label="' + esc(s('stamp.tray')) + '">'
        + '<div class="log-stamp-tabs" role="tablist" aria-label="' + esc(s('stamp.styles')) + '">' + tabs + '</div>' + opts
        + (shelf.tier === 'nice' ? '<div class="log-tray-note">' + esc(s('stamp.nice_only')) + '</div>' : '')
        + '</div>';
    }

    function commentsHtml(p) {
      var writable = !!VIEWER && canComment(p, ctx());
      var rows = (p.comments || []).map(function (cm) {
        var mine = cm.author && cm.author.handle === VIEWER;
        var armed = open.armed === cm.id;
        return '<div class="log-comment"><a href="' + esc(safeHref(cm.author && cm.author.url) || '#') + '">' + esc(who(cm.author)) + '</a> '
          + '<span>' + esc(cm.body) + '</span>'
          + (mine ? ' <button type="button" class="log-comment-del' + (armed ? ' is-armed' : '') + '" data-act="unnote" data-cid="' + esc(cm.id) + '"'
            + ' aria-label="' + esc(s('card.take_back_note')) + '">' + (armed ? esc(s('card.take_back_note_armed')) : '✕') + '</button>' : '')
          + '</div>';
      }).join('');
      var writer = '';
      if (writable) {
        writer = open.note === p.id
          ? '<div class="log-comment-box open"><input type="text" maxlength="280" placeholder="' + esc(s('card.say_something')) + '"'
            + ' aria-label="' + esc(s('card.note_label', { name: (data && data.display_name) || NAME })) + '">'
            + '<button type="button" data-act="note-send">' + esc(s('card.note_commit')) + '</button></div>'
          : '<button type="button" class="log-comment-pen" data-act="note">' + esc(s('card.leave_note')) + '</button>';
      }
      if (!rows && !writer) return '';
      return '<div class="log-comments">' + rows + writer + '</div>';
    }

    function bodyHtml(p) {
      var html = '';
      var src, size, img, href, thumb, lh, frame, kind;
      if (p.kind === 'note') {
        html += '<div class="log-note-in pg-text">' + (p.html || '') + '</div>';
      } else if (p.kind === 'image') {
        src = safeImage(p.image_url);
        size = p.width && p.height ? ' width="' + Number(p.width) + '" height="' + Number(p.height) + '"' : '';
        img = src ? '<img class="log-photo" src="' + esc(src) + '" alt="' + esc(p.alt || '') + '"' + size + ' loading="lazy">' : '';
        href = safeHref(p.href);
        html += href ? '<a href="' + esc(href) + '" target="_blank" rel="nofollow noopener ugc">' + img + '</a>' : img;
        if (p.note_html) html += '<div class="log-chin"><div class="pg-text">' + p.note_html + '</div></div>';
      } else if (p.kind === 'link') {
        thumb = safeImage(p.thumb_url);
        if (thumb) html += '<img class="log-photo" src="' + esc(thumb) + '" alt="' + esc(p.label || '') + '" loading="lazy">';
        lh = safeHref(p.href);
        html += '<div class="log-chin">'
          + (lh ? '<a class="log-link" href="' + esc(lh) + '" target="_blank" rel="nofollow noopener ugc">→ ' + esc(p.label || lh) + '</a>' : '<strong>' + esc(p.label || '') + '</strong>')
          + (p.sub ? '<span class="log-sub">' + esc(p.sub) + '</span>' : '')
          + '</div>';
        if (p.note_html) html += '<div class="log-chin"><div class="pg-text">' + p.note_html + '</div></div>';
      } else if (p.kind === 'embed') {
        frame = safeFrame(p.src);
        kind = p.media_kind === 'audio' ? 'audio' : 'video';
        if (frame) {
          html += '<div class="pg-embed ' + kind + '">' + (playing[p.id]
            ? '<iframe src="' + esc(frame) + '" title="' + esc(s('card.embed_title', { provider: p.provider || '' })) + '" loading="lazy"'
              + ' allow="encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin"'
              + ' sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>'
            : '<button type="button" class="log-play" data-act="play">▶ ' + esc(s('card.play', { provider: p.provider || '' })) + '</button>')
            + '</div>';
        }
        if (p.note_html) html += '<div class="log-chin"><div class="pg-text">' + p.note_html + '</div></div>';
      }
      if (p.kaomoji) html += '<div class="log-scrawl">' + esc(p.kaomoji) + '</div>';
      return html;
    }

    function cardHtml(p, i) {
      var c = wallChaos(chaosSeed(p));
      if (p.kind === 'divider') {
        return '<div class="log-item log-item--divider" id="' + esc(p.id) + '" data-post-id="' + esc(p.id) + '" style="--tilt:' + c.tilt + 'deg">'
          + '<span class="log-divider-mark" role="separator">' + esc(dividerGlyph(p.variant)) + '</span></div>';
      }
      var isNote = p.kind === 'note';
      // Signed out, a wall is read-only: faces and notes, never a tray (spec 13.2).
      var shelf = VIEWER ? stampShelf(data.palette || [], p, ctx()) : { tier: 'none', styles: [], custom: false };
      var raised = open.tray === p.id || open.note === p.id;
      var scatter = '--w:' + c.w + '%;--xf:' + c.xf + ';--mt:' + (i === 0 ? 6 : c.mt) + 'px;--z:' + (raised ? 40 : c.z);
      var vars = '--tilt:' + c.tilt + 'deg;--riso-x:' + c.risoX + 'px;--riso-y:' + c.risoY + 'px' + (isNote ? ';--sticky:' + c.sticky : '');
      var cls = 'log-card' + (isNote ? ' log-card--note' : p.kind === 'link' ? ' log-card--link' : '');
      var shut = p.cw && !shown[p.id];
      var age = fmtAge(p.created_at);
      return '<article class="log-item' + (raised ? ' is-top' : '') + '" id="' + esc(p.id) + '" data-post-id="' + esc(p.id) + '" style="' + scatter + '">'
        + '<div class="' + cls + '" style="' + vars + '">'
        + '<span class="log-tape" aria-hidden="true" style="--tape-col:' + c.tape + ';--tape-rot:' + c.tapeRot + 'deg"></span>'
        + (fresh[p.id] ? '<span class="log-new">✷ ' + esc(s('wall.new')) + '</span>' : '')
        + (p.pinned ? '<span class="log-nowtag">📌 ' + esc(s('wall.pinned')) + '</span>' : '')
        + (p.cw ? '<button type="button" class="log-cw" data-act="cw" aria-expanded="' + !shut + '"><b>' + esc(s('card.cw')) + '</b> ' + esc(p.cw)
          + ' · ' + esc(shut ? s('card.cw_show') : s('card.cw_hide')) + '</button>' : '')
        + (shut ? '' : bodyHtml(p))
        + (age ? '<div class="log-date" title="' + esc(String(p.created_at).slice(0, 10)) + '">· ' + esc(age) + ' ·</div>' : '')
        + commentsHtml(p)
        + stickersHtml(p, c, shelf)
        + '</div>'
        + trayHtml(p, shelf)
        + '</article>';
    }

    function friendsHtml() {
      var fr = Array.isArray(data.friends) ? data.friends : [];
      if (!fr.length) return '';
      var tags = fr.map(function (f, i) {
        var rot = ((wallHash(f.url || String(i)) % 90) / 10 - 4.5).toFixed(1);
        // A friend on another server shows their host: never mistaken for one here.
        return '<a class="log-friendtag" style="--s-rot:' + rot + 'deg" href="' + esc(safeHref(f.url) || '#') + '"' + (f.remote ? ' rel="nofollow noopener ugc"' : '') + '>'
          + esc(f.name || f.handle || '') + (f.remote && f.host ? ' · ' + esc(f.host) : '') + '</a>';
      }).join('');
      return '<div class="log-item log-friends" style="--w:88%;--xf:.1;--mt:6px;--z:2">'
        + '<span class="log-friends-label">' + esc(s('wall.friends')) + '</span>' + tags + '</div>';
    }

    function befriendHtml() {
      var name = (data && data.display_name) || NAME;
      if (!VIEWER && FED && ACTOR) return '<button type="button" class="wall-corner log-befriend" data-act="remote-follow">' + esc(s('remote.follow')) + '</button>';
      if (!VIEWER || relation === 'self' || !relation) return '';
      if (relation === 'friends') return '<button type="button" class="wall-corner log-befriend" disabled title="' + esc(s('friend.friends_tip', { name: name })) + '">' + esc(s('friend.friends')) + '</button>';
      if (relation === 'pending') return '<button type="button" class="wall-corner log-befriend" disabled title="' + esc(s('friend.pending_tip', { name: name })) + '">' + esc(s('friend.pending')) + '</button>';
      if (relation === 'asked') return '<button type="button" class="wall-corner log-befriend" data-act="befriend" aria-label="' + esc(s('friend.asked_aria', { name: name })) + '">' + esc(s('friend.asked')) + '</button>';
      return '<button type="button" class="wall-corner log-befriend" data-act="befriend" aria-label="' + esc(s('friend.befriend_aria', { name: name })) + '">' + esc(s('friend.befriend')) + '</button>';
    }

    // ── the whole wall ──

    function placeBefriend() {
      var old = wallEl.querySelector('.log-befriend');
      if (old) old.parentNode.removeChild(old);
      var html = befriendHtml();
      if (html) wallEl.insertAdjacentHTML('afterbegin', html);
    }

    function applyTheme() {
      var th = data.theme || {};
      var st = themeStyle(th, function (k) { return '/api/images/' + enc(k) + '/web'; });
      var body = doc.body;
      ['backgroundColor', 'backgroundImage', 'backgroundRepeat', 'backgroundSize', 'fontFamily', 'cursor'].forEach(function (k) { body.style[k] = st[k] || ''; });
      var m, span;
      if (th.marquee) {
        m = doc.createElement('div');
        m.className = 'pg-marquee' + (th.blink ? ' pg-blink' : '');
        span = doc.createElement('span');
        span.textContent = th.marquee;
        m.appendChild(span);
        board.parentNode.insertBefore(m, board);
      }
    }

    function render() {
      if (!data.posts.length) { board.innerHTML = '<p class="pg-empty">' + esc(s('wall.empty')) + '</p>'; return; }
      var cards = data.posts.map(cardHtml);
      var fr = friendsHtml();
      if (fr) cards.splice(Math.min(cards.length, Math.max(1, Math.ceil(cards.length / 3))), 0, fr);
      board.innerHTML = cards.join('');
    }

    /* One card again, in place: a playing embed elsewhere keeps playing. */
    function rerender(id) {
      var p = findPost(id);
      var el = board.querySelector('[data-post-id="' + (win.CSS && win.CSS.escape ? win.CSS.escape(id) : id) + '"]');
      if (!p || !el) return;
      el.outerHTML = cardHtml(p, data.posts.indexOf(p));
    }

    function odometer() {
      if (typeof data.visits !== 'number' || !odometerEl) return;
      odometerEl.innerHTML = '<span>' + esc(String(data.visits).padStart(7, '0')) + '</span>' + esc(s('wall.visitors'));
    }

    // ── the verbs ──

    function press(p, face) {
      send('POST', postPath(p) + '/stamp', { kaomoji: face }).then(function (r) {
        if (!r.ok || !Array.isArray(r.body.stamps)) { say(refused(r)); return; }
        p.stamps = r.body.stamps;
        open.tray = '';
        say('');
        rerender(p.id);
      });
    }
    function unstamp(p, sid) {
      send('DELETE', postPath(p) + '/stamp/' + enc(sid)).then(function (r) {
        if (!r.ok) { say(refused(r)); return; }
        p.stamps = (p.stamps || []).filter(function (x) { return x.id !== sid; });
        say('');
        rerender(p.id);
      });
    }
    function note(p, body) {
      send('POST', postPath(p) + '/comment', { body: body }).then(function (r) {
        if (!r.ok || !Array.isArray(r.body.comments)) { say(refused(r)); return; }
        p.comments = r.body.comments;
        open.note = '';
        say('');
        rerender(p.id);
      });
    }
    function unnote(p, cid) {
      send('DELETE', postPath(p) + '/comment/' + enc(cid)).then(function (r) {
        open.armed = '';
        if (!r.ok) { say(refused(r)); rerender(p.id); return; }
        p.comments = (p.comments || []).filter(function (x) { return x.id !== cid; });
        say('');
        rerender(p.id);
      });
    }
    function befriend(btn) {
      btn.disabled = true;
      var name = (data && data.display_name) || NAME;
      var call = relation === 'asked'
        ? send('POST', '/api/friends/' + enc(NAME) + '/confirm')
        : send('POST', '/api/friends', { handle: NAME });
      call.then(function (r) {
        if (!r.ok) { btn.disabled = false; say(refused(r)); return; }
        var st = r.body.status;
        relation = st === 'friends' ? 'friends' : st === 'pending' ? (r.body.direction === 'in' ? 'asked' : 'pending') : 'none';
        if (relation === 'friends') { friends.add(NAME); say(s('friend.done')); render(); } else say(s('friend.sent', { name: name }));
        placeBefriend();
      });
    }

    /* The "from your server" form (P6): one at a time, for the wall's actor
     * (follow) or one post's URL (stamp). A same-origin form POST (F4): the
     * server refuses one that another site sent. */
    function remoteForm(uri) {
      var el = doc.getElementById('wall-remote');
      if (!el) return;
      remoteFor = uri;
      el.hidden = false;
      el.innerHTML = '<form method="post" action="/authorize_interaction/remote" id="wall-remote-form">'
        + '<input type="hidden" name="uri" value="' + esc(remoteFor) + '">'
        + '<label>' + esc(s('remote.prompt')) + ' <input type="text" name="handle" id="wall-remote-handle" maxlength="330" autocomplete="username" placeholder="name@server"></label>'
        + ' <button type="submit" data-act="remote-go">' + esc(s('remote.go')) + '</button>'
        + ' <button type="button" data-act="remote-cancel">' + esc(s('remote.cancel')) + '</button></form>';
      var inp = doc.getElementById('wall-remote-handle');
      if (inp) inp.focus();
    }
    function remoteClose() {
      var el = doc.getElementById('wall-remote');
      if (el) { el.hidden = true; el.innerHTML = ''; }
    }
    /* The submit's check: a handle-shaped value goes (the form posts itself),
     * anything else stays here with a word. */
    function remoteGo(e) {
      var inp = doc.getElementById('wall-remote-handle');
      var h = inp ? inp.value.trim().replace(/^@/, '') : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(h) && !/^[^@\s]+@(localhost|127\.0\.0\.1)(:\d+)?$/.test(h)) {
        if (e) e.preventDefault();
        say(s('remote.invalid'));
        return;
      }
      if (inp) inp.value = h;
    }

    var closest = function (el, sel) { return el && el.closest ? el.closest(sel) : null; };

    wallEl.addEventListener('click', function (e) {
      var t = closest(e.target, '[data-act]');
      var tip, was, first, prev, input, box, inp, cid;
      var act = t ? t.getAttribute('data-act') : '';
      // Someone else's stamp on a touch screen: the first tap shows WHO, the second follows.
      var sticker = closest(e.target, 'a.log-sticker');
      if (sticker && win.matchMedia && win.matchMedia('(hover: none)').matches && !sticker.classList.contains('tip-open')) {
        e.preventDefault();
        tip = board.querySelector('.log-sticker.tip-open');
        if (tip) tip.classList.remove('tip-open');
        sticker.classList.add('tip-open');
        return;
      }
      if (!act) return;
      if (act === 'befriend') { befriend(t); return; }
      if (act === 'remote-follow') { remoteForm(ACTOR); return; }
      if (act === 'remote-go') { remoteGo(e); return; }
      if (act === 'remote-cancel') { remoteClose(); return; }
      var item = closest(t, '[data-post-id]');
      var p = item && data ? findPost(item.getAttribute('data-post-id')) : null;
      if (!p) return;
      if (act !== 'unnote' && open.armed) open.armed = '';
      if (act === 'cw') { shown[p.id] = !shown[p.id]; rerender(p.id); return; }
      if (act === 'play') { playing[p.id] = true; rerender(p.id); return; }
      if (act === 'remote-stamp') { remoteForm(p.url); return; }
      if (act === 'tray') {
        was = open.tray;
        open.tray = was === p.id ? '' : p.id;
        if (was && was !== p.id) rerender(was);
        rerender(p.id);
        first = board.querySelector('[data-post-id="' + p.id + '"] .log-stamp-opt');
        if (first && open.tray) first.focus();
        return;
      }
      if (act === 'style') { activeStyle = parseInt(t.getAttribute('data-si'), 10) || 0; rerender(p.id); return; }
      if (act === 'press') { press(p, t.getAttribute('data-face')); return; }
      if (act === 'unstamp') { unstamp(p, t.getAttribute('data-sid')); return; }
      if (act === 'note') {
        prev = open.note;
        open.note = p.id;
        if (prev && prev !== p.id) rerender(prev);
        rerender(p.id);
        input = board.querySelector('[data-post-id="' + p.id + '"] .log-comment-box input');
        if (input) input.focus();
        return;
      }
      if (act === 'note-send') {
        box = closest(t, '.log-comment-box');
        inp = box && box.querySelector('input');
        if (inp && inp.value.trim()) note(p, inp.value.trim());
        return;
      }
      if (act === 'unnote') {
        cid = t.getAttribute('data-cid');
        if (open.armed === cid) { unnote(p, cid); return; }
        open.armed = cid;
        rerender(p.id);
        win.setTimeout(function () { if (open.armed === cid) { open.armed = ''; rerender(p.id); } }, 4000);
      }
    });

    wallEl.addEventListener('keydown', function (e) {
      if (e.target && e.target.id === 'wall-remote-handle' && e.key === 'Enter') return;   // the form's own submit (its button's click checks it)
      var inp = closest(e.target, '.log-comment-box input');
      if (!inp) return;
      var item = closest(inp, '[data-post-id]');
      var p = item ? findPost(item.getAttribute('data-post-id')) : null;
      if (!p) return;
      if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); note(p, inp.value.trim()); }
      if (e.key === 'Escape') { open.note = ''; rerender(p.id); }
    });

    Promise.all([getJSON('/assets/strings.en.json'), getJSON('/api/pages/' + enc(NAME))]).then(function (got) {
      if (got[0].ok && got[0].body) S = got[0].body;
      var r = got[1];
      if (!r.ok || !r.body || !Array.isArray(r.body.posts)) {
        board.innerHTML = '<p class="pg-empty">' + esc(r.status === 404 ? s('wall.gone') : s('wall.unavailable')) + '</p>';
        return;
      }
      data = r.body;
      // Every post on a wall is its owner's: the tiers read the author.
      data.posts.forEach(function (p) { p.author = { handle: NAME, name: data.display_name || NAME, url: data.page_url || '' }; });
      if (relation === 'friends') friends.add(NAME);
      markFresh(data.posts);
      applyTheme();
      placeBefriend();
      render();
      odometer();
      // The anchor (/@name#<post id>) lands once the cards exist.
      var id = (win.location.hash || '').slice(1);
      var target;
      if (id) {
        target = doc.getElementById(decodeURIComponent(id));
        if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      }
    });
  }

  return {
    wallHash: wallHash, wallRng: wallRng, wallChaos: wallChaos, chaosSeed: chaosSeed, WALL_TAPE: WALL_TAPE, WALL_STICKY: WALL_STICKY,
    dividerGlyph: dividerGlyph, isRoom: isRoom, stampTier: stampTier, stampShelf: stampShelf, canComment: canComment,
    FONT_STACKS: FONT_STACKS, safeHex: safeHex, themeStyle: themeStyle, fmtAge: fmtAge,
    esc: esc, safeHref: safeHref, safeImage: safeImage, safeFrame: safeFrame,
    start: start,
  };
});
