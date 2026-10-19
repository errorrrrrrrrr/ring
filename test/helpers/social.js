'use strict';
/* Social fixtures for the P2 suites: a server with named members, friendships
 * made through the real routes, rings made and filled through the real routes. */
const assert = require('node:assert/strict');
const { boot, joinAdmin, joinInvited } = require('./harness');

/* Boot and sign up `names` (the first is the admin). Returns { h, c } where
 * c[name] is that member's signed-in client. A failing setup closes the server. */
async function crowd(names, bootOpts = {}) {
  const h = await boot(bootOpts);
  try {
    const c = {};
    c[names[0]] = await joinAdmin(h, names[0]);
    await c[names[0]].patch('/api/me', { display_name: `${names[0][0].toUpperCase()}${names[0].slice(1)} Tester` });
    for (const n of names.slice(1)) {
      c[n] = await joinInvited(h, c[names[0]], { slug: n, display_name: `${n[0].toUpperCase()}${n.slice(1)} Tester` });
    }
    return { h, c };
  } catch (e) {
    await h.close();
    throw e;
  }
}

/* a asks, b confirms: friends. */
async function befriend(c, a, b) {
  const r1 = await c[a].post('/api/friends', { handle: b });
  assert.equal(r1.status, 200, `befriend ${a}->${b}: ${r1.text}`);
  const r2 = await c[b].post(`/api/friends/${a}/confirm`);
  assert.equal(r2.status, 200, `confirm ${b}<-${a}: ${r2.text}`);
  assert.equal(r2.body.status, 'friends');
}

const enc = encodeURIComponent;
const codeOf = (ring) => ring.join.url.split('/').pop();

/* `owner` creates a ring and admits each of `others` (ask by link, owner approves). */
async function ring(c, owner, others = [], name = 'Print Club') {
  const r = await c[owner].post('/api/rings', { name });
  assert.equal(r.status, 201, r.text);
  const code = codeOf(r.body);
  for (const o of others) {
    const a = await c[o].post(`/api/rings/join/${code}`);
    assert.equal(a.status, 200, a.text);
    const ok = await c[owner].post(`/api/rings/${r.body.id}/requests/${enc(o)}`, { approve: true });
    assert.equal(ok.status, 200, ok.text);
  }
  return { id: r.body.id, code };
}

const note = (client, text, audience) => client.post('/api/posts', { kind: 'note', note: text, ...(audience ? { audience } : {}) });

module.exports = { crowd, befriend, ring, note, codeOf, enc };
