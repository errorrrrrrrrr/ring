'use strict';
/* Gate: the backup's review rules (spec 15.4; 16.3 "backup-hardening").
 * On a live server every row an index in the tar names has its file (indexes
 * read first, each directory listed when the walk reaches it, keys/ and
 * images/ last); the output may not land inside the data dir by a symlink, a
 * symlinked --data or a case-insensitive spelling, and no earlier backup tar
 * inside the data dir is ever carried; only a file gone meanwhile (ENOENT) is
 * skipped, any other read error fails the run and leaves nothing; a file past
 * 2 GiB is streamed and one past what ustar holds is refused by name; an
 * existing target is never overwritten; the README names every secret the tar
 * holds and how to restore it as the server's user. Each rule with a positive
 * control. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createBackup, USTAR_MAX } = require('../scripts/backup');
const { png } = require('./helpers/images');
const { boot, joinAdmin, joinInvited } = require('./helpers/harness');

const ROOT = path.join(__dirname, '..');
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* A ustar reader: Map(name -> Buffer) of the regular files. */
function untar(gz) {
  const buf = zlib.gunzipSync(gz);
  const out = new Map();
  const str = (h, o, l) => { let e = o; while (e < o + l && h[e]) e++; return h.subarray(o, e).toString('utf8'); };
  let p = 0;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const prefix = str(h, 345, 155);
    const name = prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100);
    const size = parseInt(str(h, 124, 12), 8);
    p += 512;
    if (String.fromCharCode(h[156]) === '0') out.set(name, Buffer.from(buf.subarray(p, p + size)));
    p += size + ((512 - (size % 512)) % 512);
  }
  return out;
}

/* A bare data dir (instance.json is all a backup asks for). */
function bareData() {
  const d = tmpDir('ring-bkh-data-');
  fs.writeFileSync(path.join(d, 'instance.json'), '{}');
  return d;
}

test('on a live server every row the tar\'s indexes name has its file: a sign-up and an upload land at every directory the walk lists', async () => {
  const h = await boot();
  const out = tmpDir('ring-bkh-out-');
  try {
    const ana = await joinAdmin(h, 'ana');
    const first = await ana.upload(await png(8, 8, '#3a3'));
    assert.equal((await ana.post('/api/posts', { kind: 'image', media: { key: first.body.key } })).status, 201);
    let n = 0;
    const listed = [];
    const r = await createBackup({
      dataDir: h.dir,
      outDir: out,
      onStep: async (kind, rel) => {
        if (kind !== 'list') return;
        listed.push(rel);
        await joinInvited(h, ana, { slug: `zed${n++}` });
        const up = await ana.upload(await png(8, 8, '#a33'));
        assert.equal(up.status, 201);
        assert.equal((await ana.post('/api/posts', { kind: 'image', media: { key: up.body.key } })).status, 201);
      },
    });
    assert.ok(listed.includes('keys') && listed.includes('images') && listed.includes('members'), 'the mutations landed around the blob dirs');
    assert.ok(listed.indexOf('members') < listed.indexOf('keys') && listed.indexOf('keys') < listed.indexOf('images'), 'account dirs before keys/, keys/ before images/');

    const files = untar(fs.readFileSync(r.file));
    const members = JSON.parse(files.get('members.json'));
    const rows = Array.isArray(members) ? members : Object.values(members);
    assert.ok(rows.some((m) => m.slug === 'zed0'), 'positive control: a sign-up made during the walk is in the tar');
    for (const m of rows) assert.ok(files.has(`keys/${m.slug}.pem`), `${m.slug}'s row has its key`);
    const imgs = JSON.parse(files.get('images.json'));
    assert.ok(Object.keys(imgs).length > 1, 'positive control: an upload made during the walk is in the tar');
    for (const key of Object.keys(imgs)) assert.ok(files.has(`images/${key}`), `${key}'s row has its original`);
    const store = JSON.parse(files.get('members/ana/log.json'));
    for (const p of store.posts) if (p.media?.key) assert.ok(imgs[p.media.key], `post ${p.id} names an image the tar's index holds`);
  } finally {
    await h.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the output may not land inside the data dir by a symlink, a symlinked --data or another spelling, and no earlier tar inside it travels', async () => {
  const data = bareData();
  const side = tmpDir('ring-bkh-side-');
  try {
    fs.mkdirSync(path.join(data, 'members', 'ana'), { recursive: true });
    fs.writeFileSync(path.join(data, 'members', 'ana', 'log.json'), '{}');
    const refuse = /may not be inside the data dir/;
    const link = path.join(side, 'out-link');
    fs.symlinkSync(path.join(data, 'members'), link);
    await assert.rejects(createBackup({ dataDir: data, outDir: link }), refuse, '--out a symlink into the data dir');
    await assert.rejects(createBackup({ dataDir: data, outDir: path.join(link, 'deeper') }), refuse, 'below that symlink');
    assert.ok(!fs.existsSync(path.join(data, 'members', 'deeper')), 'a refusal makes no directory');
    const dataLink = path.join(side, 'data-link');
    fs.symlinkSync(data, dataLink);
    await assert.rejects(createBackup({ dataDir: dataLink, outDir: path.join(data, 'members', 'ana') }), refuse, '--data a symlink, --out its real subdir');
    await assert.rejects(createBackup({ dataDir: data, outDir: path.join(dataLink, 'members') }), refuse, '--out through a symlink to the data dir');
    const upper = path.join(path.dirname(data), path.basename(data).toUpperCase());
    let caseless = false;
    try { caseless = fs.statSync(upper).ino === fs.statSync(data).ino; } catch { /* a case-sensitive filesystem */ }
    if (caseless) {
      await assert.rejects(createBackup({ dataDir: data, outDir: path.join(upper, 'members') }), refuse, 'a case-insensitive spelling of the data dir');
      await assert.rejects(createBackup({ dataDir: data, outDir: path.join(upper, 'MEMBERS', 'x') }), refuse);
    }
    await assert.rejects(createBackup({ dataDir: data, outDir: path.join(data, 'BACKUPS') }), refuse, 'only backups/, spelled exactly');
    // Positive control: its own backups/, and a place outside.
    const own = await createBackup({ dataDir: data, outDir: path.join(data, 'backups') });
    assert.ok(fs.existsSync(own.file));

    // Earlier tars planted anywhere inside the data dir never travel.
    for (const rel of ['ring-20260101T000000Z.tar.gz', 'members/ana/ring-20260102T000000Z.tar.gz', 'members/ring-20260103T000000Z.tar.gz.part']) {
      fs.writeFileSync(path.join(data, rel), 'an earlier backup');
    }
    const r = await createBackup({ dataDir: data, outDir: path.join(side, 'o') });
    const names = [...untar(fs.readFileSync(r.file)).keys()];
    assert.deepEqual(names.sort(), ['instance.json', 'members/ana/log.json'], 'only the data files, no earlier tar');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(side, { recursive: true, force: true });
  }
});

test('only a file gone meanwhile is skipped; any other read error fails the run, names the file and leaves nothing', async (t) => {
  const data = bareData();
  const out = tmpDir('ring-bkh-out-');
  try {
    fs.mkdirSync(path.join(data, 'keys'));
    fs.writeFileSync(path.join(data, 'keys', 'ana.pem'), 'KEY');
    fs.writeFileSync(path.join(data, 'members.json'), '[]');
    // Gone between the listing and the read: skipped and counted.
    const r = await createBackup({
      dataDir: data,
      outDir: path.join(out, 'a'),
      onStep: (kind, rel) => { if (kind === 'read' && rel === 'members.json') fs.unlinkSync(path.join(data, rel)); },
    });
    assert.equal(r.skipped, 1);
    assert.ok(untar(fs.readFileSync(r.file)).has('keys/ana.pem'), 'positive control: the rest is there');

    fs.chmodSync(path.join(data, 'keys', 'ana.pem'), 0o000);
    let readable = true;
    try { fs.accessSync(path.join(data, 'keys', 'ana.pem'), fs.constants.R_OK); } catch { readable = false; }
    if (readable) { t.diagnostic('running as a user who reads a 0000 file: the EACCES half is skipped'); return; }
    await assert.rejects(createBackup({ dataDir: data, outDir: path.join(out, 'b') }), /could not read keys\/ana\.pem in the data dir \(EACCES\)/);
    assert.deepEqual(fs.readdirSync(path.join(out, 'b')), [], 'no tar and no .part');
  } finally {
    try { fs.chmodSync(path.join(data, 'keys', 'ana.pem'), 0o600); } catch { /* gone */ }
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a large file is streamed byte for byte; past 2 GiB it still travels; past what ustar holds it is refused by name', async () => {
  const data = bareData();
  const out = tmpDir('ring-bkh-out-');
  try {
    // Past the one-read size: streamed from one handle, byte for byte.
    const mid = crypto.randomBytes(20 * 1024 * 1024);
    fs.writeFileSync(path.join(data, 'mid.bin'), mid);
    const r1 = await createBackup({ dataDir: data, outDir: path.join(out, 'a') });
    assert.ok(untar(fs.readFileSync(r1.file)).get('mid.bin').equals(mid));
    fs.unlinkSync(path.join(data, 'mid.bin'));

    // Past 2 GiB (where a whole-file read throws): in the tar at its size.
    const bigSize = 2 ** 31 + 4096;
    const big = path.join(data, 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, bigSize);
    const r2 = await createBackup({ dataDir: data, outDir: path.join(out, 'b') });
    assert.equal(r2.skipped, 0);
    assert.equal(r2.files, 2);
    const gz = fs.readFileSync(r2.file);
    const first = await new Promise((resolve, reject) => {
      const g = zlib.createGunzip();
      let got = Buffer.alloc(0);
      g.on('data', (c) => { got = Buffer.concat([got, c]); if (got.length >= 512) { g.destroy(); resolve(got.subarray(0, 512)); } });
      g.on('error', reject);
      g.end(gz.subarray(0, 64 * 1024));
    });
    assert.equal(first.subarray(0, 7).toString(), 'big.bin', 'the big file comes first (sorted)');
    assert.equal(parseInt(first.subarray(124, 135).toString(), 8), bigSize, 'recorded at its size');
    const total = 512 + bigSize + 512 + 512 + 1024;   // big, instance.json, the end blocks
    assert.equal(gz.readUInt32LE(gz.length - 4), total % 2 ** 32, 'every byte went through gzip');

    // Past ustar's size field: refused before a byte, naming the file.
    fs.truncateSync(big, USTAR_MAX + 1);
    await assert.rejects(createBackup({ dataDir: data, outDir: path.join(out, 'c') }), /big\.bin in the data dir is \d+ bytes, past the 8 GiB a tar entry can record/);
    assert.deepEqual(fs.readdirSync(path.join(out, 'c')), [], 'no tar and no .part');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('an existing target is refused, never overwritten', async () => {
  const data = bareData();
  const out = tmpDir('ring-bkh-out-');
  try {
    const now = new Date('2026-10-16T01:02:03Z');
    const a = await createBackup({ dataDir: data, outDir: out, now });
    const before = fs.readFileSync(a.file);
    const ino = fs.statSync(a.file).ino;
    fs.writeFileSync(path.join(data, 'members.json'), '[]');   // the second run would differ
    await assert.rejects(createBackup({ dataDir: data, outDir: out, now }), /already exists; a backup never overwrites one/);
    assert.equal(fs.statSync(a.file).ino, ino, 'the first is the same file');
    assert.ok(fs.readFileSync(a.file).equals(before), 'byte for byte');
    assert.deepEqual(fs.readdirSync(out), [path.basename(a.file)], 'no .part left');
    const b = await createBackup({ dataDir: data, outDir: out, now: new Date('2026-10-16T01:02:04Z') });
    assert.notEqual(b.file, a.file, 'positive control: the next second is a new file');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the README and spec name every secret the tar holds and how to restore it as the server\'s user', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = readme.split('## Backups')[1].split('\n## ')[0];
  assert.match(section, /mail outbox/i);
  assert.match(section, /live\s+account-confirm and password-reset links/i);
  assert.match(section, /invite codes/i);
  assert.match(section, /--no-same-owner/);
  assert.doesNotMatch(section, /Safe while the server runs/, 'the old claim is gone');
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'SPEC.md'), 'utf8');
  const s154 = spec.split('### 15.4')[1].split('### 15.5')[0];
  assert.match(s154, /--no-same-owner/);
  assert.match(s154, /stopped server/i);
  assert.match(s154, /invite codes/i);
});
