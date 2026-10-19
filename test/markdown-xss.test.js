'use strict';
/* The note renderer is the one place server text becomes HTML (note_html, which the
 * composer sets with dangerouslySetInnerHTML). It must escape first and only ever
 * emit its own tags, and a link only to an http(s) or mailto target. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderRingMarkdown, renderInline } = require('../lib/ring');

const NASTY = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](http://a.example/" onmouseover="alert(1))',
  '[x](http://a.example/"><script>alert(1)</script>)',
  '**<b onclick=alert(1)>bold</b>**',
  '`<svg/onload=alert(1)>`',
  '# <iframe src=//evil></iframe>',
  '> <a href="javascript:alert(1)">q</a>',
];
const ALLOWED_TAGS = new Set(['p', 'br', 'ul', 'li', 'hr', 'h3', 'h4', 'h5', 'blockquote', 'a', 'code', 'strong', 'em']);

function check(html, src) {
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const [, closing, tag, attrs] = m;
    assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `${src}: emitted <${tag}>`);
    if (closing) { assert.equal(attrs.trim(), '', `${src}: attributes on </${tag}>`); continue; }
    m[1] = tag; m[2] = attrs;
    if (m[1].toLowerCase() === 'a') {
      const href = /href="([^"]*)"/.exec(m[2]);
      assert.ok(href && /^(https?:|mailto:)/i.test(href[1]), `${src}: unsafe href ${href && href[1]}`);
      const attrs = m[2].replace(/\s(href|target|rel)="[^"]*"/g, '').trim();
      assert.equal(attrs, '', `${src}: extra attributes on <a>: ${attrs}`);
    } else {
      assert.equal(m[2].trim(), '', `${src}: attributes on <${m[1]}>: ${m[2]}`);
    }
  }
}

test('the note renderer emits only its own tags, never an attribute an author wrote', () => {
  for (const src of NASTY) { check(renderRingMarkdown(src), src); check(renderInline(src), src); }
});

test('positive control: real markdown still renders, a safe link keeps its href', () => {
  const html = renderRingMarkdown('# Title\n\n**bold** and [site](https://example.org/a?b=1&c=2)\n\n- one');
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/example\.org\/a\?b=1&amp;c=2" target="_blank" rel="nofollow noopener ugc">site<\/a>/);
  assert.match(html, /<ul><li>one<\/li><\/ul>/);
  assert.equal(renderRingMarkdown('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
});
