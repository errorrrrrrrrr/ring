'use strict';
/* Gate: the store fails closed (robustness-r1-01, -13; spec 3.11). A damaged
 * data file is a read error, never an empty file a later write persists over the
 * real data: the boot refuses, a request fails, the hourly sweep deletes nothing.
 * An operator's hand edit while the server runs is read, not reverted. Every
 * data file is 0600 in a 0700 dir. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const clock = require('../lib/clock');
const { readJSON, writeJSON, writeFileAtomic, cachedFile, filterLines, StoreReadError } = require('../lib/store');
const { boot, joinAdmin, joinInvited, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ring-store-'));

test('readJSON: absent is the fallback; damaged or unreadable is an error naming the file', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'x.json');
    assert.deepEqual(readJSON(f, { fresh: true }), { fresh: true }, 'positive control: ENOENT is absent');
    for (const bad of ['{"a": 1,}', '', '{"a"', '\u0000\u0000']) {
      fs.writeFileSync(f, bad);
      assert.throws(() => readJSON(f, {}), (e) => e instanceof StoreReadError && e.file === f && e.message.includes(f), JSON.stringify(bad));
    }
    fs.mkdirSync(path.join(dir, 'adir.json'));
    assert.throws(() => readJSON(path.join(dir, 'adir.json'), []), StoreReadError, 'EISDIR is not "absent"');
    writeJSON(f, { ok: 1 });
    assert.deepEqual(readJSON(f, {}), { ok: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cachedFile: an edit underneath is re-read; a damaged one throws and is never written over', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'rows.json');
    let reloads = 0;
    const c = cachedFile(f, { fallback: () => [], shape: (v) => { if (!Array.isArray(v)) throw new Error('not a list'); return v; }, onReload: () => { reloads++; } });
    assert.deepEqual(c.get(), []);
    c.set([1, 2]);
    assert.deepEqual(c.get(), [1, 2]);
    assert.equal(reloads, 0, 'its own write is not a reload');
    fs.writeFileSync(f, JSON.stringify([1, 2, 3, 'hand edit']));
    assert.deepEqual(c.get(), [1, 2, 3, 'hand edit']);
    assert.equal(reloads, 1);
    fs.writeFileSync(f, '[1, 2,');
    assert.throws(() => c.get(), StoreReadError);
    assert.throws(() => c.get(), StoreReadError, 'a failed read is never cached');
    fs.writeFileSync(f, '{"not": "a list"}');
    assert.throws(() => c.get(), StoreReadError, 'the wrong shape is a read error too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const [file, bad] of [
  ['members.json', '[{"slug": "ana",}]'],
  ['images.json', '{"img_1": '],
  ['retired-handles.json', '{"oops": true}'],
  ['invites.json', 'not json'],
  ['instance.json', '[]'],
]) {
  test(`a damaged ${file} refuses the boot and is left as it was`, async () => {
    const h = await boot();
    const dir = h.dir;
    try {
      await joinAdmin(h, 'ana');
      await h.close({ keepData: true });
      const ok = await boot({ dataDir: dir });
      await ok.close({ keepData: true });   // positive control: the intact dir boots

      fs.writeFileSync(path.join(dir, file), bad);
      await assert.rejects(boot({ dataDir: dir }), (e) => e.message.includes(file) && /will not start/.test(e.message));
      assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), bad, 'not overwritten');
      assert.ok(!fs.existsSync(path.join(dir, '.lock')), 'the refused boot left the lock free');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a damaged log.json: the sweep keeps its images, writes refuse, and nothing is written over it', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const keys = [];
    for (let i = 0; i < 3; i++) keys.push((await ana.upload(await png())).body.key);
    for (const key of keys) await ana.post('/api/posts', { kind: 'image', media: { key, alt: '' } });
    await ana.put('/api/me/page', { enabled: true, bio: 'kept' });
    const file = path.join(h.dir, 'members', 'ana', 'log.json');
    const good = fs.readFileSync(file);
    const damaged = good.subarray(0, Math.floor(good.length / 2));
    fs.writeFileSync(file, damaged);

    clock.set(Date.now() + 25 * 3600_000);
    const out = h.ctx.housekeeping.run();
    assert.equal(out.images, 0, 'could not read = skip, never "references nothing"');
    for (const key of keys) assert.ok(h.ctx.images.row(key), key);
    assert.ok(h.logs.some((l) => l.includes("sweep skipped ana's images")), 'and it says so');

    assert.equal((await ana.get('/api/me/page')).status, 500, 'no empty page served');
    assert.equal((await ana.put('/api/me/page', { bio: 'new' })).status, 500);
    assert.equal((await ana.post('/api/posts', { kind: 'note', note: 'x' })).status, 500);
    assert.equal((await h.client().get('/api/pages/ana')).status, 500, 'the wall fails closed, never an empty wall');
    assert.ok(fs.readFileSync(file).equals(damaged), 'nothing was written over the damaged file');

    // Positive control: restored, everything is back, and the sweep still keeps them.
    fs.writeFileSync(file, good);
    assert.equal((await ana.get('/api/me/page')).body.posts.length, 3);
    assert.equal(h.ctx.housekeeping.run().images, 0);
    assert.equal((await ana.put('/api/me/page', { bio: 'new' })).status, 200);
  } finally { await h.close(); }
});

test('a members.json damaged while running: requests fail closed, sessions and images survive', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const key = (await ana.upload(await png())).body.key;
    const file = path.join(h.dir, 'members.json');
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, `${good.toString('utf8').slice(0, -2)},]`);
    const sessions = fs.readdirSync(path.join(h.dir, 'sessions')).length;
    assert.ok(sessions > 0);

    assert.equal((await ana.get('/api/me')).status, 500);
    assert.equal(fs.readdirSync(path.join(h.dir, 'sessions')).length, sessions, 'a read error ends no session');
    clock.set(Date.now() + 25 * 3600_000);
    h.ctx.housekeeping.run();
    assert.ok(h.ctx.images.row(key), 'no owner looks deleted');
    assert.equal((await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'ana2' })).status >= 500, true, 'no re-bootstrap over it');
    assert.ok(!fs.readFileSync(file).equals(good));

    fs.writeFileSync(file, good);
    assert.equal((await ana.get('/api/me')).status, 200, 'positive control: restored, the same session works');
  } finally { await h.close(); }
});

test('a hand edit of members.json while running is read, and the next write keeps it', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const bob = await joinInvited(h, ana, { slug: 'bob' });
    await bob.put('/api/me/page', { enabled: true });
    const file = path.join(h.dir, 'members.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    const b = rows.find((r) => r.slug === 'bob');
    b.role = 'admin';
    b.display_name = 'Bob Edited';
    fs.writeFileSync(file, JSON.stringify(rows, null, 1));

    assert.equal((await bob.get('/api/me')).body.role, 'admin', 'read at once');
    assert.equal((await h.client().get('/api/pages/bob')).body.display_name, 'Bob Edited', 'the projection follows');
    assert.equal((await ana.patch('/api/me', { display_name: 'Ana Two' })).status, 200);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.find((r) => r.slug === 'bob').role, 'admin', 'an unrelated write did not revert the edit');
    assert.equal(after.find((r) => r.slug === 'ana').display_name, 'Ana Two', 'positive control: the write landed');
  } finally { await h.close(); }
});

test('the image sweep brakes when it would remove a large share of all rows', async () => {
  const h = await boot();
  try {
    await joinAdmin(h, 'ana');
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const rows = {};
    for (let i = 0; i < 30; i++) {
      rows[`img_${String(1700000000000 + i)}_${String(i).padStart(16, '0')}`] = { owner: 'ana', bytes: 1, created_at: old, width: 1, height: 1, type: 'image/webp', source: 'png' };
    }
    fs.writeFileSync(path.join(h.dir, 'images.json'), JSON.stringify(rows));
    assert.equal(h.ctx.housekeeping.run().images, 0, '30 of 30 unreferenced: refused');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir, 'images.json'), 'utf8'))).length, 30);
    assert.ok(h.logs.some((l) => /sweep REFUSED: it would remove 30 of 30/.test(l)));

    const few = Object.fromEntries(Object.entries(rows).slice(0, 3));
    fs.writeFileSync(path.join(h.dir, 'images.json'), JSON.stringify(few));
    assert.equal(h.ctx.housekeeping.run().images, 3, 'positive control: a small sweep runs');
  } finally { await h.close(); }
});

test('data files are 0600 and directories 0700, whatever the umask', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'nested', 'data');   // the app creates it
  const umask = process.umask(0o022);
  let h;
  try {
    h = await boot({ dataDir });
    const ana = await joinAdmin(h, 'ana');
    const bob = await joinInvited(h, ana, { slug: 'bob' });
    const key = (await ana.upload(await png())).body.key;
    await ana.post('/api/posts', { kind: 'image', media: { key, alt: '' } });
    await ana.post('/api/posts', { kind: 'note', note: 'x' });
    const del = await ana.post('/api/posts', { kind: 'note', note: 'gone' });
    await ana.del(`/api/posts/${del.body.id}`);
    await ana.put('/api/me/page', { enabled: true });
    await h.client().get('/api/pages/ana');
    h.ctx.visits.flush();
    await h.client().post('/api/password/forgot', { email: 'bob@example.test' });
    await bob.post('/api/me/password', { current: PASSWORD, next: 'another long password' });
    await ana.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD });
    h.ctx.audit('test.event', 'ana');

    const bad = [];
    let files = 0;
    const walk = (d) => {
      const st = fs.statSync(d);
      if ((st.mode & 0o777) !== 0o700) bad.push(`${path.relative(dataDir, d) || '.'}/ ${(st.mode & 0o777).toString(8)}`);
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        files++;
        const m = fs.statSync(p).mode & 0o777;
        if (m & 0o077) bad.push(`${path.relative(dataDir, p)} ${m.toString(8)}`);
      }
    };
    walk(dataDir);
    assert.ok(files >= 12, `positive control: the flows wrote files (${files})`);
    for (const f of ['members.json', 'images.json', 'audit.log', 'password-resets.json', 'mail-outbox.jsonl', path.join('members', 'ana', 'log.json')]) {
      assert.ok(fs.existsSync(path.join(dataDir, f)), f);
    }
    assert.deepEqual(bad, []);
  } finally {
    process.umask(umask);
    if (h) await h.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeFileAtomic fsyncs the directory after the rename', () => {
  const dir = tmpDir();
  const fsync = fs.fsyncSync;
  const synced = [];
  fs.fsyncSync = (fd) => { synced.push(fs.fstatSync(fd).isDirectory()); return fsync(fd); };
  try {
    writeFileAtomic(path.join(dir, 'a.json'), '{}');
    assert.deepEqual(synced, [false, true], 'the file, then its directory');
  } finally { fs.fsyncSync = fsync; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('filterLines streams across chunk edges, and a failure mid-way leaves the file whole', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'log.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(i % 7) }));
    fs.writeFileSync(f, lines.join('\n') + '\n');
    assert.equal(filterLines(f, (l) => JSON.parse(l).i % 2 === 0, { chunk: 7 }), 25);
    assert.deepEqual(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean), lines.filter((_, i) => i % 2 === 0));
    assert.equal(filterLines(f, () => true), 0, 'nothing to drop: no rewrite');

    const before = fs.readFileSync(f);
    const writeSync = fs.writeSync;
    let n = 0;
    fs.writeSync = (...a) => { if (++n > 3) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return writeSync(...a); };
    try {
      assert.throws(() => filterLines(f, (l) => JSON.parse(l).i < 40), /ENOSPC/);
    } finally { fs.writeSync = writeSync; }
    assert.ok(fs.readFileSync(f).equals(before), 'the old log is whole');
    assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), [], 'and no temp is left');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
