'use strict';
/* Gate: the image door (spec 16.3 "images", 10.4, 10.5). Real-bytes sniff, the
 * size cap, the pixel ceiling, metadata stripped and orientation applied, every
 * original re-encoded, animation kept, server-minted keys, the quota, originals
 * never served. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, joinAdmin, joinInvited, PASSWORD } = require('./helpers/harness');
const { gpsJpeg, png, animatedGif, pngHeaderOnly, gifHeaderOnly, sharp } = require('./helpers/images');
const { KEY_RE, sniffImageType } = require('../lib/images');
const decode = require('../lib/image-decode');

test('a real image is accepted; SVG and HTML named .jpg are refused', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const ok = await ana.upload(await png(), { filename: 'a.png', type: 'image/png' });
    assert.equal(ok.status, 201, 'positive control');
    assert.match(ok.body.key, KEY_RE);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
    for (const [buf, name] of [[svg, 'cat.jpg'], [html, 'dog.jpg']]) {
      const r = await ana.upload(buf, { filename: name, type: 'image/jpeg' });
      assert.equal(r.status, 400, name);
      assert.equal(r.body.error, 'unsupported_image');
    }
    // A JPEG magic number on garbage passes the sniff and still fails the decode.
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    assert.equal((await ana.upload(fake)).body.error, 'image_failed');
    assert.equal(fs.readdirSync(path.join(h.dir, 'images')).length, 3, 'only the good upload landed (original + 2 variants)');

    assert.equal((await h.client().upload(await png())).status, 401, 'members only');
    assert.equal(sniffImageType(svg), null);
  } finally { await h.close(); }
});

test('the size cap and the pixel ceiling answer 413 before anything is written', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10 * 1024 * 1024 + 10)]);
    const r = await ana.upload(big);
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'image_too_large');

    const huge = pngHeaderOnly(10_000, 9_000);   // 90 MP claimed by a few hundred bytes
    assert.ok(huge.length < 1000);
    const p = await ana.upload(huge, { filename: 'scan.png', type: 'image/png' });
    assert.equal(p.status, 413);
    assert.equal(p.body.error, 'too_many_pixels');
    assert.match(p.body.message, /80 megapixels/);
    assert.ok(!fs.existsSync(path.join(h.dir, 'images')) || fs.readdirSync(path.join(h.dir, 'images')).length === 0);

    const fine = await ana.upload(pngHeaderOnly(100, 100), { filename: 'small.png', type: 'image/png' });
    assert.notEqual(fine.body?.error, 'too_many_pixels', 'positive control: a small header is not refused for pixels');
  } finally { await h.close(); }
});

test('GPS and camera metadata are stripped, orientation applied, original re-encoded', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const fixture = await gpsJpeg();
    const fmd = await sharp(fixture).metadata();
    assert.ok(fmd.exif && fixture.includes(Buffer.from('FixtureCam')), 'positive control: the fixture carries EXIF');
    assert.equal(fmd.orientation, 6);
    assert.equal(fmd.width, 40);

    const r = await ana.upload(fixture);
    assert.equal(r.status, 201);
    assert.equal(r.body.width, 20, 'oriented: portrait');
    assert.equal(r.body.height, 40);

    const original = fs.readFileSync(path.join(h.dir, 'images', r.body.key));
    const omd = await sharp(original).metadata();
    assert.equal(omd.format, 'jpeg');
    assert.equal(omd.exif, undefined);
    assert.ok(!original.includes(Buffer.from('FixtureCam')));
    assert.equal(omd.width, 20);
    assert.ok(!omd.orientation || omd.orientation === 1);
    assert.ok(!original.equals(fixture), 're-encoded, never the raw bytes');

    for (const variant of ['web', 'thumb']) {
      const got = await ana.bytes(`/api/images/${r.body.key}/${variant}`);
      assert.equal(got.status, 200);
      assert.equal(got.headers.get('content-type'), 'image/webp');
      const md = await sharp(got.bytes).metadata();
      assert.equal(md.format, 'webp');
      assert.equal(md.exif, undefined);
      assert.ok(!got.bytes.includes(Buffer.from('FixtureCam')));
      assert.equal(md.width, 20);
      assert.equal(md.height, 40);
    }
  } finally { await h.close(); }
});

test('GIF and WebP are re-encoded too, and animation is kept', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const gif = await animatedGif();
    assert.equal((await sharp(gif).metadata()).pages, 3, 'positive control');
    assert.ok(gif.includes(Buffer.from('RING-GIF-COMMENT')), 'positive control: the fixture carries a comment');
    const r = await ana.upload(gif, { filename: 'a.gif', type: 'image/gif' });
    assert.equal(r.status, 201);
    const original = fs.readFileSync(path.join(h.dir, 'images', r.body.key));
    assert.ok(!original.includes(Buffer.from('RING-GIF-COMMENT')), 'a GIF is re-encoded, never written raw');
    assert.equal((await sharp(original).metadata()).pages, 3);
    const web = await ana.bytes(r.body.url);
    assert.equal((await sharp(web.bytes).metadata()).pages, 3, 'the web variant moves');

    const webp = await sharp(await png(50, 30)).webp().withExif({ IFD0: { Make: 'WebpCam' } }).toBuffer();
    assert.ok(webp.includes(Buffer.from('WebpCam')));
    const w = await ana.upload(webp, { filename: 'a.webp', type: 'image/webp' });
    assert.equal(w.status, 201);
    assert.ok(!fs.readFileSync(path.join(h.dir, 'images', w.body.key)).includes(Buffer.from('WebpCam')));
  } finally { await h.close(); }
});

test('keys are server-minted: a client-named key is ignored, and there is no keyed upload door', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const chosen = 'img_1700000000000_aaaaaaaaaaaaaaaa';
    const r = await ana.upload(await png(), { filename: chosen, type: 'image/png', fields: { key: chosen } });
    assert.equal(r.status, 201);
    assert.notEqual(r.body.key, chosen);
    assert.match(r.body.key, KEY_RE);
    const keyed = await ana.upload(await png(), { path: `/api/images/${chosen}` });
    assert.ok([404, 415].includes(keyed.status), `refused, got ${keyed.status}`);
    assert.equal(h.ctx.images.row(chosen), null);
    assert.equal(h.ctx.images.row(r.body.key).owner, 'ana');
  } finally { await h.close(); }
});

test('originals never serve, not even to the owner', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const r = await ana.upload(await png());
    assert.equal((await ana.bytes(`/api/images/${r.body.key}`)).status, 404);
    assert.equal((await ana.bytes(`/api/images/${r.body.key}/original`)).status, 404);
    assert.equal((await ana.bytes(`/api/images/${r.body.key}/web`)).status, 200, 'positive control');
    assert.equal((await ana.bytes('/api/images/..%2Fmembers.json/web')).status, 404);
  } finally { await h.close(); }
});

test('the storage quota answers 413 storage_full', async () => {
  const h = await boot({ env: { MEMBER_STORAGE_MB: '1' } });
  try {
    const ana = await joinAdmin(h, 'ana');
    assert.equal((await ana.upload(await png())).status, 201, 'positive control: a small image fits');
    const noise = await sharp(Buffer.from(Array.from({ length: 700 * 700 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 700, height: 700, channels: 3 } }).png().toBuffer();
    assert.ok(noise.length > 1024 * 1024, 'the noise PNG is over the quota');
    const r = await ana.upload(noise, { filename: 'noise.png', type: 'image/png' });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'storage_full');
    const me = await ana.get('/api/me');
    assert.ok(me.body.storage.used > 0 && me.body.storage.used < me.body.storage.limit);
  } finally { await h.close(); }
});

test('an unposted upload is swept after 24 hours; a referenced one stays', async () => {
  const clock = require('../lib/clock');
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const kept = (await ana.upload(await png())).body.key;
    const loose = (await ana.upload(await png())).body.key;
    const avatar = (await ana.upload(await png())).body.key;
    await ana.post('/api/posts', { kind: 'image', media: { key: kept, alt: 'x' } });
    await ana.put('/api/me/page', { avatar_key: avatar });
    assert.equal(h.ctx.housekeeping.run().images, 0, 'nothing is old yet');
    clock.set(Date.now() + 25 * 3600_000);
    assert.equal(h.ctx.housekeeping.run().images, 1);
    assert.ok(h.ctx.images.row(kept));
    assert.ok(h.ctx.images.row(avatar));
    assert.equal(h.ctx.images.row(loose), null);
    assert.ok(!fs.existsSync(path.join(h.dir, 'images', `${loose}__web`)));
  } finally { clock.reset(); await h.close(); }
});

test('every frame counts: an animated image past the ceiling is refused from its header', async () => {
  const h = await boot();
  try {
    const ana = await joinAdmin(h, 'ana');
    const nine = gifHeaderOnly(5000, 2000, 9);   // 10 MP a frame, 90 MP decoded together
    const md = await sharp(nine).metadata();
    assert.equal(md.pages, 9, 'positive control: sharp reads 9 frames from the fixture');
    assert.equal(md.width * md.height, 10_000_000);
    const r = await ana.upload(nine, { filename: 'a.gif', type: 'image/gif' });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'too_many_pixels');

    // Animated has its own budget (security-r1-05): 25 MP over all frames, at most 200 frames.
    const thirty = await ana.upload(gifHeaderOnly(1000, 1000, 30), { filename: 'b.gif', type: 'image/gif' });
    assert.equal(thirty.status, 413, '30 MP over 30 frames');
    assert.equal(thirty.body.error, 'too_many_pixels');
    assert.match(thirty.body.message, /25 megapixels/);
    const many = await ana.upload(gifHeaderOnly(10, 10, 201), { filename: 'c.gif', type: 'image/gif' });
    assert.equal(many.body.error, 'too_many_pixels', '201 frames');
    assert.ok(!fs.existsSync(path.join(h.dir, 'images')) || fs.readdirSync(path.join(h.dir, 'images')).length === 0, 'nothing landed');

    // Positive controls: under each budget is not a pixel refusal.
    for (const [w, hh, f] of [[1000, 1000, 20], [10, 10, 200], [5000, 2000, 1]]) {
      const ok = await ana.upload(gifHeaderOnly(w, hh, f), { filename: 'ok.gif', type: 'image/gif' });
      assert.notEqual(ok.body?.error, 'too_many_pixels', `${w}x${hh}x${f}`);
    }
  } finally { await h.close(); }
});

test('the decode pipeline carries a timeout and the animated pixel limit', () => {
  const still = decode.decodeImage(Buffer.alloc(16));
  assert.equal(still.options.timeoutSeconds, decode.DECODE_TIMEOUT_S);
  assert.ok(decode.DECODE_TIMEOUT_S > 0 && decode.DECODE_TIMEOUT_S <= 30);
  assert.equal(still.options.input.limitInputPixels, decode.MAX_IMAGE_PIXELS);
  assert.equal(decode.decodeImage(Buffer.alloc(16), { animated: true }).options.input.limitInputPixels, decode.ANIMATED_MAX_PIXELS);
});

test('the decode queue is bounded: past it, a refusal, never another buffer held', async () => {
  const slots = decode.createDecodeSlots(1, { maxWaiting: 2 });
  let release;
  const held = new Promise((r) => { release = r; });
  const running = slots(() => held);
  const queued = [slots(async () => 'a'), slots(async () => 'b')];
  assert.deepEqual(slots.stats(), { active: 1, waiting: 2 });
  await assert.rejects(slots(async () => 'c'), decode.DecodeBusy);
  release('x');
  assert.equal(await running, 'x');
  assert.deepEqual(await Promise.all(queued), ['a', 'b'], 'positive control: the queued ones run');
  assert.equal(await slots(async () => 'd'), 'd', 'and the queue takes work again');
});

test('a full decode queue answers 503 busy through the door', async () => {
  const h = await boot();
  let release;
  const held = new Promise((r) => { release = r; });
  const fillers = [];
  try {
    const ana = await joinAdmin(h, 'ana');
    // Occupy the one slot and every waiting place.
    for (let i = 0; i <= decode.DECODE_WAITING; i++) fillers.push(decode.withDecodeSlot(() => held));
    const r = await ana.upload(await png());
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'busy');
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    release();
    await Promise.all(fillers);
    assert.equal((await ana.upload(await png())).status, 201, 'positive control: free again');
  } finally { release(); await h.close(); }
});

test('the upload gate: one upload per member, a bounded queue, then 503 busy', async () => {
  const h = await boot();
  const ingest = h.ctx.images.ingest;
  let release;
  const held = new Promise((r) => { release = r; });
  try {
    const ana = await joinAdmin(h, 'ana');
    const bob = await joinInvited(h, ana, { slug: 'bob' });
    const cy = await joinInvited(h, ana, { slug: 'cy' });
    h.ctx.uploadGate.active = 1;
    h.ctx.uploadGate.waiting = 1;
    let entered = 0;
    h.ctx.images.ingest = async (...a) => { entered++; await held; return ingest(...a); };
    const img = await png();

    const first = ana.upload(img);
    while (entered < 1) await new Promise((r) => setTimeout(r, 10));
    const again = await ana.upload(img);
    assert.equal(again.status, 429, 'one upload per member at a time');
    assert.equal(again.body.error, 'upload_in_progress');
    const second = bob.upload(img);   // waits in the queue, its body unread
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.ctx.uploadGate.queue.length, 1);
    const third = await cy.upload(img);
    assert.equal(third.status, 503);
    assert.equal(third.body.error, 'busy');
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.equal(entered, 1, 'the queued upload has not reached the decoder');

    release();
    assert.equal((await first).status, 201);
    assert.equal((await second).status, 201, 'positive control: the queued one runs when a slot frees');
    assert.equal(h.ctx.uploadGate.running, 0);
    assert.equal(h.ctx.uploadGate.members.size, 0);
    assert.equal((await cy.upload(img)).status, 201);
  } finally { release(); h.ctx.images.ingest = ingest; await h.close(); }
});

test('an upload whose owner is deleted while it decodes writes nothing', async () => {
  const h = await boot();
  let release;
  const held = new Promise((r) => { release = r; });
  try {
    const admin = await joinAdmin(h, 'ada');
    const bee = await joinInvited(h, admin, { slug: 'bee' });
    const filler = decode.withDecodeSlot(() => held);   // the upload waits in the slot queue
    const up = bee.upload(await png());
    await new Promise((r) => setTimeout(r, 100));
    const other = h.client();
    await other.post('/api/login', { email: 'bee@example.test', password: PASSWORD });
    assert.equal((await other.del('/api/me', { password: PASSWORD })).status, 200);
    release();
    await filler;
    const r = await up;
    assert.equal(r.status, 401, `got ${r.status} ${r.text}`);
    assert.equal(h.ctx.images.keysOf('bee').length, 0, 'no row for the deleted owner');
    const files = fs.existsSync(path.join(h.dir, 'images')) ? fs.readdirSync(path.join(h.dir, 'images')) : [];
    assert.deepEqual(files.filter((f) => !f.startsWith('.')), [], 'no bytes either');
    assert.equal((await admin.upload(await png())).status, 201, 'positive control: a live member still uploads');
  } finally { release(); await h.close(); }
});
