'use strict';
/* Gate: a suite whose setup fails is a red run, never a hang
 * (tests-r1-harness-hang-on-setup-failure). A file that boots a server and then
 * throws outside any try leaves a listening server behind; `npm test`'s flags
 * (--test-timeout, --test-force-exit) must still end the run, non-zero, and the
 * harness must remove the temp dir it made. Positive control: without
 * --test-force-exit the same file does hang. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const npmFlags = pkg.scripts.test.split(/\s+/).filter((f) => f.startsWith('--test-'));

const LEAKY = `
const test = require('node:test');
const { boot } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'harness.js'))});
test('setup throws after boot', async () => {
  await boot();
  throw new Error('signup regressed');
});
`;

function run(flags, timeout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-hang-'));
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  const file = path.join(dir, 'leaky.test.js');
  fs.writeFileSync(file, LEAKY);
  const env = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', ...flags, file], { encoding: 'utf8', timeout, env, killSignal: 'SIGKILL' });
  const left = fs.readdirSync(tmp).filter((f) => f.startsWith('ring-test-'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, ms: Date.now() - t0, left };
}

test('npm test\'s flags end a run whose setup leaves a server listening', () => {
  assert.ok(npmFlags.includes('--test-force-exit'), npmFlags.join(' '));
  assert.ok(npmFlags.some((f) => /^--test-timeout=\d+$/.test(f)));
  const r = run(npmFlags, 60_000);
  assert.equal(r.signal, null, `the run was killed after ${r.ms} ms: it hung`);
  assert.notEqual(r.status, 0, 'and it is red');
  assert.match(r.stdout, /signup regressed/);
  assert.deepEqual(r.left, [], 'the harness removed its temp dir');
});

test('positive control: without --test-force-exit the same file hangs', () => {
  const r = run(npmFlags.filter((f) => f !== '--test-force-exit'), 6000);
  assert.equal(r.signal, 'SIGKILL', `expected a hang, got exit ${r.status} in ${r.ms} ms`);
});
