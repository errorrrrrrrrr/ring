#!/usr/bin/env node
'use strict';
/* ── Release a held signup address from the shell (spec 10.11; P8 review F5) ──
 *   npm run signup-release -- someone@example.test
 *   DATA_DIR=/srv/ring/data node scripts/signup-release.js someone@example.test
 *
 * For when no admin exists yet to press /admin's release (before the first
 * member, the address held may be ADMIN_EMAIL itself). It leaves a release
 * note under DATA_DIR (`signup-release/<sha256 of the address>`, the address
 * itself is written nowhere); the running server applies it at the next
 * signup attempt for that address (a stopped one, at its first after boot):
 * the address's daily ceiling as if never spent, its pending rows gone, one
 * `signups.released` audit line by `shell`. It touches no account and needs
 * no running server. The same address, normalised as signup does (trimmed,
 * lowercase).
 */
const path = require('node:path');
const { dataPaths } = require('../lib/paths');
const { writeReleaseNote } = require('../lib/signup-guard');
const { normEmail, validEmail } = require('../routes/auth');

function main(argv, env) {
  const email = normEmail(argv[0]);
  if (!validEmail(email)) {
    process.stderr.write('usage: npm run signup-release -- <email address>\n');
    return 2;
  }
  const paths = dataPaths(path.resolve(env.DATA_DIR || './data'));
  writeReleaseNote(paths, email);
  process.stdout.write('Released: the next signup for that address is mailed again.\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2), process.env);

module.exports = { main };
