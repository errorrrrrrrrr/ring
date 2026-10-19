'use strict';
/* Gate: rate limits and the login throttle (spec 10.7, 10.11), at limitScale 1
 * with the clock pinned. Every budget the spec names that a door spends, the
 * member bucket, the client id (IPv6 /64, IPv4-mapped, TRUST_PROXY), the bound on
 * the bucket map, and the throttle's account window and reset. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { createLimits, clientIdOf, MAX_KEYS } = require('../lib/rate-limit');
const { createLoginThrottle } = require('../lib/login-throttle');
const { boot, join, joinAdmin, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

const xff = (ip) => ({ headers: { 'x-forwarded-for': ip } });
const is429 = (r, error) => {
  assert.equal(r.status, 429, r.text);
  if (error) assert.equal(r.body.error, error);
  assert.ok(Number(r.headers.get('retry-after')) > 0, 'Retry-After');
};

test('the client id: IPv4 as is, IPv4-mapped unwrapped, IPv6 cut to its /64', () => {
  assert.equal(clientIdOf('203.0.113.9'), '203.0.113.9');
  assert.equal(clientIdOf('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(clientIdOf('::FFFF:cb00:7109'), '203.0.113.9');
  assert.equal(clientIdOf('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientIdOf('2001:db8::28'), clientIdOf('2001:db8::1'), 'one /64, one id');
  assert.equal(clientIdOf('2001:0db8:0000:0000:ffff:1:2:3'), clientIdOf('2001:db8::1'));
  assert.equal(clientIdOf('fe80::1%en0'), 'fe80:0:0:0::/64', 'a zone id is dropped');
  assert.notEqual(clientIdOf('2001:db8:0:1::1'), clientIdOf('2001:db8::1'), 'another /64 is another id');
  assert.equal(clientIdOf('::1'), '0:0:0:0::/64');
  assert.equal(clientIdOf(''), 'unknown');
  assert.equal(clientIdOf('not an ip'), 'unknown');
});

test('the bucket map is bounded, oldest-touched out (robustness-r1-09)', () => {
  const limits = createLimits();
  const rule = { perMinute: 5, perDay: 20 };
  for (let i = 0; i < 200_000; i++) limits.take(`x:${i}`, rule);
  assert.ok(limits.size() <= MAX_KEYS, `size ${limits.size()}`);
  assert.ok(limits.size() >= MAX_KEYS * 0.98, 'positive control: the map does fill');

  const small = createLimits({ maxKeys: 10 });
  const tight = { perMinute: 1 };
  assert.equal(small.take('hot', tight), null);
  for (let i = 0; i < 9; i++) small.take(`cold:${i}`, tight);
  assert.equal(small.take('hot', tight), 'minute', 'touching a spent bucket keeps it');
  for (let i = 9; i < 15; i++) small.take(`cold:${i}`, tight);
  assert.equal(small.size(), 10);
  // `hot` was refreshed after cold:0..8, so those went first; it is still spent.
  assert.equal(small.take('hot', tight), 'minute');
});

test('the throttle\'s key map is bounded too, and a flood stays linear', () => {
  const th = createLoginThrottle({ maxKeys: 1000 });
  const t0 = Date.now();
  for (let i = 0; i < 50_000; i++) th.failed(`e${i}@example.test`, '10.0.0.1');
  assert.ok(th.size() <= 1000, `size ${th.size()}`);
  assert.ok(Date.now() - t0 < 5000, 'no quadratic eviction');
});

test('a bucket keeps only its longest window; Retry-After names the window that opens', () => {
  clock.set(Date.parse('2026-10-15T00:00:00Z'));
  const limits = createLimits();
  const rule = { perMinute: 2, perHour: 3 };
  assert.equal(limits.take('a', rule), null);
  assert.equal(limits.take('a', rule), null);
  assert.equal(limits.take('a', rule), 'minute');
  clock.advance(61_000);
  assert.equal(limits.take('a', rule), null);
  assert.equal(limits.take('a', rule), 'hour', 'three in the hour');
  clock.advance(3600_000 - 61_000);
  assert.equal(limits.take('a', rule), null, 'the first two aged out of the hour');
  clock.advance(3 * 3600_000);
  limits.prune();
  assert.equal(limits.size(), 0, 'an idle bucket is pruned once past its longest window');
});

test('posts and uploads: 30 a minute per member (spec 10.7)', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    clock.set(Date.now());
    const ana = await joinAdmin(h, 'ana');
    for (let i = 0; i < 30; i++) assert.equal((await ana.post('/api/posts', { kind: 'note', note: `n${i}` })).status, 201, `post ${i}`);
    is429(await ana.post('/api/posts', { kind: 'note', note: 'one too many' }), 'rate_minute');
    const img = await png();
    for (let i = 0; i < 30; i++) assert.equal((await ana.upload(img, { filename: 'a.png', type: 'image/png' })).status, 201, `upload ${i}`);
    is429(await ana.upload(img, { filename: 'a.png', type: 'image/png' }), 'rate_minute');
    clock.advance(61_000);
    assert.equal((await ana.post('/api/posts', { kind: 'note', note: 'later' })).status, 201, 'the window opens');
  } finally { await h.close(); }
});

test('signed in, the bucket is the member\'s, whatever address they post from', async () => {
  const h = await boot({ limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  try {
    clock.set(Date.now());
    const ana = await joinAdmin(h, 'ana');
    for (let i = 0; i < 30; i++) {
      assert.equal((await ana.post('/api/posts', { kind: 'note', note: `n${i}` }, xff(`198.51.100.${i + 1}`))).status, 201);
    }
    is429(await ana.post('/api/posts', { kind: 'note', note: 'x' }, xff('198.51.100.200')), 'rate_minute');
    const bob = await join(h, { email: 'bob@example.test', slug: 'bob', invite: (await ana.post('/api/invites')).body.code });
    assert.equal((await bob.post('/api/posts', { kind: 'note', note: 'mine' }, xff('198.51.100.200'))).status, 201, 'another member, same address: their own bucket');
  } finally { await h.close(); }
});

test('forgot: 3 an hour per email, under the per-IP 5 a minute', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    clock.set(Date.now());
    await joinAdmin(h);
    for (let i = 0; i < 3; i++) assert.equal((await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL })).status, 202);
    is429(await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL }), 'rate_hour');
    assert.equal(h.mailsTo(ADMIN_EMAIL).filter((m) => /Reset/.test(m.subject)).length, 3);
    assert.equal((await h.client().post('/api/password/forgot', { email: 'other@example.test' })).status, 202, 'another email has its own budget');
  } finally { await h.close(); }
});

test('signup mail (P8, 10.11): 5 a day per address AND requester (an IPv6 /48 is one), so a stranger spends only their own; 30 a day per address', async () => {
  const h = await boot({ limitScale: 1, env: { SIGNUP: 'open', TRUST_PROXY: 'loopback' } });
  try {
    clock.set(Date.now());
    const email = 'target@example.test';
    let n = 0;
    const signup = async (ip) => {
      const r = await h.client().post('/api/signup', { email, password: PASSWORD, slug: `t${n++}` }, xff(ip));
      assert.equal(r.status, 202, 'every one is answered alike');
    };
    // A stranger on six /64s of ONE /48: one requester, five mails a day.
    for (let i = 1; i <= 6; i++) await signup(`2001:db8:1:${i}::1`);
    assert.equal(h.mailsTo(email).length, 5, 'the sixth from the same /48 mailed nothing');
    // The mailbox owner, elsewhere: their own budget, untouched by the stranger's.
    await signup('192.0.2.7');
    assert.equal(h.mailsTo(email).length, 6, 'the real signup still gets its link');
    // The ceiling: 30 a day to one address, from every requester together.
    for (let i = 10; i < 34; i++) await signup(`198.51.100.${i}`);
    assert.equal(h.mailsTo(email).length, 30, 'thirty a day, then nothing');
    clock.advance(24 * 3600_000 + 1000);
    // (the log outbox keeps a mail 24 h: count from here)
    h.ctx.mailer.prune();
    let before = h.mailsTo(email).length;
    await signup('198.51.100.200');
    assert.equal(h.mailsTo(email).length, before + 1, 'the day opens again');
    // The admin's release opens a spent address at once.
    for (let i = 40; i < 69; i++) await signup(`203.0.113.${i}`);
    before = h.mailsTo(email).length;
    await signup('203.0.113.99');
    assert.equal(h.mailsTo(email).length, before, 'spent for the day');
    h.ctx.signupGuard.release(email);
    await signup('203.0.113.99');
    assert.equal(h.mailsTo(email).length, before + 1, 'released: the next signup is mailed');
  } finally { await h.close(); }
});

test('pending rows (P8, 10.11): one requester holds at most 10 live, refused never evicted; another requester is unaffected', async () => {
  const h = await boot({ limitScale: 1000, env: { SIGNUP: 'open', TRUST_PROXY: 'loopback' } });
  try {
    clock.set(Date.now());
    for (let i = 0; i < 12; i++) {
      const r = await h.client().post('/api/signup', { email: `s${i}@example.test`, password: PASSWORD, slug: `s${i}` }, xff(`2001:db8:2:${i}::1`));
      assert.equal(r.status, 202);
    }
    assert.equal(h.ctx.pending.all().length, 10, 'the requester\'s share: the 11th and 12th wrote no row');
    assert.equal(h.mailsTo('s11@example.test').length, 0);
    assert.equal(h.mailsTo('s0@example.test').length, 1, 'the first rows stay');
    assert.equal(h.ctx.signupGuard.stats().requesters_at_share, 1);
    // Positive control: another requester signs up as usual.
    await h.client().post('/api/signup', { email: 'real@example.test', password: PASSWORD, slug: 'real' }, xff('192.0.2.9'));
    assert.equal(h.mailsTo('real@example.test').length, 1);
  } finally { await h.close(); }
});

test('invite mint: 10 a day per member, revokes included', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    clock.set(Date.now());
    const ana = await joinAdmin(h, 'ana');
    for (let i = 0; i < 10; i++) {
      const r = await ana.post('/api/invites');
      assert.equal(r.status, 201, `mint ${i}`);
      assert.equal((await ana.del(`/api/invites/${r.body.id}`)).status, 200);
    }
    clock.advance(61_000);
    is429(await ana.post('/api/invites'), 'rate_day');
  } finally { await h.close(); }
});

test('login: 10 a minute per client', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    clock.set(Date.now());
    for (let i = 0; i < 10; i++) assert.equal((await h.client().post('/api/login', { email: `u${i}@example.test`, password: 'whatever pw' })).status, 401);
    is429(await h.client().post('/api/login', { email: 'u99@example.test', password: 'whatever pw' }), 'rate_minute');
  } finally { await h.close(); }
});

test('IPv6: one /64 is one client; another /64 is another (security-r1-04)', async () => {
  const h = await boot({ limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  try {
    clock.set(Date.now());
    const statuses = [];
    for (let i = 1; i <= 6; i++) {
      statuses.push((await h.client().post('/api/login', { email: `v${i}@example.test`, password: 'x' }, xff(`2001:db8::${i.toString(16)}`))).status);
    }
    for (let i = 7; i <= 11; i++) {
      statuses.push((await h.client().post('/api/login', { email: `v${i}@example.test`, password: 'x' }, xff(`2001:db8::${i.toString(16)}`))).status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(401), 429], 'eleven addresses of one /64 share ten');
    assert.equal((await h.client().post('/api/login', { email: 'w@example.test', password: 'x' }, xff('2001:db8:0:1::1'))).status, 401, 'a neighbouring /64 is not spent');
    assert.equal((await h.client().post('/api/login', { email: 'w2@example.test', password: 'x' }, xff('::ffff:192.0.2.1'))).status, 401);
  } finally { await h.close(); }
});

test('TRUST_PROXY decides whose address a forwarded header is (tests-r1-production-cookie-proxy)', async () => {
  const signupFrom = async (h, ips) => {
    const out = [];
    for (let i = 0; i < ips.length; i++) {
      out.push((await h.client().post('/api/signup', { email: `p${i}@example.test`, password: PASSWORD, slug: `p${i}`, invite: 'D'.repeat(27) }, xff(ips[i]))).status);
    }
    return out;
  };
  const six = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5', '192.0.2.6'];

  const behind = await boot({ limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  try {
    clock.set(Date.now());
    await joinAdmin(behind);
    const st = await signupFrom(behind, six);
    assert.ok(!st.includes(429), `distinct clients behind the proxy: ${st}`);
    const one = await signupFrom(behind, Array(6).fill('192.0.2.77'));
    assert.equal(one[5], 429, 'one client: the sixth is refused');
  } finally { await behind.close(); }

  for (const env of [{}, { TRUST_PROXY: '10.9.9.9' }]) {
    const h = await boot({ limitScale: 1, env });
    try {
      clock.set(Date.now());
      await joinAdmin(h);
      const st = await signupFrom(h, six);
      assert.equal(st[5], 429, `${JSON.stringify(env)}: an untrusted peer cannot choose its bucket`);
      if (!env.TRUST_PROXY) {
        assert.equal(h.logs.filter((l) => /X-Forwarded-For but TRUST_PROXY is off/.test(l)).length, 1, 'said once');
      }
    } finally { await h.close(); }
  }
});

test('the throttle: 30 failures an hour per account from anywhere; a success clears only its pair', () => {
  clock.set(Date.parse('2026-10-15T00:00:00Z'));
  const th = createLoginThrottle();
  const email = 'ada@example.test';
  for (let i = 0; i < 29; i++) th.failed(email, `10.0.0.${i}`);
  assert.equal(th.retryAfter(email, '10.0.0.99'), 0, 'positive control: 29 is under');
  th.failed(email, '10.0.0.29');
  const wait = th.retryAfter(email, '10.0.0.99');
  assert.ok(wait > 15 * 60 && wait <= 3600, `the account window: ${wait}`);
  assert.equal(th.retryAfter('other@example.test', '10.0.0.99'), 0);

  const t2 = createLoginThrottle();
  for (let i = 0; i < 10; i++) { t2.failed(email, '10.0.0.1'); t2.failed(email, '10.0.0.2'); }
  assert.ok(t2.retryAfter(email, '10.0.0.1') > 0);
  t2.succeeded(email, '10.0.0.1');
  assert.equal(t2.retryAfter(email, '10.0.0.1'), 0, 'that pair is cleared');
  assert.ok(t2.retryAfter(email, '10.0.0.2') > 0, 'the other pair is not');
  t2.clear(email);
  assert.equal(t2.retryAfter(email, '10.0.0.2'), 0, 'clear() empties every pair');
});

test('a sprayed account locks across addresses, and a reset unlocks it at once (tests-r1-throttle-account-window-and-reset)', async () => {
  const h = await boot({ limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  try {
    clock.set(Date.now());
    await joinAdmin(h);
    for (let i = 0; i < 30; i++) {
      assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: `wrong ${i}` }, xff(`198.51.100.${i + 1}`))).status, 401);
    }
    const locked = await h.client().post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD }, xff('198.51.100.250'));
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'too_many_attempts', 'a fresh address meets the account window');

    assert.equal((await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL })).status, 202);
    const reset = await h.client().post('/api/password/reset', { token: h.lastTokenTo(ADMIN_EMAIL), password: 'the reset password' });
    assert.equal(reset.status, 200);
    const after = await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'the reset password' }, xff('198.51.100.250'));
    assert.equal(after.status, 200, 'the proven mailbox is let in without waiting');
  } finally { await h.close(); }
});

test('the social budgets (P2, spec 10.7): stamps, comments, friend requests, ring create, rotate, join preview and ask', async () => {
  const { crowd, befriend, note } = require('./helpers/social');
  const { h, c } = await crowd(['ana', 'bram'], { limitScale: 1 });
  try {
    await c.ana.put('/api/me/page', { enabled: true });
    await befriend(c, 'bram', 'ana');   // spends one friend request of bram's
    const post = (await note(c.ana, 'x')).body.id;
    const spend = async (n, fn, what) => {
      for (let i = 0; i < n; i++) assert.notEqual((await fn(i)).status, 429, `${what} #${i + 1} is within budget`);
      const r = await fn(n);
      assert.equal(r.status, 429, `${what} #${n + 1}`);
      assert.equal(r.body.error, 'rate_minute');
      assert.ok(Number(r.headers.get('retry-after')) > 0);
    };
    const faces = ['✿', '❀', '☼', '♥'];
    await spend(20, (i) => c.bram.post(`/api/pages/ana/posts/${post}/stamp`, { kaomoji: faces[i % 4] }), 'stamp');
    await spend(6, () => c.bram.post(`/api/pages/ana/posts/${post}/comment`, { body: 'hi' }), 'comment');
    await spend(4, () => c.bram.post('/api/friends', { handle: 'ana' }), 'friend request');
    await spend(5, (i) => c.ana.post('/api/rings', { name: `R${i}` }), 'ring create');
    const ringId = (await c.ana.get('/api/rings')).body.rings[0].id;
    await spend(10, () => c.ana.post(`/api/rings/${ringId}/link`), 'link rotate');
    await spend(20, () => c.bram.get('/api/rings/join/nope'), 'join preview');
    await spend(10, () => c.bram.post('/api/rings/join/nope'), 'join ask');
  } finally { await h.close(); }
});
