'use strict';
/* Gate: the export's review rules (spec 12, 14; 16.3 "export-hardening").
 * Another site's GET never spends a member's export budget; two exports stream
 * at once on the whole server and a third is 503 `export_busy` with
 * Retry-After; a reader that stops reading is cut after the idle bound;
 * `settings.blocked` is written name@host; an image whose original is gone is
 * listed as missing in a 200 export; the zip writer refuses a name that could
 * unpack outside its folder, its CRC-32 agrees with node's native one, and it
 * reads each image ONCE (a large file twice through one handle, the second
 * pass checked). Each rule with a positive control. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { unzip } = require('./helpers/unzip');
const { png } = require('./helpers/images');
const { crowd } = require('./helpers/social');
const { boot, joinAdmin } = require('./helpers/harness');
const Z = require('../lib/zip');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function fetchExport(c, headers = {}) {
  const res = await c.raw('GET', '/api/me/export', { headers });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, json: () => JSON.parse(bytes.toString('utf8')) };
}

function filesOf(bytes) {
  const all = unzip(bytes);
  const root = [...all.keys()][0].split('/')[0];
  return new Map([...all].map(([k, v]) => [k.slice(root.length + 1), v]));
}

async function imagePost(c, color) {
  const up = await c.upload(await png(20, 20, color));
  assert.equal(up.status, 201, up.text);
  assert.equal((await c.post('/api/posts', { kind: 'image', media: { key: up.body.key } })).status, 201);
  return up.body.key;
}

/* A raw export request whose reader never reads: resolves with the response
 * once the headers are in, the socket kept for the caller to watch or cut. */
function pausedExport(h, c) {
  const url = new URL(`${h.base}/api/me/export`);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, headers: { cookie: c.cookieHeader() }, agent: false }, (res) => {
      res.pause();
      resolve({ req, res, closed: new Promise((r) => req.socket.once('close', r)) });
    });
    req.on('error', () => {});
    req.once('error', reject);
    req.end();
  });
}

/* Wait until `fn()` holds, a bounded number of event-loop turns apart. */
async function until(fn, what, turns = 2000) {
  for (let i = 0; i < turns; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`never: ${what}`);
}

test('another site\'s GET is 403 and never spends the export budget; same-site and same-origin pass', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    const ana = await joinAdmin(h, 'ana');
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    for (let i = 0; i < 3; i++) {
      const r = await fetchExport(ana, nav);
      assert.equal(r.status, 403, 'a cross-site navigation is refused');
      assert.equal(r.json().error, 'csrf');
    }
    const foreign = await fetchExport(ana, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403, 'a foreign Origin is refused');
    // Not one of those spent the budget: three of her own still go through.
    assert.equal((await fetchExport(ana, { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' })).status, 200, 'same-site navigation');
    assert.equal((await fetchExport(ana, { 'sec-fetch-site': 'same-origin', origin: h.base })).status, 200, 'the page\'s own fetch');
    assert.equal((await fetchExport(ana, { 'sec-fetch-site': 'none' })).status, 200, 'a typed address');
    const fourth = await fetchExport(ana);
    assert.equal(fourth.status, 429, 'positive control: the budget is real, and these three spent it');
  } finally { await h.close(); }
});

test('two exports stream at once on the server; a third is 503 export_busy with Retry-After, and a freed slot serves it', async () => {
  const { h, c } = await crowd(['ana', 'bob', 'cy']);
  const open = [];
  try {
    // Originals large enough that a reader who does not read holds the answer open.
    for (const n of ['ana', 'bob']) fs.truncateSync(path.join(h.dir, 'images', await imagePost(c[n], '#a33')), 40 * 1024 * 1024);
    await imagePost(c.cy, '#3a3');
    open.push(await pausedExport(h, c.ana));
    open.push(await pausedExport(h, c.bob));
    assert.equal(open[0].res.statusCode, 200);
    assert.equal(open[1].res.statusCode, 200);
    assert.equal(h.ctx.exportsActive(), 2, 'two streaming');

    const busy = await fetchExport(c.cy);
    assert.equal(busy.status, 503);
    assert.equal(busy.json().error, 'export_busy');
    assert.equal(busy.headers.get('retry-after'), '30');
    const busyPost = await c.cy.raw('POST', '/api/me/export', { json: {} });
    assert.equal(busyPost.status, 503, 'the POST door counts the same slots');

    open[0].req.destroy();
    await until(() => h.ctx.exportsActive() === 1, 'a cut reader frees its slot');
    const ok = await fetchExport(c.cy);
    assert.equal(ok.status, 200, 'positive control: a free slot serves the export');
    assert.ok(filesOf(ok.bytes).has('manifest.json'));
  } finally {
    for (const o of open) o.req.destroy();
    await h.close();
  }
});

test('a reader that stops reading is cut after the idle bound, and its slot comes back', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    fs.truncateSync(path.join(h.dir, 'images', await imagePost(ana, '#33a')), 40 * 1024 * 1024);
    h.ctx.exportIdleMs = 200;
    const p = await pausedExport(h, ana);
    assert.equal(p.res.statusCode, 200);
    assert.equal(h.ctx.exportsActive(), 1, 'positive control: it holds a slot while it stalls');
    // The reader still does not read: only the server's idle bound frees the slot.
    await until(() => h.ctx.exportsActive() === 0, 'the server cuts the stalled answer and frees its slot');
    p.res.on('data', () => {});
    p.res.on('error', () => {});
    p.res.resume();
    await p.closed;
    assert.equal(p.res.complete, false, 'the cut answer is incomplete, never passed off as whole');
    h.ctx.exportIdleMs = undefined;
    assert.equal((await fetchExport(ana)).status, 200, 'a reader that reads gets the whole zip');
  } finally { await h.close(); }
});

test('settings.blocked is written name@host, local and remote alike', async () => {
  const { h, c } = await crowd(['ana', 'cy']);
  try {
    const host = new URL(h.base).host;
    assert.equal((await c.ana.put('/api/me/page', { block: 'cy' })).status, 200);
    assert.equal((await c.ana.put('/api/me/page', { block: 'zed@remote.example' })).status, 200);
    assert.deepEqual(h.ctx.pages.load('ana').blocked, ['cy', 'zed@remote.example'], 'positive control: a local block is stored bare');
    const settings = JSON.parse(filesOf((await fetchExport(c.ana)).bytes).get('settings.json'));
    assert.deepEqual(settings.blocked, [`cy@${host}`, 'zed@remote.example']);
  } finally { await h.close(); }
});

test('an image whose original is gone is listed as missing, and the export is still a 200 with every other file', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const kept = await imagePost(ana, '#a00');
    const gone = await imagePost(ana, '#0a0');
    fs.unlinkSync(path.join(h.dir, 'images', gone));
    const ex = await fetchExport(ana);
    assert.equal(ex.status, 200);
    const files = filesOf(ex.bytes);
    const manifest = JSON.parse(files.get('manifest.json'));
    assert.deepEqual(manifest.missing, [{ key: gone, file: `images/${gone}.png` }]);
    assert.ok(files.has(`images/${kept}.png`), 'positive control: the other image travels');
    assert.ok(!files.has(`images/${gone}.png`));
    assert.ok(!manifest.files[`images/${gone}.png`], 'never listed as a file it is not');
    assert.equal(manifest.counts.images, 1);
    const posts = JSON.parse(files.get('posts.json'));
    assert.ok(!posts.some((p) => p.image_file === `images/${gone}.png`));
    for (const [n, meta] of Object.entries(manifest.files)) assert.equal(meta.sha256, sha(files.get(n)), `${n} hash`);
  } finally { await h.close(); }
});

test('the zip writer refuses names that could unpack outside the folder', async () => {
  const one = (name) => [{ name, data: Buffer.from('x') }];
  for (const bad of ['../evil.txt', 'root/../../evil.txt', 'root/..', '/abs.txt', 'root\\evil.txt', 'C:/evil.txt', 'root/a\0b', '']) {
    assert.throws(() => Z.createZipStream(one(bad)), /zip: (unsafe entry name|an entry has no name)/, JSON.stringify(bad));
  }
  // Positive control: dots that are not a `..` segment are ordinary names.
  const z = await Z.zipToBuffer([{ name: 'root/..hidden', data: Buffer.from('a') }, { name: 'root/a..b/c.txt', data: Buffer.from('b') }]);
  assert.deepEqual([...unzip(z).keys()], ['root/..hidden', 'root/a..b/c.txt']);
});

test('CRC-32: native when the runtime has it, and the table version agrees, whole and running', () => {
  assert.equal(Z.NATIVE_CRC, typeof zlib.crc32 === 'function');
  if (Z.NATIVE_CRC) assert.equal(Z.crc32(Buffer.from('ring')), zlib.crc32(Buffer.from('ring')) >>> 0, 'the native one is used');
  for (let i = 0; i < 64; i++) {
    const b = crypto.randomBytes(i * 101);
    const want = zlib.crc32(b) >>> 0;
    assert.equal(Z.crc32Js(b), want, `table CRC of ${b.length} bytes`);
    const cut = Math.floor(b.length / 3);
    assert.equal(Z.crc32Js(b.subarray(cut), Z.crc32Js(b.subarray(0, cut))), want, 'table CRC, running');
    assert.equal(Z.crc32(b.subarray(cut), Z.crc32(b.subarray(0, cut))), want, 'CRC, running');
  }
  assert.equal(Z.crc32Js(Buffer.from('123456789')), 0xCBF43926, 'the check value');
});

/* Count opens and bytes read per path, through the door the writer uses. */
function spyReads(t) {
  const real = fs.promises.open;
  const seen = new Map();
  t.mock.method(fs.promises, 'open', async (p, ...rest) => {
    const fh = await real(p, ...rest);
    const s = seen.get(String(p)) || { opens: 0, bytes: 0 };
    s.opens++;
    seen.set(String(p), s);
    const read = fh.read.bind(fh);
    fh.read = async (...a) => { const o = await read(...a); s.bytes += o.bytesRead; return o; };
    return fh;
  });
  return seen;
}

test('the export reads each image once: one open, its size in bytes, and the manifest hash is of the bytes sent', async (t) => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const keys = [await imagePost(ana, '#a33'), await imagePost(ana, '#3a3')];
    const readFile = fs.promises.readFile;
    let readFiles = 0;
    t.mock.method(fs.promises, 'readFile', async (...a) => { if (String(a[0]).includes(`${path.sep}images${path.sep}`)) readFiles++; return readFile(...a); });
    const seen = spyReads(t);
    const ex = await fetchExport(ana);
    assert.equal(ex.status, 200);
    const files = filesOf(ex.bytes);
    const manifest = JSON.parse(files.get('manifest.json'));
    for (const k of keys) {
      const file = path.join(h.dir, 'images', k);
      const size = fs.statSync(file).size;
      assert.deepEqual(seen.get(file), { opens: 1, bytes: size }, `${k}: read once`);
      assert.equal(manifest.files[`images/${k}.png`].sha256, sha(files.get(`images/${k}.png`)));
    }
    assert.equal(readFiles, 0, 'no separate hash pass');
  } finally { await h.close(); }
});

test('a file past the one-read size: one handle, two passes, and a change between them fails the stream', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-zip-'));
  try {
    const size = Z.ONE_READ_MAX + 24 * 1024 * 1024;
    const file = path.join(dir, 'big.bin');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, size);
    fs.writeFileSync(path.join(dir, 'tail'), crypto.randomBytes(16));
    const seen = spyReads(t);
    const sums = [];
    const z = await Z.zipToBuffer([{ name: 'r/big.bin', path: file, size }], { onFile: (f) => sums.push(f) });
    assert.deepEqual(seen.get(file), { opens: 1, bytes: 2 * size }, 'one handle, a CRC pass and a data pass');
    const back = unzip(z).get('r/big.bin');
    assert.equal(back.length, size);
    assert.equal(sums[0].sha256, sha(back));

    // In-place change at the far end while the data pass runs: refused.
    const s = Z.createZipStream([{ name: 'r/big.bin', path: file, size }]);
    let changed = false;
    await assert.rejects(async () => {
      for await (const chunk of s) {
        if (!changed && chunk.length > 1024) {
          changed = true;
          const fd = fs.openSync(file, 'r+');
          fs.writeSync(fd, Buffer.from([7]), 0, 1, size - 1);
          fs.closeSync(fd);
        }
      }
    }, /zip: r\/big\.bin changed during export/);
    assert.ok(changed, 'the change landed mid-stream');

    // An optional file gone when reached is skipped and reported; the rest is a whole zip.
    const missing = [];
    const z2 = await Z.zipToBuffer([
      { name: 'r/gone.bin', path: path.join(dir, 'nope'), optional: true },
      { name: 'r/tail', path: path.join(dir, 'tail') },
    ], { onMissing: (e) => missing.push(e.name) });
    assert.deepEqual(missing, ['r/gone.bin']);
    assert.deepEqual([...unzip(z2).keys()], ['r/tail']);
    await assert.rejects(Z.zipToBuffer([{ name: 'r/gone.bin', path: path.join(dir, 'nope') }]), /could not be read \(ENOENT\)/, 'positive control: not optional, it fails');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
