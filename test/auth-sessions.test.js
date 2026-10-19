'use strict';
/* Gate: the session store and the mailer under damage (spec 10.9, 14). A damaged
 * session file is no session: that cookie is signed out, never a 500, and every
 * walk (destroyFor, sweep, all) goes on past it. A hung SMTP server ends in a
 * logged failure within bounded waits, never a socket held for good. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { hashOf } = require('../lib/session-store');
const { createMailer, SMTP_TIMEOUTS } = require('../lib/mail');
const { boot, joinAdmin, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');

const sidOf = (client) => decodeURIComponent(client.sid()).slice(2).split('.')[0];

test('a damaged session file signs that cookie out and stops nothing else', async () => {
  const h = await boot();
  try {
    const a = await joinAdmin(h);
    const b = h.client();
    assert.equal((await b.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD })).status, 200);
    const dir = path.join(h.dir, 'sessions');
    const aFile = path.join(dir, `${hashOf(sidOf(a))}.json`);
    assert.ok(fs.existsSync(aFile), 'positive control: the file of a\'s session');
    fs.writeFileSync(aFile, '{"member":"ada","expires":');   // torn
    const junk = path.join(dir, `${'f'.repeat(64)}.json`);
    fs.writeFileSync(junk, '[1,2,3]');                        // the wrong shape

    const me = await a.get('/api/me');
    assert.equal(me.status, 401, `a damaged session is no session, not a ${me.status}`);
    assert.ok(!fs.existsSync(aFile), 'the damaged file is gone');
    assert.ok(h.logs.some((l) => /damaged session file/.test(l)));
    assert.equal((await b.get('/api/me')).status, 200, 'the other session is untouched');

    assert.doesNotThrow(() => h.ctx.sessionStore.all(), 'all() walks past it');
    assert.ok(!fs.existsSync(junk));
    fs.writeFileSync(junk, 'not json');
    assert.doesNotThrow(() => h.ctx.sessionStore.sweep());
    fs.writeFileSync(junk, 'not json');
    // A reset ends every session: destroyFor walks the directory past the junk.
    await h.client().post('/api/password/forgot', { email: ADMIN_EMAIL });
    const reset = await h.client().post('/api/password/reset', { token: h.lastTokenTo(ADMIN_EMAIL), password: 'the reset password' });
    assert.equal(reset.status, 200);
    assert.equal((await b.get('/api/me')).status, 401, 'destroyFor still ended b');
    assert.ok(!fs.existsSync(junk));
  } finally { await h.close(); }
});

test('the SMTP transport carries bounded waits', () => {
  const cfg = { publicOrigin: 'https://ring.example', mail: { provider: 'smtp', smtpUrl: 'smtp://127.0.0.1:1', from: '' } };
  const opts = createMailer(cfg, { root: '/nonexistent', mailOutbox: '/nonexistent/x' }).transportOptions();
  for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
    assert.equal(opts[k], SMTP_TIMEOUTS[k], k);
    assert.ok(SMTP_TIMEOUTS[k] > 0 && SMTP_TIMEOUTS[k] <= 30_000, `${k} is bounded`);
  }
});

test('a hung SMTP server: the send fails within its timeouts and the socket is let go', { timeout: 8000 }, async () => {
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s));   // accepts, never greets
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const lines = [];
  const logger = { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const cfg = { publicOrigin: 'https://ring.example', mail: { provider: 'smtp', smtpUrl: `smtp://127.0.0.1:${silent.address().port}`, from: '' } };
  const mailer = createMailer(cfg, { root: '/nonexistent', mailOutbox: '/nonexistent/x' }, { logger, smtpTimeouts: { connectionTimeout: 300, greetingTimeout: 300, socketTimeout: 600 } });
  try {
    mailer.send({ to: 'a@example.test', subject: 'Reset', text: 'https://ring.example/reset?token=secret' });
    await mailer.flush();
    assert.ok(lines.some((l) => /send failed \(Reset\)/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /token=/.test(l)));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sockets.length >= 1 && sockets.every((s) => s.destroyed || s.readableEnded), 'the client hung up');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => silent.close(r));
  }
});
