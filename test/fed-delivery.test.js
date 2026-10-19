'use strict';
/* Gate: fed-delivery (spec 7, 16.3). Jobs are files and survive a restart; the
 * backoff schedule; given up at 7 days with an audit line; a host failing for 7
 * days goes unavailable until it speaks again; a Delete overtakes queued Creates
 * and Updates; one POST per shared inbox; 4xx ends a job, 408 and 429 retry; a
 * 410 from an actor's inbox drops that follower; Updates coalesce. The remote is
 * a fake Mastodon on loopback whose inbox answers what each test says. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const clock = require('../lib/clock');
const { backoffMs, retryAfterMs, BACKOFF, DAILY } = require('../lib/queue');
const { boot } = require('./helpers/harness');
const { fedRing, fakeMastodon, remoteFollow, followFrom } = require('./helpers/fediverse');

test.afterEach(() => clock.reset());

const creates = (m) => m.deliveries.filter((d) => d.body?.type === 'Create');
const jobsOf = (h) => h.ctx.federation.queue.list();
const delivers = (h) => jobsOf(h).filter((j) => j.kind === 'deliver');

test('a job survives a restart: stopped mid-backoff, a new process over the same DATA_DIR sends it', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  let h2 = null;
  try {
    await remoteFollow(h, c, m);
    m.answer(() => 503);
    const post = await c.ana.post('/api/posts', { kind: 'note', note: 'survives' });
    await h.ctx.federation.queue.drain();
    const [job] = delivers(h);
    assert.equal(job.attempts, 1);
    assert.equal(job.last_status, 503);
    assert.ok(fs.existsSync(`${h.dir}/queue/${job.id}.json`), 'the job is a file');
    const port = Number(new URL(h.base).port);
    await h.close({ keepData: true });

    m.answer(() => 202);
    h2 = await boot({ federated: true, dataDir: h.dir, port });
    clock.advance(2 * 60_000);
    await h2.ctx.federation.queue.drain();
    const got = creates(m).filter((d) => d.status === 202);
    assert.equal(got.length, 1);
    assert.equal(got[0].body.object.id, `${h.base}/users/ana/posts/${post.body.id}`);
    assert.equal(got[0].body.id, JSON.parse(job.body).id, 'the same activity id: receivers deduplicate on it');
    assert.equal(got[0].verified, true, 'signed afresh at the new attempt');
    assert.equal(h2.ctx.federation.queue.depth(), 0);
  } finally {
    await m.close();
    if (h2) await h2.close({ keepData: true });
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('the backoff schedule: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, then daily, 10% jitter; Retry-After capped at a day', async () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 30].map((n) => backoffMs(n, mid)), [...BACKOFF, DAILY, DAILY, DAILY]);
  assert.equal(backoffMs(1, () => 0), Math.round(60_000 * 0.9));
  assert.equal(backoffMs(1, () => 1), Math.round(60_000 * 1.1));
  assert.equal(retryAfterMs('120', 0), 120_000);
  assert.equal(retryAfterMs(String(7 * 24 * 3600), 0), DAILY, 'honoured up to 24 h');
  assert.equal(retryAfterMs('nonsense', 0), null);

  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    m.answer(() => 503);
    await c.ana.post('/api/posts', { kind: 'note', note: 'retry me' });
    for (let n = 1; n <= 4; n++) {
      const before = clock.now();
      await h.ctx.federation.queue.drain();
      const [job] = delivers(h);
      assert.equal(job.attempts, n);
      const wait = job.next_at - before;
      const base = BACKOFF[n - 1];
      assert.ok(wait >= base * 0.9 - 50 && wait <= base * 1.1 + 50, `attempt ${n}: waits ${wait} ms, about ${base}`);
      clock.set(job.next_at);
    }
  } finally { await m.close(); await h.close(); }
});

test('given up 7 days after creation with an audit line; past 7 days at boot, dropped the same way', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  let h2 = null;
  try {
    await remoteFollow(h, c, m);
    const t0 = clock.now();
    clock.set(t0);
    m.answer(({ body }) => (JSON.stringify(body).includes('doomed') ? 503 : 202));
    await c.ana.post('/api/posts', { kind: 'note', note: 'doomed' });
    await h.ctx.federation.queue.drain();
    let fine = false;
    for (let i = 0; i < 40 && delivers(h).length; i++) {
      const [job] = delivers(h);
      clock.set(job.next_at + 1);
      if (!fine && clock.now() - t0 > 3 * DAILY) {
        // Another post gets through: the host is failing one job, not down.
        await c.ana.post('/api/posts', { kind: 'note', note: 'fine' });
        fine = true;
      }
      await h.ctx.federation.queue.drain();
    }
    assert.ok(fine);
    assert.equal(delivers(h).length, 0, 'the doomed job is gone');
    assert.ok(clock.now() - t0 >= 7 * DAILY, 'not before 7 days');
    const gave = h.ctx.audit.read().filter((r) => r.event === 'delivery_gave_up');
    assert.equal(gave.length, 1);
    assert.equal(gave[0].status, 503);
    assert.equal(h.ctx.federation.hosts.unavailable(m.host), false, 'the host spoke within the week: not unavailable');

    // At boot: a job older than 7 days goes before any attempt.
    clock.set(clock.now());
    await c.ana.post('/api/posts', { kind: 'note', note: 'doomed again' });
    await h.ctx.federation.queue.drain();
    assert.equal(delivers(h).length, 1);
    const port = Number(new URL(h.base).port);
    await h.close({ keepData: true });
    clock.advance(8 * DAILY);
    h2 = await boot({ federated: true, dataDir: h.dir, port });
    assert.equal(h2.ctx.federation.queue.depth(), 0);
    assert.ok(h2.ctx.audit.read().some((r) => r.event === 'delivery_gave_up' && r.reason === 'expired_at_boot'));
  } finally {
    await m.close();
    if (h2) await h2.close({ keepData: true }); else await h.close({ keepData: true });
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('a host failing for 7 days goes unavailable: its jobs drop, none are written; a verified inbound request clears it', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await remoteFollow(h, c, m);
    m.answer(() => 503);
    await c.ana.post('/api/posts', { kind: 'note', note: 'into the void' });
    await h.ctx.federation.queue.drain();
    for (let i = 0; i < 40 && delivers(h).length; i++) {
      clock.set(delivers(h)[0].next_at + 1);
      await h.ctx.federation.queue.drain();
    }
    assert.equal(h.ctx.federation.hosts.unavailable(m.host), true);
    assert.ok(h.ctx.audit.read().some((r) => r.event === 'delivery_dropped' && r.reason === 'host_unavailable'));
    const sent = m.deliveries.length;
    const dropped = () => h.ctx.audit.read().filter((r) => r.event === 'delivery_dropped').length;
    const droppedBefore = dropped();
    const written = [];
    const stop = setInterval(() => { for (const j of h.ctx.federation.queue.list()) if (j.kind === 'deliver') written.push(j.id); }, 1);
    m.answer(() => 202);
    await c.ana.post('/api/posts', { kind: 'note', note: 'not written' });
    await h.ctx.federation.queue.drain();
    clearInterval(stop);
    assert.equal(m.deliveries.length, sent, 'nothing sent to an unavailable host');
    assert.equal(h.ctx.federation.queue.depth(), 0);
    assert.equal(dropped(), droppedBefore, 'and no deliver job was written to be dropped');
    assert.deepEqual(written, []);

    // carol (same host) follows: a verified request, so the host speaks again.
    const r = await m.post(`${h.base}/users/ana/inbox`, followFrom(m, `${h.base}/users/ana`, { name: 'carol' }), { name: 'carol' });
    assert.equal(r.status, 202);
    assert.equal(h.ctx.federation.hosts.unavailable(m.host), false);
    await c.ana.post('/api/posts', { kind: 'note', note: 'back' });
    await h.ctx.federation.queue.drain();
    assert.ok(creates(m).some((d) => d.body.object.source.content === 'back' && d.status === 202), 'positive control: delivered again');
  } finally { await m.close(); await h.close(); }
});

test('a Delete cancels queued Creates and Updates for its object; the Delete still goes', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    m.answer(() => 503);
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'regret' })).body;
    const other = (await c.ana.post('/api/posts', { kind: 'note', note: 'keep me' })).body;
    await h.ctx.federation.queue.drain();
    await c.ana.patch(`/api/posts/${p.id}`, { note: 'regret, edited' });
    await h.ctx.federation.queue.drain();
    const url = `${h.base}/users/ana/posts/${p.id}`;
    assert.deepEqual(jobsOf(h).filter((j) => j.object_id === url).map((j) => j.activity_type).sort(), ['Create', 'Update']);
    await c.ana.del(`/api/posts/${p.id}`);
    assert.deepEqual(jobsOf(h).filter((j) => j.object_id === url).map((j) => j.activity_type), ['Delete'], 'the Create and Update are gone');
    assert.ok(jobsOf(h).some((j) => j.object_id === `${h.base}/users/ana/posts/${other.id}`), 'positive control: another post\'s Create stays');
    const before = m.deliveries.length;
    m.answer(() => 202);
    clock.advance(DAILY);
    await h.ctx.federation.queue.drain();
    const after = m.deliveries.slice(before).filter((d) => JSON.stringify(d.body).includes(p.id));
    assert.deepEqual(after.map((d) => d.body.type), ['Delete']);
  } finally { await m.close(); await h.close(); }
});

test('one POST per shared inbox per activity; Accepts go to the personal inbox', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await remoteFollow(h, c, m, 'ana', { as: 'bob' });
    await remoteFollow(h, c, m, 'ana', { as: 'carol' });
    assert.deepEqual(m.deliveries.map((d) => [d.path, d.body.type]), [['/users/bob/inbox', 'Accept'], ['/users/carol/inbox', 'Accept']]);
    await c.ana.post('/api/posts', { kind: 'note', note: 'to both' });
    await h.ctx.federation.queue.drain();
    assert.deepEqual(creates(m).map((d) => d.path), ['/inbox'], 'one POST to the shared inbox for two followers there');
  } finally { await m.close(); await h.close(); }
});

test('a 4xx other than 408 and 429 ends the job; 408 and 429 retry, 429 after its Retry-After', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    m.answer(() => 400);
    await c.ana.post('/api/posts', { kind: 'note', note: 'refused' });
    await h.ctx.federation.queue.drain();
    assert.equal(h.ctx.federation.queue.depth(), 0);
    assert.ok(h.ctx.audit.read().some((r) => r.event === 'delivery_dropped' && r.reason === 'refused' && r.status === 400));
    m.answer(() => 429);
    const t = clock.now();
    clock.set(t);
    await c.ana.post('/api/posts', { kind: 'note', note: 'slow down' });
    await h.ctx.federation.queue.drain();
    assert.equal(delivers(h)[0].next_at, t + 120_000, 'Retry-After: 120');
    clock.set(t + 120_000);
    m.answer(() => 408);
    await h.ctx.federation.queue.drain();
    assert.equal(delivers(h)[0].attempts, 2, '408 retries too');
    m.answer(() => 202);
    clock.advance(DAILY);
    await h.ctx.federation.queue.drain();
    assert.equal(h.ctx.federation.queue.depth(), 0);
  } finally { await m.close(); await h.close(); }
});

test('a 410 from an actor\'s inbox drops that follower; a 410 from a shared inbox drops only the job', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon({ users: ['bob', 'carol'] });
  try {
    await remoteFollow(h, c, m, 'ana', { as: 'carol' });
    await remoteFollow(h, c, m, 'ana', { as: 'bob', accept: false });
    m.answer(({ path }) => (path === '/users/bob/inbox' || path === '/inbox' ? 410 : 202));
    const a = await c.ana.post(`/api/followers/${encodeURIComponent(`bob@${m.host}`)}/accept`);
    assert.equal(a.status, 200);
    await h.ctx.federation.queue.drain();
    assert.deepEqual(h.ctx.follows.load('ana').followers.map((f) => f.handle), [`carol@${m.host}`], 'bob is gone');
    await c.ana.post('/api/posts', { kind: 'note', note: 'gone server-wide?' });
    await h.ctx.federation.queue.drain();
    assert.equal(h.ctx.federation.queue.depth(), 0);
    assert.deepEqual(h.ctx.follows.load('ana').followers.map((f) => f.handle), [`carol@${m.host}`], 'positive control: a shared inbox 410 removes no follower');
  } finally { await m.close(); await h.close(); }
});

test('a newer Update replaces a queued one to the same inbox; Update{Person} coalesces to one a minute', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    m.answer(() => 503);
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'v1' })).body;
    await h.ctx.federation.queue.drain();
    await c.ana.patch(`/api/posts/${p.id}`, { note: 'v2' });
    await h.ctx.federation.queue.drain();
    await c.ana.patch(`/api/posts/${p.id}`, { note: 'v3' });
    await h.ctx.federation.queue.drain();
    const updates = delivers(h).filter((j) => j.activity_type === 'Update');
    assert.equal(updates.length, 1);
    assert.equal(JSON.parse(updates[0].body).object.source.content, 'v3');

    m.answer(() => 202);
    clock.advance(DAILY);
    await h.ctx.federation.queue.drain();
    const n = m.deliveries.length;
    const persons = () => m.deliveries.slice(n).filter((d) => d.body.type === 'Update' && d.body.object.type === 'Person').map((d) => d.body.object);
    await c.ana.put('/api/me/page', { bio: 'one' });
    await h.ctx.federation.queue.drain();
    assert.equal(persons().length, 1, 'the first change goes at once');
    assert.equal(persons()[0].summary, '<p>one</p>');
    await c.ana.put('/api/me/page', { bio: 'two' });
    await c.ana.patch('/api/me', { display_name: 'Ana Three' });
    await c.ana.put('/api/me/page', { bio: 'three' });
    await h.ctx.federation.queue.drain();
    assert.equal(persons().length, 1, 'changes inside the minute wait');
    assert.equal(jobsOf(h).filter((j) => j.activity_type === 'Update').length, 1, 'three changes, one queued Update{Person}');
    clock.advance(61_000);
    await h.ctx.federation.queue.drain();
    assert.equal(persons().length, 2, 'one more at the minute');
    assert.equal(persons()[1].name, 'Ana Three');
    assert.equal(persons()[1].summary, '<p>three</p>', 'carrying the latest of them');
    // A block list change shows nothing on the Person: nothing is sent.
    await c.ana.put('/api/me/page', { block_domain: 'spam.example' });
    clock.advance(61_000);
    await h.ctx.federation.queue.drain();
    assert.equal(persons().length, 2);
  } finally { await m.close(); await h.close(); }
});

test('federated_at is stamped at the first delivery, or the first verified inbound activity', async () => {
  const { h } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    const inst = () => JSON.parse(fs.readFileSync(`${h.dir}/instance.json`, 'utf8'));
    assert.equal(inst().federated_at, null, 'nothing has left or arrived yet');
    // Reading an actor is not federating; delivering to it is.
    await h.ctx.federation.actors.resolve(m.actor());
    assert.equal(inst().federated_at, null);
    const A = require('../lib/activities');
    h.ctx.federation.queue.enqueue(A.rejectFollow({ origin: h.base, name: 'ana', follow: { id: `${m.base}/x`, actor: m.actor(), object: `${h.base}/users/ana` } }), [m.actor()], { signer: 'ana' });
    await h.ctx.federation.queue.drain();
    assert.ok(inst().federated_at, 'the first delivery stamps it');
  } finally { await m.close(); await h.close(); }
  const { h: h2 } = await fedRing(['ana']);
  const m2 = await fakeMastodon();
  try {
    await m2.post(`${h2.base}/users/ana/inbox`, followFrom(m2, `${h2.base}/users/ana`));
    assert.ok(JSON.parse(fs.readFileSync(`${h2.dir}/instance.json`, 'utf8')).federated_at, 'so does a verified inbound activity');
  } finally { await m2.close(); await h2.close(); }
});

test('jobs about one post reach one inbox in order: an Update waits behind its Create', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  try {
    await remoteFollow(h, c, m);
    m.answer(({ body }) => (body?.type === 'Create' ? 503 : 202));
    const p = (await c.ana.post('/api/posts', { kind: 'note', note: 'first' })).body;
    await h.ctx.federation.queue.drain();
    await c.ana.patch(`/api/posts/${p.id}`, { note: 'second' });
    await h.ctx.federation.queue.drain();
    assert.ok(!m.deliveries.some((d) => d.body?.type === 'Update'), 'the Update is not sent while its Create waits');
    const other = (await c.ana.post('/api/posts', { kind: 'note', note: 'unrelated' })).body;
    m.answer(({ body }) => (body?.type === 'Create' && body.object.id.endsWith(p.id) ? 503 : 202));
    await h.ctx.federation.queue.drain();
    assert.ok(!m.deliveries.some((d) => d.status === 202 && d.body?.object?.id?.endsWith(p.id)), 'still nothing for the first post');
    assert.ok(m.deliveries.some((d) => d.status === 202 && d.body?.object?.id?.endsWith(other.id)), 'positive control: another post is not held up');
    m.answer(() => 202);
    clock.advance(DAILY);
    await h.ctx.federation.queue.drain();
    const mine = m.deliveries.filter((d) => d.status === 202 && d.body?.object?.id?.endsWith(p.id)).map((d) => d.body.type);
    assert.deepEqual(mine, ['Create', 'Update'], 'in the order they were made');
  } finally { await m.close(); await h.close(); }
});

test('a fault inside a delivery (the hosts table throws) parks the job for a minute: no hot loop, nothing lost', async () => {
  const { h, c } = await fedRing(['ana']);
  const m = await fakeMastodon();
  // The hosts table lives in memory (N6): a fault is injected, not a damaged file.
  const hosts = h.ctx.federation.hosts;
  const unavailable = hosts.unavailable;
  const damage = () => { hosts.unavailable = () => { throw new Error(`store: cannot read ${h.dir}/fed/hosts.json: damaged`); }; };
  const repair = () => { hosts.unavailable = unavailable; };
  try {
    await remoteFollow(h, c, m);
    damage();
    const t = clock.now();
    clock.set(t);
    await c.ana.post('/api/posts', { kind: 'note', note: 'patience' });
    await h.ctx.federation.queue.drain();
    const errors = h.logs.filter((l) => l.includes('[queue]') && l.includes('hosts.json'));
    assert.ok(errors.length >= 1 && errors.length <= 2, `logged once per job, not in a loop (${errors.length})`);
    const [job] = jobsOf(h);
    assert.ok(job.next_at >= t + 54_000 && job.next_at <= t + 66_000, 'parked about a minute');
    repair();
    clock.set(t + 66_000);
    await h.ctx.federation.queue.drain();
    assert.ok(creates(m).some((d) => d.body.object.source.content === 'patience'), 'delivered once the file is fixed');
    // The same at the deliver stage.
    m.answer(() => 503);
    await c.ana.post('/api/posts', { kind: 'note', note: 'again' });
    await h.ctx.federation.queue.drain();
    const [d] = delivers(h);
    damage();
    clock.set(d.next_at);
    await h.ctx.federation.queue.drain();
    assert.equal(delivers(h)[0].next_at, d.next_at + 60_000, 'a deliver job parks a minute too');
    assert.equal(delivers(h)[0].last_status, 'error');
  } finally { await m.close(); await h.close(); }
});
