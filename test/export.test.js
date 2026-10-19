'use strict';
/* Gate: the member export (spec 12, 16.3 "export" and the export half of
 * "ids-and-keys"). One standard zip, streamed: posts (archive included) with
 * their ids and URLs, settings, the profile, the friend, following and follower
 * lists (Mastodon's follow-import format), the originals of the member's own
 * images, a manifest whose sizes and hashes match every file. The signing key
 * travels ONLY on the POST with `key: true` and the password typed again; a
 * reset that lands during that check wins. A size cap and a rate limit bound
 * it. Each rule with a positive control. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const bcrypt = require('bcryptjs');
const clock = require('../lib/clock');
const { unzip } = require('./helpers/unzip');
const { png } = require('./helpers/images');
const { crowd, befriend, ring, note } = require('./helpers/social');
const { boot, joinAdmin, PASSWORD, ADMIN_EMAIL } = require('./helpers/harness');

test.afterEach(() => clock.reset());

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* The export as bytes: GET, or POST with a JSON body. */
async function fetchExport(c, body) {
  const res = body === undefined ? await c.raw('GET', '/api/me/export') : await c.raw('POST', '/api/me/export', { json: body });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, json: () => JSON.parse(bytes.toString('utf8')) };
}

/* name -> Buffer, with the one root folder taken off (and asserted). */
function filesOf(bytes) {
  const all = unzip(bytes);
  const roots = new Set([...all.keys()].map((n) => n.split('/')[0]));
  assert.equal(roots.size, 1, 'everything sits in one folder');
  const root = [...roots][0];
  return { root, files: new Map([...all].map(([k, v]) => [k.slice(root.length + 1), v])) };
}

async function upload(c, buf) {
  const r = await c.upload(buf);
  assert.equal(r.status, 201, r.text);
  return r.body.key;
}

test('the export carries posts, settings, profile, lists and the member\'s own images, and its manifest matches every file', async () => {
  const { h, c } = await crowd(['ana', 'bob', 'cy']);
  try {
    const host = new URL(h.base).host;
    await befriend(c, 'ana', 'bob');
    // cy asks, ana lets them follow: a one-way follower, not a friend.
    assert.equal((await c.cy.post('/api/friends', { handle: 'ana' })).status, 200);
    assert.equal((await c.ana.post('/api/followers/cy/accept')).status, 200);

    const imgKey = await upload(c.ana, await png(40, 30, '#a33'));
    const linkKey = await upload(c.ana, await png(20, 20, '#3a3'));
    const avatar = await upload(c.ana, await png(16, 16, '#33a'));
    const bg = await upload(c.ana, await png(24, 24, '#aa3'));
    const bobKey = await upload(c.bob, await png(10, 10, '#000'));
    assert.equal((await c.ana.put('/api/me/page', { enabled: true, avatar_key: avatar, theme: { bg_image_key: bg, bg: '#ffeedd' }, bio: 'a bio', links: [{ label: 'site', href: 'https://ana.example' }] })).status, 200);
    const p1 = await note(c.ana, 'hello world');
    const p2 = await c.ana.post('/api/posts', { kind: 'image', media: { key: imgKey, alt: 'red' } });
    const p3 = await c.ana.post('/api/posts', { kind: 'link', media: { href: 'https://ana.example/x', label: 'a link', key: linkKey } });
    const r = await ring(c, 'ana', ['bob']);
    const room = await note(c.ana, 'in the room', r.id);
    // A week on, the room post is archived by the sweep: the export still has it.
    clock.set(Date.now() + 8 * 24 * 3600_000);
    h.ctx.ringReset.run(h.base);
    clock.reset();

    const ex = await fetchExport(c.ana);
    assert.equal(ex.status, 200, ex.bytes.toString().slice(0, 200));
    assert.equal(ex.headers.get('content-type'), 'application/zip');
    assert.match(ex.headers.get('content-disposition'), /^attachment; filename="ring-ana-\d{4}-\d{2}-\d{2}\.zip"$/);
    assert.equal(ex.headers.get('cache-control'), 'private, no-store');
    const { root, files } = filesOf(ex.bytes);
    assert.match(root, /^ring-ana-\d{4}-\d{2}-\d{2}$/);

    // The manifest names every other file at its exact size and hash, and only those.
    const manifest = JSON.parse(files.get('manifest.json'));
    assert.equal(manifest.format, 'ring-export');
    assert.equal(manifest.handle, `ana@${host}`);
    assert.equal(manifest.key, false);
    const listed = Object.keys(manifest.files).sort();
    assert.deepEqual(listed, [...files.keys()].filter((n) => n !== 'manifest.json').sort());
    for (const [n, meta] of Object.entries(manifest.files)) {
      assert.equal(meta.bytes, files.get(n).length, `${n} size`);
      assert.equal(meta.sha256, sha(files.get(n)), `${n} hash`);
    }

    // Posts: every one, with its id and derived URL, the archive included.
    const posts = JSON.parse(files.get('posts.json'));
    const ids = posts.map((p) => p.id).sort();
    assert.deepEqual(ids, [p1.body.id, p2.body.id, p3.body.id, room.body.id].sort());
    for (const p of posts) assert.equal(p.url, `${h.base}/users/ana/posts/${p.id}`);
    assert.equal(posts.find((p) => p.id === room.body.id).audience, 'archive', 'the archived room post travels');
    assert.equal(posts.find((p) => p.id === p2.body.id).image_file, `images/${imgKey}.png`);
    assert.equal(manifest.counts.posts, 4);

    // Images: the stored originals of the page's own keys, nobody else's.
    const imgs = [...files.keys()].filter((n) => n.startsWith('images/')).sort();
    assert.deepEqual(imgs, [imgKey, linkKey, avatar, bg].map((k) => `images/${k}.png`).sort());
    for (const k of [imgKey, linkKey, avatar, bg]) {
      assert.ok(files.get(`images/${k}.png`).equals(fs.readFileSync(path.join(h.dir, 'images', k))), `${k} is the stored original`);
    }
    assert.ok(!imgs.some((n) => n.includes(bobKey)), 'another member\'s image never rides along');

    // Settings and profile.
    const settings = JSON.parse(files.get('settings.json'));
    assert.equal(settings.display_name, 'Ana Tester');
    assert.equal(settings.enabled, true);
    assert.equal(settings.bio, 'a bio');
    assert.equal(settings.theme.bg, '#ffeedd');
    assert.equal(settings.avatar_file, `images/${avatar}.png`);
    assert.equal(settings.theme.bg_image_file, `images/${bg}.png`);
    const profile = JSON.parse(files.get('profile.json'));
    assert.equal(profile.id, `${h.base}/users/ana`);
    assert.equal(profile.type, 'Person');
    assert.match(profile.publicKey.publicKeyPem, /BEGIN PUBLIC KEY/);

    // Lists: Mastodon's follow-import format, handles as name@host.
    const header = 'Account address,Show boosts,Notify on new posts,Languages';
    assert.equal(files.get('friends.csv').toString(), `${header}\nbob@${host},true,false,\n`);
    assert.equal(files.get('following.csv').toString(), `${header}\nbob@${host},true,false,\n`);
    assert.deepEqual(files.get('followers.csv').toString().trim().split('\n').sort(), ['Account address', `bob@${host}`, `cy@${host}`].sort());

    // No key, anywhere, in the default export.
    assert.ok(!files.has('key.pem'));
    assert.ok(!ex.bytes.includes('PRIVATE KEY'), 'the zip carries no private key');
    const plainPost = await fetchExport(c.ana, {});
    assert.ok(!filesOf(plainPost.bytes).files.has('key.pem'), 'POST without the tick: no key');
    assert.ok(!plainPost.bytes.includes('PRIVATE KEY'));

    // A standard zip: the system's own tool reads it, when there is one.
    let unzipTool = true;
    try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); } catch { unzipTool = false; }
    if (unzipTool) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-export-'));
      try {
        fs.writeFileSync(path.join(tmp, 'x.zip'), ex.bytes);
        execFileSync('unzip', ['-tq', path.join(tmp, 'x.zip')], { stdio: 'pipe' });
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  } finally { await h.close(); }
});

test('the signing key travels only with the tick and the password typed again', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const pem = fs.readFileSync(path.join(h.dir, 'keys', 'ana.pem'), 'utf8');

    const wrong = await fetchExport(ana, { key: true, password: 'not the password' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json().error, 'wrong_password');
    const none = await fetchExport(ana, { key: true });
    assert.equal(none.status, 403, 'no password, no key');
    const odd = await fetchExport(ana, { key: 'yes', password: PASSWORD });
    assert.equal(odd.status, 400, 'the tick is a literal boolean');
    assert.ok(!wrong.bytes.includes('PRIVATE KEY') && !none.bytes.includes('PRIVATE KEY') && !odd.bytes.includes('PRIVATE KEY'));

    const ok = await fetchExport(ana, { key: true, password: PASSWORD });
    assert.equal(ok.status, 200, 'positive control: the tick and the password');
    const { files } = filesOf(ok.bytes);
    assert.equal(files.get('key.pem').toString(), pem, 'the member\'s own key, byte for byte');
    assert.match(files.get('key.pem').toString(), /PRIVATE KEY/);
    const manifest = JSON.parse(files.get('manifest.json'));
    assert.equal(manifest.key, true);
    assert.equal(manifest.files['key.pem'].sha256, sha(Buffer.from(pem)));
    assert.match(files.get('README.txt').toString(), /Anyone with this file can sign as you/);

    // The key never reached a log line or the audit log; the audit says it happened.
    const body = pem.split('\n')[1];
    const audit = fs.readFileSync(path.join(h.dir, 'audit.log'), 'utf8');
    for (const [name, text] of Object.entries({ logs: h.logs.join('\n'), audit })) {
      assert.ok(!text.includes('PRIVATE KEY') && !text.includes(body), `${name} carries no key`);
    }
    const lines = audit.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.event === 'member.exported');
    assert.equal(lines.length, 1, 'one export with the key audited');
    assert.match(JSON.stringify(lines[0]), /"key":true/);
  } finally { await h.close(); }
});

test('a reset that lands while the key export checks the password wins (409, no key)', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const resetHash = await bcrypt.hash('the reset password', 4);
    const real = bcrypt.compare;
    let landed = false;
    bcrypt.compare = async (pw, hash) => {
      const out = await real(pw, hash);
      if (!landed && pw === PASSWORD) {
        landed = true;
        const m = h.ctx.members.byEmail(ADMIN_EMAIL);
        h.ctx.members.update(m.slug, { password_hash: resetHash });
        h.ctx.auth.endSessions(m.slug);
      }
      return out;
    };
    let r;
    try { r = await fetchExport(ana, { key: true, password: PASSWORD }); } finally { bcrypt.compare = real; }
    assert.ok(landed, 'the reset landed inside the compare');
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'password_changed');
    assert.ok(!r.bytes.includes('PRIVATE KEY'));
  } finally { await h.close(); }
});

test('the size cap refuses before a byte of the zip is sent', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const key = await upload(ana, await png(400, 300, '#123'));
    await ana.post('/api/posts', { kind: 'image', media: { key } });
    const ok = await fetchExport(ana);
    assert.equal(ok.status, 200, 'positive control: under the cap');
    h.ctx.exportMaxBytes = ok.bytes.length - 2000;   // under what the export holds
    const r = await fetchExport(ana);
    assert.equal(r.status, 413);
    assert.equal(r.json().error, 'export_too_large');
    assert.notEqual(r.headers.get('content-type'), 'application/zip');
  } finally { await h.close(); }
});

test('the export budget: 3 a minute per member, then 429 with Retry-After', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    const ana = await joinAdmin(h, 'ana');
    for (let i = 0; i < 3; i++) assert.equal((await fetchExport(ana)).status, 200, `export ${i + 1}`);
    const r = await fetchExport(ana);
    assert.equal(r.status, 429);
    assert.equal(r.json().error, 'rate_minute');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await fetchExport(h.client())).status, 401, 'signed out: no export');
  } finally { await h.close(); }
});

test('a page store that names another member\'s image (a hand edit) never exports it', async () => {
  const { h, c } = await crowd(['ana', 'bob']);
  try {
    const mine = await upload(c.ana, await png(12, 12, '#a00'));
    const theirs = await upload(c.bob, await png(12, 12, '#0a0'));
    const store = h.ctx.pages.load('ana');
    h.ctx.pages.save('ana', { ...store, avatar_key: theirs, theme: { ...store.theme, bg_image_key: mine } });
    const { files } = filesOf((await fetchExport(c.ana)).bytes);
    const imgs = [...files.keys()].filter((n) => n.startsWith('images/'));
    assert.deepEqual(imgs, [`images/${mine}.png`], 'positive control: her own background travels');
    assert.ok(!JSON.parse(files.get('settings.json')).avatar_file, 'no file named for the foreign avatar');
  } finally { await h.close(); }
});
