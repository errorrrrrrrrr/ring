'use strict';
/* Gate: /@name.rss (spec 8.3, 10.2, 10.12). Well-formed XML and valid RSS 2.0
 * (the channel's three, each item's link, guid and RFC 822 date, an image's
 * enclosure with url, length and type), the 20 newest PUBLIC posts only (no
 * room post, no archived post, no divider, pinned not leading), everything
 * escaped and stripped of what XML cannot carry, every URL absolute; a
 * content warning is the item's title; `noindex` unless indexable; CORS open;
 * the 404 of an unknown name when the page is off. No XML package: a small
 * well-formedness walker below, with its own positive controls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { crowd, ring, note } = require('./helpers/social');
const { png } = require('./helpers/images');

/* XML 1.0 well-formedness, enough for a feed: one root, every tag closed in
 * order, attributes quoted and unique, entities known, no forbidden character.
 * Returns the error or ''. */
function xmlError(xml) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(xml)) return 'a character XML forbids';
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(xml)) return 'a lone surrogate';
  let s = xml.replace(/^<\?xml [^?]*\?>\s*/, '');
  const stack = [];
  let roots = 0;
  const NAME = '[A-Za-z_][\\w.:-]*';
  const tagRe = new RegExp(`^<(/?)(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`);
  while (s.length) {
    const lt = s.indexOf('<');
    const text = lt < 0 ? s : s.slice(0, lt);
    for (const m of text.matchAll(/&([^;\s]*);?/g)) {
      if (!/^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/.test(m[0])) return `a bad entity ${m[0].slice(0, 12)}`;
    }
    if (text.includes('>') && /]]>/.test(text)) return ']]> in text';
    if (!stack.length && text.trim()) return 'text outside the root';
    if (lt < 0) break;
    s = s.slice(lt);
    const m = tagRe.exec(s);
    if (!m) return `a malformed tag at ${JSON.stringify(s.slice(0, 30))}`;
    const [all, close, name, attrs, self] = m;
    const names = [...attrs.matchAll(new RegExp(`(${NAME})\\s*=`, 'g'))].map((a) => a[1]);
    if (new Set(names).size !== names.length) return `a repeated attribute on <${name}>`;
    for (const v of attrs.matchAll(/=\s*"([^"]*)"/g)) {
      for (const ent of v[1].matchAll(/&[^;\s]*;?/g)) if (!/^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/.test(ent[0])) return 'a bad entity in an attribute';
    }
    if (close) {
      if (stack.pop() !== name) return `</${name}> closes the wrong tag`;
    } else if (!self) {
      if (!stack.length) roots++;
      stack.push(name);
    } else if (!stack.length) roots++;
    s = s.slice(all.length);
  }
  if (stack.length) return `<${stack.at(-1)}> never closed`;
  if (roots !== 1) return `${roots} roots`;
  return '';
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const items = (xml) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
const field = (item, tag) => new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)</${tag}>`).exec(item)?.[1];
const RFC822 = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

test('the walker itself: well-formed passes, each kind of breakage is caught (positive controls)', () => {
  assert.equal(xmlError('<?xml version="1.0"?>\n<a x="1"><b>t &amp; u</b><c/></a>'), '');
  assert.notEqual(xmlError('<a><b></a></b>'), '');
  assert.notEqual(xmlError('<a>x & y</a>'), '');
  assert.notEqual(xmlError('<a>&nbsp;</a>'), '');
  assert.notEqual(xmlError('<a>\u0001</a>'), '');
  assert.notEqual(xmlError('<a x=1></a>'), '');
  assert.notEqual(xmlError('<a></a><b></b>'), '');
  assert.notEqual(xmlError('<a><script>alert(1)</a>'), '');
});

test('valid RSS 2.0: public posts only, newest first, 20 at most, absolute URLs, escaped, enclosures', async () => {
  const { h, c } = await crowd(['ana', 'bea']);
  try {
    await c.ana.patch('/api/me', { display_name: 'Ana & "Co" <x>' });
    await c.ana.put('/api/me/page', { enabled: true, bio: 'plates & **prints**' });
    const up = await c.ana.upload(await png(120, 80), { filename: 'i.png', type: 'image/png' });
    const { id: ringId } = await ring(c, 'ana', ['bea']);

    let clock = Date.parse('2026-10-01T09:00:00.000Z');
    const at = (id) => { const s = h.ctx.pages.load('ana'); s.posts.find((p) => p.id === id).created_at = new Date(clock += 60_000).toISOString(); h.ctx.pages.save('ana', s); };
    const make = async (body) => { const r = await c.ana.post('/api/posts', body); assert.equal(r.status, 201, r.text); at(r.body.id); return r.body.id; };

    const oldest = await make({ kind: 'note', note: 'the very first one' });
    for (let i = 0; i < 18; i++) await make({ kind: 'note', note: `filler ${i}` });
    const pinned = await make({ kind: 'note', note: 'PINNED-OLD' });
    await c.ana.patch(`/api/posts/${pinned}`, { pinned: true });
    const roomId = await make({ kind: 'note', note: 'ROOM-SECRET', audience: ringId });
    await make({ kind: 'divider', media: { variant: 'stars' } });
    const evil = await make({ kind: 'note', note: '# Head <script>alert(1)</script> & "q" \u0001\u0007 ]]> \ud800\n[home](/@bea) and [out](https://x.example/?a=1&b=2)' });
    const image = await make({ kind: 'image', media: { key: up.body.key, alt: 'three <prints>' }, note: 'drying' });
    const link = await make({ kind: 'link', media: { href: 'https://shop.example/a?b=1&c=2', label: 'The <shop>', sub: 'open late' } });
    const embed = await make({ kind: 'embed', media: { url: 'https://youtu.be/dQw4w9WgXcQ' }, note: 'a film' });
    const warned = await make({ kind: 'note', note: 'behind the warning', cw: 'flashing <lights>' });
    // An archived post, written by the sweep, never by the composer.
    const s = h.ctx.pages.load('ana');
    s.posts.push({ id: 'parchivedarchived', kind: 'note', note: 'SHELF-SECRET', created_at: new Date(clock += 60_000).toISOString(), audience: 'archive', archived_from: ringId });
    h.ctx.pages.save('ana', s);

    const anon = h.client();
    const r = await anon.get('/@ana.rss');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/rss+xml; charset=utf-8');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    const xml = r.text;
    assert.equal(xmlError(xml), '', xmlError(xml));
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0" xmlns:atom="http:\/\/www\.w3\.org\/2005\/Atom">\n<channel>/);
    const channel = xml.split('<item>')[0];
    assert.equal(field(channel, 'title'), 'Ana &amp; &quot;Co&quot; &lt;x&gt;');
    assert.equal(field(channel, 'link'), `${h.base}/@ana`);
    assert.equal(field(channel, 'description'), 'plates &amp; prints');
    assert.match(channel, new RegExp(`<atom:link href="${h.base}/@ana\\.rss" rel="self" type="application/rss\\+xml"/>`));

    const list = items(xml);
    assert.equal(list.length, 20, 'the 20 newest');
    for (const leak of ['ROOM-SECRET', 'SHELF-SECRET', 'the very first one', 'stars', '✦']) assert.ok(!xml.includes(leak), leak);
    assert.ok(!xml.includes(roomId) && !xml.includes(oldest), 'neither the room post nor the 21st newest');
    const ids = list.map((it) => field(it, 'link').split('#')[1]);
    assert.deepEqual(ids.slice(0, 6), [warned, embed, link, image, evil, pinned], 'newest first; a pin keeps its date, it does not lead the feed');
    for (const it of list) {
      assert.match(field(it, 'link'), new RegExp(`^${h.base}/@ana#p[0-9a-z]+$`), 'the wall anchor, absolute');
      assert.match(field(it, 'guid'), new RegExp(`^${h.base}/users/ana/posts/p[0-9a-z]+$`), 'the object URL');
      assert.match(field(it, 'pubDate'), RFC822);
      assert.ok(field(it, 'title'));
      // Every href and src in an item's HTML is absolute.
      const html = unescapeXml(field(it, 'description'));
      for (const u of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) assert.match(u[1], /^(https?:|mailto:)/, `absolute: ${u[1]}`);
    }

    const byId = (id) => list.find((it) => field(it, 'link').endsWith(`#${id}`));
    // Escaping: the pasted script is text, twice over (rendered escaped, then XML-escaped).
    const ev = byId(evil);
    assert.ok(!/<script/i.test(ev), 'no raw tag in the XML');
    const evHtml = unescapeXml(field(ev, 'description'));
    assert.ok(!/<script/i.test(evHtml), 'no tag once a reader unescapes it either');
    assert.match(evHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;/);
    assert.ok(!/[\u0001\u0007]/.test(xml), 'control characters stripped');
    assert.match(evHtml, new RegExp(`<a href="${h.base}/@bea" target="_blank" rel="nofollow noopener ugc">home</a>`), 'a site-relative link made absolute');
    assert.match(evHtml, /<a href="https:\/\/x\.example\/\?a=1&amp;b=2"/);
    assert.equal(unescapeXml(field(ev, 'title')), 'Head <script>alert(1)</script> & "q" ]]>', 'the first line, as text');

    // The image post: an enclosure of its public web variant, with its real length.
    const im = byId(image);
    const enc = /<enclosure url="([^"]+)" length="(\d+)" type="image\/webp"\/>/.exec(im);
    assert.ok(enc, 'an enclosure');
    assert.equal(enc[1], `${h.base}/api/images/${up.body.key}/web`);
    const bytes = await anon.bytes(`/api/images/${up.body.key}/web`);
    assert.equal(bytes.status, 200);
    assert.equal(Number(enc[2]), bytes.bytes.length);
    assert.match(unescapeXml(field(im, 'description')), new RegExp(`<img src="${h.base}/api/images/${up.body.key}/web" alt="three &lt;prints&gt;"`));
    assert.equal(field(im, 'title'), 'drying');
    // The link and the embed.
    const ln = unescapeXml(field(byId(link), 'description'));
    assert.match(ln, /<a href="https:\/\/shop\.example\/a\?b=1&amp;c=2">The &lt;shop&gt;<\/a>/);
    assert.equal(unescapeXml(field(byId(link), 'title')), 'The <shop>');
    assert.match(unescapeXml(field(byId(embed), 'description')), /https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
    assert.ok(!/<enclosure/.test(byId(link)), 'only image posts carry an enclosure');
    // A content warning is the title.
    assert.equal(unescapeXml(field(byId(warned), 'title')), 'flashing <lights>');
  } finally { await h.close(); }
});

test('the feed is absent with the page: the same 404 as an unknown name; it returns live', async () => {
  const { h, c } = await crowd(['ana']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await note(c.ana, 'hello');
    const anon = h.client();
    assert.equal((await anon.get('/@ana.rss')).status, 200, 'positive control: on');
    await c.ana.put('/api/me/page', { enabled: false });
    const off = await anon.get('/@ana.rss');
    const unknown = await anon.get('/@nobody.rss');
    assert.equal(off.status, 404);
    assert.equal(off.text, unknown.text);
    const hdrs = (r) => [...r.headers].filter(([k]) => k !== 'date');
    assert.deepEqual(hdrs(off), hdrs(unknown));
    assert.equal(off.headers.get('access-control-allow-origin'), null, 'nothing feed-shaped about the 404');
    await c.ana.put('/api/me/page', { enabled: true });
    assert.equal((await anon.get('/@ana.rss')).status, 200, 'on again, live');
  } finally { await h.close(); }
});
