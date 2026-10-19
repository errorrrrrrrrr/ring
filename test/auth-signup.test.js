'use strict';
/* Gate: the signup door (spec 6.3, 10.11, 11.1). The password is the mailbox
 * holder's (a planted signup never carries the planter's password), a stranger
 * cannot evict a pending row, the first-admin window names no address, the confirm
 * page needs a submit, and the two sides of "no enumeration" cost the same:
 * counted, not timed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const express = require('express');
const clock = require('../lib/clock');
const { boot, joinAdmin, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');

test.afterEach(() => clock.reset());

const ATTACKER_PW = 'attacker-password-123';
const xff = (ip) => ({ headers: { 'x-forwarded-for': ip } });

test('a planted signup is never completed with the planter\'s password (security-r1-01)', async () => {
  const h = await boot({ env: { TRUST_PROXY: 'loopback' } });
  try {
    // The operator signs up first; then a stranger plants three rows for the same
    // address, same name, their own password, from another address.
    const op = await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'op' }, xff('198.51.100.7'));
    assert.equal(op.status, 202);
    const opToken = h.lastTokenTo(ADMIN_EMAIL);
    const planted = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: ATTACKER_PW, slug: 'op' }, xff('203.0.113.9'));
      assert.equal(r.status, 202, 'the stranger is answered like anyone');
      const tok = h.lastTokenTo(ADMIN_EMAIL);
      if (tok !== opToken && !planted.includes(tok)) planted.push(tok);
    }
    assert.equal(planted.length, 3, 'a client holds at most three live links for one email; the fourth is refused');
    assert.ok(h.ctx.pending.find(opToken), 'the operator\'s own row was not evicted');

    // The mailbox owner clicks a planted link and types THEIR password: refused.
    for (const tok of planted) {
      const r = await h.client().post('/api/signup/confirm', { token: tok, password: PASSWORD });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'password_mismatch');
    }
    assert.equal(h.ctx.members.count(), 0, 'no row came of a planted link');
    const none = await h.client().post('/api/signup/confirm', { token: planted[0] });
    assert.equal(none.body.error, 'password_mismatch', 'no password is no proof either');

    // Their own link with their own password: the admin, holding their password.
    const ok = await h.client().post('/api/signup/confirm', { token: opToken, password: PASSWORD });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.member.role, 'admin');
    assert.ok(await bcrypt.compare(PASSWORD, h.ctx.members.get('op').password_hash));
    assert.ok(!(await bcrypt.compare(ATTACKER_PW, h.ctx.members.get('op').password_hash)));
    const attacker = await h.client().post('/api/login', { email: ADMIN_EMAIL, password: ATTACKER_PW });
    assert.equal(attacker.status, 401, 'the planter cannot sign in');
    assert.equal((await h.client().post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD })).status, 200, 'positive control');
    assert.deepEqual(h.ctx.pending.all().filter((r) => r.email_lc === ADMIN_EMAIL), [], 'the confirm cleared every pending row of the address');
  } finally { await h.close(); }
});

test('pending rows past the per-client cap are refused, never evicted', async () => {
  const h = await boot({ env: { SIGNUP: 'open' } });
  try {
    clock.set(Date.now());
    const email = 'cap@example.test';
    const tokens = [];
    for (let i = 0; i < 4; i++) {
      if (i) clock.advance(61_000);   // under the per-IP 5 a minute
      assert.equal((await h.client().post('/api/signup', { email, password: PASSWORD, slug: `cap${i}` })).status, 202);
      tokens.push(h.lastTokenTo(email));
    }
    assert.equal(h.mailsTo(email).length, 3, 'the fourth wrote no row and sent no mail');
    assert.equal(tokens[3], tokens[2]);
    assert.ok(h.ctx.pending.find(tokens[0]), 'the first row is still there');
    assert.equal((await h.client().post('/api/signup/confirm', { token: tokens[0], password: PASSWORD })).status, 200);
  } finally { await h.close(); }
});

test('before the first member, every invite-less signup gets the same answer (spec-r1-02)', async () => {
  const h = await boot();
  try {
    const body = (email, extra = {}) => ({ email, password: PASSWORD, slug: 'someone', ...extra });
    const guess = await h.client().post('/api/signup', body('guess@example.test'));
    const bogus = await h.client().post('/api/signup', body('other@example.test', { invite: 'C'.repeat(27) }));
    const admin = await h.client().post('/api/signup', body(ADMIN_EMAIL));
    for (const r of [guess, bogus]) {
      assert.equal(r.status, admin.status);
      assert.deepEqual(r.body, admin.body);
    }
    assert.equal(admin.status, 202);
    assert.equal(h.mailsTo('guess@example.test').length, 0, 'a guess is mailed nothing');
    assert.equal(h.mailsTo('other@example.test').length, 0);
    assert.equal(h.mailsTo(ADMIN_EMAIL).length, 1, 'positive control: ADMIN_EMAIL gets its link');
    assert.equal(h.ctx.pending.all().length, 1, 'only ADMIN_EMAIL has a row');

    // Once the admin exists, the ordinary door speaks again.
    await h.client().post('/api/signup/confirm', { token: h.lastTokenTo(ADMIN_EMAIL), password: PASSWORD });
    const after = await h.client().post('/api/signup', body('guess@example.test', { slug: 'guesser' }));
    assert.equal(after.status, 400);
    assert.equal(after.body.error, 'invite_required');
  } finally { await h.close(); }
});

test('the confirm page needs a submit: opening the link spends nothing (tests-r1-confirm-get-click)', async () => {
  const h = await boot();
  try {
    await h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'ada' });
    const token = h.lastTokenTo(ADMIN_EMAIL);
    const scanner = h.client();
    const page = await scanner.get(`/signup/confirm?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.text, /<form id="confirm-form">/);
    assert.match(page.text, /type="password" name="password"/, 'the page asks for the signup password');
    assert.equal(h.ctx.members.get('ada'), null, 'no row from a GET');
    assert.ok(h.ctx.pending.find(token), 'the token is unspent');
    assert.equal((await scanner.get('/api/me')).status, 401, 'the scanner holds no session');
    const ok = await h.client().post('/api/signup/confirm', { token, password: PASSWORD });
    assert.equal(ok.status, 200, 'positive control: the submit confirms');

    // The script posts the confirm only from the form's submit handler.
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'auth.js'), 'utf8');
    const at = src.indexOf("post('/api/signup/confirm'");
    assert.ok(at > 0);
    assert.equal(src.split("post('/api/signup/confirm'").length, 2, 'one call site');
    const before = src.slice(0, at);
    assert.ok(before.lastIndexOf("addEventListener('submit'") > before.lastIndexOf('})'), 'inside the submit handler');
  } finally { await h.close(); }
});

/* Count bcrypt work by wrapping the shared module object (lib/auth.js reads
 * bcrypt.hash and bcrypt.compare at call time). */
async function counting(fn) {
  const real = { hash: bcrypt.hash, compare: bcrypt.compare };
  const n = { hash: 0, compare: 0 };
  bcrypt.hash = (...a) => { n.hash++; return real.hash(...a); };
  bcrypt.compare = (...a) => { n.compare++; return real.compare(...a); };
  try { await fn(); } finally { Object.assign(bcrypt, real); }
  return n;
}

test('no enumeration, counted: one compare per login and one hash per signup on every path (tests-r1-enumeration-timing)', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const unknown = await counting(() => h.client().post('/api/login', { email: 'nobody@example.test', password: PASSWORD }));
    const wrong = await counting(() => h.client().post('/api/login', { email: ADMIN_EMAIL, password: 'not the password' }));
    const right = await counting(() => h.client().post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD }));
    assert.equal(right.compare, 1, 'positive control: the spy sees the compare');
    assert.equal(unknown.compare, 1, 'an unknown email costs a compare');
    assert.equal(wrong.compare, 1);

    const inv = async () => (await admin.post('/api/invites')).body.code;
    const fresh = await counting(async () => h.client().post('/api/signup', { email: 'new@example.test', password: PASSWORD, slug: 'newbie', invite: await inv() }));
    const taken = await counting(async () => h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'other', invite: await inv() }));
    assert.equal(fresh.hash, 1, 'positive control');
    assert.equal(taken.hash, 1, 'a taken email is hashed too');
  } finally { await h.close(); }

  const h2 = await boot();
  try {
    const quiet = await counting(() => h2.client().post('/api/signup', { email: 'guess@example.test', password: PASSWORD, slug: 'guess' }));
    const real = await counting(() => h2.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'ada' }));
    assert.equal(real.hash, 1);
    assert.equal(quiet.hash, 1, 'the quiet first-admin answer hashes too');
  } finally { await h2.close(); }
});

/* Record the order of the answer and the store work, and count fsyncs. */
async function traced(h, fn) {
  const events = [];
  const realJson = express.response.json;
  const realFsync = fs.fsyncSync;
  const wrapped = [];
  for (const file of [h.ctx.pending, h.ctx.resets]) {
    for (const k of ['add', 'touch']) {
      const real = file[k];
      file[k] = function (...a) { events.push('work'); return real.apply(this, a); };
      wrapped.push([file, k, real]);
    }
  }
  let fsyncs = 0;
  express.response.json = function (...a) { events.push('answer'); return realJson.apply(this, a); };
  fs.fsyncSync = (...a) => { fsyncs++; return realFsync(...a); };
  try {
    const r = await fn();
    return { r, events, fsyncs };
  } finally {
    express.response.json = realJson;
    fs.fsyncSync = realFsync;
    for (const [file, k, real] of wrapped) file[k] = real;
  }
}

test('signup and forgot answer first, then do the same store work on both paths (security-r1-02, spec-r1-09)', async () => {
  const h = await boot();
  try {
    const admin = await joinAdmin(h);
    const inv = async () => (await admin.post('/api/invites')).body.code;
    const codes = [await inv(), await inv()];

    const known = await traced(h, () => h.client().post('/api/password/forgot', { email: ADMIN_EMAIL }));
    const unknown = await traced(h, () => h.client().post('/api/password/forgot', { email: 'nobody@example.test' }));
    assert.equal(known.r.status, 202);
    assert.deepEqual(unknown.r.body, known.r.body);
    assert.deepEqual(known.events, ['answer', 'work'], 'the token is written after the answer left');
    assert.deepEqual(unknown.events, ['answer', 'work'], 'an unknown email does the same write');
    assert.equal(unknown.fsyncs, known.fsyncs, 'the same fsync count');
    assert.ok(known.fsyncs >= 1, 'positive control: the spy sees the write');
    assert.ok(h.lastTokenTo(ADMIN_EMAIL), 'the reset mail is out by the time the answer is read');

    const fresh = await traced(h, () => h.client().post('/api/signup', { email: 'new@example.test', password: PASSWORD, slug: 'newbie', invite: codes[0] }));
    const taken = await traced(h, () => h.client().post('/api/signup', { email: ADMIN_EMAIL, password: PASSWORD, slug: 'other', invite: codes[1] }));
    assert.deepEqual(taken.r.body, fresh.r.body);
    assert.deepEqual(fresh.events, ['answer', 'work']);
    assert.deepEqual(taken.events, ['answer', 'work']);
    assert.equal(taken.fsyncs, fresh.fsyncs, 'a taken email writes the pending file too');
    assert.ok(h.lastTokenTo('new@example.test'));
  } finally { await h.close(); }
});
