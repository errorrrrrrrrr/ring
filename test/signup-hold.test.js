'use strict';
/* The signup door cannot be held shut by one requester (P8 review F5; spec
 * 10.11, 16.3), real budgets (limitScale 1), the clock moved, TRUST_PROXY so
 * X-Forwarded-For stands in for the client address. No real server.
 *   one requester (one IPv6 /48, a fresh /64 every attempt) attacking for
 *     thirty hours at its full rate never closes an address: the owner, elsewhere, is
 *     mailed every time they try;
 *   six requesters can close it (the exact claim), the owner's attempts while
 *     it is held spend nothing of their own, and a release opens it at once
 *     while the six cannot refill it (each spent its own day);
 *   the owner's own confirm clears the ceiling;
 *   before the first member, with no admin to release anything, the shell
 *     does (scripts/signup-release.js), and ADMIN_EMAIL then becomes admin.
 * Each with its positive control. */
const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../lib/clock');
const { boot, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');
const { main: releaseFromShell } = require('../scripts/signup-release');

const xff = (ip) => ({ headers: { 'x-forwarded-for': ip } });
const HOUR = 3600_000;
test.afterEach(() => clock.reset());

function door(h) {
  let n = 0;
  let sixtyfour = 0;
  const signup = async (email, ip, password = 'attacker-pw-123456') => {
    clock.advance(13_000);   // under the route's own 5 a minute per client
    const r = await h.client().post('/api/signup', { email, password, slug: `s${n++}` }, xff(ip));
    assert.equal(r.status, 202, r.text);
  };
  // Requester k: a fresh /64 inside ITS /48 every time (the route's own limit,
  // and the 3 live pending rows per address and client, are per /64).
  const as = (email, k) => signup(email, `2001:db8:${k}:${(sixtyfour++).toString(16)}::1`);
  const oneRequester = (email) => as(email, 77);
  // Count what is SENT (the log outbox prunes itself as the clock moves).
  const sent = [];
  const send = h.ctx.mailer.send.bind(h.ctx.mailer);
  h.ctx.mailer.send = (msg) => { sent.push(msg.to); return send(msg); };
  const mailsTo = (email) => sent.filter((t) => t === email).length;
  const mailed = async (email, ip, password) => {
    const before = mailsTo(email);
    await signup(email, ip, password);
    return mailsTo(email) - before;
  };
  return { signup, as, oneRequester, mailed, mailsTo, ip: (k) => `2001:db8:${k}:${(sixtyfour++).toString(16)}::1` };
}

test('one requester at its full rate for thirty hours never closes an address: the owner is mailed every time', async () => {
  clock.set(Date.parse('2026-11-01T00:00:00Z'));
  const h = await boot({ limitScale: 1, env: { SIGNUP: 'open', TRUST_PROXY: 'loopback' } });
  try {
    const victim = 'victim@example.test';
    const d = door(h);
    let hits = 0;
    for (let hour = 0; hour < 30; hour++) {
      for (let i = 0; i < 5; i++) await d.oneRequester(victim);
      // (from a fresh address each time: one client holds 3 live links per address)
      if (hour % 6 === 5) { assert.equal(await d.mailed(victim, `198.51.100.${hour}`, PASSWORD), 1, `hour ${hour}: the owner's link`); hits++; }
      clock.advance(HOUR + 60_000);
    }
    assert.equal(hits, 5);
  } finally { await h.close(); }
});

test('six requesters can hold it shut, the owner loses nothing trying, and a release opens it while the six cannot refill it', async () => {
  clock.set(Date.parse('2026-11-01T00:00:00Z'));
  const h = await boot({ limitScale: 1, env: { SIGNUP: 'open', TRUST_PROXY: 'loopback' } });
  try {
    const victim = 'victim@example.test';
    const d = door(h);
    for (let k = 1; k <= 5; k++) for (let i = 0; i < 5; i++) await d.as(victim, k);
    assert.equal(await d.mailed(victim, '198.51.100.7', PASSWORD), 1, 'five requesters cannot close it (positive control)');
    for (let i = 0; i < 4; i++) await d.as(victim, 6);
    assert.equal(d.mailsTo(victim), 30, 'the ceiling: thirty');
    // Held. The owner tries five times: nothing goes, and nothing of theirs is spent.
    for (let i = 0; i < 5; i++) assert.equal(await d.mailed(victim, '198.51.100.7', PASSWORD), 0, 'held shut');
    for (let k = 1; k <= 6; k++) await d.as(victim, k);   // the six keep at it
    h.ctx.signupGuard.release(victim);
    for (let k = 1; k <= 5; k++) assert.equal(await d.mailed(victim, d.ip(k)), 0, `requester ${k} spent its own day: it cannot refill the ceiling`);
    assert.equal(await d.mailed(victim, '198.51.100.7', PASSWORD), 1, 'released: the owner is mailed');
    assert.equal(await d.mailed(victim, '198.51.100.7', PASSWORD), 1, 'and their budget was untouched while held (2 of 5 now)');
  } finally { await h.close(); }
});

test('the owner\'s own confirm clears the address\'s ceiling', async () => {
  clock.set(Date.parse('2026-11-01T00:00:00Z'));
  const h = await boot({ limitScale: 1, env: { SIGNUP: 'open', TRUST_PROXY: 'loopback' } });
  try {
    const email = 'owner@example.test';
    const d = door(h);
    const owner = h.client();
    assert.equal((await owner.post('/api/signup', { email, password: PASSWORD, slug: 'owner' }, xff('198.51.100.7'))).status, 202);
    const token = h.lastTokenTo(email);
    for (let k = 1; k <= 6; k++) for (let i = 0; i < 5; i++) await d.as(email, k);
    assert.equal(d.mailsTo(email), 30, 'held by six');
    assert.equal(await d.mailed(email, '203.0.113.9'), 0, 'a seventh gets nothing (positive control: still held)');
    assert.equal((await owner.post('/api/signup/confirm', { token, password: PASSWORD })).status, 200);
    assert.equal(h.ctx.pending.all().filter((r) => r.email_lc === email).length, 0, 'the strangers\' rows went too');
    assert.equal(await d.mailed(email, '203.0.113.9'), 1, 'cleared: the next attempt is mailed (an "already have an account" mail)');
  } finally { await h.close(); }
});

test('before the first member, the shell releases ADMIN_EMAIL held by six requesters; with no release it stays held', async () => {
  clock.set(Date.parse('2026-11-01T00:00:00Z'));
  const h = await boot({ limitScale: 1, env: { TRUST_PROXY: 'loopback' } });
  try {
    const d = door(h);
    for (let k = 1; k <= 6; k++) for (let i = 0; i < 5; i++) await d.as(ADMIN_EMAIL, k);
    assert.equal(d.mailsTo(ADMIN_EMAIL), 30);
    assert.equal(h.ctx.members.count(), 0, 'no admin exists to release it');
    assert.equal(await d.mailed(ADMIN_EMAIL, '198.51.100.7', PASSWORD), 0, 'held (positive control)');
    assert.equal(releaseFromShell(['  Admin@Example.Test '], { DATA_DIR: h.dir }), 0, 'the script, spelled as typed');
    assert.equal(releaseFromShell(['not an address'], { DATA_DIR: h.dir }), 2);
    for (let k = 1; k <= 6; k++) assert.equal(await d.mailed(ADMIN_EMAIL, d.ip(k)), 0, 'the six cannot refill it');
    assert.equal(await d.mailed(ADMIN_EMAIL, '198.51.100.7', PASSWORD), 1, 'released: the operator is mailed');
    const ok = await h.client().post('/api/signup/confirm', { token: h.lastTokenTo(ADMIN_EMAIL), password: PASSWORD });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.member.role, 'admin');
    const audit = require('node:fs').readFileSync(h.ctx.paths.audit, 'utf8');
    assert.match(audit, /"event":"signups.released","actor":"shell"/);
    assert.ok(!audit.includes(ADMIN_EMAIL), 'the address is logged nowhere');
  } finally { await h.close(); }
});
