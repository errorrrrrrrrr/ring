'use strict';
/* Gate: every bearer secret is a pure function of the platform CSPRNG
 * (tests-r1-csprng-gates-pin-spelling). crypto.randomBytes is pinned to a known
 * buffer: each value must then be exactly that buffer's encoding, and with the
 * real generator two draws must differ. A value built from the clock, hrtime or
 * Math.random fails here whatever its source text says. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ids = require('../lib/ids');
const { imageStamp } = require('../lib/image-stamp');
const { createInvites } = require('../lib/invites');
const { dataPaths } = require('../lib/paths');

const fixed = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255));

/* Run fn with randomBytes(n) answering fixed(n) for the sizes in `only` (all when
 * empty); every other size draws for real. */
function pinned(fn, only = []) {
  const real = crypto.randomBytes;
  crypto.randomBytes = (n, ...rest) => {
    if (rest.length || (only.length && !only.includes(n))) return real(n, ...rest);
    return fixed(n);
  };
  try { return fn(); } finally { crypto.randomBytes = real; }
}

test('link tokens: exactly 32 CSPRNG bytes', () => {
  assert.equal(pinned(() => ids.newToken()), fixed(32).toString('base64url'));
  assert.notEqual(ids.newToken(), ids.newToken());
});

test('invite ids and codes: exactly their CSPRNG bytes', () => {
  assert.equal(pinned(() => ids.newInviteId()), `inv_${fixed(8).toString('hex')}`);
  assert.equal(pinned(() => ids.newRingId()), `ring_${fixed(10).toString('hex')}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-csprng-'));
  try {
    const invites = createInvites(dataPaths(dir));
    // Pin only the code's draw (20 bytes): equal ids would loop the collision re-mint.
    const [a, b] = pinned(() => [invites.mint('ana'), invites.mint('ana')], [20]);
    assert.equal(a.code, fixed(20).toString('base64url'));
    assert.equal(b.code, a.code, 'the code is the draw and nothing else');
    const [c, d] = [invites.mint('ana'), invites.mint('ana')];
    assert.notEqual(c.code, d.code);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('image key tails: exactly 8 CSPRNG bytes', () => {
  const stamp = pinned(() => imageStamp());
  assert.equal(stamp.split('_')[1], fixed(8).toString('hex'));
  assert.notEqual(imageStamp().split('_')[1], imageStamp().split('_')[1]);
});

test('post, stamp and comment id tails: drawn from the CSPRNG', () => {
  const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  const want = [...fixed(16)].filter((x) => x < 252).slice(0, 8).map((x) => B36[x % 36]).join('');
  assert.equal(pinned(() => ids.randomBase36(8)), want);
  assert.equal(pinned(() => ids.newPostId()).slice(-8), want);
  assert.equal(pinned(() => ids.newStampId()).slice(-8), want);
  assert.equal(pinned(() => ids.newCommentId()).slice(-8), want);
  assert.equal(pinned(() => ids.newActivityId()).slice(-8), want, 'activity ids (P2)');
  assert.notEqual(ids.randomBase36(8), ids.randomBase36(8));
});

test('ring join codes: exactly 20 CSPRNG bytes (160 bits)', () => {
  assert.equal(pinned(() => ids.newJoinCode()), fixed(20).toString('base64url'));
  assert.notEqual(ids.newJoinCode(), ids.newJoinCode());
});
