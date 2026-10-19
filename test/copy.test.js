'use strict';
/* Gate: user-facing copy (spec 14). Every key the code asks for exists in
 * lib/strings.js, and no em dash appears in any string a person can read: the
 * catalog, the pages and the public assets. P3: the same two rules over the
 * composer (app/): every t('key') it asks for exists in app/strings.en.ts (the
 * typecheck holds it too, the key is typed), no em dash in any of its files,
 * and every value carries the placeholders its callers fill. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EN, t } = require('../lib/strings');

const ROOT = path.join(__dirname, '..');
const EM_DASH = '\u2014';

function filesUnder(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, ext));
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

test('no em dash in any user-facing string', () => {
  for (const [k, v] of Object.entries(EN)) assert.ok(!v.includes(EM_DASH), `strings: ${k}`);
  for (const f of filesUnder(path.join(ROOT, 'public'), ['.html', '.js', '.css', '.json'])) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes(EM_DASH), path.relative(ROOT, f));
  }
  // String literals in routes (the pages' markup) carry no em dash either.
  for (const f of filesUnder(path.join(ROOT, 'routes'), ['.js'])) {
    const literals = fs.readFileSync(f, 'utf8').match(/(['`])(?:\\.|(?!\1)[^\\])*\1/g) || [];
    for (const s of literals) assert.ok(!s.includes(EM_DASH), `${path.relative(ROOT, f)}: ${s.slice(0, 60)}`);
  }
});

test('every key the code asks for exists', () => {
  const used = new Set();
  const sources = [...filesUnder(path.join(ROOT, 'routes'), ['.js']), ...filesUnder(path.join(ROOT, 'lib'), ['.js'])];
  for (const f of sources) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\('([a-z0-9_.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bfail\(res, \d{3}, '([a-z0-9_.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/new ImageRefusal\(\d{3}, '([a-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\berror: '([a-z0-9_]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 30, `found ${used.size} keys: the scan works`);
  const missing = [...used].filter((k) => !Object.hasOwn(EN, k));
  assert.deepEqual(missing, []);
  assert.equal(t('invite_limit', { n: 5 }), 'You have 5 live invites already. Revoke one or wait for one to be used.');
});

const APP = path.join(ROOT, 'app');

test('the composer: no em dash in any file, every t() key in app/strings.en.ts', async () => {
  const { EN: APP_EN } = await import('../app/strings.en.ts');
  const files = filesUnder(APP, ['.ts', '.tsx', '.css', '.html']);
  assert.ok(files.length > 10, `found ${files.length} files: the scan works`);
  for (const [k, v] of Object.entries(APP_EN)) assert.ok(!v.includes(EM_DASH), `app strings: ${k}`);
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!src.includes(EM_DASH), path.relative(ROOT, f));
    for (const m of src.matchAll(/\bt\('([a-z0-9_.]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 200, `found ${used.size} keys: the scan works`);
  const missing = [...used].filter((k) => !Object.hasOwn(APP_EN, k));
  assert.deepEqual(missing, []);
  const unused = Object.keys(APP_EN).filter((k) => !used.has(k));
  assert.deepEqual(unused, [], 'a catalog row nothing shows is a promise the UI does not keep');

  // Every {placeholder} in a value is filled by every call that shows it.
  const holes = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\('([a-z0-9_.]+)'(?:,\s*\{([^}]*)\})?\)/g)) {
      const given = new Set([...(m[2] || '').matchAll(/(\w+)\s*(?=[:,]|$)/g)].map((x) => x[1]));
      for (const want of String(APP_EN[m[1]] || '').matchAll(/\{(\w+)\}/g)) {
        if (!given.has(want[1])) holes.push(`${path.relative(ROOT, f)}: t('${m[1]}') leaves {${want[1]}}`);
      }
    }
  }
  assert.deepEqual(holes, []);
});

// Copy names no other product. The name is built from parts so this file never
// spells it.
const OTHER_PRODUCT = ['b', 'u', 'r', 'o'].join('');

test('the composer copy names no other product and nothing Ring does not have', async () => {
  const { EN: APP_EN } = await import('../app/strings.en.ts');
  const banned = new RegExp(`${OTHER_PRODUCT}|inventory|artwork record|mascot`, 'i');
  for (const [k, v] of Object.entries(APP_EN)) {
    assert.ok(!banned.test(v), `${k}: ${v}`);
  }
});

test('the wall (public/assets/page.js): every s() key in strings.en.json, every row shown, every {placeholder} filled', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'page.js'), 'utf8');
  const WALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'assets', 'strings.en.json'), 'utf8'));
  const used = new Set([...src.matchAll(/\bs\('([a-z0-9_.]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 25, `found ${used.size} keys: the scan works`);
  assert.deepEqual([...used].filter((k) => !Object.hasOwn(WALL, k)), [], 'asked for, missing');
  assert.deepEqual(Object.keys(WALL).filter((k) => !used.has(k)), [], 'a row nothing shows');
  const holes = [];
  for (const m of src.matchAll(/\bs\('([a-z0-9_.]+)'(?:,\s*\{([^}]*)\})?\)/g)) {
    const given = new Set([...(m[2] || '').matchAll(/(\w+)\s*(?=:)/g)].map((x) => x[1]));
    for (const want of String(WALL[m[1]]).matchAll(/\{(\w+)\}/g)) if (!given.has(want[1])) holes.push(`s('${m[1]}') leaves {${want[1]}}`);
  }
  assert.deepEqual(holes, []);
  const banned = new RegExp(`${OTHER_PRODUCT}|mascot`, 'i');
  for (const [k, v] of Object.entries(WALL)) assert.ok(!banned.test(v), `${k}: ${v}`);
});
