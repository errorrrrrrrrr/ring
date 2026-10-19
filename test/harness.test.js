'use strict';
/* Gate: the harness itself. A failing assertion and an unhandled rejection each
 * fail a `node --test` run (positive control: a passing file exits 0), and a
 * failure inside a route is a logged 500, never a hang or a swallowed rejection.
 * Also: `npm test` discovers test/*.test.js and nothing under test/helpers/. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { boot, joinAdmin, ADMIN_EMAIL, PASSWORD } = require('./helpers/harness');

function runFile(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-harness-'));
  const file = path.join(dir, 'case.test.js');
  fs.writeFileSync(file, source);
  // A fresh runner: NODE_TEST_CONTEXT would make the child report to this run instead.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', timeout: 60_000, env });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('node --test fails on a failing assertion and on an unhandled rejection', () => {
  const pass = runFile("require('node:test')('ok', () => { require('node:assert').equal(1, 1); });");
  assert.equal(pass.status, 0, `positive control:\n${pass.stdout}${pass.stderr}`);
  const fail = runFile("require('node:test')('bad', () => { require('node:assert').equal(1, 2); });");
  assert.equal(fail.status, 1);
  const asyncFail = runFile("require('node:test')('bad', async () => { await Promise.resolve(); require('node:assert').equal('a', 'b'); });");
  assert.equal(asyncFail.status, 1);
  const rejection = runFile("require('node:test')('leak', async () => { Promise.reject(new Error('swallowed?')); await new Promise((r) => setTimeout(r, 50)); });");
  assert.equal(rejection.status, 1, `an unhandled rejection must fail the run:\n${rejection.stdout}`);
});

test('a throw inside a route is a logged 500 with no detail', async () => {
  const h = await boot();
  try {
    await joinAdmin(h, 'ana');
    const stage = h.ctx.keys.stage;
    h.ctx.keys.stage = async () => { throw new Error('disk on fire'); };
    try {
      const admin = h.client();
      await admin.post('/api/login', { email: ADMIN_EMAIL, password: PASSWORD });
      const code = (await admin.post('/api/invites')).body.code;
      await h.client().post('/api/signup', { email: 'b@example.test', password: PASSWORD, slug: 'bee', invite: code });
      const r = await h.client().post('/api/signup/confirm', { token: h.lastTokenTo('b@example.test'), password: PASSWORD });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, 'server_error');
      assert.ok(!r.text.includes('disk on fire'), 'no detail leaves the server');
      assert.ok(h.logs.some((l) => l.includes('disk on fire')), 'but it is logged');
      assert.equal(h.ctx.members.get('bee'), null);
    } finally { h.ctx.keys.stage = stage; }
  } finally { await h.close(); }
});

test('npm test discovers test/*.test.js only', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, "node --test --test-timeout=60000 --test-force-exit 'test/*.test.js'");
  const suites = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
  for (const s of ['auth', 'ids-and-keys', 'images', 'ring', 'privacy', 'store', 'lifecycle', 'harness-hang']) assert.ok(suites.includes(`${s}.test.js`), s);
  assert.ok(!fs.readdirSync(path.join(__dirname, 'helpers')).some((f) => f.endsWith('.test.js')));
});
