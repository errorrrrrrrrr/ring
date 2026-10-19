'use strict';
/* ── Remote text: THE node-tree re-emitter (spec 5.8) ─────────────────────────
 * Remote HTML is NEVER stored or served as HTML. parseRemoteHtml() tokenizes it
 * into a small node tree and that tree is what is stored, served (JSON) and
 * rendered (React elements in the app, createElement on a page): nothing from
 * another server ever reaches innerHTML.
 *
 *   node   a string (text), or { t: <tag>, c: [nodes] }, `href` on an `a` only;
 *          `br` has no children
 *   tags   p br a strong em b i del code pre blockquote ul ol li (ALLOWED)
 *
 * The rules, in the order the tokenizer meets them:
 *   - script style template iframe object embed svg math (and noscript, title,
 *     head, textarea, select, xmp, noembed, noframes, frameset) are DROPPED WITH
 *     THEIR CONTENT;
 *   - Mastodon's `span.invisible` is dropped with its content and
 *     `span.ellipsis` gains "…" after its text;
 *   - every other tag is UNWRAPPED to its text (its children stay, the tag goes);
 *   - no attribute survives except `href` on `a`, and only when it is an http(s)
 *     URL that lib/ring.js ringSafeHref passes (a relative path would resolve
 *     against THIS origin, so it is dropped too);
 *   - comments, doctypes and processing instructions vanish; entities decode to
 *     text (and are escaped again by whatever renders the tree).
 * SAFETY COMES FROM THE EMITTER, NOT THE TOKENIZER: a tokenizer bug can garble
 * text, never inject markup, because every renderer of the tree emits only the
 * allowed tags and escapes every string. settleTree() re-checks a stored tree
 * on every read the same way (a hand-edited file cannot widen it).
 *
 * Bounds: input over 60 KB is refused (null); the text is cut at `maxText`
 * (20 000 by default) characters with `cut: true` (the caller links "more at
 * source"); at most 4000 nodes and 24 levels (deeper elements are unwrapped);
 * at most 64 open elements tracked at once (past it a tag is unwrapped and its
 * closer swallowed). The parse is LINEAR in the input (F1: no rescans of the
 * open-element stack, no regex that backtracks over a tag). clipTree() cuts a
 * settled tree to a preview (From elsewhere keeps 2000 characters, 200 nodes).
 * No dependency: no sanitizer package (spec 5.8, 14).
 */
const { ringSafeHref } = require('./ring');

const MAX_INPUT = 60 * 1024;
const MAX_TEXT = 20_000;
const MAX_NODES = 4000;
const MAX_DEPTH = 24;
const MAX_HREF = 2000;
const MAX_STACK = 64;   // open elements tracked at once (F1): past it a tag is unwrapped

const ALLOWED = new Set(['p', 'br', 'a', 'strong', 'em', 'b', 'i', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li']);
const DROPPED = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'math',
  'noscript', 'title', 'head', 'textarea', 'select', 'xmp', 'noembed', 'noframes', 'frameset']);
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr', 'source', 'area', 'base', 'col', 'param', 'track', 'embed']);
const BLOCK = new Set(['p', 'blockquote', 'pre', 'ul', 'ol', 'li']);

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '\u2014', ndash: '–',
  laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
  middot: '·', bull: '•', times: '×', deg: '°', shy: '',
};

/* Entities to text. An unknown one stays as written; a code point that is not a
 * character (a surrogate, past U+10FFFF, NUL) becomes U+FFFD. */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
      return String.fromCodePoint(n);
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/* A safe href for a remote link: http(s) only, through ringSafeHref, bounded,
 * and never one carrying whitespace, a quote, an angle bracket, a backtick or a
 * control character inside it (no real URL does; a renderer escapes anyway). */
function remoteHref(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > MAX_HREF || !/^https?:\/\//i.test(s)) return '';
  if (/[\s"'<>`\u0000-\u001f\u007f]/.test(s)) return '';
  return ringSafeHref(s);
}

/* Attributes of an open tag: Map name -> raw value (names lowercased, the first
 * of a repeated name wins). One pass, no regex, no backtracking: an unclosed
 * quote takes the rest of the tag and the scan ends. Read only for `a` (href)
 * and `span` (class); every other tag's attributes are never looked at. */
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
function readAttrs(src) {
  const out = new Map();
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isSpace(c) || c === 47) { i++; continue; }
    const s = i;
    while (i < n) { const d = src.charCodeAt(i); if (isSpace(d) || d === 47 || d === 61) break; i++; }
    if (i === s) { i++; continue; }   // a stray `=`
    const name = src.slice(s, i).toLowerCase();
    let j = i;
    while (j < n && isSpace(src.charCodeAt(j))) j++;
    let value = '';
    if (src.charCodeAt(j) === 61) {
      j++;
      while (j < n && isSpace(src.charCodeAt(j))) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const e = src.indexOf(q, j + 1);
        const end = e < 0 ? n : e;
        value = src.slice(j + 1, end);
        i = end + 1;
      } else {
        const v = j;
        while (j < n && !isSpace(src.charCodeAt(j))) j++;
        value = src.slice(v, j);
        i = j;
      }
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/* Raw-text elements: their content is never markup, so the tokenizer jumps to
 * the closer (case-insensitive) and drops everything up to it. */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'textarea', 'title', 'noscript']);
const rawCloser = new Map([...RAW_TEXT].map((t) => [t, new RegExp(`</${t}`, 'gi')]));
const isAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c) => isAlpha(c) || (c >= 48 && c <= 57) || c === 58 || c === 45;

/* THE tokenizer. -> { tree, cut } or null (over 60 KB, or not a string).
 *
 * LINEAR TIME (F1): every character is looked at a bounded number of times.
 * The open-element stack is capped at MAX_STACK entries; past it a tag is
 * unwrapped and its closer is swallowed (a dropped tag past it ends the parse,
 * `cut`). "Am I inside a dropped element" and "where do kept nodes go" are
 * running counters and a stack of kept nodes, never a rescan; a closer looks
 * at most MAX_STACK entries; a tag is read by one forward scan that stops at
 * the next `<` or `>`, so a `<` with no `>` costs only the distance to the next
 * `<`. `stats` (tests): { steps } counts the units of work, which a gate holds
 * to a small multiple of the input's length. */
let parses = 0;   // how many inputs this process tokenized (the gates: one parse per object)
function parseRemoteHtml(html, { maxText = MAX_TEXT, stats = null } = {}) {
  if (typeof html !== 'string') return null;
  if (Buffer.byteLength(html, 'utf8') > MAX_INPUT) return null;
  parses++;
  const root = { t: '#root', c: [] };
  // Every open element: { tag, node (kept, or null when unwrapped), drop, ellipsis }
  const stack = [{ tag: '#root', node: root, drop: false }];
  const kept = [root];          // the kept nodes among them, innermost last
  let dropDepth = 0;            // how many of them drop their content
  const swallow = new Map();    // tag -> opens past MAX_STACK whose closers are swallowed
  let steps = 0;
  let textLen = 0;
  let nodes = 0;
  let cut = false;
  const n = html.length;

  const keptParent = () => kept[kept.length - 1];
  function push(e) {
    stack.push(e);
    if (e.node) kept.push(e.node);
    if (e.drop) dropDepth++;
  }
  function popFrom(i) {
    while (stack.length > i) {
      const e = stack.pop();
      steps++;
      if (e.node) kept.pop();
      if (e.drop) dropDepth--;
    }
  }
  const full = () => stack.length >= MAX_STACK;
  const overflow = (tag) => { swallow.set(tag, (swallow.get(tag) || 0) + 1); };

  function addText(s) {
    steps += s.length;
    if (cut || !s || dropDepth) return;
    let len = 0;
    for (let k = 0; k < s.length; k++) { const x = s.charCodeAt(k); if (x < 0xdc00 || x > 0xdfff) len++; }
    const room = maxText - textLen;
    let text = s;
    if (len > room) { text = Array.from(text).slice(0, Math.max(0, room)).join(''); len = Math.max(0, room); cut = true; }
    if (!text) return;
    textLen += len;
    const parent = keptParent();
    const last = parent.c[parent.c.length - 1];
    if (typeof last === 'string') parent.c[parent.c.length - 1] = last + text;
    else { if (++nodes > MAX_NODES) { cut = true; return; } parent.c.push(text); }
  }

  /* An open tag. -> 'raw' when the caller must skip a raw-text element. */
  function open(tag, rest, selfClosing) {
    if (cut) return '';
    if (DROPPED.has(tag)) {
      if (VOID.has(tag) || selfClosing) return '';
      if (RAW_TEXT.has(tag)) return 'raw';
      if (full()) { cut = true; return ''; }   // its content cannot be tracked: stop here
      push({ tag, node: null, drop: true });
      return '';
    }
    if (tag === 'a' || tag === 'span') steps += rest.length;
    const attrs = tag === 'a' || tag === 'span' ? readAttrs(rest) : null;
    const cls = tag === 'span' ? decodeEntities(attrs.get('class') || '').split(/\s+/) : [];
    if (tag === 'span' && cls.includes('invisible')) {
      if (selfClosing) return '';
      if (full()) { cut = true; return ''; }
      push({ tag, node: null, drop: true });
      return '';
    }
    if (dropDepth) {
      if (!VOID.has(tag) && !selfClosing) { if (full()) overflow(tag); else push({ tag, node: null, drop: false }); }
      return '';
    }
    if (tag === 'br') {
      if (++nodes > MAX_NODES) { cut = true; return ''; }
      keptParent().c.push({ t: 'br' });
      return '';
    }
    if (VOID.has(tag) || selfClosing) return '';   // img, hr, input...: nothing of them stays
    if (full()) { overflow(tag); return ''; }        // unwrapped: its text goes to the parent
    const ellipsis = tag === 'span' && cls.includes('ellipsis');
    if (!ALLOWED.has(tag) || kept.length > MAX_DEPTH) { push({ tag, node: null, drop: false, ellipsis }); return ''; }
    if (++nodes > MAX_NODES) { cut = true; return ''; }
    const node = { t: tag, c: [] };
    if (tag === 'a') { const href = remoteHref(decodeEntities(attrs.get('href') || '')); if (href) node.href = href; }
    keptParent().c.push(node);
    push({ tag, node, drop: false });
    return '';
  }

  function close(tag) {
    const owed = swallow.get(tag);
    if (owed) { if (owed > 1) swallow.set(tag, owed - 1); else swallow.delete(tag); return; }
    for (let i = stack.length - 1; i > 0; i--) {
      steps++;
      if (stack[i].tag !== tag) continue;
      const was = stack[i];
      popFrom(i);
      if (was.ellipsis && !dropDepth) addText('…');
      return;
    }
    // A close with no open: ignored.
  }

  /* The tag at `lt` ('<' + letters...), read by one forward scan to the next
   * `<` or `>`: { closing, name, rest, end } or null (not a tag). */
  function readTag(lt) {
    let j = lt + 1;
    const closing = html.charCodeAt(j) === 47;
    if (closing) j++;
    if (!isAlpha(html.charCodeAt(j))) return null;
    let k = j + 1;
    while (k < n && isNameChar(html.charCodeAt(k))) k++;
    let e = k;
    while (e < n) { const c = html.charCodeAt(e); if (c === 62 || c === 60) break; e++; }
    steps += e - lt;
    if (e >= n || html.charCodeAt(e) === 60) return null;
    return { closing, name: html.slice(j, k).toLowerCase(), rest: html.slice(k, e), end: e + 1 };
  }

  let i = 0;
  while (i < n && !cut) {
    steps++;
    const lt = html.indexOf('<', i);
    if (lt < 0) { addText(decodeEntities(html.slice(i))); break; }
    if (lt > i) addText(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      steps += (end < 0 ? n : end) - lt;
      i = end < 0 ? n : end + 3;
      continue;
    }
    const tok = readTag(lt);
    if (!tok) {
      const next = html[lt + 1];
      if (next === '!' || next === '?') {
        const gt = html.indexOf('>', lt);
        steps += (gt < 0 ? n : gt) - lt;
        i = gt < 0 ? n : gt + 1;
        continue;
      }
      addText('<');
      i = lt + 1;
      continue;
    }
    i = tok.end;
    if (tok.closing) { close(tok.name); continue; }
    const trimmed = tok.rest.trimEnd();
    const selfClosing = trimmed.endsWith('/');
    if (open(tok.name, selfClosing ? trimmed.slice(0, -1) : tok.rest, selfClosing) === 'raw') {
      // Inside a dropped raw-text element (script, style...): skip to its close.
      const re = rawCloser.get(tok.name);
      re.lastIndex = i;
      const m = re.exec(html);
      if (!m) { steps += n - i; i = n; break; }
      const gt = html.indexOf('>', m.index);
      steps += (gt < 0 ? n : gt) - i;
      i = gt < 0 ? n : gt + 1;
    }
  }
  if (stats) stats.steps = steps;
  return { tree: prune(root.c), cut };
}

/* Drop empty elements (an `a` with no text, an empty `p`), keep `br`. */
function prune(list) {
  const out = [];
  for (const x of list) {
    if (typeof x === 'string') { if (x) out.push(x); continue; }
    if (x.t === 'br') { out.push({ t: 'br' }); continue; }
    const c = prune(x.c);
    if (!c.length) continue;
    const node = { t: x.t, c };
    if (x.href) node.href = x.href;
    out.push(node);
  }
  return out;
}

/* Re-check a tree read back from disk (or built by anything): only allowed
 * tags, strings as text, `href` only on `a` and only when safe. Anything else is
 * dropped. Bounded like the parse. */
function settleTree(raw, { depth = 0, budget = { nodes: 0 } } = {}) {
  if (!Array.isArray(raw) || depth > MAX_DEPTH) return [];
  const out = [];
  for (const x of raw) {
    if (++budget.nodes > MAX_NODES) break;
    if (typeof x === 'string') { out.push(x.slice(0, MAX_TEXT)); continue; }
    if (!x || typeof x !== 'object' || !ALLOWED.has(x.t)) continue;
    if (x.t === 'br') { out.push({ t: 'br' }); continue; }
    const node = { t: x.t, c: settleTree(x.c, { depth: depth + 1, budget }) };
    if (x.t === 'a') { const href = remoteHref(x.href); if (href) node.href = href; }
    out.push(node);
  }
  return out;
}

/* A preview of a settled tree: at most `maxText` characters and `maxNodes`
 * nodes, in document order, empty elements dropped. -> { tree, cut }. */
function clipTree(tree, { maxText = 2000, maxNodes = 200 } = {}) {
  let text = 0;
  let nodes = 0;
  let cut = false;
  const walk = (list, depth) => {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (cut) break;
      if (++nodes > maxNodes || depth > MAX_DEPTH) { cut = true; break; }
      if (typeof x === 'string') {
        const room = maxText - text;
        const cps = Array.from(x);
        if (cps.length > room) { cut = true; if (room > 0) out.push(cps.slice(0, room).join('')); text = maxText; break; }
        text += cps.length;
        out.push(x);
        continue;
      }
      if (!x || typeof x !== 'object') continue;
      if (x.t === 'br') { out.push({ t: 'br' }); continue; }
      const c = walk(x.c, depth + 1);
      if (!c.length) continue;
      const node = { t: x.t, c };
      if (x.href) node.href = x.href;
      out.push(node);
    }
    return out;
  };
  const out = walk(tree, 0);
  return { tree: out, cut };
}

/* The tree as plain text: blocks on their own lines, `br` a newline, list items
 * on their own lines, whitespace inside a line collapsed. */
function treeText(tree) {
  const parts = [];
  const walk = (list) => {
    for (const x of list) {
      if (typeof x === 'string') { parts.push(x); continue; }
      if (x.t === 'br') { parts.push('\n'); continue; }
      if (BLOCK.has(x.t)) parts.push('\n');
      walk(x.c || []);
      if (BLOCK.has(x.t)) parts.push('\n');
    }
  };
  walk(Array.isArray(tree) ? tree : []);
  return parts.join('').split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* The reference emitter: the tree as escaped HTML, ONLY the allowed tags, `href`
 * the only attribute. For the gates (and anything that must show the tree as
 * markup, never served for another server's text: the app renders elements). */
function treeToHtml(tree) {
  return settleTree(tree).map(function emit(x) {
    if (typeof x === 'string') return escapeText(x);
    if (x.t === 'br') return '<br>';
    const inner = x.c.map(emit).join('');
    if (x.t === 'a') return x.href ? `<a href="${escapeText(x.href)}" rel="nofollow noopener ugc">${inner}</a>` : inner;
    return `<${x.t}>${inner}</${x.t}>`;
  }).join('');
}

module.exports = { parseRemoteHtml, parseCount: () => parses, settleTree, clipTree, treeText, treeToHtml, remoteHref, decodeEntities, ALLOWED, DROPPED, MAX_INPUT, MAX_TEXT, MAX_STACK };
