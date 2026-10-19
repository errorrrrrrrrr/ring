/* ── Settings › Rings (spec 3.6, 13.1) ────────────────────────────────────────
 * Sober tool chrome: my rings,
 * each with its members (and the host each is on), the name as its own rename
 * (InlineText, any member), one ⋮ menu for every ring verb (new link, link off,
 * a link when there is none, leave, delete for the creator; the destructive
 * ones arm first), the requests to approve or decline (a kicked handle marked,
 * a requester from another server with the trust notice), the standing join
 * link with Copy, and two forms: name a new ring, or paste a join link.
 * The ?ring=<code> offer from a join link reads "Ask to join": the link asks,
 * it never admits; a member approves.
 */
import { useState } from 'react';
import { t } from './strings.ts';
import { post, patch, del, enc, copyText, errorText } from './api.ts';
import { fmtDay } from './datetime.ts';
import { Menu, Tip } from './ui.tsx';
import { InlineText } from './inline-edit.tsx';
import { useConfirm } from './confirm.tsx';
import type { Ring, JoinOffer } from './types.ts';

export function RingsPanel({ rings, me, myHost, maxMembers, maxRings, offer, onAcceptOffer, onDismissOffer, onChanged, say, onCreated }: {
  rings: Ring[];
  me: string;
  myHost: string;
  maxMembers: number;
  maxRings: number;
  offer: JoinOffer | null;
  onAcceptOffer: () => void;
  onDismissOffer: () => void;
  onChanged: () => void;
  say: (m: string) => void;
  onCreated: (ring: Ring) => void;
}) {
  const [newName, setNewName] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, confirmUI] = useConfirm();

  const call = async <T,>(fn: () => Promise<T>, done?: (r: T) => string): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await fn();
      if (done) say(done(r));
      onChanged();
      return r;
    } catch (e) { say(errorText(e)); return null; } finally { setBusy(false); }
  };
  const copy = async (id: string, url: string) => {
    if (await copyText(url)) {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? '' : c)), 2000);
      return true;
    }
    say(t('rings.clipboard_failed'));
    return false;
  };
  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    const made = await call(() => post<Ring>('/api/rings', { name }));
    if (!made) return;
    setNewName('');
    onCreated(made);
  };
  const askByLink = async () => {
    const url = joinUrl.trim();
    if (!url) return;
    const r = await call(() => post<{ requested?: boolean; name: string }>('/api/rings/join', { url }),
      (d) => (d.requested ? t('rings.asked', { name: d.name }) : t('rings.joined', { name: d.name })));
    if (r) setJoinUrl('');
  };
  const atCap = rings.length >= maxRings;
  const ringPath = (r: Ring) => `/api/rings/${enc(r.id)}`;

  return (
    <div className="setting-card">
      <h3><Tip text={t('rings.explainer', { max: maxRings })}>{t('rings.title')}</Tip></h3>

      {offer && (
        <div style={{ marginBottom: 12, border: '1px solid var(--blue)', background: 'var(--tint)', padding: '10px 12px' }}>
          <div style={{ fontSize: 'var(--fs-sm)' }}>
            <b>{offer.name}</b>{' '}
            <span className="muted">{t('rings.offer_meta', { who: offer.offered_by, n: offer.members, max: offer.max_members })}</span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {offer.already_member ? <span className="small muted">{t('rings.already_in')}</span>
              : offer.requested ? <span className="small muted">{t('rings.already_asked')}</span>
              : offer.full ? <span className="small muted">{t('rings.offer_full', { max: offer.max_members })}</span>
              : offer.at_my_cap ? <span className="small muted">{t('rings.offer_at_cap', { max: maxRings })}</span>
              : <button type="button" className="btn btn-sm btn-primary" onClick={onAcceptOffer}>{t('rings.ask_to_join', { name: offer.name })}</button>}
            <button type="button" className="btn-link" onClick={onDismissOffer}>{t('rings.dismiss')}</button>
          </div>
        </div>
      )}

      {rings.length === 0 && <p className="small faint">{t('rings.none_yet')}</p>}
      {rings.map((r) => (
        <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--divider)' }}>
          <div className="row" style={{ gap: 4, fontSize: 'var(--fs-sm)', marginBottom: 6 }}>
            <InlineText value={r.name} label={t('rings.rename', { name: r.name })} maxLength={60} display={<b>{r.name}</b>}
              onCommit={(next) => { call(() => patch(ringPath(r), { name: next }), () => t('rings.renamed')); }} />
            <Menu label={t('rings.actions', { name: r.name })} items={[
              r.join && { label: t('rings.new_link'), confirm: true, confirmNote: t('rings.new_link_note'),
                onClick: () => { call(() => post(`${ringPath(r)}/link`), () => t('rings.new_link_ready')); } },
              r.join && { label: t('rings.link_off'), confirm: true, confirmNote: t('rings.link_off_note'),
                onClick: () => { call(() => del(`${ringPath(r)}/link`), () => t('rings.link_is_off')); } },
              !r.join && !r.full && { label: t('rings.make_link'),
                onClick: () => { call(() => post<Ring>(`${ringPath(r)}/link`)).then((d) => { if (d?.join?.url) copy(r.id, d.join.url).then((ok) => say(ok ? t('rings.link_copied') : t('rings.link_ready'))); }); } },
              { label: t('rings.leave'), confirm: true, confirmLabel: t('rings.leave_confirm', { name: r.name }),
                onClick: () => { call(() => post<{ dissolved: boolean }>(`${ringPath(r)}/leave`), (d) => (d.dissolved ? t('rings.left_dissolved') : t('rings.left'))); } },
              r.mine && { label: t('rings.delete'), danger: true, confirm: true,
                confirmLabel: t('rings.delete_confirm', { name: r.name }), confirmNote: t('rings.delete_note'),
                onClick: () => { call(() => del(ringPath(r)), () => t('rings.deleted')); } },
            ]} />
            <span className="faint" style={{ fontSize: 'var(--fs-2xs)' }}>
              {r.mine ? t('rings.members_of_yours', { n: r.members.length, max: maxMembers }) : t('rings.members_of', { n: r.members.length, max: maxMembers })}
            </span>
          </div>
          {(r.hosts.length > 1 || !r.home) && (
            <div className="small faint" style={{ marginBottom: 6 }}>
              {!r.home && `${t('rings.hosted_on', { host: r.home_host })} · `}{t('rings.held_on', { hosts: r.hosts.join(', ') })}
            </div>
          )}
          <div className="row" style={{ gap: 6 }}>
            {r.members.map((m) => (
              <span key={m.handle} className="chip">
                {m.name}{m.handle === me ? ` ${t('rings.you_marker')}` : ''}
                {m.host && m.host !== myHost && <span className="faint"> · {m.host}</span>}
                {r.mine && m.handle !== me && (
                  <button type="button" className="chip-x" disabled={busy} aria-label={t('rings.kick_aria', { name: m.name, ring: r.name })}
                    onClick={async () => {
                      if (!await ask({ title: t('rings.kick_confirm', { name: m.name, ring: r.name }), note: t('rings.kick_note'), verb: t('rings.kick_verb'), name: m.name })) return;
                      call(() => del(`${ringPath(r)}/members/${enc(m.handle)}`), () => t('rings.kicked', { name: m.name }));
                    }}>✕</button>
                )}
              </span>
            ))}
          </div>

          {r.requests.length > 0 && (
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <span className="eyebrow-sm muted">{t('rings.asked_to_join')}</span>
              {r.requests.map((q) => (
                <span key={q.handle} className="chip chip--ask">
                  {q.name}
                  {q.host && q.host !== myHost && <Tip text={t('rings.trust_notice', { name: q.name, host: q.host })}><span className="faint"> · {q.host}</span></Tip>}
                  {q.kicked && <span className="kicked-mark"> {t('inbox.kicked_mark')}</span>}
                  <button type="button" className="chip-x chip-ok" disabled={busy} aria-label={t('rings.approve_aria', { name: q.name })}
                    onClick={async () => {
                      // P7: letting in someone from another server is consenting to trust
                      // that server with the room (spec 4.7): the dialog says so.
                      if (q.host && q.host !== myHost && !await ask({ title: t('rings.approve_remote', { name: q.name, ring: r.name }), note: t('rings.trust_notice', { name: q.handle, host: q.host }), verb: t('rings.approve_verb'), danger: false })) return;
                      call(() => post(`${ringPath(r)}/requests/${enc(q.handle)}`, { approve: true }), () => t('rings.member_joined', { name: q.name, ring: r.name }));
                    }}>✓</button>
                  <button type="button" className="chip-x" disabled={busy} aria-label={t('rings.decline_aria', { name: q.name })}
                    onClick={() => { call(() => post(`${ringPath(r)}/requests/${enc(q.handle)}`, { approve: false }), () => t('rings.request_declined')); }}>✕</button>
                </span>
              ))}
            </div>
          )}

          {r.full ? (
            <div className="small faint" style={{ marginTop: 8 }}>{t('rings.full_note', { max: maxMembers })}</div>
          ) : r.join ? (
            <div style={{ marginTop: 8 }}>
              <div className="row" style={{ gap: 6 }}>
                <input className="form-input mono" readOnly value={r.join.url} aria-label={t('rings.link_label', { name: r.name })}
                  style={{ flex: '1 1 240px', minWidth: 0, fontSize: 'var(--fs-sm)', height: 'var(--ctl-sm)' }}
                  onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn btn-sm" onClick={() => r.join && copy(r.id, r.join.url)}>
                  {copied === r.id ? t('common.copied') : t('rings.copy_link')}
                </button>
              </div>
              <div className="small faint" style={{ marginTop: 4 }}>{t('rings.link_note', { date: fmtDay(r.join.expires_at) })}</div>
            </div>
          ) : (
            <div className="small faint" style={{ marginTop: 8 }}>{t('rings.no_link')}</div>
          )}
        </div>
      ))}

      <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); create(); }}>
        <input className="form-input" value={newName} maxLength={60} placeholder={t('rings.name_new')} aria-label={t('rings.name_new')}
          style={{ width: 220, height: 'var(--ctl-sm)', fontSize: 'var(--fs-sm)' }} disabled={atCap}
          onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={busy || atCap || !newName.trim()}>{t('rings.new_ring')}</button>
        <span className="small faint">{atCap ? t('rings.at_cap', { max: maxRings }) : t('rings.link_on_create')}</span>
      </form>
      <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); askByLink(); }}>
        <input className="form-input mono" value={joinUrl} maxLength={600} placeholder={t('rings.paste_placeholder')} aria-label={t('rings.paste_label')}
          style={{ flex: '1 1 240px', minWidth: 0, height: 'var(--ctl-sm)', fontSize: 'var(--fs-sm)' }}
          onChange={(e) => setJoinUrl(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={busy || !joinUrl.trim()}>{t('rings.ask')}</button>
      </form>
      {confirmUI}
    </div>
  );
}
