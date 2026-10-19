'use strict';
/* ── Members (spec 3.1) ───────────────────────────────────────────────────────
 * `members.json`: one row per account, `{ slug, email, email_lc, password_hash,
 * display_name, role: 'member'|'admin', invited_by, created_at, status:
 * 'active'|'suspended', sessions_from }`. `slug` is the member's NAME: immutable,
 * inside permanent URLs. `invited_by` is a handle (lib/handles.js).
 *
 * `sessions_from` (ISO) is the session cutoff: a session stamped earlier is not a
 * session (lib/auth.js). It backs up the session store's destroyFor, so a request
 * in flight while sessions are ended cannot write its session back to life.
 *
 * `retired-handles.json`: the name of every deleted member, never reissued (other
 * servers still hold its actor, key and follows).
 *
 * `onWrite(name)` runs after every change (the projection cache drops that
 * member: a display name or a suspension shows at once).
 *
 * The file is cached in memory and written through: one process owns the data
 * dir (lib/instance.js), and every write lands here. Callers get COPIES; a change
 * is an insert, update or remove, each one synchronous write. The cache is
 * checked against the file's stat on every access (lib/store.js cachedFile): an
 * operator's hand edit while the server runs (P1's only admin tool) is read, not
 * reverted by the next write, and a damaged file is a read error, never an empty
 * member list (robustness-r1-01, -13).
 */
const { cachedFile } = require('./store');
const { nameAllowed } = require('./handles');
const clock = require('./clock');

const clone = (row) => (row ? { ...row } : null);

function createMembers(paths, { onWrite = () => {} } = {}) {
  const list = (what) => (raw) => {
    if (!Array.isArray(raw)) throw new Error(`not ${what}`);
    return raw;
  };
  // A hand edit read in drops every touched member's projection, as a write would.
  const onReload = (prev, next) => {
    const names = new Set([...(prev || []), ...next].map((r) => r?.slug).filter((n) => typeof n === 'string'));
    for (const n of names) onWrite(n);
  };
  const membersFile = cachedFile(paths.members, { fallback: () => [], shape: list('a list of member rows'), onReload });
  const retiredFile = cachedFile(paths.retired, { fallback: () => [], shape: list('a list of retired names') });

  const load = () => membersFile.get().filter((r) => r && typeof r.slug === 'string');
  const retiredList = () => retiredFile.get();
  const loadRetired = () => new Set(retiredList().map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean));
  const commit = (next) => membersFile.set(next);

  return {
    all: () => load().map(clone),
    count: () => load().length,
    get: (slug) => clone(load().find((r) => r.slug === slug)),
    byEmail: (emailLc) => clone(load().find((r) => r.email_lc === emailLc)),
    admins: () => load().filter((r) => r.role === 'admin' && r.status === 'active').map((r) => r.slug),
    isRetired: (slug) => loadRetired().has(slug),
    nameAvailable(slug) {
      return nameAllowed(slug) && !load().some((r) => r.slug === slug) && !loadRetired().has(slug);
    },
    insert(row) {
      const cur = load();
      if (cur.some((r) => r.slug === row.slug || r.email_lc === row.email_lc)) throw new Error('members: duplicate row');
      commit([...cur, { ...row }]);
      onWrite(row.slug);
    },
    update(slug, patch) {
      const cur = load();
      const i = cur.findIndex((r) => r.slug === slug);
      if (i < 0) return null;
      const next = cur.slice();
      next[i] = { ...cur[i], ...patch, slug };
      commit(next);
      onWrite(slug);
      return clone(next[i]);
    },
    /* Remove the row and retire the name, retire first: a crash between the two
     * leaves a retired name with a row (still unissuable), never a free name. */
    remove(slug) {
      if (!loadRetired().has(slug)) retiredFile.set([...retiredList(), { name: slug, at: clock.iso() }]);
      const cur = load();
      if (cur.some((r) => r.slug === slug)) commit(cur.filter((r) => r.slug !== slug));
      onWrite(slug);
    },
  };
}

module.exports = { createMembers };
