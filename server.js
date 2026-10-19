'use strict';
/* ── Ring's entry point ───────────────────────────────────────────────────────
 * Reads the environment (lib/config.js), builds the app (lib/app.js), listens.
 * A setting production needs and lacks refuses the boot with every reason at
 * once. SIGINT and SIGTERM close cleanly and boundedly: timers stop, requests in
 * flight drain, the odometer flushes, mail in flight is awaited for a while, the
 * data-dir lock is released. A second signal stops at once.
 */
const { createApp } = require('./lib/app');

let ring;
try {
  ring = createApp();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const { cfg } = ring;
if (cfg.sessionSecretWarning) console.warn(`[ring] ${cfg.sessionSecretWarning}. Fine locally; production refuses to start like this.`);
if (cfg.trustProxy && typeof cfg.trustProxy === 'number') console.warn(`[ring] TRUST_PROXY=${cfg.trustProxy} believes X-Forwarded-For from ANY peer: keep the app port off the network, or name the proxy (TRUST_PROXY=loopback).`);
if (cfg.federation) {
  console.warn(`[ring] FEDERATION=on as ${cfg.publicOrigin}. Once this server federates (its first delivery or verified inbound activity), that origin is permanent: other servers keep its actor URLs for good, and this data dir will refuse to boot under any other.`);
  if (!cfg.authorizedFetch) console.warn('[ring] AUTHORIZED_FETCH=0: outboxes, collections and posts answer unsigned GETs.');
}
if (!cfg.adminEmail) console.warn('[ring] ADMIN_EMAIL is not set: nobody can become the first admin.');

ring.listen().then((server) => {
  const addr = server.address();
  console.log(`[ring] listening on ${typeof addr === 'string' ? addr : `port ${addr.port}`}`
    + ` (data ${cfg.dataDir}, trust proxy ${cfg.trustProxy || 'off'}, origin ${cfg.publicOrigin || 'the request origin, dev'}, mail ${cfg.mail.provider || 'none'}, signup ${cfg.signup})`);
}, (e) => {
  console.error(`[ring] could not listen: ${e.message}`);
  process.exit(1);
});

/* A TEST hook (P7): a suite that runs this server as a child process with an
 * IPC channel (test/helpers/ring-process.js, RING_TEST_IPC=1) may move ITS clock
 * and run its room sweep, housekeeping and delivery queue on demand, so a ring
 * spanning three servers can live through a week in a test. Installed only on
 * a TEST server: the env var, the IPC channel, never NODE_ENV=production (the
 * clock refuses too), and the loopback test hook on (FED_TEST_LOOPBACK=1, which
 * lib/config.js allows only with PUBLIC_ORIGIN on loopback). A process manager
 * that forks a real server with an IPC channel never gets it (P7 review, F5).
 * A clock move must be a finite number of ms within a year either way. */
const { testIpcAllowed, advanceMs } = require('./lib/test-ipc');
if (testIpcAllowed({ env: process.env, cfg, channel: typeof process.send === 'function' })) {
  const clock = require('./lib/clock');
  console.warn('[ring] RING_TEST_IPC: the test hook is on (loopback test server only)');
  process.on('message', async (m) => {
    const answer = (x) => { try { process.send({ id: m?.id, ...x }); } catch { /* parent gone */ } };
    try {
      if (m?.type === 'advance') {
        const ms = advanceMs(m.ms);
        if (ms === null) return answer({ ok: false, error: 'advance: a finite number of ms within a year' });
        clock.advance(ms);
      } else if (m?.type === 'sweep') ring.ctx.ringReset.run();
      else if (m?.type === 'housekeeping') ring.ctx.housekeeping.run();
      else if (m?.type === 'drain') await ring.ctx.federation?.queue.drain();
      else return answer({ ok: false, error: 'unknown' });
      answer({ ok: true });
    } catch (e) { answer({ ok: false, error: e.message }); }
  });
}

/* The first SIGINT/SIGTERM drains (lib/app.js close: in-flight requests up to 8 s,
 * mail up to 10 s, then the lock goes). A second signal, or a close still running
 * after 25 s, releases the lock synchronously and exits at once. */
let closing = false;
const hardStop = (why) => {
  console.error(`[ring] ${why}: stopping now.`);
  try { ring.forceRelease(); } catch (e) { console.error(e.message); }
  process.exit(1);
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return hardStop(`${sig} again`);
    closing = true;
    setTimeout(() => hardStop('shutdown took over 25 s'), 25_000).unref();
    ring.close().then(() => process.exit(0), () => process.exit(1));
  });
}
