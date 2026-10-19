'use strict';
/* ── The test harness (spec 16.1) ─────────────────────────────────────────────
 * boot() builds the app in-process over a fresh temp DATA_DIR, listens on an
 * ephemeral port on 127.0.0.1, and returns helpers. Nothing uses a fixed port.
 * Mail goes to the `log` provider (DATA/mail-outbox.jsonl), read back by
 * mails(). Every log line the app writes is captured (`logs`), never printed, so
 * a suite can assert what reached the log.
 *
 * Limits are scaled up by default (limitScale 1000) so a suite that is not about
 * rate limits never trips one; a suite that is passes limitScale: 1.
 *
 * Client is a fetch wrapper with a cookie jar: one Client is one browser.
 * Client.stream() opens a request and sends only part of its body, so a suite
 * can act while the body is still arriving.
 *
 * A boot that fails removes the temp dir it made, and any temp dir a suite never
 * closed is removed when the process exits (a failing setup must not leak).
 *
 * `federated: true` (P5) boots with FEDERATION=on on a loopback origin: a free
 * port is found first so PUBLIC_ORIGIN (http://127.0.0.1:<port>, permanent for
 * the server's life) is known before the app is built, and FED_TEST_LOOPBACK=1
 * lets the fetcher reach the other in-process servers on loopback, and loopback
 * ONLY (lib/net.js). The delivery worker runs (`worker`), timers otherwise off.
 */
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../lib/app');

const SECRET = 'test-session-secret-0123456789-abcdefghijklmnop';
const ADMIN_EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';

function captureLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' '));
  return { lines, logger: { log: push, info: push, warn: push, error: push } };
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  sid() { return this.cookies.get('ring.sid') || null; }

  absorb(res) {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || /expires=Thu, 01 Jan 1970/i.test(sc)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  async raw(method, p, { json, body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size && !h.cookie) h.cookie = this.cookieHeader();
    let b = body;
    if (json !== undefined) {
      h['content-type'] = h['content-type'] || 'application/json';
      b = JSON.stringify(json);
    }
    const res = await fetch(this.base + p, { method, headers: h, body: b, redirect: 'manual' });
    this.absorb(res);
    return res;
  }

  async req(method, p, opts) {
    const res = await this.raw(method, p, opts);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, body, text };
  }

  get(p, o) { return this.req('GET', p, o); }
  post(p, json, o = {}) { return this.req('POST', p, { ...o, json }); }
  put(p, json, o = {}) { return this.req('PUT', p, { ...o, json }); }
  patch(p, json, o = {}) { return this.req('PATCH', p, { ...o, json }); }
  del(p, json, o = {}) { return this.req('DELETE', p, json === undefined ? o : { ...o, json }); }

  async bytes(p, o = {}) {
    const res = await this.raw('GET', p, o);
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  /* Start `method path` with a JSON body, send its first `head` bytes and stop.
   * Returns { finish(): Promise<{ status, body }> } that sends the rest. */
  async stream(method, p, json, { head = 5 } = {}) {
    const body = Buffer.from(JSON.stringify(json));
    const url = new URL(this.base + p);
    let answer;
    const answered = new Promise((resolve, reject) => { answer = { resolve, reject }; });
    const req = http.request({
      host: url.hostname, port: url.port, path: url.pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': body.length, cookie: this.cookieHeader() },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        answer.resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', (e) => answer.reject(e));
    req.write(body.subarray(0, head));
    await new Promise((r) => setTimeout(r, 50));   // the server has read the head and is waiting
    return {
      finish: () => { req.end(body.subarray(head)); return answered; },
    };
  }

  async upload(buf, { filename = 'photo.jpg', type = 'image/jpeg', fields = {}, path: p = '/api/images', headers = {} } = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('image', new Blob([buf], { type }), filename);
    return this.req('POST', p, { body: fd, headers });
  }
}

const tempDirs = new Set();   // made by boot() and not removed yet
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function boot(opts = {}) {
  if (!opts.federated) return bootOnce(opts);
  for (let attempt = 0; ; attempt++) {
    const port = opts.port || await freePort();
    try {
      return await bootOnce({ ...opts, port, env: { FEDERATION: 'on', FED_TEST_LOOPBACK: '1', PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, ...opts.env } });
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || attempt >= 4 || opts.port) throw e;
    }
  }
}

async function bootOnce({ env = {}, limitScale = 1000, dataDir = null, federated = false, worker = federated, port = 0 } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ring-test-'));
  if (!dataDir) tempDirs.add(dir);
  const dropDir = () => { if (!dataDir) { fs.rmSync(dir, { recursive: true, force: true }); tempDirs.delete(dir); } };
  const { lines, logger } = captureLogger();
  let ring;
  let server;
  try {
    ring = createApp({
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET: SECRET,
        ADMIN_EMAIL,
        DATA_DIR: dir,
        MAIL_PROVIDER: 'log',
        ...env,
      },
      logger,
      limitScale,
      timers: false,
      worker,
    });
  } catch (e) { dropDir(); throw e; }
  try {
    server = await ring.listen(port, '127.0.0.1');
  } catch (e) {
    await ring.close().catch(() => {});
    dropDir();
    throw e;
  }
  const base = `http://127.0.0.1:${server.address().port}`;

  const mails = () => {
    try {
      return fs.readFileSync(path.join(dir, 'mail-outbox.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  };
  const mailsTo = (to) => mails().filter((m) => m.to === to);
  const tokenIn = (m) => (m && /token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1]) || null;
  const lastTokenTo = (to) => tokenIn(mailsTo(to).at(-1));

  let closed = false;
  const h = {
    ring, ctx: ring.ctx, base, dir, logs: lines,
    client: () => new Client(base),
    mails, mailsTo, lastTokenTo, tokenIn,
    async close({ keepData = false, ...opts } = {}) {
      if (!closed) { closed = true; await ring.close(opts); }
      if (!keepData) dropDir();
    },
  };
  return h;
}

/* Sign up and confirm; returns the signed-in client. */
async function join(h, { email, slug, display_name, invite, password = PASSWORD, client } = {}) {
  const c = client || h.client();
  const r = await c.post('/api/signup', { email, password, slug, display_name: display_name || slug, invite });
  if (r.status !== 202) throw new Error(`signup ${slug}: ${r.status} ${r.text}`);
  const token = h.lastTokenTo(email);
  if (!token) throw new Error(`signup ${slug}: no confirm mail`);
  const ok = await c.post('/api/signup/confirm', { token, password });
  if (ok.status !== 200) throw new Error(`confirm ${slug}: ${ok.status} ${ok.text}`);
  return c;
}

/* The first admin, by ADMIN_EMAIL. */
const joinAdmin = (h, slug = 'ada') => join(h, { email: ADMIN_EMAIL, slug, display_name: 'Ada Admin' });

/* A member invited by `inviter` (a signed-in client). */
async function joinInvited(h, inviter, { slug, email = `${slug}@example.test`, display_name } = {}) {
  const inv = await inviter.post('/api/invites');
  if (inv.status !== 201) throw new Error(`invite for ${slug}: ${inv.status} ${inv.text}`);
  return join(h, { email, slug, display_name, invite: inv.body.code });
}

module.exports = { boot, join, joinAdmin, joinInvited, Client, SECRET, ADMIN_EMAIL, PASSWORD, freePort };
