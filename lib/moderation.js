'use strict';
/* ── The server's moderation stores (spec 6.2, 6.3; P8) ───────────────────────
 * Three files under DATA/moderation/, each cached in memory and stat-checked on
 * every read (an operator's hand edit is read, never reverted by the next
 * write); the two block lists written whole and fsync'd (lib/store.js
 * cachedFile), the reports appended (below):
 *
 *   domain-blocks.json  { blocks: [{ host, reason, at, by }], seeded: [host] }
 *                       A host covers its subdomains (lib/handles.js hostUnder;
 *                       a test host with a port matches exactly). `seeded` is
 *                       every host BLOCKED_DOMAINS has ever imported (below).
 *   actor-blocks.json   [{ handle, id, inbox, reason, at, by }]: server-wide
 *                       blocks of ONE remote person, a domain block's twin.
 *   reports.jsonl       one report row per line, [{ id, kind, from, actor?,
 *                       remote, target, post, ref, objects[], comment,
 *                       forwarded, at, state, resolved_by, note, resolved_at }]
 *                       (spec 6.2). `from` is a local name (a member's report)
 *                       or a host (a Flag from another server); `actor` the
 *                       remote reporter's handle when the Flag named a person.
 *                       `post` is the reported post's URL (kind post), or the
 *                       post a reported comment or stamp is on; `ref` names
 *                       that comment or stamp ({ owner, post_id, id }): the
 *                       admin's removals act on these two, never on `objects`
 *                       (P8 review F1), which are what a Flag forwards.
 *
 * THE REPORT STORE (P8 review F3) is APPEND-ONLY: a new row, or a changed one,
 * is one line appended and fsync'd (a later line for an id wins; `{id, gone}`
 * is a row's removal), never the whole file rewritten per insert. The file is
 * compacted (rewritten whole, atomically) only when its lines pass twice its
 * rows plus 200, after a prune, or when a crash left a torn last line (which
 * is ignored on read). Held in memory, stat-checked on every read as the other
 * two are: a hand edit is read, and a damaged line refuses the boot.
 *
 * THE PREDICATES every door asks (lib/federation.js, lib/net.js, lib/queue.js,
 * the routes, the render-time filters): hostBlocked(host), handleBlocked(handle)
 * (its host, or the handle itself), actorBlocked(id). They read a Set built once
 * per change of the file, and walk a host's labels (a.b.c tries a.b.c, b.c, c),
 * so a check costs the labels of one host, never the length of the list. Every
 * host goes through THE normalizer first (lib/handles.js canonHost: case, one
 * trailing dot, IDN, IP literal forms; P8 review F4), so `Evil.Example.` is
 * `evil.example` to the list; a host the normalizer refuses is blocked (fail
 * closed). An IP literal (IPv4, or bracketed IPv6) matches only itself.
 *
 * BLOCKED_DOMAINS (P8 decision, spec 6.5): the env var is a SEED, imported at
 * boot. Each listed host not yet in `seeded` is added to the list (reason
 * "BLOCKED_DOMAINS", by "env") and recorded in `seeded`, so an admin who removes
 * it in /admin is not overruled at the next boot; naming a NEW host in the env
 * adds it at the next boot. The list in the file is the one truth.
 *
 * BOUNDS. 10 000 domain blocks, 10 000 actor blocks (a refusal past them, 409
 * `block_limit`). Reports: 5000 rows; past it the oldest CLOSED row goes, and
 * when every row is open a new one is refused (null). A Flag from another server
 * (lib/moderate.js) is held to 20 open reports per SITE (lib/handles.js siteOf:
 * the registrable domain, so subdomains and ports share one) and 1000 open from
 * all other servers together, so a hostile host can never bury the members'
 * own; a domain or actor block closes that origin's open reports (closeWhere).
 * Closed reports older than 90 days go in the hourly housekeeping.
 */
const fs = require('node:fs');
const path = require('node:path');
const clock = require('./clock');
const { cachedFile, writeFileAtomic, StoreReadError } = require('./store');
const { normalizeHost, canonHost, hostOfUrl, splitHostPort, isIpLiteral, siteOf, isHandle, hostUnder } = require('./handles');
const { randomBase36 } = require('./ids');
const { plainLine } = require('./ring');

const MAX_DOMAIN_BLOCKS = 10_000;
const MAX_ACTOR_BLOCKS = 10_000;
const MAX_REPORTS = 5000;
const MAX_OPEN_PER_HOST = 20;
const MAX_OPEN_REMOTE = 1000;
const CLOSED_KEEP_MS = 90 * 24 * 3600_000;
const REASON_MAX = 500;
const COMMENT_MAX = 1000;
const NOTE_MAX = 1000;
const MAX_OBJECTS = 20;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const STATES = new Set(['open', 'resolved', 'dismissed']);
const KINDS = new Set(['post', 'comment', 'stamp', 'reply', 'person']);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const hostOfHandle = (h) => (typeof h === 'string' && h.includes('@') ? h.slice(h.indexOf('@') + 1) : '');
const NAME_ID = /^[a-z0-9_-]{1,64}$/i;
const httpUrl = (u) => typeof u === 'string' && u.length <= 2000 && /^https?:\/\/[^\s]+$/.test(u);

/* Every suffix of a host a block could name, the host through THE normalizer
 * first: `a.b.c:8443` -> the host with its port, then a.b.c, b.c, c. An IP
 * literal is only itself (with and without its port). A host the normalizer
 * refuses has no suffixes ([]); hostBlocked refuses it outright. */
function suffixes(host) {
  const h = canonHost(host);
  if (!h) return [];
  const out = [h];
  const [bare, port] = splitHostPort(h);
  if (port) out.push(bare);
  if (isIpLiteral(bare)) return out;
  let s = bare;
  for (let i = s.indexOf('.'); i >= 0; i = s.indexOf('.')) { s = s.slice(i + 1); if (s) out.push(s); }
  return out;
}

function settleDomains(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const blocks = [];
  const seen = new Set();
  for (const b of Array.isArray(r.blocks) ? r.blocks : []) {
    const host = normalizeHost(b?.host, { allowPort: true, allowIp: true });
    if (!host || seen.has(host)) continue;
    seen.add(host);
    blocks.push({ host, reason: str(b.reason, REASON_MAX), at: str(b.at, 40), by: str(b.by, 64) });
    if (blocks.length >= MAX_DOMAIN_BLOCKS) break;
  }
  const seeded = [...new Set((Array.isArray(r.seeded) ? r.seeded : []).filter((h) => typeof h === 'string' && h.length <= 260))].slice(0, MAX_DOMAIN_BLOCKS);
  return { blocks, seeded };
}

function settleActors(raw) {
  const out = [];
  const seen = new Set();
  for (const b of Array.isArray(raw) ? raw : []) {
    if (!b || !isHandle(b.handle, { allowPort: true }) || !b.handle.includes('@') || seen.has(b.handle)) continue;
    seen.add(b.handle);
    out.push({
      handle: b.handle, id: httpUrl(b.id) ? b.id : '', inbox: httpUrl(b.inbox) ? b.inbox : '',
      reason: str(b.reason, REASON_MAX), at: str(b.at, 40), by: str(b.by, 64),
    });
    if (out.length >= MAX_ACTOR_BLOCKS) break;
  }
  return out;
}

function settleRef(v) {
  if (!v || typeof v !== 'object') return null;
  return NAME_ID.test(v.owner) && NAME_ID.test(v.post_id) && NAME_ID.test(v.id) ? { owner: v.owner, post_id: v.post_id, id: v.id } : null;
}

function settleReport(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !/^rep_[0-9a-z]{8,32}$/.test(r.id)) return null;
  const state = STATES.has(r.state) ? r.state : 'open';
  return {
    id: r.id,
    kind: KINDS.has(r.kind) ? r.kind : 'person',
    from: str(r.from, 300),
    ...(typeof r.actor === 'string' && r.actor ? { actor: str(r.actor, 300) } : {}),
    remote: r.remote === true,
    target: str(r.target, 300),
    post: httpUrl(r.post) ? r.post : '',
    ref: settleRef(r.ref),
    objects: (Array.isArray(r.objects) ? r.objects : []).filter(httpUrl).slice(0, MAX_OBJECTS),
    comment: str(r.comment, COMMENT_MAX),
    forwarded: r.forwarded === true,
    at: str(r.at, 40),
    state,
    resolved_by: str(r.resolved_by, 64),
    note: str(r.note, NOTE_MAX),
    resolved_at: str(r.resolved_at, 40),
  };
}
const copyRow = (r) => ({ ...r, objects: [...r.objects], ref: r.ref ? { ...r.ref } : null });

/* The queue's order: open first, then newest first (`at`, then id). */
const orderKey = (r) => [r.state === 'open' ? 0 : 1, r.at, r.id];
function cmpKey(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? 1 : -1;
  return a[2] === b[2] ? 0 : a[2] < b[2] ? 1 : -1;
}
const encodeCursor = (k) => Buffer.from(JSON.stringify(k)).toString('base64url');
function decodeCursor(c) {
  if (typeof c !== 'string' || !c || c.length > 400) return null;
  try {
    const k = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    return Array.isArray(k) && k.length === 3 && (k[0] === 0 || k[0] === 1) && typeof k[1] === 'string' && typeof k[2] === 'string' ? k : null;
  } catch { return null; }
}

/* THE report store: append-only lines, held in memory (header). */
function createReportLog(file) {
  let rows = new Map();   // id -> row, in insertion order
  let lines = 0;
  let torn = false;
  let sig = null;
  const stats = { appends: 0, rewrites: 0 };
  const sigOf = () => {
    try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (e) { if (e.code === 'ENOENT') return ''; throw new StoreReadError(file, e); }
  };
  function load() {
    const now = sigOf();
    if (sig !== null && now === sig) return;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new StoreReadError(file, e); }
    const parts = text.split('\n');
    const tail = parts.pop();
    torn = tail !== '';   // a crash mid-append: ignored, and the next write compacts
    const next = new Map();
    let n = 0;
    for (const line of parts) {
      if (!line.trim()) continue;
      let v;
      try { v = JSON.parse(line); } catch (e) { throw new StoreReadError(file, e); }
      n++;
      if (v && typeof v.id === 'string' && v.gone === true) { next.delete(v.id); continue; }
      const row = settleReport(v);
      if (!row) continue;
      next.delete(row.id);   // a later line for an id is its newest state, kept in its first place
      next.set(row.id, row);
    }
    if (next.size > MAX_REPORTS) for (const id of [...next.keys()].slice(0, next.size - MAX_REPORTS)) next.delete(id);
    rows = next;
    lines = n;
    sig = now;
  }
  function compact() {
    writeFileAtomic(file, [...rows.values()].map((r) => `${JSON.stringify(r)}\n`).join(''));
    lines = rows.size;
    torn = false;
    stats.rewrites++;
    sig = sigOf();
  }
  /* Append `items` (rows, or { id, gone }) as one write; compact when due. */
  function append(items) {
    if (!items.length) return;
    if (torn || lines + items.length > 2 * rows.size + 200) { compact(); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, items.map((x) => `${JSON.stringify(x)}\n`).join(''));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    lines += items.length;
    stats.appends++;
    sig = sigOf();
  }
  return {
    rows: () => { load(); return rows; },
    // A row's id order is kept: a changed row stays where it was.
    put(list, gone = []) {
      load();
      for (const id of gone) rows.delete(id);
      for (const r of list) rows.set(r.id, r);
      append([...gone.map((id) => ({ id, gone: true })), ...list]);
    },
    drop(ids) { load(); for (const id of ids) rows.delete(id); compact(); },
    stats: () => { load(); return { rows: rows.size, lines, ...stats }; },
  };
}

function createModeration({ paths, cfg = {}, logger = console }) {
  const dir = paths.moderationDir || path.join(paths.root, 'moderation');
  const domainsFile = cachedFile(path.join(dir, 'domain-blocks.json'), { fallback: () => ({}), shape: settleDomains });
  const actorsFile = cachedFile(path.join(dir, 'actor-blocks.json'), { fallback: () => [], shape: settleActors });
  const reports = createReportLog(path.join(dir, 'reports.jsonl'));

  // ── the predicates: Sets rebuilt only when the file's value changed ──
  let domainsSeen = null;
  let domainSet = new Set();
  const domains = () => {
    const v = domainsFile.get();
    if (v !== domainsSeen) { domainsSeen = v; domainSet = new Set(v.blocks.map((b) => b.host)); }
    return domainSet;
  };
  let actorsSeen = null;
  let actorHandles = new Set();
  let actorIds = new Set();
  let actorInboxes = new Set();
  const actorSets = () => {
    const v = actorsFile.get();
    if (v !== actorsSeen) {
      actorsSeen = v;
      actorHandles = new Set(v.map((b) => b.handle));
      actorIds = new Set(v.map((b) => b.id).filter(Boolean));
      actorInboxes = new Set(v.map((b) => b.inbox).filter(Boolean));
    }
  };

  /* Is this host (as in a URL or a handle, perhaps with a port) blocked? A
   * host THE normalizer refuses is (fail closed: no door may reach it). */
  function hostBlocked(host) {
    if (!host) return false;
    const sx = suffixes(host);
    if (!sx.length) return true;
    const set = domains();
    if (!set.size) return false;
    return sx.some((s) => set.has(s));
  }
  /* A remote handle blocked server-wide: its host, or the person. */
  function handleBlocked(handle) {
    if (typeof handle !== 'string' || !handle.includes('@')) return false;
    if (hostBlocked(hostOfHandle(handle))) return true;
    actorSets();
    return actorHandles.has(handle);
  }
  /* An actor URL blocked server-wide (its host, or the person by id). */
  function actorBlocked(id) {
    if (typeof id !== 'string' || !id) return false;
    const h = hostOfUrl(id);
    if (!h) return false;
    if (hostBlocked(h)) return true;
    actorSets();
    return actorIds.has(id);
  }
  /* A delivery to this inbox URL is to a person blocked server-wide. */
  function inboxBlocked(inbox) {
    actorSets();
    return !!inbox && actorInboxes.has(inbox);
  }

  // ── domain blocks ──
  const listDomains = () => domainsFile.get().blocks.map((b) => ({ ...b }));
  /* -> { host, added } or { error }. */
  function addDomain(raw, { reason = '', by = '' } = {}) {
    const host = normalizeHost(raw, { allowPort: cfg.fedTestLoopback === true, allowIp: true });
    if (!host) return { error: 'host_invalid' };
    const cur = domainsFile.get();
    if (cur.blocks.some((b) => b.host === host)) return { host, added: false };
    if (cur.blocks.length >= MAX_DOMAIN_BLOCKS) return { error: 'block_limit' };
    domainsFile.set({ ...cur, blocks: [...cur.blocks, { host, reason: plainLine(reason, REASON_MAX), at: clock.iso(), by: str(by, 64) }] });
    return { host, added: true };
  }
  function removeDomain(raw) {
    const host = normalizeHost(raw, { allowPort: true, allowIp: true });
    const cur = domainsFile.get();
    if (!host || !cur.blocks.some((b) => b.host === host)) return false;
    domainsFile.set({ ...cur, blocks: cur.blocks.filter((b) => b.host !== host) });
    return true;
  }
  /* BLOCKED_DOMAINS, the seed: -> the hosts newly added. Each through THE
   * normalizer (lib/config.js already did; a caller's raw list too). */
  function seed(hosts) {
    const cur = domainsFile.get();
    const norm = [...new Set((hosts || []).map((h) => normalizeHost(h, { allowPort: true, allowIp: true })).filter(Boolean))];
    const fresh = norm.filter((h) => !cur.seeded.includes(h));
    if (!fresh.length) return [];
    const have = new Set(cur.blocks.map((b) => b.host));
    const at = clock.iso();
    const blocks = [...cur.blocks];
    for (const h of fresh) if (!have.has(h) && blocks.length < MAX_DOMAIN_BLOCKS) blocks.push({ host: h, reason: 'BLOCKED_DOMAINS', at, by: 'env' });
    domainsFile.set({ blocks, seeded: [...cur.seeded, ...fresh] });
    logger.log?.(`[moderation] BLOCKED_DOMAINS: ${fresh.length} host(s) imported into the admin's domain blocks`);
    return fresh;
  }

  // ── actor blocks ──
  const listActors = () => actorsFile.get().map((b) => ({ ...b }));
  function addActor(handle, { id = '', inbox = '', reason = '', by = '' } = {}) {
    if (!isHandle(handle, { allowPort: true }) || !handle.includes('@')) return { error: 'handle_invalid' };
    const cur = actorsFile.get();
    const prev = cur.find((b) => b.handle === handle);
    if (prev) {
      // A later block learns the id or inbox an earlier one could not.
      if ((id && !prev.id) || (inbox && !prev.inbox)) actorsFile.set(cur.map((b) => (b === prev ? { ...b, id: b.id || id, inbox: b.inbox || inbox } : b)));
      return { handle, added: false };
    }
    if (cur.length >= MAX_ACTOR_BLOCKS) return { error: 'block_limit' };
    actorsFile.set([...cur, { handle, id: httpUrl(id) ? id : '', inbox: httpUrl(inbox) ? inbox : '', reason: plainLine(reason, REASON_MAX), at: clock.iso(), by: str(by, 64) }]);
    return { handle, added: true };
  }
  function removeActor(handle) {
    const cur = actorsFile.get();
    if (!cur.some((b) => b.handle === handle)) return false;
    actorsFile.set(cur.filter((b) => b.handle !== handle));
    return true;
  }

  // ── reports ──
  const listReports = () => [...reports.rows().values()].map(copyRow);
  const getReport = (id) => { const r = reports.rows().get(id); return r ? copyRow(r) : null; };
  /* Open reports from other servers: all of them, or one SITE's (siteOf). */
  function openRemote(site = '') {
    let n = 0;
    for (const r of reports.rows().values()) if (r.state === 'open' && r.remote && (!site || siteOf(r.from) === site)) n++;
    return n;
  }

  /* One page of the queue (open first, newest first). `state`: 'open',
   * 'closed' or 'all'; `cursor` the `next` of the page before. -> { rows, next },
   * or null for a cursor this server never wrote. */
  function pageReports({ state = 'all', cursor = '', limit = PAGE_DEFAULT } = {}) {
    const lim = Math.min(Math.max(1, Number.isInteger(limit) ? limit : PAGE_DEFAULT), PAGE_MAX);
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) return null;   // not a cursor this server wrote
    const keep = (r) => (state === 'open' ? r.state === 'open' : state === 'closed' ? r.state !== 'open' : true);
    const all = [...reports.rows().values()].filter((r) => keep(r) && (!after || cmpKey(orderKey(r), after) > 0));
    all.sort((a, b) => cmpKey(orderKey(a), orderKey(b)));
    const page = all.slice(0, lim);
    return { rows: page.map(copyRow), next: all.length > lim ? encodeCursor(orderKey(page[page.length - 1])) : '' };
  }

  /* A new report. -> the row, or null when the file is full of open ones or a
   * remote site is past its open share. */
  function addReport({ kind, from, actor = '', remote = false, target, post = '', ref = null, objects = [], comment = '', forwarded = false }) {
    const rows = reports.rows();
    if (remote && (openRemote(siteOf(from)) >= MAX_OPEN_PER_HOST || openRemote() >= MAX_OPEN_REMOTE)) return null;
    const gone = [];
    if (rows.size >= MAX_REPORTS) {
      let oldest = null;
      for (const r of rows.values()) if (r.state !== 'open') { oldest = r; break; }
      if (!oldest) return null;
      gone.push(oldest.id);
    }
    const row = settleReport({
      id: `rep_${randomBase36(16)}`, kind, from, actor, remote, target, post, ref,
      objects: [...new Set(objects)], comment: plainLine(comment, COMMENT_MAX), forwarded, at: clock.iso(), state: 'open',
    });
    reports.put([row], gone);
    return copyRow(row);
  }
  /* Change one report. -> the row or null. */
  function updateReport(id, patch) {
    const cur = reports.rows().get(id);
    if (!cur) return null;
    const next = settleReport({ ...cur, ...patch, id });
    reports.put([next]);
    return copyRow(next);
  }
  /* Close every OPEN report `pred(row)` accepts, in one write (a block closes
   * its origin's reports, P8 review F3). -> how many. */
  function closeWhere(pred, { state = 'dismissed', by = '', note = '' } = {}) {
    const at = clock.iso();
    const changed = [];
    for (const r of reports.rows().values()) {
      if (r.state !== 'open' || !pred(r)) continue;
      changed.push(settleReport({ ...r, state, resolved_by: by, note: plainLine(note, NOTE_MAX), resolved_at: at }));
    }
    if (changed.length) reports.put(changed);
    return changed.length;
  }
  /* Housekeeping: closed reports past 90 days. -> how many went. */
  function pruneReports() {
    const cutoff = clock.now() - CLOSED_KEEP_MS;
    const gone = [...reports.rows().values()].filter((r) => r.state !== 'open' && Date.parse(r.resolved_at || r.at) < cutoff).map((r) => r.id);
    if (gone.length) reports.drop(gone);
    return gone.length;
  }

  /* Boot: a damaged file refuses the boot (spec 3.11, reads fail closed). */
  function verify() { domainsFile.get(); actorsFile.get(); reports.rows(); }

  return {
    verify,
    hostBlocked, handleBlocked, actorBlocked, inboxBlocked,
    listDomains, addDomain, removeDomain, seed,
    listActors, addActor, removeActor,
    listReports, pageReports, getReport, addReport, updateReport, closeWhere, pruneReports, openRemote,
    reportStats: () => reports.stats(),
    hostUnder,
  };
}

module.exports = {
  createModeration, suffixes, settleReport,
  MAX_DOMAIN_BLOCKS, MAX_ACTOR_BLOCKS, MAX_REPORTS, MAX_OPEN_PER_HOST, MAX_OPEN_REMOTE, COMMENT_MAX, NOTE_MAX, MAX_OBJECTS, CLOSED_KEEP_MS, PAGE_DEFAULT, PAGE_MAX,
};
