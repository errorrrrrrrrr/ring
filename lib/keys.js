'use strict';
/* ── Signing keys (spec 2.6) ──────────────────────────────────────────────────
 * An RSA 2048 keypair per member, generated at signup confirm BEFORE the member
 * row is written (the row is the commit). `keyId` = `<actor id>#main-key`.
 *
 * THE one reader and writer of `DATA/keys/`: the private key lives in
 * `keys/<name>.pem`, mode 0600 in a 0700 dir. It never appears in an HTTP
 * response, a log line, an audit row or an error report; nothing outside this
 * module touches the file. The public half is derived from it on read.
 *
 * Generation is async, so a confirm STAGES the key under a random name first and
 * COMMITS it (a rename) in the same synchronous tick as the member row: two
 * confirms racing for one name can never overwrite each other's key.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const clock = require('./clock');
const { writeFileAtomic } = require('./store');
const { validName } = require('./handles');
const { RING_ID_RE } = require('./ids');

const MODULUS_BITS = 2048;

function createKeys(keysDir) {
  const publicCache = new Map();

  function ensureDir() {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(keysDir, 0o700);
  }
  const fileOf = (name) => {
    if (!validName(name)) throw new Error('keys: not a member name');
    return path.join(keysDir, `${name}.pem`);
  };

  /* A fresh keypair, written under a staging name. Returns its handle. */
  async function stage() {
    const { privateKey } = await new Promise((resolve, reject) => {
      crypto.generateKeyPair('rsa', {
        modulusLength: MODULUS_BITS,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      }, (err, publicKey, privKey) => (err ? reject(err) : resolve({ publicKey, privateKey: privKey })));
    });
    ensureDir();
    const staged = path.join(keysDir, `.staged-${crypto.randomBytes(8).toString('hex')}.pem`);
    writeFileAtomic(staged, privateKey, { mode: 0o600 });
    fs.chmodSync(staged, 0o600);
    return staged;
  }

  /* Synchronous: the staged key becomes `name`'s. */
  function commit(staged, name) {
    const file = fileOf(name);
    fs.renameSync(staged, file);
    fs.chmodSync(file, 0o600);
    publicCache.delete(name);
  }

  function discard(staged) {
    try { fs.unlinkSync(staged); } catch { /* already gone */ }
  }

  const has = (name) => validName(name) && fs.existsSync(fileOf(name));

  /* The public key as SPKI PEM (the actor's publicKeyPem, P5). */
  function publicKeyPem(name) {
    if (publicCache.has(name)) return publicCache.get(name);
    const pem = crypto.createPublicKey(fs.readFileSync(fileOf(name), 'utf8')).export({ type: 'spki', format: 'pem' });
    publicCache.set(name, pem);
    return pem;
  }

  /* The private key as a KeyObject, for signing (P5). Never serialized here. */
  function privateKey(name) {
    return crypto.createPrivateKey(fs.readFileSync(fileOf(name), 'utf8'));
  }

  /* The private key as PEM text, for ONE caller: the member's own export
   * (routes/export.js, spec 12), only after they ticked "include my signing
   * key" and typed their password again. Nothing else serializes it. */
  function exportPem(name) {
    return fs.readFileSync(fileOf(name), 'utf8');
  }

  /* A deleted member's key goes with the purge when no delivery job needs it;
   * else it waits for the last job they sign (lib/queue.js, spec 2.6). */
  function remove(name) {
    publicCache.delete(name);
    try { fs.unlinkSync(fileOf(name)); } catch { /* already gone */ }
  }

  /* The instance actor's key (`keys/_instance.pem`, spec 2.6): it signs the
   * server's own fetches (actors, keys) and, from P8, Flags. Made once, at the
   * first federating boot, synchronously (one 2048-bit key, before listen). */
  const instanceFile = () => path.join(keysDir, '_instance.pem');
  let instancePem = null;
  function ensureInstance() {
    if (fs.existsSync(instanceFile())) return false;
    const { privateKey: pem } = crypto.generateKeyPairSync('rsa', {
      modulusLength: MODULUS_BITS,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    ensureDir();
    writeFileAtomic(instanceFile(), pem, { mode: 0o600 });
    fs.chmodSync(instanceFile(), 0o600);
    instancePem = null;
    return true;
  }
  function instancePrivateKey() {
    return crypto.createPrivateKey(fs.readFileSync(instanceFile(), 'utf8'));
  }
  function instancePublicKeyPem() {
    if (!instancePem) instancePem = crypto.createPublicKey(fs.readFileSync(instanceFile(), 'utf8')).export({ type: 'spki', format: 'pem' });
    return instancePem;
  }

  /* A ring's key (P7, spec 2.6): `keys/rings/<ring id>.pem`, made at the ring's
   * creation on its HOME server (and lazily for a ring made before P7), signing
   * every activity its Group sends; deleted with the ring once no delivery job
   * it signs is left (lib/groups.js, lib/federation.js onSignerIdle). The ring
   * id is checked against its shape before it names a file. */
  const ringsDir = () => path.join(keysDir, 'rings');
  const ringFile = (id) => {
    if (!RING_ID_RE.test(String(id))) throw new Error('keys: not a ring id');
    return path.join(ringsDir(), `${id}.pem`);
  };
  const ringPublicCache = new Map();
  const hasRing = (id) => RING_ID_RE.test(String(id)) && fs.existsSync(ringFile(id));
  function ensureRing(id) {
    const file = ringFile(id);
    if (fs.existsSync(file)) return false;
    const { privateKey: pem } = crypto.generateKeyPairSync('rsa', {
      modulusLength: MODULUS_BITS,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    ensureDir();
    fs.mkdirSync(ringsDir(), { recursive: true, mode: 0o700 });
    fs.chmodSync(ringsDir(), 0o700);
    writeFileAtomic(file, pem, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    ringPublicCache.delete(id);
    return true;
  }
  function ringPrivateKey(id) {
    ensureRing(id);
    return crypto.createPrivateKey(fs.readFileSync(ringFile(id), 'utf8'));
  }
  function ringPublicKeyPem(id) {
    if (ringPublicCache.has(id)) return ringPublicCache.get(id);
    ensureRing(id);
    const pem = crypto.createPublicKey(fs.readFileSync(ringFile(id), 'utf8')).export({ type: 'spki', format: 'pem' });
    ringPublicCache.set(id, pem);
    return pem;
  }
  function removeRing(id) {
    ringPublicCache.delete(id);
    try { fs.unlinkSync(ringFile(id)); } catch { /* already gone */ }
  }
  /* The ring ids that still have a key file (housekeeping: a deleted ring's key
   * goes once its last job has ended). */
  function ringNames() {
    try { return fs.readdirSync(ringsDir()).filter((f) => f.endsWith('.pem') && !f.startsWith('.')).map((f) => f.slice(0, -4)).filter((x) => RING_ID_RE.test(x)); } catch { return []; }
  }

  /* The member names that still have a key file (housekeeping: a retired name's
   * key goes once its last delivery job has ended, spec 2.6). */
  function names() {
    try {
      return fs.readdirSync(keysDir).filter((f) => f.endsWith('.pem') && !f.startsWith('.') && !f.startsWith('_')).map((f) => f.slice(0, -4)).filter(validName);
    } catch { return []; }
  }

  /* Housekeeping: staging files a crash left behind. */
  function sweepStaged(maxAgeMs = 3600_000) {
    let n = 0;
    try {
      for (const f of fs.readdirSync(keysDir)) {
        if (!f.startsWith('.staged-')) continue;
        const p = path.join(keysDir, f);
        if (clock.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); n++; }
      }
    } catch { /* no dir yet */ }
    return n;
  }

  return {
    stage, commit, discard, has, publicKeyPem, privateKey, exportPem, remove, sweepStaged, names, ensureInstance, instancePrivateKey, instancePublicKeyPem, MODULUS_BITS,
    hasRing, ensureRing, ringPrivateKey, ringPublicKeyPem, removeRing, ringNames,
  };
}

module.exports = { createKeys };
