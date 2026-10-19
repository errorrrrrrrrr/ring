/* ── /admin: the server admin's page (spec 6.3, 13.1; P8) ─────────────────────
 * A lazy chunk of the composer's bundle (main.tsx loads it by the path), in
 * the same tool register: system sans, tokens, sharp corners, no shadow. Four
 * tabs, as the spec names them:
 *   Reports     the queue (open first), a page at a time; dismiss or resolve
 *               with a note; from a report: remove the reported post, comment
 *               or stamp (only that one, only the target's), suspend a local
 *               member, block a remote person or their domain server-wide,
 *               forward to their server (a Flag from the server itself, no
 *               reporter's name); reopen a closed one
 *   Domains     the domain blocks (host, private reason), and the server-wide
 *               person blocks; both private
 *   Members     every account: suspend, unsuspend, make admin, step down
 *               (oneself); and the signup door (spec 10.11): its counts, which
 *               name no one, release an address, clear the pending file
 *   Federation  failing and unavailable hosts (clear a mark), the queue's
 *               depth, the origin and when it federated (ops readouts)
 * The server decides everything (routes/admin.js) and its message is what a
 * refusal shows. Every destructive act asks first (confirm.tsx). Phone width
 * is a first-class target: rows wrap, controls keep their 44px floor.
 */
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { t } from './strings.ts';
import { get, post, del, enc, errorText } from './api.ts';
import { Segmented, Toast, useToast } from './ui.tsx';
import { useConfirm } from './confirm.tsx';
import { fmtAge, fmtDay } from './datetime.ts';
import './admin.css';

type Tab = 'reports' | 'domains' | 'members' | 'federation';

interface Who { handle: string; name: string; local?: boolean; host?: string; status?: string; url?: string; blocked?: boolean }
interface Report {
  id: string; kind: string; from: string; actor?: string; remote: boolean; target: string; post: string;
  ref: { owner: string; post_id: string; id: string } | null; objects: string[]; comment: string;
  forwarded: boolean; at: string; state: 'open' | 'resolved' | 'dismissed'; resolved_by: string; note: string; resolved_at: string;
  target_view: Who | null; from_view: (Who & { actor?: string }) | null;
}
interface DomainBlock { host: string; reason: string; at: string; by: string }
interface ActorBlock { handle: string; id: string; reason: string; at: string; by: string }
interface MemberRow { name: string; display_name: string; email: string; role: 'admin' | 'member'; status: 'active' | 'suspended'; created_at: string; invited_by: string | null; invites_live: number }
interface Signups { pending: number; cap: number; per_requester: number; requesters_at_share: number; full: boolean; mail_per_requester_day: number; mail_per_address_day: number }
interface Fed { federation: boolean; origin: string; federated_at: string; queue_depth: number; hosts: { host: string; failing_since: string; unavailable: boolean; last_success_at: string; software: string }[]; hosts_total: number }
interface Me { handle: string; role: string }

const httpish = (u: string) => /^https?:\/\//i.test(u);
const KIND: Record<string, () => string> = {
  post: () => t('admin.kind.post'), comment: () => t('admin.kind.comment'), stamp: () => t('admin.kind.stamp'),
  reply: () => t('admin.kind.reply'), person: () => t('admin.kind.person'),
};
const STATE: Record<string, () => string> = {
  open: () => t('admin.state.open'), resolved: () => t('admin.state.resolved'), dismissed: () => t('admin.state.dismissed'),
};

export function Admin() {
  const [tab, setTab] = useState<Tab>('reports');
  const [me, setMe] = useState<Me | null>(null);
  const [toast, say] = useToast();
  const [ask, confirmUI] = useConfirm();
  useEffect(() => { get<Me>('/api/me').then(setMe, () => {}); }, []);
  useEffect(() => { document.title = t('admin.doc_title'); }, []);
  const host = (() => { try { return location.host; } catch { return ''; } })();
  return (
    <div className="admin">
      <header className="admin-head">
        <div className="admin-title">
          <h1>{t('admin.title')}</h1>
          <span className="muted small mono">{host}</span>
        </div>
        <a href="/app" className="btn btn-sm">{t('admin.back')}</a>
      </header>
      <nav className="admin-tabs">
        <Segmented label={t('admin.tabs')} value={tab} onChange={setTab} options={[
          ['reports', t('admin.tab.reports')], ['domains', t('admin.tab.domains')],
          ['members', t('admin.tab.members')], ['federation', t('admin.tab.federation')],
        ]} />
      </nav>
      <main className="admin-main">
        {tab === 'reports' && <ReportsTab say={say} ask={ask} />}
        {tab === 'domains' && <DomainsTab say={say} ask={ask} />}
        {tab === 'members' && <MembersTab say={say} ask={ask} me={me} />}
        {tab === 'federation' && <FederationTab say={say} />}
      </main>
      <Toast text={toast} />
      {confirmUI}
    </div>
  );
}

type Say = (m: string) => void;
type Ask = ReturnType<typeof useConfirm>[0];

function useLoad<T>(path: string, say: Say): [T | null, () => Promise<void>] {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(async () => {
    try { setData(await get<T>(path)); } catch (e) { say(errorText(e)); }
  }, [path, say]);
  useEffect(() => { load(); }, [load]);
  return [data, load];
}

// ── Reports ──

/* The queue a page at a time (the server's cursor, P8 review F3): the first
 * page on load and on refresh, the next one appended by Show more. */
function ReportsTab({ say, ask }: { say: Say; ask: Ask }) {
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [data, setData] = useState<{ reports: Report[]; next: string } | null>(null);
  const [more, setMore] = useState(false);
  const load = useCallback(async () => {
    try { setData(await get<{ reports: Report[]; next: string }>(`/api/admin/reports?state=${show}`)); } catch (e) { say(errorText(e)); }
  }, [show, say]);
  useEffect(() => { load(); }, [load]);
  async function loadMore() {
    if (!data?.next) return;
    setMore(true);
    try {
      const page = await get<{ reports: Report[]; next: string }>(`/api/admin/reports?state=${show}&cursor=${enc(data.next)}`);
      setData({ reports: [...data.reports, ...page.reports.filter((r) => !data.reports.some((x) => x.id === r.id))], next: page.next });
    } catch (e) { say(errorText(e)); }
    setMore(false);
  }
  const rows = data?.reports || [];
  return (
    <section aria-label={t('admin.tab.reports')}>
      <div className="admin-bar">
        <Segmented label={t('admin.reports.show')} value={show} onChange={setShow}
          options={[['open', t('admin.reports.open')], ['all', t('admin.reports.all')]]} />
        <button type="button" className="btn btn-sm" onClick={load}>{t('admin.refresh')}</button>
      </div>
      {!data && <p className="muted" role="status">{t('admin.loading')}</p>}
      {data && !rows.length && <p className="muted">{show === 'open' ? t('admin.reports.none_open') : t('admin.reports.none')}</p>}
      {rows.map((r) => <ReportCard key={r.id} r={r} say={say} ask={ask} onDone={load} />)}
      {data?.next && (
        <div className="admin-bar">
          <button type="button" className="btn btn-sm" disabled={more} onClick={loadMore}>{t('admin.reports.more')}</button>
        </div>
      )}
    </section>
  );
}

function ReportCard({ r, say, ask, onDone }: { r: Report; say: Say; ask: Ask; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const target = r.target_view;
  const remote = !!target && !target.local;
  // The reported post, when it is THIS server's and its owner is the target
  // (the server checks again, and acts on nothing else: P8 review F1).
  const ownPost = r.kind === 'post' && !!target?.local && r.post.startsWith(`${location.origin}/users/${enc(r.target)}/posts/`);
  const reaction = (r.kind === 'comment' || r.kind === 'stamp') && !!r.ref;
  const from = r.remote
    ? t('admin.reports.from_server', { host: r.from, actor: r.actor ? ` (${r.actor})` : '' })
    : t('admin.reports.from_member', { name: r.from_view?.name || r.from });
  async function act(action: string, confirm?: { title: string; verb: string; danger?: boolean; note?: string; who?: boolean }) {
    if (confirm && !(await ask({ title: confirm.title, verb: confirm.verb, danger: confirm.danger, note: confirm.note, name: confirm.who ? target?.handle : undefined }))) return;
    setBusy(true);
    try {
      await post(`/api/admin/reports/${enc(r.id)}`, { action, note });
      say(t('admin.done'));
      onDone();
    } catch (e) { say(errorText(e)); }
    setBusy(false);
  }
  return (
    <article className={`setting-card admin-report${r.state === 'open' ? '' : ' is-closed'}`}>
      <div className="admin-report-top">
        <span className="eyebrow">{KIND[r.kind]?.() || r.kind}</span>
        <span className="chip">{STATE[r.state]?.()}</span>
        {r.forwarded && <span className="chip">{t('admin.reports.forwarded')}</span>}
        <span className="muted small admin-age" title={r.at}>{fmtAge(r.at)}</span>
      </div>
      <p className="admin-line">
        <b>{target ? target.name : r.target}</b>{' '}
        <span className="muted mono small">{target?.local ? `@${r.target}` : r.target}</span>
        {target?.status === 'suspended' && <> <span className="chip">{t('admin.members.suspended')}</span></>}
        {target?.blocked && <> <span className="chip">{t('admin.reports.blocked')}</span></>}
      </p>
      <p className="muted small admin-line">{from}</p>
      {r.comment && <blockquote className="admin-comment">{r.comment}</blockquote>}
      {r.objects.length > 0 && (
        <ul className="admin-objects">
          {r.objects.map((u) => (
            <li key={u} className="mono small">
              {httpish(u) ? <a href={u} target="_blank" rel="noopener noreferrer nofollow">{u}</a> : u}
            </li>
          ))}
        </ul>
      )}
      {r.state !== 'open' && (
        <div className="row admin-actions">
          <p className="muted small">{t('admin.reports.closed_by', { name: r.resolved_by || '?', day: fmtDay(r.resolved_at) })}{r.note ? `: ${r.note}` : ''}</p>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('reopen')}>{t('admin.reports.reopen')}</button>
        </div>
      )}
      {r.state === 'open' && (
        <div className="stack">
          <label className="field">
            <span>{t('admin.reports.note')}</span>
            <input className="form-input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row admin-actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('resolve')}>{t('admin.reports.resolve')}</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act('dismiss')}>{t('admin.reports.dismiss')}</button>
            {ownPost && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => act('remove_post', { title: t('admin.reports.remove_post_q'), verb: t('admin.reports.remove_post'), danger: true, note: t('admin.reports.remove_post_note') })}>
                {t('admin.reports.remove_post')}
              </button>
            )}
            {reaction && r.kind === 'comment' && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => act('remove_comment', { title: t('admin.reports.remove_comment_q'), verb: t('admin.reports.remove_comment'), danger: true, note: t('admin.reports.remove_comment_note') })}>
                {t('admin.reports.remove_comment')}
              </button>
            )}
            {reaction && r.kind === 'stamp' && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => act('remove_stamp', { title: t('admin.reports.remove_stamp_q'), verb: t('admin.reports.remove_stamp'), danger: true, note: t('admin.reports.remove_stamp_note') })}>
                {t('admin.reports.remove_stamp')}
              </button>
            )}
            {target?.local && target.status === 'active' && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => act('suspend', { title: t('admin.members.suspend_q'), verb: t('admin.members.suspend'), danger: true, note: t('admin.members.suspend_note'), who: true })}>
                {t('admin.members.suspend')}
              </button>
            )}
            {remote && !r.remote && !r.forwarded && (
              <button type="button" className="btn btn-sm" disabled={busy}
                onClick={() => act('forward', { title: t('admin.reports.forward_q', { host: target?.host || '' }), verb: t('admin.reports.forward'), note: t('admin.reports.forward_note') })}>
                {t('admin.reports.forward')}
              </button>
            )}
            {remote && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => act('block_actor', { title: t('admin.blocks.person_q'), verb: t('admin.reports.block_person'), danger: true, note: t('admin.blocks.person_note'), who: true })}>
                {t('admin.reports.block_person')}
              </button>
            )}
            {remote && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => act('block_domain', { title: t('admin.blocks.domain_q', { host: target?.host || '' }), verb: t('admin.reports.block_domain'), danger: true, note: t('admin.blocks.domain_note') })}>
                {t('admin.reports.block_domain')}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

// ── Domains (and people) blocked server-wide ──

function DomainsTab({ say, ask }: { say: Say; ask: Ask }) {
  const [domains, loadDomains] = useLoad<{ blocks: DomainBlock[] }>('/api/admin/domain-blocks', say);
  const [actors, loadActors] = useLoad<{ blocks: ActorBlock[] }>('/api/admin/actor-blocks', say);
  const [host, setHost] = useState('');
  const [reason, setReason] = useState('');
  const [handle, setHandle] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);

  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!host.trim()) return;
    if (!(await ask({ title: t('admin.blocks.domain_q', { host: host.trim() }), verb: t('admin.blocks.block'), danger: true, note: t('admin.blocks.domain_note') }))) return;
    setBusy(true);
    try { await post('/api/admin/domain-blocks', { host: host.trim(), reason }); setHost(''); setReason(''); say(t('admin.done')); await loadDomains(); }
    catch (err) { say(errorText(err)); }
    setBusy(false);
  }
  async function addActor(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim()) return;
    if (!(await ask({ title: t('admin.blocks.person_q'), name: handle.trim(), verb: t('admin.blocks.block'), danger: true, note: t('admin.blocks.person_note') }))) return;
    setBusy(true);
    try { await post('/api/admin/actor-blocks', { handle: handle.trim(), reason: why }); setHandle(''); setWhy(''); say(t('admin.done')); await loadActors(); }
    catch (err) { say(errorText(err)); }
    setBusy(false);
  }
  async function remove(path: string, reload: () => Promise<void>) {
    try { await del(path); say(t('admin.done')); await reload(); } catch (err) { say(errorText(err)); }
  }

  return (
    <section aria-label={t('admin.tab.domains')}>
      <div className="setting-card">
        <h3>{t('admin.blocks.domains')}</h3>
        <p className="muted small">{t('admin.blocks.domains_help')}</p>
        <form className="admin-form" onSubmit={addDomain}>
          <label className="field grow"><span>{t('admin.blocks.host')}</span>
            <input className="form-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.social" autoCapitalize="none" spellCheck={false} />
          </label>
          <label className="field grow"><span>{t('admin.blocks.reason')}</span>
            <input className="form-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !host.trim()}>{t('admin.blocks.block')}</button>
        </form>
        {!domains && <p className="muted" role="status">{t('admin.loading')}</p>}
        {domains && !domains.blocks.length && <p className="muted small">{t('admin.blocks.none')}</p>}
        {domains?.blocks.map((b) => (
          <div key={b.host} className="list-row">
            <span className="who"><b className="mono">{b.host}</b>{b.reason && <span className="muted"> · {b.reason}</span>}
              <span className="faint small"> · {fmtDay(b.at)}{b.by ? ` · ${b.by}` : ''}</span></span>
            <span className="verbs"><button type="button" className="btn btn-sm" onClick={() => remove(`/api/admin/domain-blocks/${enc(b.host)}`, loadDomains)}>{t('admin.blocks.unblock')}</button></span>
          </div>
        ))}
      </div>
      <div className="setting-card">
        <h3>{t('admin.blocks.people')}</h3>
        <p className="muted small">{t('admin.blocks.people_help')}</p>
        <form className="admin-form" onSubmit={addActor}>
          <label className="field grow"><span>{t('admin.blocks.handle')}</span>
            <input className="form-input" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="name@example.social" autoCapitalize="none" spellCheck={false} />
          </label>
          <label className="field grow"><span>{t('admin.blocks.reason')}</span>
            <input className="form-input" value={why} maxLength={500} onChange={(e) => setWhy(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !handle.trim()}>{t('admin.blocks.block')}</button>
        </form>
        {actors && !actors.blocks.length && <p className="muted small">{t('admin.blocks.none')}</p>}
        {actors?.blocks.map((b) => (
          <div key={b.handle} className="list-row">
            <span className="who"><b className="mono">{b.handle}</b>{b.reason && <span className="muted"> · {b.reason}</span>}
              <span className="faint small"> · {fmtDay(b.at)}</span></span>
            <span className="verbs"><button type="button" className="btn btn-sm" onClick={() => remove(`/api/admin/actor-blocks/${enc(b.handle)}`, loadActors)}>{t('admin.blocks.unblock')}</button></span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Members and the signup door ──

function MembersTab({ say, ask, me }: { say: Say; ask: Ask; me: Me | null }) {
  const [data, load] = useLoad<{ members: MemberRow[]; invites_per_member: number; signup: string }>('/api/admin/members', say);
  const [door, loadDoor] = useLoad<Signups>('/api/admin/signups', say);
  const [email, setEmail] = useState('');
  async function act(m: MemberRow, action: string) {
    const danger = action === 'suspend' || action === 'step_down';
    const title = action === 'suspend' ? t('admin.members.suspend_q') : action === 'unsuspend' ? t('admin.members.unsuspend_q')
      : action === 'make_admin' ? t('admin.members.make_admin_q') : t('admin.members.step_down_q');
    const verb = action === 'suspend' ? t('admin.members.suspend') : action === 'unsuspend' ? t('admin.members.unsuspend')
      : action === 'make_admin' ? t('admin.members.make_admin') : t('admin.members.step_down');
    if (!(await ask({ title, verb, name: m.name, danger, note: action === 'suspend' ? t('admin.members.suspend_note') : undefined }))) return;
    try {
      await post(`/api/admin/members/${enc(m.name)}`, { action });
      say(t('admin.done'));
      if (action === 'step_down') { location.assign('/app'); return; }
      await load();
    } catch (e) { say(errorText(e)); }
  }
  async function release(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    try { await post('/api/admin/signups', { action: 'release', email: email.trim() }); setEmail(''); say(t('admin.signups.released')); await loadDoor(); }
    catch (err) { say(errorText(err)); }
  }
  async function clear() {
    if (!(await ask({ title: t('admin.signups.clear_q'), verb: t('admin.signups.clear'), danger: true, note: t('admin.signups.clear_note') }))) return;
    try { await post('/api/admin/signups', { action: 'clear' }); say(t('admin.done')); await loadDoor(); } catch (err) { say(errorText(err)); }
  }
  return (
    <section aria-label={t('admin.tab.members')}>
      <div className="setting-card">
        <h3>{t('admin.members.title')}</h3>
        {!data && <p className="muted" role="status">{t('admin.loading')}</p>}
        {data?.members.map((m) => (
          <div key={m.name} className="list-row admin-member">
            <span className="who">
              <b>{m.display_name}</b> <span className="mono muted">@{m.name}</span>
              {m.role === 'admin' && <> <span className="chip">{t('admin.members.admin')}</span></>}
              {m.status === 'suspended' && <> <span className="chip admin-chip-bad">{t('admin.members.suspended')}</span></>}
              <br /><span className="faint small">{m.email} · {t('admin.members.joined', { day: fmtDay(m.created_at) })}
                {m.invited_by ? ` · ${t('admin.members.invited_by', { name: m.invited_by })}` : ''} · {t('admin.members.invites', { n: m.invites_live, max: data.invites_per_member })}</span>
            </span>
            <span className="verbs">
              {m.status === 'active' && m.name !== me?.handle && <button type="button" className="btn btn-sm btn-danger" onClick={() => act(m, 'suspend')}>{t('admin.members.suspend')}</button>}
              {m.status === 'suspended' && <button type="button" className="btn btn-sm" onClick={() => act(m, 'unsuspend')}>{t('admin.members.unsuspend')}</button>}
              {m.role === 'member' && m.status === 'active' && <button type="button" className="btn btn-sm" onClick={() => act(m, 'make_admin')}>{t('admin.members.make_admin')}</button>}
              {m.role === 'admin' && m.name === me?.handle && <button type="button" className="btn btn-sm" onClick={() => act(m, 'step_down')}>{t('admin.members.step_down')}</button>}
            </span>
          </div>
        ))}
      </div>
      <div className="setting-card">
        <h3>{t('admin.signups.title')}</h3>
        <p className="muted small">{t('admin.signups.help')}</p>
        {door && (
          <dl className="admin-facts">
            <dt>{t('admin.signups.pending')}</dt><dd className="mono">{door.pending} / {door.cap}{door.full ? ` · ${t('admin.signups.full')}` : ''}</dd>
            <dt>{t('admin.signups.at_share')}</dt><dd className="mono">{door.requesters_at_share} <span className="muted">({t('admin.signups.share', { n: door.per_requester })})</span></dd>
            <dt>{t('admin.signups.mail')}</dt><dd>{t('admin.signups.mail_rule', { mine: door.mail_per_requester_day, day: door.mail_per_address_day })}</dd>
          </dl>
        )}
        <form className="admin-form" onSubmit={release}>
          <label className="field grow"><span>{t('admin.signups.release_label')}</span>
            <input className="form-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} />
          </label>
          <button type="submit" className="btn" disabled={!email.trim()}>{t('admin.signups.release')}</button>
        </form>
        <div className="row"><button type="button" className="btn btn-sm btn-danger" onClick={clear}>{t('admin.signups.clear')}</button></div>
      </div>
    </section>
  );
}

// ── Federation ──

function FederationTab({ say }: { say: Say }) {
  const [data, load] = useLoad<Fed>('/api/admin/federation', say);
  async function clear(h: string) {
    try { await post(`/api/admin/federation/hosts/${enc(h)}/clear`); say(t('admin.done')); await load(); } catch (e) { say(errorText(e)); }
  }
  if (!data) return <p className="muted" role="status">{t('admin.loading')}</p>;
  return (
    <section aria-label={t('admin.tab.federation')}>
      <div className="setting-card">
        <dl className="admin-facts">
          <dt>{t('admin.fed.state')}</dt><dd>{data.federation ? t('admin.fed.on') : t('admin.fed.off')}</dd>
          <dt>{t('admin.fed.origin')}</dt><dd className="mono">{data.origin || '-'}</dd>
          <dt>{t('admin.fed.federated_at')}</dt><dd>{data.federated_at ? fmtDay(data.federated_at) : t('admin.fed.not_yet')}</dd>
          <dt>{t('admin.fed.queue')}</dt><dd className="mono">{data.queue_depth}</dd>
        </dl>
      </div>
      <div className="setting-card">
        <h3>{t('admin.fed.hosts')}</h3>
        {!data.hosts.length && <p className="muted small">{t('admin.fed.no_hosts')}</p>}
        {data.hosts.map((h) => (
          <div key={h.host} className="list-row">
            <span className="who"><b className="mono">{h.host}</b>
              <span className="muted small"> · {h.unavailable ? t('admin.fed.unavailable') : t('admin.fed.failing_since', { day: fmtDay(h.failing_since) })}</span>
              {h.software && <span className="faint small"> · {h.software}</span>}</span>
            <span className="verbs"><button type="button" className="btn btn-sm" onClick={() => clear(h.host)}>{t('admin.fed.clear')}</button></span>
          </div>
        ))}
        {data.hosts_total > data.hosts.length && <p className="muted small">{t('admin.fed.more', { n: data.hosts_total - data.hosts.length })}</p>}
      </div>
    </section>
  );
}
