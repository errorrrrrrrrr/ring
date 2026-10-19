'use strict';
/* Gate: activity-shapes (spec 16.3, P2). Every local social act emits exactly the
 * ActivityStreams activity P5 to P7 send, delivered in-process through
 * lib/outbox.js. Each act's emissions are recorded through the outbox tap,
 * normalized (the test origin becomes https://h, each minted id, code, key and
 * instant a numbered placeholder, by first appearance, so the links between
 * activities stay pinned) and compared with test/fixtures/activities/<act>.json.
 * `UPDATE_FIXTURES=1` rewrites the fixtures: read the diff before committing it.
 *
 * Beside the fixtures, the rules the spec states outright are asserted on every
 * emission: the context and its `ring` term, no `totalItems` or count anywhere, a
 * public Note to as:Public with followers in cc, a room Note to its Group only,
 * nothing for an archive post or a divider. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../lib/clock');
const { CONTEXT, RING_NS } = require('../lib/activities');
const { crowd, ring, note, codeOf } = require('./helpers/social');
const { png } = require('./helpers/images');

const DIR = path.join(__dirname, 'fixtures', 'activities');
const UPDATE = process.env.UPDATE_FIXTURES === '1';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

test.afterEach(() => clock.reset());

/* Placeholders by first appearance, one counter per kind. */
function normalizer(base) {
  const seen = new Map();
  const counts = {};
  const ph = (kind, v) => {
    const k = `${kind}:${v}`;
    if (!seen.has(k)) { counts[kind] = (counts[kind] || 0) + 1; seen.set(k, `<${kind}${counts[kind]}>`); }
    return seen.get(k);
  };
  const host = new URL(base).host;
  const str = (s) => s
    .split(base).join('https://h')
    .split(`@${host}`).join('@h')
    .split(host).join('h')   // P7: a Group names the hosts its members are on
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, (m) => ph('time', m))
    .replace(/\/activities\/a[0-9a-z]+/g, (m) => `/activities/${ph('act', m)}`)
    .replace(/stmp_[0-9a-z]+/g, (m) => ph('stamp', m))
    .replace(/lc_[0-9a-z]+/g, (m) => ph('comment', m))
    .replace(/ring_[0-9a-f]{20}/g, (m) => ph('ring', m))
    .replace(/\/posts\/p[0-9a-z]{16}/g, (m) => `/posts/${ph('post', m)}`)
    .replace(/#p[0-9a-z]{16}/g, (m) => `#${ph('post', `/posts/${m.slice(1)}`)}`)
    .replace(/img_\d+_[0-9a-f]{16}/g, (m) => ph('image', m))
    .replace(/\/rings\/join\/[A-Za-z0-9_-]{27}/g, (m) => `/rings/join/${ph('code', m)}`);
  // (a bare code, the Join's ring.code, shares its link's placeholder: see walk)
  const walk = (v) => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'code' && typeof x === 'string' ? ph('code', `/rings/join/${x}`) : walk(x)]));
    }
    return v;
  };
  return walk;
}

function recorder(h) {
  let got = [];
  h.ctx.outbox.tap(({ activity, to }) => got.push({ to, activity: JSON.parse(JSON.stringify(activity)) }));
  return {
    take() { const out = got; got = []; return out; },
  };
}

/* The rules every emission keeps, whatever the fixture says. */
function rules(list) {
  for (const { activity: a } of list) {
    assert.deepEqual(a['@context'], JSON.parse(JSON.stringify(CONTEXT)), `${a.type}: the inline context`);
    assert.equal(a['@context'][2].ring, `${RING_NS}data`);
    assert.ok(!JSON.stringify(a).includes('totalItems'), `${a.type}: no totalItems`);
    const notes = [a.object, a.object?.object].filter((o) => o && typeof o === 'object' && o.type === 'Note' && !o.inReplyTo);
    for (const n of notes) {
      if (n.audience) {
        assert.deepEqual(n.to, [n.audience], 'a room Note: to its Group only');
        assert.deepEqual(n.cc, []);
        assert.ok(!JSON.stringify(n).includes(PUBLIC), 'never Public');
        assert.ok(n.ring.room && n.ring.expires);
      } else {
        assert.deepEqual(n.to, [PUBLIC], 'a public Note: to Public');
        assert.match(n.cc[0], /\/followers$/, 'cc followers');
      }
    }
  }
}

function pin(name, list, base) {
  rules(list);
  const norm = normalizer(base)(list);
  const file = path.join(DIR, `${name}.json`);
  if (UPDATE || !fs.existsSync(file)) {
    if (!UPDATE) assert.fail(`no fixture ${name}.json: run with UPDATE_FIXTURES=1 and review it`);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(norm, null, 2)}\n`);
    return;
  }
  assert.deepEqual(norm, JSON.parse(fs.readFileSync(file, 'utf8')), `${name}: the emitted activities changed`);
}

test('follows: befriend, confirm, sever, let follow, decline', async () => {
  clock.set(Date.parse('2026-10-15T09:00:00.000Z'));
  const { h, c } = await crowd(['ana', 'bram', 'coco']);
  try {
    const rec = recorder(h);
    await c.ana.post('/api/friends', { handle: 'bram' });
    pin('befriend', rec.take(), h.base);
    await c.bram.post('/api/friends/ana/confirm');
    pin('confirm', rec.take(), h.base);
    await c.ana.del('/api/friends/bram');
    pin('sever', rec.take(), h.base);
    await c.coco.post('/api/friends', { handle: 'ana' });
    rec.take();
    await c.ana.post('/api/followers/coco/accept');
    pin('let-follow', rec.take(), h.base);
    await c.ana.post('/api/followers/coco/reject');
    pin('decline', rec.take(), h.base);
  } finally { await h.close(); }
});

test('posts: create, edit, pin, delete, Keep; nothing for an archive post, a divider or a page that is off', async () => {
  clock.set(Date.parse('2026-10-15T09:00:00.000Z'));
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    const rec = recorder(h);
    const { id } = await ring(c, 'ana', ['bram']);
    rec.take();
    await note(c.ana, 'page off: nowhere new');
    assert.deepEqual(rec.take(), [], 'page off: no Create');
    await c.ana.put('/api/me/page', { enabled: true });
    const key = (await c.ana.upload(await png())).body.key;
    const post = (await c.ana.post('/api/posts', { kind: 'image', media: { key, alt: 'three prints', href: 'https://ana.example/prints' }, note: 'new prints *drying*', kaomoji: '(´ ▽ ` )', cw: 'flash' })).body.id;
    pin('create-public', rec.take(), h.base);
    await c.ana.post('/api/posts', { kind: 'divider', media: { variant: 'stars' } });
    assert.deepEqual(rec.take(), [], 'a divider never federates');
    await c.ana.post('/api/posts', { kind: 'link', media: { href: 'https://ana.example', label: 'my site', sub: 'a sub line' } });
    pin('create-link', rec.take(), h.base);
    await c.ana.post('/api/posts', { kind: 'embed', media: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
    pin('create-embed', rec.take(), h.base);
    clock.advance(60_000);
    await c.ana.patch(`/api/posts/${post}`, { note: 'dry now' });
    pin('edit', rec.take(), h.base);
    await c.ana.patch(`/api/posts/${post}`, { note: 'dry now' });
    assert.deepEqual(rec.take(), [], 'a PATCH that changes nothing sends nothing');
    await c.ana.patch(`/api/posts/${post}`, { pinned: true });
    pin('pin', rec.take(), h.base);
    await c.ana.patch(`/api/posts/${post}`, { pinned: false });
    pin('unpin', rec.take(), h.base);
    await c.ana.del(`/api/posts/${post}`);
    pin('delete', rec.take(), h.base);

    const room = (await note(c.ana, 'in the room', id)).body.id;
    pin('create-room', rec.take(), h.base);
    await c.ana.post(`/api/posts/${room}/keep`);
    pin('keep-room', rec.take(), h.base);
    const later = (await note(c.ana, 'clears in a week', id)).body.id;
    rec.take();
    clock.advance(8 * 86400_000);
    h.ctx.ringReset.run(h.base);
    pin('reset', rec.take(), h.base);
    await c.ana.post(`/api/posts/${later}/keep`);
    pin('keep-archive', rec.take(), h.base);
  } finally { await h.close(); }
});

test('stamps and comments: on a public post and on a room post; take back', async () => {
  clock.set(Date.parse('2026-10-15T09:00:00.000Z'));
  const { h, c } = await crowd(['ana', 'bram']);
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await c.ana.post('/api/friends', { handle: 'bram' });
    await c.bram.post('/api/friends/ana/confirm');
    const { id } = await ring(c, 'ana', ['bram']);
    const pub = (await note(c.ana, 'public')).body.id;
    const room = (await note(c.ana, 'room', id)).body.id;
    const rec = recorder(h);
    let r = await c.bram.post(`/api/pages/ana/posts/${pub}/stamp`, { kaomoji: '🌞' });
    pin('stamp', rec.take(), h.base);
    await c.bram.del(`/api/pages/ana/posts/${pub}/stamp/${r.body.stamps[0].id}`);
    pin('stamp-take-back', rec.take(), h.base);
    r = await c.bram.post(`/api/pages/ana/posts/${room}/stamp`, { kaomoji: '🦑 ink' });
    pin('stamp-room-custom', rec.take(), h.base);
    await c.ana.del(`/api/pages/ana/posts/${room}/stamp/${r.body.stamps[0].id}`);
    pin('stamp-owner-removes-room', rec.take(), h.base);
    r = await c.bram.post(`/api/pages/ana/posts/${pub}/comment`, { body: 'that blue <b>is</b> worth it' });
    pin('comment', rec.take(), h.base);
    await c.bram.del(`/api/pages/ana/posts/${pub}/comment/${r.body.comments[0].id}`);
    pin('comment-take-back', rec.take(), h.base);
    await c.bram.post(`/api/pages/ana/posts/${room}/comment`, { body: 'in the room' });
    pin('comment-room', rec.take(), h.base);
  } finally { await h.close(); }
});

test('every ring act', async () => {
  clock.set(Date.parse('2026-10-15T09:00:00.000Z'));
  const { h, c } = await crowd(['ana', 'bram', 'coco', 'dora']);
  try {
    const rec = recorder(h);
    const made = (await c.ana.post('/api/rings', { name: 'Print Club' })).body;
    assert.deepEqual(rec.take(), [], 'creating a ring is local: a home row');
    const id = made.id;
    await note(c.ana, 'already in the room', id);
    rec.take();
    await c.bram.post(`/api/rings/join/${codeOf(made)}`);
    pin('ring-ask', rec.take(), h.base);
    await c.ana.post(`/api/rings/${id}/requests/bram`, { approve: true });
    pin('ring-approve', rec.take(), h.base);
    await c.coco.post(`/api/rings/join/${codeOf(made)}`);
    rec.take();
    await c.bram.post(`/api/rings/${id}/requests/coco`, { approve: false });
    pin('ring-decline', rec.take(), h.base);
    await c.bram.patch(`/api/rings/${id}`, { name: 'Thursday' });
    pin('ring-rename', rec.take(), h.base);
    const rot = (await c.bram.post(`/api/rings/${id}/link`)).body;
    pin('ring-rotate', rec.take(), h.base);
    await c.ana.del(`/api/rings/${id}/link`);
    pin('ring-close-link', rec.take(), h.base);
    assert.ok(rot.join);
    const code = codeOf((await c.ana.post(`/api/rings/${id}/link`)).body);
    for (const n of ['coco', 'dora']) {
      await c[n].post(`/api/rings/join/${code}`);
      await c.ana.post(`/api/rings/${id}/requests/${n}`, { approve: true });
    }
    rec.take();
    await c.ana.del(`/api/rings/${id}/members/dora`);
    pin('ring-kick', rec.take(), h.base);
    await c.coco.post(`/api/rings/${id}/leave`);
    pin('ring-leave', rec.take(), h.base);
    await c.ana.del(`/api/rings/${id}`);
    pin('ring-delete', rec.take(), h.base);
  } finally { await h.close(); }
});
