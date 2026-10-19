'use strict';
/* Gate: the lifecycle (spec 7, 11.4, 15.4). A deletion stays a deletion even
 * against a write whose body was still arriving; the purge ends every session
 * itself; housekeeping runs each step on its own and sweeps crash leftovers; the
 * settings writes are limited; a client error is a quiet 4xx; shutdown is bounded;
 * the data-dir lock is a lease that holds across processes and hosts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const clock = require('../lib/clock');
const { acquireLock } = require('../lib/instance');
const { boot, joinAdmin, joinInvited, PASSWORD } = require('./helpers/harness');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

async function withBee(fn) {
  const h = await boot();
  try {
    const admin = await joinAdmin(h, 'ada');
    const bee = await joinInvited(h, admin, { slug: 'bee' });
    await fn(h, admin, bee);
  } finally { await h.close(); }
}

// ── the purge holds against a write in flight (robustness-r1-02, security-r1-06) ──

for (const [method, p, body, okStatus] of [
  ['PUT', '/api/me/page', { enabled: true, bio: 'still here?' }, 200],
  ['POST', '/api/posts', { kind: 'note', note: 'from beyond' }, 201],
]) {
  test(`${method} ${p} whose body arrives after DELETE /api/me writes nothing`, () => withBee(async (h, admin, bee) => {
    // Positive control: the same streamed write, with no deletion between, lands.
    const control = await bee.stream(method, p, body);
    assert.equal((await control.finish()).status, okStatus);

    const write = await bee.stream(method, p, body);
    const other = h.client();
    await other.post('/api/login', { email: 'bee@example.test', password: PASSWORD });
    assert.equal((await other.del('/api/me', { password: PASSWORD })).status, 200);
    assert.ok(!fs.existsSync(path.join(h.dir, 'members', 'bee')), 'purged');
    const r = await write.finish();
    assert.equal(r.status, 401, `${r.status} ${r.text}`);
    assert.ok(!fs.existsSync(path.join(h.dir, 'members', 'bee')), 'the member dir did not come back');
    assert.equal(h.ctx.members.get('bee'), null);
  }));
}

test('the page store refuses a write for a member who is not there', () => withBee(async (h) => {
  const store = h.ctx.pages.load('bee');
  h.ctx.pages.save('bee', store);   // positive control
  assert.throws(() => h.ctx.pages.save('nobody', store), (e) => e.code === 'MEMBER_GONE');
  assert.throws(() => h.ctx.pages.addTombstone('nobody', { id: 'p1', kind: 'note', audience: 'public' }), (e) => e.code === 'MEMBER_GONE');
  assert.ok(!fs.existsSync(path.join(h.dir, 'members', 'nobody')));
}));

test('a write from a session ended mid-request (a password change elsewhere) does not land', () => withBee(async (h, admin, bee) => {
  const write = await bee.stream('POST', '/api/posts', { kind: 'note', note: 'stolen session' });
  h.ctx.auth.endSessions('bee');
  const r = await write.finish();
  assert.equal(r.status, 401);
  assert.equal(h.ctx.pages.load('bee').posts.length, 0);
}));

// ── the purge ends every session itself (tests-r1-purge-sessions-masked) ──

test('DELETE /api/me ends every session of the member at once, before any other request', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const ana = await joinInvited(h, admin, { slug: 'ana', email: 'ana@example.test' });
    const other = h.client();
    await other.post('/api/login', { email: 'ana@example.test', password: PASSWORD });
    const anas = () => h.ctx.sessionStore.all().filter((s) => s.member === 'ana');
    assert.equal(anas().length, 2, 'positive control: two live sessions');
    const files = () => fs.readdirSync(path.join(h.dir, 'sessions')).filter((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(h.dir, 'sessions', f), 'utf8')).member === 'ana'; } catch { return false; }
    });
    assert.equal(files().length, 2);

    assert.equal((await ana.del('/api/me', { password: PASSWORD })).status, 200);
    // No other request has run: loadMember has had no chance to end anything.
    assert.equal(anas().length, 0, 'every session ended by the purge itself');
    assert.deepEqual(files(), [], 'no session file names her');
    assert.ok(h.ctx.sessionStore.all().some((s) => s.member === 'ada'), "positive control: the admin's session is untouched");
  } finally { await h.close(); }
});

// ── housekeeping (robustness-r1-12, -14, -11) ──

test('housekeeping: a failing step is logged by name with its stack, and the rest still run', () => withBee(async (h) => {
  const sweep = h.ctx.invites.sweep;
  h.ctx.invites.sweep = () => { throw new Error('EACCES: invites.json'); };
  const sessions = h.ctx.sessionStore.sweep;
  let sessionsRan = false;
  h.ctx.sessionStore.sweep = () => { sessionsRan = true; return 2; };
  try {
    const out = h.ctx.housekeeping.run();
    assert.deepEqual(out.failed, ['invites']);
    assert.ok(sessionsRan, 'a later step still ran');
    assert.equal(out.sessions, 2);
    const line = h.logs.find((l) => l.includes('[housekeeping] invites failed'));
    assert.ok(line && /EACCES: invites\.json/.test(line) && /\n\s+at /.test(line), 'the step name and a stack');
    assert.ok(h.logs.some((l) => /\[housekeeping\] removed .*sessions 2/.test(l)), 'a non-zero run says what it removed');
  } finally { h.ctx.invites.sweep = sweep; h.ctx.sessionStore.sweep = sessions; }
  const quiet = h.logs.length;
  assert.deepEqual(h.ctx.housekeeping.run().failed, [], 'positive control');
  assert.equal(h.logs.length, quiet, 'an empty run logs nothing');
}));

test('housekeeping sweeps crash leftovers: hidden temps, image files with no row, staged keys', () => withBee(async (h, admin, bee) => {
  const key = (await bee.upload(await png())).body.key;
  await bee.post('/api/posts', { kind: 'image', media: { key, alt: '' } });
  const tmp = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.log.json.12345.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(f, 'half');
    return f;
  };
  const temps = [h.dir, path.join(h.dir, 'images'), path.join(h.dir, 'keys'), path.join(h.dir, 'members', 'bee')].map(tmp);
  const orphan = `img_1700000000000_${'a'.repeat(16)}`;
  const orphans = ['', '__web', '__thumb'].map((v) => path.join(h.dir, 'images', orphan + v));
  for (const f of orphans) fs.writeFileSync(f, 'bytes');
  const staged = path.join(h.dir, 'keys', '.staged-0123456789abcdef.pem');
  fs.writeFileSync(staged, 'key');

  const fresh = h.ctx.housekeeping.run();
  assert.equal(fresh.temps + fresh.image_files + fresh.staged_keys, 0, 'positive control: nothing under an hour old goes');
  for (const f of [...temps, ...orphans, staged]) assert.ok(fs.existsSync(f), f);

  clock.set(Date.now() + 2 * 3600_000);
  const out = h.ctx.housekeeping.run();
  assert.equal(out.temps, 4);
  assert.equal(out.image_files, 3);
  assert.equal(out.staged_keys, 1, 'the staged-key sweep reads lib/clock.js');
  for (const f of [...temps, ...orphans, staged]) assert.ok(!fs.existsSync(f), f);
  for (const v of ['', '__web', '__thumb']) assert.ok(fs.existsSync(path.join(h.dir, 'images', key + v)), 'a real image stays');
  assert.ok(fs.existsSync(path.join(h.dir, 'keys', 'bee.pem')));
}));

test('housekeeping trims the log-provider mail outbox past 24 hours; the audit prune is a rename', () => withBee(async (h) => {
  const outbox = path.join(h.dir, 'mail-outbox.jsonl');
  const before = fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(before >= 2);
  h.ctx.audit('old.event', 'bee');
  const ino = fs.statSync(path.join(h.dir, 'audit.log')).ino;
  clock.set(Date.now() + 25 * 3600_000);
  fs.appendFileSync(outbox, `${JSON.stringify({ at: clock.iso(), to: 'x@example.test', subject: 's', text: 't' })}\n`);
  const out = h.ctx.housekeeping.run();
  assert.equal(out.mail_outbox, before);
  assert.equal(fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length, 1, 'the new mail stays');
  assert.equal(out.audit, 0, 'positive control: nothing is 90 days old yet');
  clock.set(Date.now() + 91 * 24 * 3600_000);
  h.ctx.audit('new.event', 'bee');
  assert.ok(h.ctx.housekeeping.run().audit > 0);
  assert.notEqual(fs.statSync(path.join(h.dir, 'audit.log')).ino, ino, 'replaced by rename, never rewritten in place');
  assert.deepEqual(h.ctx.audit.read().map((r) => r.event), ['new.event']);
}));

test('page settings writes are rate limited', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    const ana = await joinAdmin(h, 'ana');
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await ana.put('/api/me/page', { enabled: i % 2 === 0 })).status);
    assert.deepEqual(statuses.slice(0, 60).filter((s) => s !== 200), [], 'positive control: 60 a minute pass');
    assert.equal(statuses[60], 429);
    assert.equal((await ana.patch('/api/me', { display_name: 'x' })).status, 429, 'PATCH /api/me shares the bucket');
  } finally { await h.close(); }
});

// ── client errors are quiet 4xx (security-r1-11) ──

test('a malformed escape or a garbage body is a 4xx that logs nothing; a real fault still logs', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const quiet = h.logs.length;
    const page = await h.client().get('/api/pages/%E0%A4%A');
    assert.equal(page.status, 404);
    assert.equal(page.body.error, 'not_found');
    const img = await h.client().get('/api/images/%E0/web');
    assert.equal(img.status, 404);
    const gz = await h.client().req('POST', '/api/login', { body: 'this is not gzip', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
    assert.ok(gz.status >= 400 && gz.status < 500, `got ${gz.status}`);
    assert.notEqual(gz.body?.error, 'server_error');
    assert.equal(h.logs.length, quiet, `nothing logged:\n${h.logs.slice(quiet).join('\n')}`);

    const load = h.ctx.pages.load;
    h.ctx.pages.load = () => { throw new Error('disk on fire'); };
    try {
      assert.equal((await ana.get('/api/me/page')).status, 500, 'positive control');
    } finally { h.ctx.pages.load = load; }
    assert.ok(h.logs.some((l) => l.includes('disk on fire')));
  } finally { await h.close(); }
});

test('a malformed image path spends the miss budget like any other miss', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    const anon = h.client();
    let last;
    for (let i = 0; i < 101; i++) last = await anon.get('/api/images/%E0/web');
    assert.equal(last.status, 429);
  } finally { await h.close(); }
});

// ── shutdown (robustness-r1-08) ──

test('close() is bounded: a stalled mail flush and a hung request cannot hold it', async () => {
  const h = await boot();
  const ana = await joinAdmin(h, 'ana');
  h.ctx.mailer.flush = () => new Promise(() => {});   // an SMTP server that greets, then stalls
  const ingest = h.ctx.images.ingest;
  h.ctx.images.ingest = () => new Promise(() => {});    // a request that never answers
  const hung = ana.upload(await png()).catch((e) => e);
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await h.close({ drainMs: 300, mailMs: 300 });
  const took = Date.now() - t0;
  assert.ok(took < 3000, `close took ${took} ms`);
  assert.ok(took >= 500, 'it did wait for the drain and the mail first');
  assert.ok((await hung) instanceof Error, 'the hung request was cut');
  assert.ok(h.logs.some((l) => /mail still in flight/.test(l)));
  h.ctx.images.ingest = ingest;
});

test('close() drains: a request in flight finishes before the server goes', async () => {
  const h = await boot();
  const ana = await joinAdmin(h, 'ana');
  const ingest = h.ctx.images.ingest;
  h.ctx.images.ingest = async (...a) => { await new Promise((r) => setTimeout(r, 300)); return ingest(...a); };
  const up = ana.upload(await png());
  await new Promise((r) => setTimeout(r, 100));
  await h.close({ keepData: true });
  assert.equal((await up).status, 201, 'answered, not cut');
  assert.ok(!fs.existsSync(path.join(h.dir, '.lock')), 'and the lock went');
  fs.rmSync(h.dir, { recursive: true, force: true });
});

// ── the data-dir lock is a lease (robustness-r1-06) ──

const lockDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ring-lock-'));
const silent = { warn() {}, error() {}, log() {} };

test('lock: a live holder in another process refuses; its death frees the lock', async () => {
  const dir = lockDir();
  const file = path.join(dir, '.lock');
  const child = spawn(process.execPath, ['-e', `
    const { acquireLock } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'instance.js'))});
    acquireLock(${JSON.stringify(file)}, { logger: { warn() {}, error() {} } });
    console.log('held');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); });
      child.on('exit', () => reject(new Error('child died')));
    });
    assert.throws(() => acquireLock(file, { logger: silent }), /Another Ring process holds/);
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const release = acquireLock(file, { logger: silent });   // same host, dead pid: stale at once
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    release();
    assert.ok(!fs.existsSync(file));
  } finally { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock: another host\'s fresh lock refuses even under our own pid; a stale heartbeat is taken over', () => {
  const dir = lockDir();
  const file = path.join(dir, '.lock');
  try {
    // Two containers on one volume: both are pid 1. Our pid, another hostname.
    fs.writeFileSync(file, JSON.stringify({ token: 'theirs', pid: process.pid, hostname: 'other-container', boot_id: 'x', at: new Date().toISOString() }));
    assert.throws(() => acquireLock(file, { logger: silent }), /Another Ring process holds .*other-container/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'theirs', 'left alone');

    // Same lock, heartbeat gone quiet: stale, taken over.
    const old = new Date(Date.now() - 200_000);
    fs.utimesSync(file, old, old);
    const release = acquireLock(file, { logger: silent });
    const mine = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.notEqual(mine.token, 'theirs');
    assert.equal(mine.hostname, os.hostname());
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('stale')), [], 'the stale file was cleared');

    // Our own pid on THIS host, not held by this process: a previous life.
    release();
    fs.writeFileSync(file, JSON.stringify({ token: 'prev', pid: process.pid, hostname: os.hostname(), boot_id: mine.boot_id, at: new Date().toISOString() }));
    acquireLock(file, { logger: silent })();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock: release only removes our own lock; the heartbeat notices a lock that is no longer ours', () => {
  const dir = lockDir();
  const file = path.join(dir, '.lock');
  try {
    const lost = [];
    const release = acquireLock(file, { logger: silent, onLost: (why) => lost.push(why) });
    const before = fs.statSync(file).mtimeMs;
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    release.heartbeat();
    assert.ok(fs.statSync(file).mtimeMs > before - 1000, 'the heartbeat renews the mtime');
    assert.deepEqual(lost, [], 'positive control: still ours');

    fs.writeFileSync(file, JSON.stringify({ token: 'intruder', pid: 1, hostname: 'elsewhere', at: new Date().toISOString() }));
    release.heartbeat();
    assert.equal(lost.length, 1);
    assert.match(lost[0], /elsewhere/);
    release();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'intruder', 'release never deletes another holder\'s lock');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
