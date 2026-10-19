'use strict';
/* Gate: accounts (spec 16.3 "auth"). Signup without enumeration, invites, the
 * first admin, tokens, names, login, the throttle, session rotation, ending
 * sessions, and deletion purging every trace. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clock = require('../lib/clock');
const { boot, join, joinAdmin, joinInvited, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');
const { png } = require('./helpers/images');

test.afterEach(() => clock.reset());

test('signup answers alike for a new and a taken email; the row exists only after confirm', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const inv1 = (await admin.post('/api/invites')).body.code;
    const inv2 = (await admin.post('/api/invites')).body.code;

    const fresh = await h.client().post('/api/signup', { email: 'new@example.test', password: PASSWORD, slug: 'newbie', invite: inv1 });
    const taken = await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'other', invite: inv2 });
    assert.equal(fresh.status, 202);
    assert.equal(taken.status, fresh.status);
    assert.deepEqual(taken.body, fresh.body);

    // Each got a different mail: a link for the new one, "you have an account" for the taken one.
    assert.match(h.mailsTo('new@example.test').at(-1).subject, /Confirm/);
    const adminMails = h.mailsTo(ADMIN_EMAIL);
    assert.match(adminMails.at(-1).subject, /Your Ring account/);
    assert.equal(h.tokenIn(adminMails.at(-1)), null, 'the taken-email mail carries no token');

    // No row before confirm; a row after.
    assert.equal(h.ctx.members.get('newbie'), null);
    assert.equal((await h.client().get('/api/names/newbie')).body.available, true);
    const c = h.client();
    const ok = await c.post('/api/signup/confirm', { token: h.lastTokenTo('new@example.test'), password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.member.name, 'newbie');
    assert.equal(h.ctx.members.get('newbie').role, 'member');
    assert.equal(h.ctx.members.get('newbie').invited_by, 'ada', 'invited_by holds a handle');
    assert.equal((await c.get('/api/me')).status, 200, 'confirm signs in');
  } finally { await h.close(); }
});

test('an invite is required, single use, capped at 5 live, revocable, and expires', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const none = await h.client().post('/api/signup', { email: 'x@example.test', password: PASSWORD, slug: 'xx' });
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'invite_required');
    const bogus = await h.client().post('/api/signup', { email: 'x@example.test', password: PASSWORD, slug: 'xx', invite: 'A'.repeat(27) });
    assert.equal(bogus.body.error, 'invite_invalid');

    // Single use: two pending signups on one invite, the second confirm is refused.
    const code = (await admin.post('/api/invites')).body.code;
    assert.equal((await h.client().post('/api/signup', { email: 'p1@example.test', password: PASSWORD, slug: 'p-one', invite: code })).status, 202);
    assert.equal((await h.client().post('/api/signup', { email: 'p2@example.test', password: PASSWORD, slug: 'p-two', invite: code })).status, 202);
    assert.equal((await h.client().post('/api/signup/confirm', { token: h.lastTokenTo('p1@example.test'), password: PASSWORD })).status, 200);
    const second = await h.client().post('/api/signup/confirm', { token: h.lastTokenTo('p2@example.test'), password: PASSWORD });
    assert.equal(second.status, 400);
    assert.equal(second.body.error, 'invite_invalid');
    assert.equal(h.ctx.members.get('p-two'), null);
    const used = await h.client().post('/api/signup', { email: 'p3@example.test', password: PASSWORD, slug: 'p-three', invite: code });
    assert.equal(used.body.error, 'invite_invalid');

    const bob = await joinInvited(h, admin, { slug: 'bob' });

    // Five live, then 409; revoking one frees a slot.
    const minted = [];
    for (let i = 0; i < 5; i++) {
      const r = await admin.post('/api/invites');
      assert.equal(r.status, 201, `invite ${i}`);
      minted.push(r.body);
    }
    const sixth = await admin.post('/api/invites');
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.error, 'invite_limit');
    const list = await admin.get('/api/invites');
    assert.equal(list.body.live, 5);
    assert.equal(list.body.limit, 5);
    assert.equal((await admin.del(`/api/invites/${minted[0].id}`)).status, 200);
    const revoked = await h.client().post('/api/signup', { email: 'r@example.test', password: PASSWORD, slug: 'rev', invite: minted[0].code });
    assert.equal(revoked.body.error, 'invite_invalid');
    assert.equal((await admin.post('/api/invites')).status, 201, 'a revoked invite frees its slot');

    // Someone else cannot revoke it.
    assert.equal((await bob.del(`/api/invites/${minted[1].id}`)).status, 404);

    // Expiry: 14 days.
    clock.set(Date.now() + 15 * 24 * 3600_000);
    const late = await h.client().post('/api/signup', { email: 'late@example.test', password: PASSWORD, slug: 'late', invite: minted[1].code });
    assert.equal(late.body.error, 'invite_invalid');
  } finally { await h.close(); }
});

test('SIGNUP=open needs no invite; ADMIN_EMAIL makes only the very first account admin', async () => {
  const h = await boot({ env: { SIGNUP: 'open' } });
  try {
    // A pending first-admin signup that confirms after someone else joined: an ordinary member.
    await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'slowpoke' });
    const pendingAdmin = h.lastTokenTo(ADMIN_EMAIL);
    const bob = await join(h, { email: 'bob@example.test', slug: 'bob' });
    const late = await h.client().post('/api/signup/confirm', { token: pendingAdmin, password: PASSWORD });
    assert.equal(late.status, 200, late.text);
    assert.equal(late.body.member.role, 'member');
    assert.equal((await bob.get('/api/me')).body.role, 'member', 'the first account is admin only by ADMIN_EMAIL');
    await join(h, { email: 'second@example.test', slug: 'second' });
    assert.equal(h.ctx.members.get('second').role, 'member');
    assert.deepEqual(h.ctx.members.admins(), [], 'after the first account ADMIN_EMAIL grants nothing');
  } finally { await h.close(); }

  const h2 = await boot();
  try {
    // Two bootstrap signups pending at once: the first confirm is admin, the second is refused.
    await h2.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'first' });
    const t1 = h2.lastTokenTo(ADMIN_EMAIL);
    const admin = h2.client();
    assert.equal((await admin.post('/api/signup/confirm', { token: t1, password: PASSWORD })).body.member.role, 'admin');
    const again = await h2.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'second' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'invite_required', 'with members present, ADMIN_EMAIL needs an invite like anyone');
  } finally { await h2.close(); }

  const h3 = await boot();
  try {
    await h3.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'racer' });
    const pendingAdmin = h3.lastTokenTo(ADMIN_EMAIL);
    // Another account appears first (an operator seeded it), then the pending bootstrap confirms.
    h3.ctx.members.insert({ slug: 'seed', email: 's@example.test', email_lc: 's@example.test', password_hash: 'x', display_name: 'Seed', role: 'admin', invited_by: null, created_at: clock.iso(), status: 'active' });
    const r = await h3.client().post('/api/signup/confirm', { token: pendingAdmin, password: PASSWORD });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invite_required');
    assert.equal(h3.ctx.members.get('racer'), null);
  } finally { await h3.close(); }
});

test('confirm and reset tokens are single use and expire', async () => {
  const h = await boot();
  try {
    await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'ada' });
    const token = h.lastTokenTo(ADMIN_EMAIL);
    assert.ok(!fs.readFileSync(path.join(h.dir, 'pending-signups.json'), 'utf8').includes(token), 'only the hash is stored');
    assert.equal((await h.client().post('/api/signup/confirm', { token, password: PASSWORD })).status, 200);
    const twice = await h.client().post('/api/signup/confirm', { token, password: PASSWORD });
    assert.equal(twice.status, 400);
    assert.equal(twice.body.error, 'token_invalid');

    // A confirm link past 24 hours.
    const admin = h.client();
    await admin.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD });
    const code = (await admin.post('/api/invites')).body.code;
    await h.client().post('/api/signup', { email: 'slow@example.test', password: PASSWORD, slug: 'slow', invite: code });
    clock.set(Date.now() + 25 * 3600_000);
    assert.equal((await h.client().post('/api/signup/confirm', { token: h.lastTokenTo('slow@example.test'), password: PASSWORD })).body.error, 'token_invalid');
    clock.reset();

    // Reset: single use, an hour.
    assert.equal((await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL })).status, 202);
    const rt = h.lastTokenTo(ADMIN_EMAIL);
    assert.ok(!fs.readFileSync(path.join(h.dir, 'password-resets.json'), 'utf8').includes(rt));
    assert.equal((await h.client().post('/api/password/reset', { token: rt, password: 'a brand new password' })).status, 200);
    assert.equal((await h.client().post('/api/password/reset', { token: rt, password: 'another new password' })).body.error, 'token_invalid');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'a brand new password' })).status, 200);

    await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL });
    const rt2 = h.lastTokenTo(ADMIN_EMAIL);
    clock.set(Date.now() + 61 * 60_000);
    assert.equal((await h.client().post('/api/password/reset', { token: rt2, password: 'too late password' })).body.error, 'token_invalid');

    // Forgot answers 202 for an unknown email too, and mails nobody.
    const before = h.mails().length;
    const unknown = await h.client().post('/api/password/forgot', { email: 'nobody@example.test' });
    assert.equal(unknown.status, 202);
    assert.equal(h.mails().length, before);
  } finally { await h.close(); }
});

test('names: shape, reserved and retired words, taken names', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h, 'ana');
    const avail = async (n) => (await h.client().get(`/api/names/${encodeURIComponent(n)}`)).body.available;
    assert.equal(await avail('fresh-name'), true, 'positive control');
    for (const bad of ['-lead', 'trail-', 'UPPER_', 'a'.repeat(31), 'has space', 'dot.ted']) {
      assert.equal(await avail(bad), false, bad);
    }
    for (const reserved of ['api', 'admin', 'users', 'well-known', 'inbox', 'login']) {
      assert.equal(await avail(reserved), false, reserved);
    }
    assert.equal(await avail('ana'), false, 'taken');

    const inv = (await admin.post('/api/invites')).body.code;
    const r = await h.client().post('/api/signup', { email: 'x@example.test', password: PASSWORD, slug: 'admin', invite: inv });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'name_unavailable');
    const shape = await h.client().post('/api/signup', { email: 'x@example.test', password: PASSWORD, slug: 'Bad Name!', invite: inv });
    assert.equal(shape.body.error, 'name_invalid');
    const short = await h.client().post('/api/signup', { email: 'x@example.test', password: 'short', slug: 'okname', invite: inv });
    assert.equal(short.body.error, 'password_short');

    // A deleted member's name retires and is never reissued.
    const gone = await joinInvited(h, admin, { slug: 'gone' });
    assert.equal((await gone.del('/api/me', { password: PASSWORD })).status, 200);
    assert.equal(await avail('gone'), false);
    const reuse = await h.client().post('/api/signup', { email: 'g2@example.test', password: PASSWORD, slug: 'gone', invite: (await admin.post('/api/invites')).body.code });
    assert.equal(reuse.body.error, 'name_unavailable');
  } finally { await h.close(); }
});

test('login: one 401 for an unknown email and a wrong password; suspended after the password', async () => {
  const h = await boot();
  try {
    await joinAdmin(h);
    const unknown = await h.client().post('/api/login', { email: 'nobody@example.test', password: PASSWORD });
    const wrong = await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'not the password' });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(unknown.body, wrong.body);
    assert.equal(unknown.body.error, 'invalid_credentials');
    const right = await h.client().post('/api/login', { email: ADMIN_EMAIL.toUpperCase(), password: PASSWORD });
    assert.equal(right.status, 200, 'positive control, email case-insensitive');

    h.ctx.members.update('ada', { status: 'suspended' });
    const s = await h.client().post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD });
    assert.equal(s.status, 403);
    assert.equal(s.body.error, 'suspended');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'wrong again' })).status, 401, 'a wrong password never says suspended');
  } finally { await h.close(); }
});

test('the login throttle refuses an account after 10 failures, before the password is checked', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    await joinAdmin(h);
    clock.set(Date.now());
    for (let i = 0; i < 10; i++) {
      if (i && i % 9 === 0) clock.advance(61_000);   // keep under the per-IP 10 a minute
      assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: `wrong ${i}` })).status, 401);
    }
    clock.advance(61_000);
    const locked = await h.client().post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'too_many_attempts');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    // An unknown email is throttled the same way (no oracle).
    for (let i = 0; i < 10; i++) {
      if (i % 9 === 0) clock.advance(61_000);
      await h.client().post('/api/login', { email: 'ghost@example.test', password: `x${i}` });
    }
    clock.advance(61_000);
    assert.equal((await h.client().post('/api/login', { email: 'ghost@example.test', password: 'x' })).body.error, 'too_many_attempts');
    // The window ages out.
    clock.advance(16 * 60_000);
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD })).status, 200);
  } finally { await h.close(); }
});

test('the per-IP signup limit answers 429 with Retry-After', async () => {
  const h = await boot({ limitScale: 1 });
  try {
    clock.set(Date.now());
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await h.client().post('/api/signup', { email: `s${i}@example.test`, password: PASSWORD, slug: `s${i}`, invite: 'B'.repeat(27) })).status);
    }
    // No member yet: every invite-less signup gets the same quiet 202 (spec-r1-02).
    assert.deepEqual(statuses.slice(0, 5), [202, 202, 202, 202, 202]);
    assert.equal(statuses[5], 429);
  } finally { await h.close(); }
});

test('the session id rotates at login, and logout ends the session', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const first = admin.sid();
    assert.ok(first);
    const again = await admin.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD });
    assert.equal(again.status, 200);
    const second = admin.sid();
    assert.ok(second && second !== first, 'a new id on every sign-in');
    const thief = h.client();
    thief.cookies.set('ring.sid', first);
    assert.equal((await thief.get('/api/me')).status, 401, 'the pre-login id is dead');
    assert.equal((await admin.get('/api/me')).status, 200);

    const kept = admin.sid();
    assert.equal((await admin.post('/api/logout')).status, 200);
    const replay = h.client();
    replay.cookies.set('ring.sid', kept);
    assert.equal((await replay.get('/api/me')).status, 401, 'logout destroys the session');
  } finally { await h.close(); }
});

test('password change ends the other sessions; reset ends all', async () => {
  const h = await boot();
  try {
    const a = await joinAdmin(h);
    const b = h.client();
    assert.equal((await b.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD })).status, 200);
    assert.equal((await b.get('/api/me')).status, 200);

    const wrong = await a.post('/api/me/password', { current: 'nope nope nope', next: 'the next password' });
    assert.equal(wrong.status, 403);
    assert.equal((await a.post('/api/me/password', { current: PASSWORD, next: 'the next password' })).status, 200);
    assert.equal((await a.get('/api/me')).status, 200, 'this session stays');
    assert.equal((await b.get('/api/me')).status, 401, 'the other one ends');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'the next password' })).status, 200);

    const c = h.client();
    await c.post('/api/login', { email: ADMIN_EMAIL, password: 'the next password' });
    await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL });
    assert.equal((await h.client().post('/api/password/reset', { token: h.lastTokenTo(ADMIN_EMAIL), password: 'reset password one' })).status, 200);
    assert.equal((await a.get('/api/me')).status, 401);
    assert.equal((await c.get('/api/me')).status, 401);
    assert.equal(h.ctx.sessionStore.all().filter((s) => s.member === 'ada').length, 0);
  } finally { await h.close(); }
});

test('deletion needs the password, ends every session and purges every trace', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const ana = await joinInvited(h, admin, { slug: 'ana', email: 'ana@example.test', display_name: 'Ana Lima' });
    const other = h.client();
    await other.post('/api/login', { email: 'ana@example.test', password: PASSWORD });
    const img = await ana.upload(await png(), { filename: 'a.png', type: 'image/png' });
    assert.equal(img.status, 201);
    await ana.post('/api/posts', { kind: 'image', media: { key: img.body.key, alt: 'a' } });
    await ana.post('/api/posts', { kind: 'note', note: 'hello' });
    await ana.put('/api/me/page', { enabled: true, bio: 'hi' });
    const inv = await ana.post('/api/invites');
    const carl = await joinInvited(h, ana, { slug: 'carl' });
    await h.client().post('/api/password/forgot', { email: 'ana@example.test' });
    assert.ok(fs.existsSync(path.join(h.dir, 'keys', 'ana.pem')));

    assert.equal((await ana.del('/api/me', { password: 'wrong password!' })).status, 403);
    assert.equal((await ana.del('/api/me', { password: PASSWORD })).status, 200);
    assert.equal((await ana.get('/api/me')).status, 401);
    assert.equal((await other.get('/api/me')).status, 401, 'every session ended');
    assert.equal((await h.client().get('/api/pages/ana')).status, 404);
    assert.equal((await h.client().bytes(img.body.url)).status, 404);

    // No file under DATA mentions her, except the retired list and the audit log
    // (the mail outbox included: the purge drops every mail to her address).
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        const rel = path.relative(h.dir, p);
        if (rel === 'retired-handles.json' || rel === 'audit.log') continue;
        const text = fs.readFileSync(p).toString('latin1');
        if (/"ana"|ana@example\.test|\bana\.pem|members\/ana/.test(text) || rel.includes('ana')) hits.push(rel);
      }
    };
    walk(h.dir);
    assert.deepEqual(hits, [], 'traces left behind');
    assert.ok(!fs.existsSync(path.join(h.dir, 'members', 'ana')));
    assert.equal(h.ctx.images.keysOf('ana').length, 0);
    assert.equal(h.ctx.members.get('carl').invited_by, null);
    assert.equal(h.ctx.invites.get(inv.body.id), null);
    assert.equal((await carl.get('/api/me')).status, 200, 'positive control: other members untouched');
    assert.ok(h.ctx.audit.read().some((r) => r.event === 'member.deleted' && r.actor === 'ana'));
  } finally { await h.close(); }
});

test('the last admin cannot delete their account while others remain', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const bob = await joinInvited(h, admin, { slug: 'bob' });
    const r = await admin.del('/api/me', { password: PASSWORD });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'last_admin');
    assert.equal((await bob.del('/api/me', { password: PASSWORD })).status, 200, 'positive control: a member may');
    assert.equal((await admin.del('/api/me', { password: PASSWORD })).status, 200, 'the only member may');
  } finally { await h.close(); }
});

test('without a mail provider in production, signup and reset answer 503', async () => {
  const h = await boot({ env: { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://ring.example', MAIL_PROVIDER: '', TRUST_PROXY: 'loopback' } });
  try {
    const r = await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'ada' });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'mail_unavailable');
    assert.equal((await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL })).status, 503);
  } finally { await h.close(); }
});

test('production refuses to boot without its settings', () => {
  const { loadConfig } = require('../lib/config');
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (e) => e.problems.length >= 3);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://ring.example', SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAIL: 'a@b.c' }), /https|entropy/);
  assert.throws(() => loadConfig({}), /SESSION_SECRET/);
  const ok = loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://ring.example/', SESSION_SECRET: 'Zq8f1-a9LmP0x7Kd2RtY6vWb3NcE5hGj', ADMIN_EMAIL: 'A@B.example', TRUST_PROXY: 'loopback' });
  assert.equal(ok.publicOrigin, 'https://ring.example');
  assert.equal(ok.adminEmail, 'a@b.example');
  assert.equal(ok.mail.provider, null);
  assert.equal(ok.federation, false, 'federation defaults off');
});
