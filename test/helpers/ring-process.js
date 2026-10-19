'use strict';
/* A real Ring server in its own process (`node server.js`), on loopback, with
 * FEDERATION=on and the loopback test hook: for the suites that need two Ring
 * servers talking (fed-two-servers) or a process boundary (fed-smoke's shape).
 * Nothing leaves loopback. stop() is SIGTERM, waits for the exit and removes the
 * data dir. member(slug) signs up a member over the JSON API (the first is the
 * admin, by ADMIN_EMAIL; later ones by an invite the admin mints) and returns
 * its signed-in Client. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client, SECRET, ADMIN_EMAIL, PASSWORD, freePort } = require('./harness');
const { until } = require('./fediverse');

const ROOT = path.join(__dirname, '..', '..');

async function startRing({ env = {} } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-proc-'));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test', SESSION_SECRET: SECRET, ADMIN_EMAIL, DATA_DIR: dir, PORT: String(port),
      PUBLIC_ORIGIN: origin, FEDERATION: 'on', FED_TEST_LOOPBACK: '1', MAIL_PROVIDER: 'log', RING_TEST_IPC: '1', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // The test hook (server.js, RING_TEST_IPC): move this server's clock, run its
  // room sweep, housekeeping or queue, and wait for its answer.
  let seq = 0;
  const pending = new Map();
  child.on('message', (m) => { const p = pending.get(m?.id); if (p) { pending.delete(m.id); (m.ok ? p.resolve : p.reject)(new Error(m.error || 'failed')); } });
  const send = (type, extra = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve: () => resolve(), reject });
    child.send({ id, type, ...extra });
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  await until(() => out.includes('listening on') || child.exitCode !== null, { ms: 15_000, what: 'the server to listen' });
  if (child.exitCode !== null) throw new Error(`server exited: ${out}`);
  let admin = null;
  const mails = () => {
    try { return fs.readFileSync(path.join(dir, 'mail-outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  let stopped = null;
  return {
    origin, dir, port, host: `127.0.0.1:${port}`, child, log: () => out,
    advance: (ms) => send('advance', { ms }),
    sweep: () => send('sweep'),
    housekeeping: () => send('housekeeping'),
    drain: () => send('drain'),
    async member(slug, displayName) {
      const c = new Client(origin);
      const email = admin ? `${slug}@example.test` : ADMIN_EMAIL;
      let invite;
      if (admin) invite = (await admin.post('/api/invites')).body.code;
      const s = await c.post('/api/signup', { email, password: PASSWORD, slug, display_name: displayName || slug, invite });
      if (s.status !== 202) throw new Error(`signup ${slug}: ${s.status} ${s.text}`);
      const token = await until(() => /token=([A-Za-z0-9_-]+)/.exec(mails().filter((m) => m.to === email).at(-1)?.text || '')?.[1], { what: `the confirm mail for ${slug}` });
      const ok = await c.post('/api/signup/confirm', { token, password: PASSWORD });
      if (ok.status !== 200) throw new Error(`confirm ${slug}: ${ok.status} ${ok.text}`);
      if (!admin) admin = c;
      return c;
    },
    stop() {
      if (!stopped) {
        stopped = (async () => {
          if (child.exitCode === null) child.kill('SIGTERM');
          const code = await exited;
          fs.rmSync(dir, { recursive: true, force: true });
          return code;
        })();
      }
      return stopped;
    },
  };
}

module.exports = { startRing };
