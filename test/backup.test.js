'use strict';
/* Gate: the admin's full-data backup (spec 15.4, scripts/backup.js). The tar
 * holds the data dir minus sessions, the remote media cache, backups, the lock
 * and write temps; it is written 0600 and whole, on a live server; it restores
 * into an empty dir that boots and signs the member in with their posts and
 * images; the script prints no secret; it refuses a dir that is not a data dir
 * and an output inside one. Each rule with a positive control. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { createBackup } = require('../scripts/backup');
const { png } = require('./helpers/images');
const { boot, joinAdmin, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup.js');
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/* A strict ustar reader for the suite: [{ name, type, mode, data }]. */
function untar(gz) {
  const buf = zlib.gunzipSync(gz);
  const out = [];
  let p = 0;
  const str = (h, o, l) => { let e = o; while (e < o + l && h[e]) e++; return h.subarray(o, e).toString('utf8'); };
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    assert.equal(parseInt(str(h, 148, 8), 8), sum, 'header checksum');
    const prefix = str(h, 345, 155);
    const name = prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100);
    const size = parseInt(str(h, 124, 12), 8);
    const type = String.fromCharCode(h[156]);
    const mode = parseInt(str(h, 100, 8), 8);
    p += 512;
    out.push({ name, type, mode, data: buf.subarray(p, p + size) });
    p += size + ((512 - (size % 512)) % 512);
  }
  return out;
}

/* Every regular file under dir, relative. */
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

test('the tar holds the data dir minus what a restore must not bring back, 0600, whole, and restores into a server that signs the member in', async () => {
  const h = await boot();
  const out = tmpDir('ring-bk-out-');
  const restored = tmpDir('ring-bk-restore-');
  let h2 = null;
  try {
    const ana = await joinAdmin(h, 'ana');
    const up = await ana.upload(await png(30, 20, '#c33'));
    assert.equal(up.status, 201);
    const post = await ana.post('/api/posts', { kind: 'image', media: { key: up.body.key, alt: 'red' } });
    assert.equal(post.status, 201);
    await ana.put('/api/me/page', { enabled: true });
    // What must stay out: the media cache, backups, a write temp, a symlink (the lock and sessions are real).
    for (const [rel, body] of [['fed/media/m_cache__web', 'cached'], ['backups/pre-1.tar.gz', 'old'], ['.members.json.123.abc.tmp', 'temp']]) {
      fs.mkdirSync(path.dirname(path.join(h.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(h.dir, rel), body);
    }
    fs.symlinkSync('/etc/passwd', path.join(h.dir, 'members', 'ana', 'link'));
    // A deep name past ustar's 100 bytes (the prefix field carries it), and one past 255 (skipped).
    const deep = `fed/rooms/ring_${'a'.repeat(20)}/${'b'.repeat(90)}.json`;
    fs.mkdirSync(path.join(h.dir, path.dirname(deep)), { recursive: true });
    fs.writeFileSync(path.join(h.dir, deep), '{}');
    const tooDeep = `fed/rooms/${'c'.repeat(200)}/${'d'.repeat(99)}`;
    fs.mkdirSync(path.join(h.dir, path.dirname(tooDeep)), { recursive: true });
    fs.writeFileSync(path.join(h.dir, tooDeep), 'x');
    assert.ok(fs.readdirSync(path.join(h.dir, 'sessions')).length > 0, 'positive control: there are sessions to leave out');
    assert.ok(fs.existsSync(path.join(h.dir, '.lock')), 'positive control: the lock is there');

    // On the live server.
    const r = await createBackup({ dataDir: h.dir, outDir: out, now: new Date('2026-10-16T12:34:56Z') });
    assert.equal(path.basename(r.file), 'ring-20261016T123456Z.tar.gz');
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600, 'the tar is a secret: 0600');
    assert.deepEqual(fs.readdirSync(out), [path.basename(r.file)], 'no .part left behind');
    assert.equal(r.skipped, 1, 'the one name past 255 bytes');

    const entries = untar(fs.readFileSync(r.file));
    const files = entries.filter((e) => e.type === '0');
    const names = files.map((e) => e.name).sort();
    const excluded = (n) => n.startsWith('sessions/') || n.startsWith('fed/media/') || n.startsWith('backups/')
      || n === '.lock' || /(^|\/)\..+\.tmp$/.test(n) || n === 'members/ana/link' || n === tooDeep;
    const expected = walk(h.dir).filter((n) => !excluded(n)).sort();
    assert.deepEqual(names, expected, 'exactly the data files, nothing excluded');
    assert.ok(names.includes('keys/ana.pem') && names.includes('members.json') && names.includes('instance.json'), 'positive control: keys, members and instance travel');
    assert.ok(names.includes(deep), 'a long name through the prefix field');
    for (const e of files) {
      assert.ok(e.data.equals(fs.readFileSync(path.join(h.dir, e.name))), `${e.name} byte for byte`);
      assert.equal(e.mode, 0o600);
    }
    for (const e of entries.filter((x) => x.type === '5')) assert.equal(e.mode, 0o700);

    // The system's own tar reads it, when there is one.
    let tar = true;
    try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); } catch { tar = false; }
    if (tar) {
      const listed = execFileSync('tar', ['-tzf', r.file], { encoding: 'utf8' }).split('\n').filter((n) => n && !n.endsWith('/')).sort();
      assert.deepEqual(listed, names);
    }

    // Restore: untar into an empty dir, boot there, sign in, the post and image are back.
    await h.close({ keepData: true });
    for (const e of entries) {
      const dest = path.join(restored, e.name);
      if (e.type === '5') fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
      else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.data, { mode: 0o600 }); }
    }
    h2 = await boot({ dataDir: restored });
    const c = h2.client();
    assert.equal((await c.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD })).status, 200);
    const page = await c.get('/api/me/page');
    assert.deepEqual(page.body.posts.map((p) => p.id), [post.body.id]);
    assert.equal((await c.bytes(`/api/images/${up.body.key}/web`)).status, 200);
  } finally {
    if (h2) await h2.close({ keepData: true });
    await h.close();
    for (const d of [out, restored]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the script prints the path and the counts, never a secret', async () => {
  const h = await boot();
  const out = tmpDir('ring-bk-cli-');
  try {
    await joinAdmin(h, 'ana');
    const stdout = execFileSync(process.execPath, [SCRIPT, '--data', h.dir, '--out', out], { encoding: 'utf8', env: { ...process.env, DATA_DIR: '' } });
    assert.match(stdout, /^backup written: .*ring-\d{8}T\d{6}Z\.tar\.gz \(\d+ files, [\d.]+ MB\)/);
    const pem = fs.readFileSync(path.join(h.dir, 'keys', 'ana.pem'), 'utf8');
    const hash = JSON.parse(fs.readFileSync(path.join(h.dir, 'members.json'), 'utf8'))[0]?.password_hash || '$2';
    for (const secret of ['PRIVATE KEY', pem.split('\n')[1], ADMIN_EMAIL, hash, 'members.json', 'keys/']) {
      assert.ok(!stdout.includes(secret), `stdout says nothing of ${secret.slice(0, 20)}`);
    }
    assert.equal(fs.readdirSync(out).length, 1, 'positive control: a backup was written');
  } finally {
    await h.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('it refuses a dir that is not a data dir, and an output inside the data dir', async () => {
  const h = await boot();
  const empty = tmpDir('ring-bk-empty-');
  try {
    await assert.rejects(createBackup({ dataDir: empty, outDir: empty }), /not a Ring data dir/);
    await assert.rejects(createBackup({ dataDir: h.dir, outDir: path.join(h.dir, 'members') }), /may not be inside the data dir/);
    // Its own backups/ is allowed: the tar leaves that folder out.
    const r = await createBackup({ dataDir: h.dir, outDir: path.join(h.dir, 'backups') });
    assert.ok(fs.existsSync(r.file), 'positive control: backups/ takes it');
    assert.ok(!untar(fs.readFileSync(r.file)).some((e) => e.name.startsWith('backups/')));
    let failed = false;
    try { execFileSync(process.execPath, [SCRIPT, '--data', empty], { stdio: 'pipe' }); } catch (e) { failed = e.status === 1; }
    assert.ok(failed, 'the script exits 1');
  } finally {
    await h.close();
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
