'use strict';
/* Gate: fed-shapes (spec 4.1, 4.3, 4.4, 8.1, 8.2, 16.3). What other servers
 * read from Ring has the shape they expect, held against documents RECORDED from
 * a real Mastodon 4.7.2 server (mas.to, the project's own @mastodon account,
 * fetched 2026-10-15: test/fixtures/fediverse/mastodon-*.json) and against the
 * NodeInfo 2.0 and 2.1 JSON schemas vendored from github.com/jhass/nodeinfo.
 * Ring publishes no counts: no `totalItems` anywhere, no numbers in NodeInfo's
 * usage. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fedRing, fakeMastodon, fixture } = require('./helpers/fediverse');
const { crowd } = require('./helpers/social');
const { RING_NS } = require('../lib/activities');

const AP = { accept: 'application/activity+json' };
const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/* A JSON-schema (draft-04) checker for the keywords the NodeInfo schemas use. */
function validate(schema, v, at = '$') {
  const errs = [];
  const t = typeOf(v);
  if (schema.type) {
    const ok = schema.type === 'integer' ? Number.isInteger(v) : schema.type === t;
    if (!ok) errs.push(`${at}: not ${schema.type}`);
  }
  if (schema.enum && !schema.enum.some((e) => e === v)) errs.push(`${at}: not one of ${schema.enum.join(',')}`);
  if (schema.pattern && typeof v === 'string' && !new RegExp(schema.pattern).test(v)) errs.push(`${at}: does not match ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof v === 'number' && v < schema.minimum) errs.push(`${at}: under ${schema.minimum}`);
  if (t === 'array') {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems}`);
    if (schema.items) v.forEach((x, i) => { errs.push(...validate(schema.items, x, `${at}[${i}]`)); });
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in v)) errs.push(`${at}: missing ${k}`);
    if (schema.minProperties !== undefined && Object.keys(v).length < schema.minProperties) errs.push(`${at}: too few properties`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
    }
  }
  return errs;
}

/* Every key anywhere in a document. */
function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

test('WebFinger for acct: and URL resources matches the recorded Mastodon JRD; unknown, retired, suspended 404', async () => {
  const { h, c } = await fedRing(['ana', 'bram', 'coco']);
  try {
    const host = new URL(h.base).host;
    const rec = fixture('mastodon-webfinger.json');
    const recRels = new Map(rec.links.map((l) => [l.rel, l]));
    const wf = (resource) => fetch(`${h.base}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
    const r = await wf(`acct:ana@${host}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/jrd\+json/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const jrd = await r.json();
    assert.deepEqual(Object.keys(jrd).sort(), Object.keys(rec).sort(), 'subject, aliases, links: as Mastodon');
    assert.equal(jrd.subject, `acct:ana@${host}`);
    assert.deepEqual(jrd.aliases.map(typeOf), rec.aliases.map(typeOf));
    for (const l of jrd.links) {
      const m = recRels.get(l.rel);
      assert.ok(m, `Mastodon carries rel ${l.rel}`);
      assert.deepEqual(Object.keys(l).sort(), Object.keys(m).sort(), `link ${l.rel} keys`);
      if (m.type) assert.equal(l.type, m.type);
    }
    assert.equal(jrd.links.find((l) => l.rel === 'self').href, `${h.base}/users/ana`);
    for (const res of [`${h.base}/users/ana`, `${h.base}/@ana`, `acct:@ana@${host}`, `ACCT:Ana@${host.toUpperCase()}`]) {
      const again = await wf(res);
      assert.equal(again.status, 200, res);
      assert.deepEqual(await again.json(), jrd, `${res}: the same JRD`);
    }
    // The page switch does not matter: names are public.
    await c.bram.put('/api/me/page', { enabled: false });
    assert.equal((await wf(`acct:bram@${host}`)).status, 200, 'a page that is off still resolves');
    // The instance actor.
    const inst = await (await wf(`acct:${host}@${host}`)).json();
    assert.equal(inst.links[0].href, `${h.base}/actor`);
    // Unknown, other host, suspended, retired.
    assert.equal((await wf(`acct:nobody@${host}`)).status, 404);
    assert.equal((await wf('acct:ana@elsewhere.example')).status, 404);
    assert.equal((await fetch(`${h.base}/.well-known/webfinger`)).status, 400);
    h.ctx.members.update('coco', { status: 'suspended' });
    assert.equal((await wf(`acct:coco@${host}`)).status, 404, 'suspended');
    const del = await c.bram.del('/api/me', { password: require('./helpers/harness').PASSWORD });
    assert.equal(del.status, 200, del.text);
    assert.equal((await wf(`acct:bram@${host}`)).status, 404, 'retired');
  } finally { await h.close(); }
});

test('the Person carries every field the recorded Mastodon actor does that Mastodon needs; minimal when off; 404 suspended; 410 deleted', async () => {
  const { h, c } = await fedRing(['ana', 'bram', 'coco']);
  try {
    await c.ana.put('/api/me/page', { bio: 'prints and *paper*', indexable: true, links: [{ label: 'site', href: 'https://ana.example/' }], theme: { bg: '#ffeedd' } });
    const rec = fixture('mastodon-actor.json');
    const r = await fetch(`${h.base}/users/ana`, { headers: AP });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/activity\+json/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('vary') || '', /Accept/);
    const p = await r.json();
    const REQUIRED = ['id', 'type', 'inbox', 'outbox', 'followers', 'following', 'featured', 'preferredUsername', 'name', 'url', 'manuallyApprovesFollowers'];
    for (const k of REQUIRED) {
      assert.ok(k in p, `Person has ${k}`);
      assert.equal(typeOf(p[k]), typeOf(rec[k]), `${k} is a ${typeOf(rec[k])}, as Mastodon's`);
    }
    for (const k of ['id', 'owner', 'publicKeyPem']) assert.equal(typeOf(p.publicKey[k]), typeOf(rec.publicKey[k]), `publicKey.${k}`);
    assert.equal(typeOf(p.endpoints.sharedInbox), typeOf(rec.endpoints.sharedInbox));
    assert.equal(p.type, 'Person');
    assert.equal(p.id, `${h.base}/users/ana`);
    assert.equal(p.publicKey.id, `${p.id}#main-key`);
    assert.equal(p.publicKey.owner, p.id);
    assert.match(p.publicKey.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
    assert.ok(!JSON.stringify(p).includes('PRIVATE KEY'));
    assert.equal(p.manuallyApprovesFollowers, true, 'asks unless open_follows');
    assert.equal(p.discoverable, true);
    assert.equal(p.indexable, true);
    assert.equal(p.summary, '<p>prints and <em>paper</em></p>');
    assert.equal(p.attachment[0].type, 'PropertyValue');
    assert.match(p.attachment[0].value, /rel="me nofollow noopener"/);
    assert.equal(p.ring.v, 1);
    assert.equal(p.ring.theme.bg, '#ffeedd');
    assert.equal(p['@context'][2].ring, `${RING_NS}data`, 'the context carries the ring term');

    await c.ana.put('/api/me/page', { open_follows: true });
    assert.equal((await (await fetch(`${h.base}/users/ana`, { headers: AP })).json()).manuallyApprovesFollowers, false);

    // Page off: the minimal Person, nothing the page shows.
    await c.bram.put('/api/me/page', { enabled: false, bio: 'secret bio' });
    const off = await (await fetch(`${h.base}/users/bram`, { headers: AP })).json();
    assert.deepEqual(Object.keys(off).filter((k) => k !== '@context').sort(),
      ['endpoints', 'featured', 'followers', 'following', 'id', 'inbox', 'manuallyApprovesFollowers', 'name', 'outbox', 'preferredUsername', 'publicKey', 'type'].sort());
    assert.ok(!JSON.stringify(off).includes('secret bio'));

    h.ctx.members.update('coco', { status: 'suspended' });
    assert.equal((await fetch(`${h.base}/users/coco`, { headers: AP })).status, 404, 'suspended');
    await c.bram.del('/api/me', { password: require('./helpers/harness').PASSWORD });
    const gone = await fetch(`${h.base}/users/bram`, { headers: AP });
    assert.equal(gone.status, 410, 'deleted: 410 forever');
    assert.equal((await gone.json()).type, 'Tombstone');
    assert.equal((await fetch(`${h.base}/users/nobody`, { headers: AP })).status, 404);

    // The instance actor: an Application with a key.
    const inst = await (await fetch(`${h.base}/actor`, { headers: AP })).json();
    assert.equal(inst.type, 'Application');
    assert.equal(inst.preferredUsername, new URL(h.base).host);
    assert.equal(inst.publicKey.owner, inst.id);
  } finally { await h.close(); }
});

test('NodeInfo 2.1 and 2.0 validate against the vendored schemas; `ring`, ringProtocol 1, no numbers', async () => {
  const { h } = await fedRing(['ana']);
  try {
    const s21 = fixture('nodeinfo-2.1.schema.json');
    const s20 = fixture('nodeinfo-2.0.schema.json');
    // The checker itself: the recorded Mastodon NodeInfo passes 2.0, a broken one fails.
    assert.deepEqual(validate(s20, fixture('mastodon-nodeinfo-2.0.json')), [], 'positive control: the recorded Mastodon document');
    assert.ok(validate(s21, { version: '2.1', software: { name: 'Ring', version: '1' } }).length > 0, 'the checker refuses a broken document');

    const wk = await (await fetch(`${h.base}/.well-known/nodeinfo`)).json();
    assert.deepEqual(wk.links.map((l) => l.href), [`${h.base}/nodeinfo/2.1`, `${h.base}/nodeinfo/2.0`]);
    const r = await fetch(`${h.base}/nodeinfo/2.1`);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const n21 = await r.json();
    assert.deepEqual(validate(s21, n21), []);
    assert.equal(n21.software.name, 'ring');
    assert.equal(n21.metadata.ringProtocol, 1);
    assert.deepEqual(n21.usage, { users: {} }, 'no counts');
    assert.deepEqual(n21.protocols, ['activitypub']);
    assert.deepEqual(n21.services.outbound, ['rss2.0']);
    assert.equal(n21.openRegistrations, false);
    const n20 = await (await fetch(`${h.base}/nodeinfo/2.0`)).json();
    assert.deepEqual(validate(s20, n20), []);
    assert.equal(n20.version, '2.0');
  } finally { await h.close(); }
});

test('no totalItems anywhere; a public Note is to as:Public, cc followers; collections as Mastodon reads them', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const a = await c.ana.post('/api/posts', { kind: 'note', note: 'one', cw: 'a warning', kaomoji: '(´ ▽ ` )' });
    await c.ana.patch(`/api/posts/${a.body.id}`, { pinned: true });
    for (let i = 0; i < 22; i++) await c.ana.post('/api/posts', { kind: 'note', note: `n${i}` });
    const docs = [];
    const get = async (p) => { const r = await m.get(`${h.base}${p}`); assert.equal(r.status, 200, `${p}: ${r.text}`); docs.push(r.body); return r.body; };
    const outbox = await get('/users/ana/outbox');
    assert.equal(outbox.type, 'OrderedCollection');
    assert.equal(outbox.first, `${h.base}/users/ana/outbox?page=1`);
    const p1 = await get('/users/ana/outbox?page=1');
    assert.equal(p1.type, 'OrderedCollectionPage');
    assert.equal(p1.orderedItems.length, 20);
    assert.equal(p1.next, `${h.base}/users/ana/outbox?page=2`);
    const p2 = await get('/users/ana/outbox?page=2');
    assert.equal(p2.orderedItems.length, 3);
    assert.equal(p2.next, undefined);
    assert.ok(p1.orderedItems.every((x) => x.type === 'Create' && x.object.type === 'Note' && !x['@context']));
    const featured = await get('/users/ana/featured');
    assert.deepEqual(featured.orderedItems.map((n) => n.id), [`${h.base}/users/ana/posts/${a.body.id}`]);
    const followers = await get('/users/ana/followers');
    const following = await get('/users/ana/following');
    assert.deepEqual(Object.keys(followers).sort(), ['@context', 'id', 'type'], 'no items, no counts');
    assert.equal(following.type, 'OrderedCollection');
    const note = await get(`/users/ana/posts/${a.body.id}`);
    assert.deepEqual(note.to, ['https://www.w3.org/ns/activitystreams#Public']);
    assert.deepEqual(note.cc, [`${h.base}/users/ana/followers`]);
    assert.equal(note.summary, 'a warning');
    assert.equal(note.sensitive, true);
    assert.equal(note.url, `${h.base}/@ana#${a.body.id}`);
    assert.equal(note.ring.kaomoji, '(´ ▽ ` )');
    docs.push(await (await fetch(`${h.base}/users/ana`, { headers: AP })).json());
    docs.push(await (await fetch(`${h.base}/nodeinfo/2.1`)).json());
    for (const d of docs) assert.ok(!keysDeep(d).has('totalItems'), `no totalItems in ${d.id || d.version}`);
    // Mastodon's own collections carry totalItems: the recorded one, so the check can see it.
    assert.ok(keysDeep(fixture('mastodon-followers.json')).has('totalItems'), 'positive control');
  } finally { await m.close(); await h.close(); }
});

test('negotiation: an AP Accept on /@name goes to the actor, HTML on the actor and a post goes to the wall; the head names the actor', async () => {
  const { h, c } = await fedRing(['ana']);
  try {
    const p = await c.ana.post('/api/posts', { kind: 'note', note: 'hello' });
    let r = await fetch(`${h.base}/@ana`, { headers: AP, redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `${h.base}/users/ana`);
    r = await fetch(`${h.base}/@ana`, { headers: { accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' }, redirect: 'manual' });
    assert.equal(r.status, 302);
    r = await fetch(`${h.base}/users/ana`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `${h.base}/@ana`);
    r = await fetch(`${h.base}/users/ana/posts/${p.body.id}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `${h.base}/@ana#${p.body.id}`);
    const html = await (await fetch(`${h.base}/@ana`, { headers: { accept: 'text/html' } })).text();
    assert.ok(html.includes(`<link rel="alternate" type="application/activity+json" href="${h.base}/users/ana">`));
  } finally { await h.close(); }
  // Off: the wall carries no AP alternate, and an AP Accept gets the wall.
  const { h: off, c: co } = await crowd(['ana']);
  try {
    await co.ana.put('/api/me/page', { enabled: true });
    const html = await (await fetch(`${off.base}/@ana`, { headers: { accept: 'text/html' } })).text();
    assert.ok(!html.includes('application/activity+json'), 'no alternate pointing at an actor that does not answer');
    assert.equal((await fetch(`${off.base}/@ana`, { headers: AP, redirect: 'manual' })).status, 200);
  } finally { await off.close(); }
});
