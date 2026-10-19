'use strict';
/* ── A fake Mastodon, in-process, on loopback (spec 16.1) ─────────────────────
 * Federation suites NEVER reach a real server: every remote here is one of
 * these, an http server on 127.0.0.1 that speaks the parts of Mastodon 4.x a
 * Ring server talks to:
 *   GET  /.well-known/webfinger    the recorded Mastodon JRD, re-hosted
 *   GET  /users/<name>             the recorded Mastodon Person, re-hosted, with
 *                                  this fake's own RSA key
 *   POST /users/<name>/inbox, /inbox   records every delivery, and checks its
 *                                  signature with an INDEPENDENT verifier (below,
 *                                  plain node:crypto, not lib/http-sig.js), so a
 *                                  bug shared by Ring's signer and verifier
 *                                  cannot pass
 * and SIGNS what it sends Ring with its own independent signer (Mastodon's
 * header set: (request-target) host date digest content-type).
 *
 * Reachable only because the Ring server under test runs with
 * FED_TEST_LOOPBACK=1 (its fetcher then allows loopback, and loopback only).
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../../lib/clock');

const FIX = path.join(__dirname, '..', 'fixtures', 'fediverse');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

/* Replace placeholder origins in a fixture (deep). */
function rehost(v, map) {
  if (typeof v === 'string') { let s = v; for (const [a, b] of Object.entries(map)) s = s.split(a).join(b); return s; }
  if (Array.isArray(v)) return v.map((x) => rehost(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rehost(x, map)]));
  return v;
}

let keyCache = null;
/* RSA keys are slow to make: a small pool, made once per process. */
function keypair(i = 0) {
  keyCache ||= [];
  while (keyCache.length <= i) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    keyCache.push({ publicKey, privateKey });
  }
  return keyCache[i];
}

// ── the independent signer and verifier (cavage, rsa-sha256) ──

function sign({ method, url, body, keyId, privateKey, headers = {}, signed, dateMs }) {
  const u = new URL(url);
  const h = { host: u.host, date: new Date(dateMs ?? clock.now()).toUTCString(), ...headers };
  if (body !== undefined && h.digest === undefined) h.digest = `SHA-256=${crypto.createHash('sha256').update(body).digest('base64')}`;
  const names = signed || (method === 'POST' ? ['(request-target)', 'host', 'date', 'digest', 'content-type'] : ['(request-target)', 'host', 'date', 'accept']);
  const lines = names.map((n) => (n === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${u.pathname}${u.search}` : `${n}: ${h[n]}`));
  const sig = crypto.sign('sha256', Buffer.from(lines.join('\n')), privateKey).toString('base64');
  h.signature = `keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${sig}"`;
  return h;
}

function parseSig(s) {
  const out = {};
  for (const m of String(s || '').matchAll(/([a-zA-Z]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

async function independentVerify({ method, path: p, headers, raw }) {
  const sig = parseSig(headers.signature);
  if (!sig.keyId || !sig.signature || !sig.headers) return { ok: false, why: 'no signature' };
  const names = sig.headers.split(' ');
  for (const need of ['(request-target)', 'host', 'date', 'digest']) if (!names.includes(need)) return { ok: false, why: `unsigned ${need}` };
  const want = `SHA-256=${crypto.createHash('sha256').update(raw).digest('base64')}`;
  if (headers.digest !== want) return { ok: false, why: 'digest' };
  if (Math.abs(Date.parse(headers.date) - clock.now()) > 3600_000) return { ok: false, why: 'date' };
  const res = await fetch(sig.keyId.split('#')[0], { headers: { accept: 'application/activity+json' } });
  if (res.status !== 200) return { ok: false, why: `key fetch ${res.status}` };
  const actor = await res.json();
  if (actor.publicKey?.id !== sig.keyId) return { ok: false, why: 'key id' };
  const lines = names.map((n) => (n === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${p}` : `${n}: ${headers[n]}`));
  const ok = crypto.verify('sha256', Buffer.from(lines.join('\n')), actor.publicKey.publicKeyPem, Buffer.from(sig.signature, 'base64'));
  return ok ? { ok: true, keyId: sig.keyId, owner: actor.id } : { ok: false, why: 'signature' };
}

/* A fake Mastodon with `users` (names). Returns { base, host, actor(name), keyId(name),
 * deliveries, inbox(status), post(url, activity, opts), get(url, opts), close() }.
 * P6 options (the other fakes are this one with another face):
 *   software       the NodeInfo software name it answers ('mastodon', 'akkoma',
 *                  'misskey', ...): an Akkoma or a Misskey for the stamp mapping
 *   hostname       '127.0.0.1' (default) or 'localhost': two fakes a
 *                  BLOCKED_DOMAINS gate can tell apart (both are loopback)
 *   instanceActor  serve an Akkoma-style instance actor at /internal/fetch
 *                  (Application, preferredUsername `internal.fetch`) that
 *                  WebFinger does NOT answer for, to sign GETs with
 *   autoAccept     answer a Follow from Ring with an Accept, as an unlocked
 *                  Mastodon account does */
async function fakeMastodon({ users = ['bob'], keyIndex = 0, verify = true, software = 'mastodon', hostname = '127.0.0.1', instanceActor = false, autoAccept = false } = {}) {
  const keys = Object.fromEntries(users.map((u, i) => [u, keypair(keyIndex + i)]));
  const deliveries = [];
  let inboxAnswer = () => 202;
  const objects = new Map();   // path -> { doc, type }: documents this fake serves (an activity by its id)
  let patch = (d) => d;   // bends the actor document for a gate
  let actorType = 'application/activity+json; charset=utf-8';
  const gets = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const u = new URL(req.url, base);
      try {
        if (req.method === 'GET') gets.push({ path: u.pathname + u.search, headers: { ...req.headers } });
        if (req.method === 'GET' && objects.has(u.pathname)) {
          const o = objects.get(u.pathname);
          res.writeHead(o.status || 200, { 'content-type': o.type || 'application/activity+json' });
          return res.end(typeof o.doc === 'string' || Buffer.isBuffer(o.doc) ? o.doc : JSON.stringify(o.doc));
        }
        if (req.method === 'GET' && u.pathname === '/.well-known/nodeinfo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${base}/nodeinfo/2.0` }] }));
        }
        if (req.method === 'GET' && u.pathname === '/nodeinfo/2.0') {
          const ni = software === 'mastodon' ? fixture('mastodon-nodeinfo-2.0.json')
            : fixture('p6-nodeinfo.json')[software] || { version: '2.0', software: { name: software, version: '1.0.0' }, protocols: ['activitypub'], services: { inbound: [], outbound: [] }, openRegistrations: false, usage: { users: {} }, metadata: {} };
          res.writeHead(200, { 'content-type': 'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.0#"' });
          return res.end(JSON.stringify(ni));
        }
        if (req.method === 'GET' && instanceActor && u.pathname === '/internal/fetch') {
          res.writeHead(200, { 'content-type': 'application/activity+json' });
          return res.end(JSON.stringify({
            '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'], id: `${base}/internal/fetch`, type: 'Application',
            preferredUsername: 'internal.fetch', name: 'internal.fetch', inbox: `${base}/internal/fetch/inbox`, outbox: `${base}/internal/fetch/outbox`,
            publicKey: { id: `${base}/internal/fetch#main-key`, owner: `${base}/internal/fetch`, publicKeyPem: instanceKey.publicKey },
          }));
        }
        if (req.method === 'GET' && u.pathname === '/.well-known/webfinger') {
          const m = /^acct:([^@]+)@(.+)$/.exec(u.searchParams.get('resource') || '');
          if (!m || m[2] !== host || !users.includes(m[1])) { res.writeHead(404); return res.end(); }
          const jrd = rehost(fixture('mastodon-webfinger.json'), { 'https://mas.to/users/mastodon': `${base}/users/${m[1]}`, 'https://mas.to/@mastodon': `${base}/@${m[1]}`, 'acct:mastodon@mas.to': `acct:${m[1]}@${host}`, 'https://mas.to': base });
          res.writeHead(200, { 'content-type': 'application/jrd+json; charset=utf-8' });
          return res.end(JSON.stringify(jrd));
        }
        const um = /^\/users\/([^/]+)$/.exec(u.pathname);
        if (req.method === 'GET' && um && users.includes(um[1])) {
          res.writeHead(200, { 'content-type': actorType });
          return res.end(JSON.stringify(patch(actorDoc(um[1]), um[1])));
        }
        if (req.method === 'POST' && (u.pathname === '/inbox' || /^\/users\/[^/]+\/inbox$/.test(u.pathname))) {
          let body = null;
          try { body = JSON.parse(raw.toString('utf8')); } catch { /* recorded raw */ }
          const headers = { ...req.headers };
          const v = verify ? await independentVerify({ method: 'POST', path: u.pathname, headers, raw }) : { ok: null };
          const status = inboxAnswer({ path: u.pathname, body });
          deliveries.push({ path: u.pathname, headers, raw: raw.toString('utf8'), body, verified: v.ok, why: v.why, owner: v.owner, status, at: clock.now() });
          if (autoAccept && body?.type === 'Follow' && typeof body.object === 'string' && body.object.startsWith(`${base}/users/`)) {
            const name = body.object.slice(`${base}/users/`.length);
            setImmediate(() => {
              post(`${body.actor}/inbox`, { '@context': 'https://www.w3.org/ns/activitystreams', id: `${actor(name)}#accepts/follows/${crypto.randomBytes(4).toString('hex')}`, type: 'Accept', actor: actor(name), object: { id: body.id, type: 'Follow', actor: body.actor, object: body.object } }, { name })
                .catch(() => {});
            });
          }
          const extra = typeof status === 'object' ? status : null;
          res.writeHead(extra ? extra.status : status, extra ? extra.headers : (status === 429 ? { 'retry-after': '120' } : {}));
          return res.end();
        }
        res.writeHead(404);
        res.end();
      } catch (e) {
        res.writeHead(500);
        res.end(String(e.message));
      }
    });
  });
  const instanceKey = keypair(keyIndex + users.length);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://${hostname}:${server.address().port}`;
  const host = `${hostname}:${server.address().port}`;
  const actor = (name = users[0]) => `${base}/users/${name}`;
  const keyId = (name = users[0]) => `${actor(name)}#main-key`;

  function actorDoc(name) {
    const d = rehost(fixture('mastodon-actor.json'), { 'https://mas.to/users/mastodon': actor(name), 'https://mas.to/@mastodon': `${base}/@${name}`, 'https://mas.to/ap/users/107496346327997373': `${base}/ap/users/${name}`, 'mastodon@mas.to': `${name}@${host}`, 'https://mas.to': base });
    d.preferredUsername = name;
    d.name = `${name[0].toUpperCase()}${name.slice(1)} Remote`;
    d.publicKey.publicKeyPem = keys[name].publicKey;
    return d;
  }

  /* Bob POSTs `activity` to `url`, signed Mastodon's way. `opts` bends it for the gates:
   * { name, body (raw string), headers, signed, dateMs, keyId, privateKey, unsigned } */
  async function post(url, activity, opts = {}) {
    const name = opts.name || users[0];
    const body = opts.body ?? JSON.stringify(activity);
    const headers = { 'content-type': 'application/activity+json', ...(opts.headers || {}) };
    const signedBody = opts.signBody ?? body;
    const h = opts.unsigned ? { ...headers, host: new URL(url).host, date: new Date(clock.now()).toUTCString() } : sign({
      method: 'POST', url, body: signedBody, keyId: opts.keyId || keyId(name), privateKey: opts.privateKey || keys[name].privateKey,
      headers, signed: opts.signed, dateMs: opts.dateMs,
    });
    for (const k of opts.drop || []) delete h[k];
    delete h.host;
    const res = await fetch(url, { method: 'POST', headers: h, body });
    return { status: res.status, text: await res.text() };
  }

  async function get(url, opts = {}) {
    const name = opts.name || users[0];
    const headers = { accept: 'application/activity+json' };
    const as = opts.instance ? { keyId: `${base}/internal/fetch#main-key`, privateKey: instanceKey.privateKey } : { keyId: keyId(name), privateKey: keys[name].privateKey };
    const h = opts.unsigned ? headers : sign({ method: 'GET', url, ...as, headers, dateMs: opts.dateMs });
    delete h.host;
    const res = await fetch(url, { headers: h, redirect: 'manual' });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, body, text };
  }

  /* A constructed P6 fixture (test/fixtures/fediverse/p6-*.json), re-hosted:
   * the fake's base, the Ring server's, a post id, and the fixture's user
   * (`user`) as `name`. Ids are the fixture's: a test that sends one twice
   * sets its own. */
  function p6(file, part, { ring, post = '', name = users[0], user = 'bob' } = {}) {
    const raw = rehost(fixture(file)[part], { 'https://remote.example': base, 'https://ring.example': ring || 'https://ring.example', RING_POST: post });
    return rehost(raw, { [`${base}/users/${user}`]: `${base}/users/${name}`, [`${base}/@${user}`]: `${base}/@${name}` });
  }

  return {
    base, host, actor, keyId, keys, deliveries, actorDoc, p6, software,
    answer(fn) { inboxAnswer = fn; },
    serve(p, doc, opts = {}) { objects.set(p, { doc, ...opts }); },
    patchActor(fn) { patch = fn; },
    actorContentType(t) { actorType = t; },
    rotateKey(name = users[0], i = 7) { keys[name] = keypair(i); },
    gets,
    post, get,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/* A Mastodon-shaped Follow from `fake`'s user to a Ring actor, from the fixture. */
function followFrom(fake, ringActor, { name, id } = {}) {
  const f = fixture('mastodon-follow.json').body;
  const body = rehost(f, { 'https://mastodon.example/users/bob': fake.actor(name), 'https://mastodon.example': fake.base, 'https://ring.example/users/ana': ringActor });
  if (id) body.id = id;
  else body.id = `${fake.base}/${crypto.randomUUID()}`;
  return body;
}

function undoFrom(fake, follow) {
  const u = fixture('mastodon-undo-follow.json').body;
  const body = rehost(u, { 'https://mastodon.example/users/bob': follow.actor, 'https://mastodon.example': fake.base });
  body.id = `${follow.actor}#follows/${crypto.randomBytes(4).toString('hex')}/undo`;
  body.object = { id: follow.id, type: 'Follow', actor: follow.actor, object: follow.object };
  return body;
}

/* Wait until `pred()` holds (polling), or fail after `ms`. */
async function until(pred, { ms = 10_000, every = 25, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

module.exports = { fakeMastodon, followFrom, undoFrom, sign, independentVerify, fixture, rehost, keypair, until };

/* A federated Ring server with `names` signed up (the first is the admin), each
 * page ON unless `pageOn: false`; `limitScale: 1` for a suite about a budget. Returns { h, c } as test/helpers/social.js crowd. */
async function fedRing(names = ['ana'], { pageOn = true, env = {}, limitScale } = {}) {
  const { crowd } = require('./social');
  const { h, c } = await crowd(names, { federated: true, env, ...(limitScale ? { limitScale } : {}) });
  if (pageOn) for (const n of names) await c[n].put('/api/me/page', { enabled: true });
  return { h, c };
}

/* `fake`'s user (`as`) follows Ring's `name`; with `accept`, the member lets
 * them follow, and the queue is drained. Returns the Follow sent. */
async function remoteFollow(h, c, fake, name = 'ana', { as, accept = true } = {}) {
  const follow = followFrom(fake, `${h.base}/users/${name}`, { name: as });
  const r = await fake.post(`${h.base}/users/${name}/inbox`, follow, { name: as });
  if (r.status !== 202) throw new Error(`follow: ${r.status} ${r.text}`);
  if (accept) {
    const handle = `${as || 'bob'}@${fake.host}`;
    const a = await c[name].post(`/api/followers/${encodeURIComponent(handle)}/accept`);
    if (a.status !== 200) throw new Error(`accept: ${a.status} ${a.text}`);
    await h.ctx.federation.queue.drain();
  }
  return follow;
}

module.exports.fedRing = fedRing;
module.exports.remoteFollow = remoteFollow;

/* Ring's `me` and `fake`'s user `as` become friends across servers (P6): the
 * member befriends (a Follow goes out), the fake accepts it, then follows back
 * (Ring accepts at once: it crosses the member's own accepted follow). */
async function befriendRemote(h, c, fake, me = 'ana', { as } = {}) {
  const name = as || 'bob';
  const handle = `${name}@${fake.host}`;
  const r = await c[me].post('/api/friends', { handle });
  if (r.status !== 200) throw new Error(`befriend: ${r.status} ${r.text}`);
  await h.ctx.federation.queue.drain();
  const follow = [...fake.deliveries].reverse().find((d) => d.body?.type === 'Follow' && d.body.object === fake.actor(name));
  if (!follow) throw new Error('befriend: no Follow arrived');
  const crypto = require('node:crypto');
  const a = await fake.post(`${h.base}/users/${me}/inbox`, {
    '@context': 'https://www.w3.org/ns/activitystreams', id: `${fake.actor(name)}#accepts/follows/${crypto.randomBytes(4).toString('hex')}`,
    type: 'Accept', actor: fake.actor(name), object: { id: follow.body.id, type: 'Follow', actor: follow.body.actor, object: fake.actor(name) },
  }, { name });
  if (a.status !== 202) throw new Error(`accept: ${a.status} ${a.text}`);
  await remoteFollow(h, c, fake, me, { as: name, accept: false });
  await h.ctx.federation.queue.drain();
  const s = await c[me].get(`/api/friends/with/${encodeURIComponent(handle)}`);
  if (s.body?.status !== 'friends') throw new Error(`befriend: ${JSON.stringify(s.body)}`);
  return handle;
}

/* An activity from `fake`'s user, with a fresh id on the fake's host. */
function activityFrom(fake, type, extra = {}, { name } = {}) {
  const crypto = require('node:crypto');
  return { '@context': 'https://www.w3.org/ns/activitystreams', id: `${fake.base}/activities/${crypto.randomBytes(6).toString('hex')}`, type, actor: fake.actor(name), ...extra };
}

/* A public Note by `fake`'s user, served at its id (so a lookup or a stamp can
 * fetch it) and returned with its Create. */
function noteFrom(fake, { name, text = 'hello from elsewhere', html, inReplyTo = null, to, cc, attachment = [], summary = null, tag = [], extra = {} } = {}) {
  const crypto = require('node:crypto');
  const actor = fake.actor(name);
  const id = `${actor}/statuses/${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  const note = {
    id, type: 'Note', attributedTo: actor, inReplyTo, published: new Date(clock.now()).toISOString(), url: id,
    to: to || ['https://www.w3.org/ns/activitystreams#Public'], cc: cc || [`${actor}/followers`],
    content: html ?? `<p>${text}</p>`, summary, sensitive: !!summary, attachment, tag, ...extra,
  };
  fake.serve(new URL(id).pathname, { '@context': 'https://www.w3.org/ns/activitystreams', ...note });
  const create = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${id}/activity`, type: 'Create', actor, published: note.published, to: note.to, cc: note.cc, object: note };
  return { note, create };
}

module.exports.befriendRemote = befriendRemote;
module.exports.activityFrom = activityFrom;
module.exports.noteFrom = noteFrom;
