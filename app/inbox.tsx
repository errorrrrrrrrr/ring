/* ── The Inbox: one quiet list of lines (spec 13.1, 11.1) ─────────────────────
 * What waits on a person comes
 * first, the only thing allowed a count: join requests (any member may wave
 * one in; a kicked handle is marked, and only the ring's creator can re-admit
 * it) and follow requests (Befriend, Let follow, Decline). Then what arrived:
 * stamps and friends' notes on my posts, unseen ones in bold. Then From
 * elsewhere (P6): a reply or a mention from another server that is not a
 * comment (a non-friend's), the owner's only, never on the wall; its text is a
 * node tree (remote-text.tsx), never HTML; from there, Befriend or Block. A
 * follow request from another server can be befriended too (P6).
 * OPENING the Inbox is what marks reactions and From elsewhere seen (the
 * parent posts /api/inbox/seen); a request stays until it is answered.
 */
import { Popover } from './popover.tsx';
import { t } from './strings.ts';
import { fmtAge } from './datetime.ts';
import type { Inbox } from './types.ts';
import type { ReportTarget } from './report.tsx';
import { RemoteText } from './remote-text.tsx';

export function InboxPanel({ open, anchorRef, onClose, inbox, busy, onJoin, onFollow, onElsewhere, onReport }: {
  open: boolean;
  anchorRef: { readonly current: HTMLElement | null };
  onClose: () => void;
  inbox: Inbox | null;
  busy: boolean;
  onJoin: (ringId: string, handle: string, approve: boolean, name: string, ringName: string) => void;
  onFollow: (handle: string, how: 'befriend' | 'let' | 'decline', name: string) => void;
  onElsewhere: (handle: string, how: 'befriend' | 'block', name: string) => void;
  onReport: (target: ReportTarget) => void;   // P8: From elsewhere, to the admin
}) {
  const reactions = inbox ? [
    ...inbox.stamps.map((s) => ({ key: s.id, at: s.at, seen: s.seen, line: t('inbox.stamped', { name: s.author.name, face: s.kaomoji }) })),
    ...inbox.comments.map((c) => ({ key: c.id, at: c.at, seen: c.seen, line: t('inbox.noted', { name: c.author.name, body: c.body }) })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40) : [];
  const notices = inbox?.notices || [];
  const nothing = inbox && !inbox.join_requests.length && !inbox.follow_requests.length && !reactions.length && !inbox.elsewhere.length && !notices.length;

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} placement="right-end" sheet minWidth={300}
      surfaceProps={{ role: 'dialog', 'aria-label': t('inbox.title') }}>
      <div className="inbox-panel">
        <div className="inbox-head eyebrow">{t('inbox.title')}</div>
        {!inbox && <div className="inbox-line inbox-line--quiet" role="status">{t('board.fetching')}</div>}
        {notices.map((n) => (
          <div key={n.id} className={`inbox-line${n.seen ? '' : ' is-unseen'}`}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{n.kind === 'comment_removed' ? t('inbox.comment_removed') : n.kind === 'stamp_removed' ? t('inbox.stamp_removed') : t('inbox.post_removed')}</span>
            <span className="inbox-age">{fmtAge(n.at)}</span>
          </div>
        ))}
        {inbox?.join_requests.map((q) => (
          <div key={`${q.ring.id}:${q.handle}`} className="inbox-line">
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {t('inbox.asked_to_join', { name: q.name, ring: q.ring.name })}
              {q.kicked && <> <span className="kicked-mark">{t('inbox.kicked_mark')}</span></>}
            </span>
            <span className="inbox-verbs">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onJoin(q.ring.id, q.handle, true, q.name, q.ring.name)}>{t('rings.wave_in')}</button>
              <button type="button" className="btn btn-sm" disabled={busy} aria-label={t('rings.decline_aria', { name: q.name })}
                onClick={() => onJoin(q.ring.id, q.handle, false, q.name, q.ring.name)}>✕</button>
            </span>
          </div>
        ))}
        {inbox?.follow_requests.map((f) => (
          <div key={`f:${f.handle}`} className="inbox-line">
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t('inbox.wants_to_follow', { name: f.name })}</span>
            <span className="inbox-verbs">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onFollow(f.handle, 'befriend', f.name)}>{t('friends.befriend')}</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onFollow(f.handle, 'let', f.name)}>{t('friends.let_follow')}</button>
              <button type="button" className="btn btn-sm" disabled={busy} aria-label={t('friends.decline_aria', { name: f.name })}
                onClick={() => onFollow(f.handle, 'decline', f.name)}>✕</button>
            </span>
          </div>
        ))}
        {reactions.map((r) => (
          <div key={r.key} className={`inbox-line${r.seen ? '' : ' is-unseen'}`}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{r.line}</span>
            <span className="inbox-age">{fmtAge(r.at)}</span>
          </div>
        ))}
        {inbox && inbox.elsewhere.length > 0 && <div className="inbox-head eyebrow">{t('inbox.elsewhere')}</div>}
        {inbox?.elsewhere.map((x) => (
          <div key={x.id} className={`inbox-line inbox-line--elsewhere${x.seen ? '' : ' is-unseen'}`}>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <a href={x.url} target="_blank" rel="nofollow noopener ugc">
                {x.kind === 'reply' ? t('inbox.elsewhere_reply', { name: x.author.name, host: x.author.host }) : t('inbox.elsewhere_mention', { name: x.author.name, host: x.author.host })}
              </a>
              {x.summary && <> <b>{x.summary}</b></>}
              <RemoteText tree={x.tree} className="inbox-remote" />
              {x.cut && <> <a className="logwall-quiet" href={x.url} target="_blank" rel="nofollow noopener ugc">{t('card.more_at_source')}</a></>}
            </span>
            <span className="inbox-verbs">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onElsewhere(x.author.handle, 'befriend', x.author.name)}>{t('friends.befriend')}</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onElsewhere(x.author.handle, 'block', x.author.name)}>{t('friends.block')}</button>
              <button type="button" className="btn btn-sm" disabled={busy}
                onClick={(e) => onReport({ body: { kind: 'reply', id: x.id }, label: x.author.name, host: x.author.host, anchor: e.currentTarget })}>{t('card.report')}</button>
            </span>
          </div>
        ))}
        {nothing && <div className="inbox-line inbox-line--quiet">{t('inbox.nothing')}</div>}
      </div>
    </Popover>
  );
}
