'use strict';
/* ── Configuration (spec 15.3) ────────────────────────────────────────────────
 * The environment is read ONCE, here, into a frozen object every module gets
 * injected. Nothing else reads process.env for a setting (the clock's production
 * guard is the one exception). A setting production needs and lacks refuses the
 * boot with every reason at once, never a half-configured server.
 */
const path = require('node:path');
const { normalizeHost } = require('./handles');

const SESSION_SECRET_MIN_LEN = 32;

/* Length is not entropy. */
function sessionSecretProblem(v) {
  const s = String(v == null ? '' : v);
  if (!s.trim()) return 'SESSION_SECRET is not set';
  if (s.length < SESSION_SECRET_MIN_LEN) return `SESSION_SECRET is ${s.length} characters; the minimum is ${SESSION_SECRET_MIN_LEN}`;
  if (new Set(s).size < 8) return 'SESSION_SECRET repeats too few distinct characters to carry real entropy';
  return '';
}

/* PUBLIC_ORIGIN as an origin, or '' (unset), or null (refused). A TRAILING DOT
 * is refused, never normalised away: `ring.example.` and `ring.example` are one
 * host to DNS but two strings in every id, handle and signature, so the origin
 * is spelled the one way (spec 15.2). */
function parseOrigin(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  if (u.hostname.endsWith('.')) return null;
  return u.origin;
}

/* Is this origin's host a loopback address or name (what the test hook needs)? */
function loopbackOrigin(origin) {
  if (!origin) return false;
  const hostname = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '::1';
}

/* TRUST_PROXY (spec 15.3): which peers may speak for the client in
 * X-Forwarded-For / X-Forwarded-Proto. Express's own grammar, minus `true`:
 *   1, 2, ...                 a hop count (the nearest N peers, whoever they are)
 *   loopback,uniquelocal,...  names, addresses or CIDRs: ONLY those peers are
 *                             believed, so a client that reaches the app port
 *                             directly cannot pick its own bucket (security-r1-04)
 * Unset is false. Returns undefined for a value it refuses. */
const PROXY_NAMES = new Set(['loopback', 'linklocal', 'uniquelocal']);
function parseTrustProxy(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '0') return false;
  if (/^[1-9]\d?$/.test(s)) return Number(s);
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  const ok = parts.length && parts.every((x) => PROXY_NAMES.has(x) || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x));
  return ok ? parts.join(',') : undefined;
}

/* Hosts a server must never federate under (spec 15.2): a provider's default
 * host or a tunnel can never move to the real domain later, and every id embeds
 * the host for good. The host itself or any subdomain of a row is refused. A
 * bare IP or `localhost` is refused too, except loopback under the test hook,
 * and so is a trailing dot. */
const NEVER_FEDERATE = [
  // platform default hosts
  'onrender.com', 'herokuapp.com', 'fly.dev', 'railway.app', 'up.railway.app', 'vercel.app', 'netlify.app',
  'pages.dev', 'workers.dev', 'azurewebsites.net', 'azurestaticapps.net', 'azurecontainerapps.io', 'cloudapp.azure.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'run.app', 'cloudfunctions.net', 'amplifyapp.com', 'awsapprunner.com',
  'elasticbeanstalk.com', 'amazonaws.com', 'cloudfront.net', 'ondigitalocean.app', 'koyeb.app', 'northflank.app',
  'deno.dev', 'deno.net', 'replit.app', 'replit.dev', 'repl.co', 'glitch.me', 'github.io', 'gitlab.io',
  'codeberg.page', 'surge.sh', 'sevalla.app', 'zeabur.app', 'csb.app',
  // tunnels and dev environments
  'ngrok.io', 'ngrok.app', 'ngrok.dev', 'ngrok-free.app', 'ngrok-free.dev', 'trycloudflare.com', 'loca.lt',
  'localtunnel.me', 'lhr.life', 'localhost.run', 'serveo.net', 'pinggy.link', 'tunnelmole.net', 'ts.net',
  'github.dev', 'gitpod.io', 'codesandbox.io',
];
function federationOriginProblem(origin, { testLoopback = false } = {}) {
  if (!origin) return 'FEDERATION=on needs PUBLIC_ORIGIN: every actor and post id embeds it, for good';
  const u = new URL(origin);
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname.endsWith('.')) return `FEDERATION=on refuses ${hostname}: spell PUBLIC_ORIGIN without the trailing dot`;
  const loopback = loopbackOrigin(origin);
  if (testLoopback && loopback) return '';
  if (u.protocol !== 'https:') return 'FEDERATION=on needs an https PUBLIC_ORIGIN';
  if (u.port) return 'FEDERATION=on needs PUBLIC_ORIGIN on the default https port (other servers address name@host, without a port)';
  if (loopback || /^[\d.]+$/.test(hostname) || hostname.includes(':') || !hostname.includes('.')) return `FEDERATION=on refuses ${hostname}: federate only under a domain you will keep forever`;
  const bad = NEVER_FEDERATE.find((d) => hostname === d || hostname.endsWith(`.${d}`));
  if (bad) return `FEDERATION=on refuses ${hostname}: a provider's default host (*.${bad}) can never move to your real domain later; set PUBLIC_ORIGIN to the domain you will keep`;
  return '';
}

const intOr = (v, d, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const problems = [];

  const publicOrigin = parseOrigin(env.PUBLIC_ORIGIN);
  if (publicOrigin === null) {
    let dotted = false;
    try { dotted = new URL(String(env.PUBLIC_ORIGIN).trim()).hostname.endsWith('.'); } catch { dotted = false; }
    problems.push(dotted ? 'PUBLIC_ORIGIN must be spelled without a trailing dot (https://ring.example, never https://ring.example.)' : 'PUBLIC_ORIGIN must be an origin like https://ring.example (no path)');
  }
  if (production && !publicOrigin) problems.push('PUBLIC_ORIGIN is required in production');
  if (production && publicOrigin && !publicOrigin.startsWith('https://')) problems.push('PUBLIC_ORIGIN must be https in production');

  const secretProblem = sessionSecretProblem(env.SESSION_SECRET);
  if (!String(env.SESSION_SECRET || '').trim()) problems.push('SESSION_SECRET is required');
  else if (production && secretProblem) problems.push(secretProblem);

  const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (production && !adminEmail) problems.push('ADMIN_EMAIL is required in production');

  const signup = (env.SIGNUP || 'invite').trim();
  if (!['invite', 'open'].includes(signup)) problems.push('SIGNUP must be invite or open');

  const federation = (env.FEDERATION || 'off').trim();
  if (!['on', 'off'].includes(federation)) problems.push('FEDERATION must be on or off');

  let mailProvider = (env.MAIL_PROVIDER || '').trim();
  if (!mailProvider && !production) mailProvider = 'log';
  if (mailProvider && !['smtp', 'resend', 'log'].includes(mailProvider)) problems.push('MAIL_PROVIDER must be smtp, resend or log');
  if (mailProvider === 'smtp' && !env.SMTP_URL) problems.push('MAIL_PROVIDER=smtp needs SMTP_URL');
  if (mailProvider === 'resend' && !env.RESEND_API_KEY) problems.push('MAIL_PROVIDER=resend needs RESEND_API_KEY');

  // A real provider mails links to strangers' inboxes: their origin must never
  // come from a request's Host header (security-r1-03), whatever NODE_ENV says.
  if ((mailProvider === 'smtp' || mailProvider === 'resend') && !publicOrigin) {
    problems.push(`MAIL_PROVIDER=${mailProvider} needs PUBLIC_ORIGIN: mailed links are never built from a request's Host header`);
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (trustProxy === undefined) problems.push('TRUST_PROXY must be a hop count (1) or a list of proxy addresses (loopback, uniquelocal, 10.0.0.0/8, ...)');
  // Ring always runs behind a TLS proxy in production (spec 15.1): without this
  // the Secure cookie is never set and every client shares the proxy's bucket.
  else if (production && !trustProxy) problems.push('TRUST_PROXY is required in production (Ring is always behind a TLS proxy): 1, or the proxy\'s address such as loopback');

  // The test hook opens loopback to the fetcher: only on a server that is itself
  // on loopback, and never in production (F6). A real domain with the hook on
  // would let any remote point this server's fetches at its own machine.
  const testHook = env.FED_TEST_LOOPBACK === '1';
  if (testHook && production) problems.push('FED_TEST_LOOPBACK is a test hook and is refused in production');
  else if (testHook && !loopbackOrigin(publicOrigin)) problems.push('FED_TEST_LOOPBACK is a test hook: it needs PUBLIC_ORIGIN on loopback (http://127.0.0.1:<port>), never a real domain');
  if (federation === 'on' && publicOrigin !== null) {
    const p = federationOriginProblem(publicOrigin, { testLoopback: testHook && !production });
    if (p) problems.push(p);
  }

  // BLOCKED_DOMAINS: a comma list of hosts, each covering its subdomains. P6's
  // stopgap; since P8 a SEED of the admin's domain blocks (lib/moderation.js
  // seed, spec 6.5), imported at boot, a host once.
  const blockedDomains = [];
  for (const raw of String(env.BLOCKED_DOMAINS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    // THE normalizer (lib/handles.js): case, one trailing dot, IDN; an IP
    // literal names that address (P8 review F4).
    const d = normalizeHost(raw, { allowPort: testHook, allowIp: true });
    if (!d) problems.push(`BLOCKED_DOMAINS: ${raw.slice(0, 80)} is not a host name`);
    else if (!blockedDomains.includes(d)) blockedDomains.push(d);
  }

  if (problems.length) {
    const err = new Error('Ring cannot start:\n  - ' + problems.join('\n  - '));
    err.problems = problems;
    throw err;
  }

  return Object.freeze({
    production,
    publicOrigin: publicOrigin || '',
    sessionSecret: String(env.SESSION_SECRET),
    sessionSecretWarning: secretProblem,
    adminEmail,
    dataDir: path.resolve(env.DATA_DIR || './data'),
    port: intOr(env.PORT, 3000, 0, 65535),
    trustProxy: trustProxy || false,
    signup,
    invitesPerMember: intOr(env.INVITES_PER_MEMBER, 5, 0, 100),
    federation: federation === 'on',
    authorizedFetch: env.AUTHORIZED_FETCH !== '0',
    mail: Object.freeze({
      provider: mailProvider || null,
      smtpUrl: env.SMTP_URL || '',
      resendApiKey: env.RESEND_API_KEY || '',
      from: env.MAIL_FROM || '',
    }),
    nodeName: String(env.NODE_NAME || '').trim(),
    memberStorageBytes: intOr(env.MEMBER_STORAGE_MB, 500, 1, 1_000_000) * 1024 * 1024,
    fedTestLoopback: testHook,
    blockedDomains: Object.freeze(blockedDomains),
    remoteMediaBytes: intOr(env.REMOTE_MEDIA_MB, 2048, 1, 1_000_000) * 1024 * 1024,
  });
}

module.exports = { loadConfig, sessionSecretProblem, parseOrigin, parseTrustProxy, federationOriginProblem, loopbackOrigin, NEVER_FEDERATE };
