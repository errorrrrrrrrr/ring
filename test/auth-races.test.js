'use strict';
/* Gate: password work under concurrency (spec 10.9, 10.11). A reset that commits
 * while a change, a login or a deletion is inside bcrypt wins (robustness-r1-03);
 * a password change voids outstanding reset links (security-r1-13); and every
 * hash and compare goes through ONE bounded queue, so password work cannot freeze
 * the server (robustness-r1-04). */
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const authLib = require('../lib/auth');
const clock = require('../lib/clock');
const { boot, joinAdmin, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');

test.afterEach(() => clock.reset());

const until = async (cond, what) => {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('a reset that lands during a password change wins (robustness-r1-03)', async () => {
  const h = await boot();
  try {
    const a = await joinAdmin(h);
    await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL });
    const rt = h.lastTokenTo(ADMIN_EMAIL);

    // The change's compare holds the queue until the reset's hash is queued behind
    // it; FIFO then runs: change compare, reset hash (the reset commits), change hash.
    const real = bcrypt.compare;
    bcrypt.compare = async (pw, hash) => {
      if (pw === PASSWORD) await until(() => authLib.queue.size() >= 2, 'the reset to queue');
      return real(pw, hash);
    };
    let change;
    let reset;
    try {
      const changing = a.post('/api/me/password', { current: PASSWORD, next: 'the changed password' });
      await until(() => authLib.queue.size() >= 1, 'the change to start');
      reset = await h.client().post('/api/password/reset', { token: rt, password: 'the reset password' });
      change = await changing;
    } finally { bcrypt.compare = real; }

    assert.equal(reset.status, 200);
    assert.equal(change.status, 409);
    assert.equal(change.body.error, 'password_changed');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'the reset password' })).status, 200, 'the reset password is in force');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'the changed password' })).status, 401);
    assert.equal((await a.get('/api/me')).status, 401, 'the reset ended the changing session');
  } finally { await h.close(); }
});

/* Apply what POST /api/password/reset commits, at the moment bcrypt finishes the
 * compare `when` picks: the reset "lands" inside the other request's await. */
async function resetDuringCompare(h, when, fn) {
  const resetHash = await bcrypt.hash('the reset password', 4);
  const real = bcrypt.compare;
  let landed = false;
  bcrypt.compare = async (pw, hash) => {
    const out = await real(pw, hash);
    if (!landed && when(pw)) {
      landed = true;
      const m = h.ctx.members.byEmail(ADMIN_EMAIL);
      h.ctx.members.update(m.slug, { password_hash: resetHash });
      h.ctx.resets.removeWhere((r) => r.slug === m.slug);
      h.ctx.auth.endSessions(m.slug);
    }
    return out;
  };
  try { return await fn(); } finally {
    bcrypt.compare = real;
    assert.ok(landed, 'the reset landed inside the compare');
  }
}

test('a login whose compare straddles a reset signs nobody in', async () => {
  const h = await boot();
  try {
    await joinAdmin(h);
    const c = h.client();
    const r = await resetDuringCompare(h, (pw) => pw === PASSWORD, () => c.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD }));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'invalid_credentials');
    assert.equal((await c.get('/api/me')).status, 401, 'no session came of it');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'the reset password' })).status, 200, 'positive control');
  } finally { await h.close(); }
});

test('a deletion whose check straddles a reset deletes nothing', async () => {
  const h = await boot();
  try {
    const a = await joinAdmin(h);
    const r = await resetDuringCompare(h, (pw) => pw === PASSWORD, () => a.del('/api/me', { password: PASSWORD }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'password_changed');
    assert.ok(h.ctx.members.get('ada'), 'the account stands');
  } finally { await h.close(); }
});

test('a password change voids every outstanding reset link (security-r1-13)', async () => {
  const h = await boot();
  try {
    const a = await joinAdmin(h);
    await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL });
    const rt = h.lastTokenTo(ADMIN_EMAIL);
    assert.ok(h.ctx.resets.find(rt), 'positive control: the link is live');
    assert.equal((await a.post('/api/me/password', { current: PASSWORD, next: 'the changed password' })).status, 200);
    const late = await h.client().post('/api/password/reset', { token: rt, password: 'the thief password' });
    assert.equal(late.status, 400);
    assert.equal(late.body.error, 'token_invalid');
    assert.equal((await a.get('/api/me')).status, 200, 'the changing session stays');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'the changed password' })).status, 200);
  } finally { await h.close(); }
});

test('the password queue: one at a time, FIFO, bounded, with turns for the loop between jobs', async () => {
  const q = authLib.createPasswordQueue({ max: 3 });
  let inFlight = 0;
  let peak = 0;
  const order = [];
  const job = (name) => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    const until = Date.now() + 20;
    while (Date.now() < until) { /* synchronous, like bcryptjs */ }
    order.push(name);
    inFlight--;
    return name;
  };
  const timerTurns = [];
  const ticker = setInterval(() => timerTurns.push(order.length), 1);
  const runs = ['a', 'b', 'c', 'd'].map((n) => q.run(job(n)));
  await assert.rejects(q.run(job('e')), (e) => e.code === 'RING_BUSY', 'past the bound: busy');
  assert.deepEqual(await Promise.all(runs), ['a', 'b', 'c', 'd']);
  clearInterval(ticker);
  assert.equal(peak, 1, 'never two at once');
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  const between = new Set(timerTurns.filter((n) => n > 0 && n < 4));
  assert.ok(between.size >= 2, `timers ran between jobs: ${[...between]}`);
  assert.equal(authLib.queue.max, authLib.QUEUE_MAX);
});

test('a full password queue answers 503 busy with Retry-After, and the server keeps answering', async () => {
  const h = await boot();
  try {
    await joinAdmin(h);
    const real = bcrypt.compare;
    let release;
    const gate = new Promise((r) => { release = r; });
    bcrypt.compare = async (...a) => { await gate; return real(...a); };
    let held;
    let over;
    let health;
    try {
      held = Array.from({ length: authLib.QUEUE_MAX + 1 }, (_, i) => h.client().post('/api/login', { email: `q${i}@example.test`, password: 'whatever pw' }));
      await until(() => authLib.queue.size() === authLib.QUEUE_MAX + 1, 'the queue to fill');
      over = await h.client().post('/api/login', { email: 'one-more@example.test', password: 'whatever pw' });
      health = await h.client().get('/api/health');
    } finally {
      release();
      bcrypt.compare = real;
    }
    assert.equal(over.status, 503);
    assert.equal(over.body.error, 'busy');
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    assert.equal(health.status, 200, 'other requests are answered meanwhile');
    const answers = await Promise.all(held);
    assert.ok(answers.every((r) => r.status === 401), 'the queued ones finish normally');
  } finally { await h.close(); }
});

test('password work never runs back to back: a health check is answered between compares', async () => {
  const h = await boot();
  try {
    const real = bcrypt.compare;
    let release;
    const gate = new Promise((r) => { release = r; });
    let started = 0;
    bcrypt.compare = async (...a) => { started++; await gate; return real(...a); };
    let done = 0;
    let health;
    let doneAtHealth;
    let logins;
    try {
      logins = Array.from({ length: 12 }, (_, i) => h.client().post('/api/login', { email: `z${i}@example.test`, password: 'whatever pw' }).then((r) => { done++; return r; }));
      await until(() => authLib.queue.size() >= 12 || started >= 12, 'the logins to arrive');
      release();
      health = await h.client().get('/api/health');
      doneAtHealth = done;
      await Promise.all(logins);
    } finally { bcrypt.compare = real; }
    assert.equal(health.status, 200);
    assert.ok(doneAtHealth <= 4, `health waited for ${doneAtHealth} of 12 compares`);
  } finally { await h.close(); }
});
