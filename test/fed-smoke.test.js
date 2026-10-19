'use strict';
/* The P5 smoke, two processes (spec 16.4 items 1 to 4 and 12, automated): a
 * real `node server.js` in its own process with FEDERATION=on, and a fake
 * Mastodon in this one, on loopback, signing with its own key and checking
 * Ring's signatures with its own verifier (test/helpers/fediverse.js).
 *   the fake resolves the member by WebFinger, reads the Person, follows;
 *   the member sees the request and lets them follow: the Accept arrives;
 *   a public post, an edit, a pin and a delete arrive, signed, at the shared inbox;
 *   a room post does not, nor anything naming it;
 *   the page switched off: the actor still resolves, a public post URL finds nothing.
 * Nothing leaves loopback: the server's fetcher runs under FED_TEST_LOOPBACK=1. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client, SECRET, ADMIN_EMAIL, PASSWORD, freePort } = require('./helpers/harness');
const { fakeMastodon, followFrom, until } = require('./helpers/fediverse');

const ROOT = path.join(__dirname, '..');

async function startServer() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-smoke-'));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test', SESSION_SECRET: SECRET, ADMIN_EMAIL, DATA_DIR: dir, PORT: String(port),
      PUBLIC_ORIGIN: origin, FEDERATION: 'on', FED_TEST_LOOPBACK: '1', MAIL_PROVIDER: 'log',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  await until(() => out.includes('listening on') || child.exitCode !== null, { ms: 15_000, what: 'the server to listen' });
  if (child.exitCode !== null) throw new Error(`server exited: ${out}`);
  return {
    origin, dir, port, child, log: () => out,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      const code = await exited;
      fs.rmSync(dir, { recursive: true, force: true });
      return code;
    },
  };
}

test('two processes: a fake Mastodon follows a Ring member, who lets it; posts, an edit, a pin and a delete arrive signed; a room post never does', async () => {
  const srv = await startServer();
  const m = await fakeMastodon({ users: ['bob'] });
  try {
    const host = `127.0.0.1:${srv.port}`;
    // Sign up the first member over the JSON API, the confirm link from the log outbox.
    const ana = new Client(srv.origin);
    assert.equal((await ana.post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'ana', display_name: 'Ana Lima' })).status, 202);
    const token = await until(() => {
      try {
        const lines = fs.readFileSync(path.join(srv.dir, 'mail-outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        return /token=([A-Za-z0-9_-]+)/.exec(lines.at(-1)?.text || '')?.[1];
      } catch { return null; }
    }, { what: 'the confirm mail' });
    assert.equal((await ana.post('/api/signup/confirm', { token, password: PASSWORD })).status, 200);
    assert.equal((await ana.put('/api/me/page', { enabled: true, bio: 'prints' })).status, 200);

    // 1. Search name@host: WebFinger, then the Person.
    const jrd = await (await fetch(`${srv.origin}/.well-known/webfinger?resource=acct:ana@${host}`)).json();
    const actorUrl = jrd.links.find((l) => l.rel === 'self').href;
    const person = await (await fetch(actorUrl, { headers: { accept: 'application/activity+json' } })).json();
    assert.equal(person.name, 'Ana Lima');
    assert.equal(person.manuallyApprovesFollowers, true, 'the lock');

    // 2. Follow: a request in Ring's Inbox; Let follow; the Accept arrives, signed.
    const follow = followFrom(m, actorUrl);
    assert.equal((await m.post(person.inbox, follow)).status, 202);
    const inbox = await ana.get('/api/inbox');
    assert.deepEqual(inbox.body.follow_requests.map((r) => [r.handle, r.name, r.host]), [[`bob@${m.host}`, 'Bob Remote', m.host]]);
    assert.equal((await ana.post(`/api/followers/${encodeURIComponent(`bob@${m.host}`)}/accept`)).status, 200);
    const accept = await until(() => m.deliveries.find((d) => d.body?.type === 'Accept'), { what: 'the Accept' });
    assert.equal(accept.path, '/users/bob/inbox');
    assert.equal(accept.body.object.id, follow.id);
    assert.equal(accept.verified, true, accept.why);

    // A room, and a post to it: it must never reach the follower.
    const ring = await ana.post('/api/rings', { name: 'Thursday' });
    assert.equal(ring.status, 201, ring.text);
    const room = (await ana.post('/api/posts', { kind: 'note', note: 'room only', audience: ring.body.id })).body;

    // 3 and 4. A post, an edit, a pin, a delete.
    // Each step waits for its delivery, as a person watching Mastodon would: a
    // Delete made while an Update still waits in the queue cancels it (spec 7).
    const arrived = (type) => until(() => m.deliveries.find((d) => d.body?.type === type), { what: `the ${type}` });
    const p = (await ana.post('/api/posts', { kind: 'note', note: 'new prints drying', cw: 'ink' })).body;
    await arrived('Create');
    await ana.patch(`/api/posts/${p.id}`, { note: 'new prints, dry' });
    await arrived('Update');
    await ana.patch(`/api/posts/${p.id}`, { pinned: true });
    await arrived('Add');
    const outbox = await m.get(`${srv.origin}/users/ana/outbox?page=1`);
    assert.equal(outbox.status, 200);
    assert.ok(outbox.body.orderedItems.some((x) => x.object.id.endsWith(p.id)));
    assert.ok(!outbox.text.includes(room.id), 'the room post is in no collection');
    await ana.del(`/api/posts/${p.id}`);
    const del = await until(() => m.deliveries.find((d) => d.body?.type === 'Delete'), { what: 'the Delete' });
    const types = m.deliveries.filter((d) => d.path === '/inbox').map((d) => d.body.type);
    // Up to two deliveries to one host run at once, so arrival order is not pinned.
    assert.deepEqual(types.filter((t) => ['Create', 'Update', 'Add', 'Delete'].includes(t)).sort(), ['Add', 'Create', 'Delete', 'Update']);
    const create = m.deliveries.find((d) => d.body.type === 'Create');
    assert.equal(create.body.object.summary, 'ink');
    assert.equal(create.body.object.sensitive, true);
    assert.deepEqual(create.body.object.to, ['https://www.w3.org/ns/activitystreams#Public']);
    assert.equal(m.deliveries.find((d) => d.body.type === 'Update').body.object.source.content, 'new prints, dry');
    assert.equal(m.deliveries.find((d) => d.body.type === 'Add').body.target, `${actorUrl}/featured`);
    assert.equal(del.body.object.type, 'Tombstone');
    for (const d of m.deliveries) assert.equal(d.verified, true, `${d.body.type}: ${d.why}`);
    assert.ok(m.deliveries.every((d) => d.owner === actorUrl), 'every delivery signed by the member');
    assert.ok(!m.deliveries.some((d) => d.raw.includes(room.id) || d.raw.includes(ring.body.id)), 'nothing names the room post or the ring');
    const gone = await m.get(`${srv.origin}/users/ana/posts/${p.id}`);
    assert.equal(gone.status, 410, 'a deleted post is a Tombstone');

    // 12. The page off: the profile still resolves, a public post URL finds nothing.
    const kept = (await ana.post('/api/posts', { kind: 'note', note: 'still here' })).body;
    await until(() => m.deliveries.some((d) => d.body.type === 'Create' && d.body.object.id.endsWith(kept.id)), { what: 'the second Create' });
    await ana.put('/api/me/page', { enabled: false });
    assert.equal((await fetch(actorUrl, { headers: { accept: 'application/activity+json' } })).status, 200);
    assert.equal((await m.get(`${srv.origin}/users/ana/posts/${kept.id}`)).status, 404);
    const quiet = (await ana.post('/api/posts', { kind: 'note', note: 'while off' })).body;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!m.deliveries.some((d) => d.raw.includes(quiet.id)), 'new posts do not arrive');

    assert.equal(await srv.stop(), 0, 'a clean shutdown');
  } catch (e) {
    e.message += `\n--- server log ---\n${srv.log().slice(-3000)}`;
    throw e;
  } finally {
    await m.close();
    await srv.stop();
  }
});
