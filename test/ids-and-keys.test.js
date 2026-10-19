'use strict';
/* Gate: ids and keys (spec 16.3 "ids-and-keys", the P1 half; the export half,
 * the key only with the tick and the password, is test/export.test.js). A keypair before the row, owner-only key files, no private key anywhere it
 * can leak, CSPRNG ids never reused, derivable URLs, the handle rule. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('../lib/clock');
const ids = require('../lib/ids');
const { toHandle, normalizeHost } = require('../lib/handles');
const { boot, joinAdmin, joinInvited, Client, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

test('the keypair exists before the member row, 0600 in a 0700 dir, and verifies', async () => {
  const h = await boot();
  try {
    const seen = [];
    const insert = h.ctx.members.insert;
    h.ctx.members.insert = (row) => { seen.push([row.slug, h.ctx.keys.has(row.slug)]); return insert(row); };
    await joinAdmin(h, 'ana');
    assert.deepEqual(seen, [['ana', true]], 'the key file was there when the row was written');

    const keysDir = path.join(h.dir, 'keys');
    assert.equal(fs.statSync(keysDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(keysDir, 'ana.pem')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(keysDir).filter((f) => f.startsWith('.')), [], 'no staging leftovers');

    // A real RSA 2048 pair: sign with the private half, verify with the public one.
    const priv = h.ctx.keys.privateKey('ana');
    assert.equal(priv.asymmetricKeyDetails.modulusLength, 2048);
    const sig = crypto.sign('sha256', Buffer.from('hello'), priv);
    assert.ok(crypto.verify('sha256', Buffer.from('hello'), h.ctx.keys.publicKeyPem('ana'), sig));
    assert.match(h.ctx.keys.publicKeyPem('ana'), /BEGIN PUBLIC KEY/);
  } finally { await h.close(); }
});

test('a failed confirm leaves no key behind', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const code = (await admin.post('/api/invites')).body.code;
    await h.client().post('/api/signup', { email: 'a1@example.test', password: PASSWORD, slug: 'same', invite: code });
    const code2 = (await admin.post('/api/invites')).body.code;
    await h.client().post('/api/signup', { email: 'a2@example.test', password: PASSWORD, slug: 'same', invite: code2 });
    assert.equal((await h.client().post('/api/signup/confirm', { token: h.lastTokenTo('a1@example.test'), password: PASSWORD })).status, 200);
    const pemBefore = fs.readFileSync(path.join(h.dir, 'keys', 'same.pem'), 'utf8');
    const lost = await h.client().post('/api/signup/confirm', { token: h.lastTokenTo('a2@example.test'), password: PASSWORD });
    assert.equal(lost.status, 409);
    assert.equal(fs.readFileSync(path.join(h.dir, 'keys', 'same.pem'), 'utf8'), pemBefore, 'the winner keeps its key');
    assert.deepEqual(fs.readdirSync(path.join(h.dir, 'keys')).filter((f) => f.startsWith('.')), []);
  } finally { await h.close(); }
});

test('no HTTP response, log line, audit row or mail contains a private key', async () => {
  const h = await boot();
  const bodies = [];
  const req = Client.prototype.req;
  Client.prototype.req = async function (...a) {
    const r = await req.apply(this, a);
    bodies.push(r.text);
    for (const [, v] of r.headers) bodies.push(v);
    return r;
  };
  try {
    const admin = await joinAdmin(h);
    const bob = await joinInvited(h, admin, { slug: 'bob' });
    await bob.get('/api/me');
    await bob.get('/api/me/page');
    await bob.put('/api/me/page', { enabled: true });
    await bob.post('/api/posts', { kind: 'note', note: 'hi' });
    await h.client().get('/api/pages/bob');
    await bob.get('/api/invites');
    await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'wrong wrong' });
    await bob.post('/api/signup/confirm', { token: 'nope' });

    const pem = fs.readFileSync(path.join(h.dir, 'keys', 'bob.pem'), 'utf8');
    assert.match(pem, /PRIVATE KEY/, 'positive control: the file itself holds it');
    const body = pem.split('\n')[1];   // a line of the key material itself
    const haystacks = {
      responses: bodies.join('\n'),
      logs: h.logs.join('\n'),
      audit: fs.readFileSync(path.join(h.dir, 'audit.log'), 'utf8'),
      mail: fs.readFileSync(path.join(h.dir, 'mail-outbox.jsonl'), 'utf8'),
    };
    assert.ok(haystacks.responses.length > 1000 && haystacks.audit.length > 10, 'the haystacks are not empty');
    for (const [name, text] of Object.entries(haystacks)) {
      assert.ok(!text.includes('PRIVATE KEY'), `${name} mentions PRIVATE KEY`);
      assert.ok(!text.includes(body), `${name} carries key material`);
    }
  } finally {
    Client.prototype.req = req;
    await h.close();
  }
});

test('post ids are CSPRNG-minted and never reused after delete; URLs are derived', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const r = await ana.post('/api/posts', { kind: 'note', note: 'first' });
    assert.equal(r.status, 201);
    assert.match(r.body.id, /^p[0-9a-z]{16}$/);
    assert.equal(r.body.url, `${h.base}/users/ana/posts/${r.body.id}`);
    assert.equal(r.body.wall_url, `${h.base}/@ana#${r.body.id}`);
    assert.ok(!('url' in JSON.parse(fs.readFileSync(path.join(h.dir, 'members', 'ana', 'log.json'), 'utf8')).posts[0]), 'the URL is derived, never stored');
    const own = await ana.post('/api/posts', { kind: 'note', note: 'x', id: 'pclientchosen0000', created_at: '1999-01-01T00:00:00.000Z' });
    assert.notEqual(own.body.id, 'pclientchosen0000', 'a client id is ignored');
    assert.notEqual(own.body.created_at, '1999-01-01T00:00:00.000Z');

    // Force the generator to repeat itself: the tombstone makes the server mint again.
    clock.set(Date.parse('2026-10-14T12:00:00Z'));
    const realRandom = crypto.randomBytes;
    const fixed = Buffer.alloc(16, 7);
    let forced = 0;   // how many of the next 16-byte draws repeat `fixed`
    crypto.randomBytes = (n, ...rest) => {
      if (n === 16 && forced > 0) { forced--; return Buffer.from(fixed); }
      return realRandom(n, ...rest);
    };
    let first;
    try {
      forced = 1;
      first = (await ana.post('/api/posts', { kind: 'note', note: 'doomed' })).body.id;
      assert.equal((await ana.del(`/api/posts/${first}`)).status, 200);
      forced = 1;   // the first candidate is the deleted id again
      const again = (await ana.post('/api/posts', { kind: 'note', note: 'reborn' })).body.id;
      assert.equal(forced, 0, 'the forced draw was used');
      assert.notEqual(again, first, 'a deleted id never comes back');
    } finally { crypto.randomBytes = realRandom; }
    const tomb = JSON.parse(fs.readFileSync(path.join(h.dir, 'members', 'ana', 'tombstones.json'), 'utf8'));
    assert.ok(tomb.some((t) => t.id === first));
  } finally { await h.close(); }
});

test('the id minters: prefixes, shapes, CSPRNG source, no collisions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ids.js'), 'utf8');
  assert.ok(!/Math\.random\(/.test(src), 'no Math.random in lib/ids.js');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(ids.newPostId());
  assert.equal(seen.size, 2000);
  assert.match(ids.newPostId(), /^p[0-9a-z]{16}$/);
  assert.match(ids.newStampId(), /^stmp_[0-9a-z]{16}$/);
  assert.match(ids.newCommentId(), /^lc_[0-9a-z]{16}$/);
  assert.match(ids.newRingId(), /^ring_[0-9a-f]{20}$/);
  // The random tail is uniform over base36: every symbol shows up.
  const tail = Array.from({ length: 400 }, () => ids.randomBase36(8)).join('');
  assert.equal(new Set(tail).size, 36);
  assert.match(ids.newToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ids.tokenHash('x').length, 64);
});

test('the handle rule: bare names here, name@host there, this host folded', () => {
  const here = 'ring.example';
  assert.equal(toHandle('Ana', here), 'ana');
  assert.equal(toHandle('@ana@ring.example', here), 'ana', 'name@<this host> is never written');
  assert.equal(toHandle('acct:Ana@Other.Example', here), 'ana@other.example');
  assert.equal(toHandle('ana@bücher.de', here), 'ana@xn--bcher-kva.de', 'punycode host');
  assert.equal(toHandle('ana@other.example:8443', here), '', 'no port outside tests');
  assert.equal(toHandle('ana@127.0.0.1:3000', here, { allowPort: true }), 'ana@127.0.0.1:3000');
  assert.equal(toHandle('bad name', here), '');
  assert.equal(toHandle('a@b', here), '', 'a host needs a dot');
  assert.equal(normalizeHost('Sub.Example.COM'), 'sub.example.com');
});

test('invite and member rows hold handles', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h, 'ana');
    await joinInvited(h, admin, { slug: 'bob' });
    const inv = JSON.parse(fs.readFileSync(path.join(h.dir, 'invites.json'), 'utf8'));
    assert.equal(inv[0].created_by, 'ana');
    assert.equal(inv[0].used_by, 'bob');
    assert.equal(h.ctx.members.get('bob').invited_by, 'ana');
    const img = await admin.upload(await png(), { filename: 'a.png', type: 'image/png' });
    assert.equal(h.ctx.images.row(img.body.key).owner, 'ana');
  } finally { await h.close(); }
});

test('instance.json records the origin; a federated server refuses another origin', async () => {
  const h = await boot({ env: { PUBLIC_ORIGIN: 'https://one.example' } });
  const dir = h.dir;
  await h.close({ keepData: true });
  try {
    const inst = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    assert.equal(inst.origin, 'https://one.example');
    assert.equal(inst.federated_at, null);
    assert.equal(inst.schema, 1);

    // Not federated yet: the origin may move.
    const h2 = await boot({ dataDir: dir, env: { PUBLIC_ORIGIN: 'https://two.example' } });
    await h2.close({ keepData: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8')).origin, 'https://two.example');

    // Federated: never.
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    f.federated_at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(f));
    await assert.rejects(boot({ dataDir: dir, env: { PUBLIC_ORIGIN: 'https://three.example' } }), /federated as https:\/\/two\.example/);
    const ok = await boot({ dataDir: dir, env: { PUBLIC_ORIGIN: 'https://two.example' } });
    await ok.close({ keepData: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one process per data dir', async () => {
  const h = await boot();
  try {
    await assert.rejects(boot({ dataDir: h.dir }), /already uses this data dir/);
    assert.ok(fs.existsSync(path.join(h.dir, '.lock')));
  } finally { await h.close(); }
});
