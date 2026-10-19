/* ── The lookup panel (spec 8.5; P6) ──────────────────────────────────────────
 * What GET /api/lookup found for a handle, a profile, a post or a join link,
 * opened by /authorize_interaction (`/app?open=<uri>`) or by Settings ›
 * Friends' look-up field, with its verbs:
 *   a person   their name, host and bio (a node tree, never HTML); Befriend,
 *              or what stands between you (asked, friends)
 *   a post     the card itself (board.tsx), so a stamp is a press and a note is
 *              open to friends, through /api/remote/* like any remote card
 *   a link     a ring's join link here goes to the offer (Settings › Rings);
 *              another Ring server's (P7) shows the ring's name and the hosts
 *              that hold it, with the trust notice, and asks from here
 * The server decides everything (the tiers, blocks, a blocked domain's 404);
 * this only shows its answer and its refusal.
 */
import { useState } from 'react';
import { t } from './strings.ts';
import { Board, type CardActions } from './board.tsx';
import type { ReportTarget } from './report.tsx';
import { RemoteText } from './remote-text.tsx';
import type { ShelfContext } from './wall.ts';
import type { Lookup, StampStyle } from './types.ts';

export function LookupPanel({ looked, onClose, onLookup, onBefriend, onJoin, onAskRemote, onReport, ctx, palette, actions }: {
  looked: { q: string; result: Lookup | null; error: string };
  onClose: () => void;
  onLookup: (q: string) => void;
  onBefriend: (handle: string, name: string) => void;
  onJoin: (code: string) => void;
  onAskRemote: (url: string, name: string) => void;
  onReport: (target: ReportTarget) => void;   // P8: a person, to the admin
  ctx: ShelfContext;
  palette: StampStyle[];
  actions: CardActions;
}) {
  const [q, setQ] = useState(looked.q);
  const r = looked.result;
  return (
    <div className="lookup-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="lookup-panel" role="dialog" aria-modal="true" aria-label={t('lookup.title')}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="row">
          <div className="eyebrow grow">{t('lookup.title')}</div>
          <button type="button" className="btn-link" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (q.trim()) onLookup(q.trim()); }}>
          <input className="form-input grow" value={q} maxLength={2000} aria-label={t('lookup.label')}
            placeholder={t('lookup.placeholder')} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={!q.trim()}>{t('lookup.go')}</button>
        </form>
        {!r && !looked.error && <p className="small faint" role="status">{t('lookup.looking')}</p>}
        {looked.error && <p className="small" role="alert">{looked.error}</p>}
        {r?.type === 'person' && (
          <div className="lookup-person">
            {r.avatar_url && <img className="lookup-avatar" src={r.avatar_url} alt="" width={64} height={64} />}
            <div className="grow">
              <a className="who" href={r.url} target="_blank" rel={r.local ? 'noopener' : 'nofollow noopener ugc'}>{r.name}</a>
              <div className="faint mono small">{r.handle}</div>
              {r.bio && r.bio.length > 0 && <RemoteText tree={r.bio} className="small" />}
            </div>
            <div className="verbs">
              {r.status === 'none' && <button type="button" className="btn btn-sm" onClick={() => onBefriend(r.handle, r.name)}>{t('friends.befriend')}</button>}
              {r.status === 'pending' && <span className="small faint">{t('lookup.asked')}</span>}
              {r.status === 'friends' && <span className="small faint">{t('lookup.friends')}</span>}
              <button type="button" className="btn btn-sm"
                onClick={(e) => onReport({ body: { kind: 'person', handle: r.handle }, label: r.name, host: r.local ? undefined : r.host, anchor: e.currentTarget })}>{t('card.report')}</button>
            </div>
          </div>
        )}
        {r?.type === 'post' && r.local && (
          <p><a href={r.url}>{t('lookup.local_post', { name: r.owner })}</a></p>
        )}
        {r?.type === 'post' && !r.local && (
          <div className="lookup-post">
            {!r.friends && <p className="small faint">{t('lookup.not_friends')}</p>}
            <Board posts={[r.post]} ctx={ctx} palette={palette} feed="friends" roomName="" ends={false} keepBlocked actions={actions} />
          </div>
        )}
        {r?.type === 'join' && r.local && (
          <p><button type="button" className="btn btn-sm" onClick={() => onJoin(r.code)}>{t('lookup.open_join')}</button></p>
        )}
        {r?.type === 'join' && !r.local && (
          <div className="lookup-join">
            <p><b>{r.name}</b></p>
            <p className="small">{t('lookup.join_remote', { host: new URL(r.url).host, hosts: r.hosts.join(', ') })}</p>
            <p className="small faint">{t('lookup.join_trust')}</p>
            {r.already_member ? <p className="small muted">{t('lookup.join_member')}</p>
              : r.requested ? <p className="small muted">{t('lookup.join_asked')}</p>
              : r.at_my_cap ? <p className="small muted">{t('lookup.join_cap', { max: 3 })}</p>
              : <p><button type="button" className="btn btn-sm btn-primary" onClick={() => onAskRemote(r.url, r.name)}>{t('lookup.join_ask', { name: r.name })}</button></p>}
          </div>
        )}
      </section>
    </div>
  );
}
