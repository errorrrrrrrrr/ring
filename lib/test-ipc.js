'use strict';
/* ── The P7 test hook's gate (server.js, RING_TEST_IPC) ───────────────────────
 * A suite that runs a Ring server as a child process (test/helpers/
 * ring-process.js) moves its clock and runs its sweeps over the IPC channel.
 * The hook exists only on a TEST server (P7 review, F5), all four at once:
 *   RING_TEST_IPC=1                the suite asked for it
 *   an IPC channel                 a parent that can speak to it
 *   not production                 cfg.production (NODE_ENV=production)
 *   cfg.fedTestLoopback            FED_TEST_LOOPBACK=1, which lib/config.js
 *                                  refuses unless PUBLIC_ORIGIN is on loopback
 * A process manager that forks a real server with an IPC channel (pm2's fork
 * mode, node's fork) and a stray env var never opens it. A clock move must be
 * a finite number of ms, at most a year either way; anything else is refused.
 */
const { loopbackOrigin } = require('./config');

const ADVANCE_MAX_MS = 366 * 24 * 3600_000;

function testIpcAllowed({ env, cfg, channel }) {
  return env.RING_TEST_IPC === '1' && channel === true && !cfg.production && cfg.fedTestLoopback === true
    && !!cfg.publicOrigin && loopbackOrigin(cfg.publicOrigin);
}

/* -> the ms to move, or null when refused. */
function advanceMs(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > ADVANCE_MAX_MS) return null;
  return raw;
}

module.exports = { testIpcAllowed, advanceMs, ADVANCE_MAX_MS };
