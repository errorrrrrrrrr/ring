/* ── The board: cards on the wall (spec 13.1) ─────────────────────────────────
 * The board, its cards, the stamp tray and the days rail, in the
 * sticker-wall register: polaroids for images,
 * stickies for notes, tickets for links, torn strips for dividers, the
 * author's name tag pinned to the corner, stamps as tickets in the sender's
 * tint. Chaos is seeded from the post's object URL (app/wall.ts).
 *
 * The rules:
 *   - a link card carries an optional image and a caption
 *   - a face is text, always (decision 4)
 *   - a `cw` card stays shut until opened
 *   - the stamp tray offers what THIS viewer may press (wall.ts stampShelf):
 *     the nice shelf to a non-friend, every face to a friend, every face and a
 *     custom one to a ring-mate on a room post
 *   - a note (comment) is offered to confirmed friends only, as the server
 *     enforces; the author of a post removes any stamp or note on it
 *   - an embed is a click-to-play frame (nothing loads from YouTube, Vimeo or
 *     SoundCloud until asked), not a bare URL
 *   - own-post verbs: Edit, Pin (Public), Keep (a room or the shelf), Delete
 *     (house confirm), Copy link
 * Every string escapes through React; only the server's sanitized markdown
 * (lib/ring.js renderRingMarkdown, escape-first) goes in as HTML, the same
 * markup the member's wall renders.
 *
 * P6, a REMOTE card (`origin: 'remote'`: a remote friend's post, a looked-up
 * one): its text is the node tree another server's HTML became, rendered by
 * remote-text.tsx with React elements only, never as HTML (a Ring server's
 * post arrives as this server's own rendering of its markdown instead); its
 * images are the media cache's copies; video and audio are links to the
 * source; its stamps and notes are the viewer's own, sent to its server.
 */
import type React from 'react';
import { useState } from 'react';
import { t } from './strings.ts';
import { fmtAge } from './datetime.ts';
import {
  wallChaos, chaosSeed, wallDay, wallHash, dividerGlyph, stampShelf, canComment, customFace, isRoom, cardKey,
  type WallChaos, type ShelfContext,
} from './wall.ts';
import type { PostView, StampStyle, StampView, CommentView } from './types.ts';
import { RemoteText } from './remote-text.tsx';

export interface CardActions {
  onStamp: (p: PostView, face: string, custom: boolean) => void;
  onTakeBackStamp: (p: PostView, s: StampView) => void;
  onRemoveStamp: (p: PostView, s: StampView) => void;
  onComment: (p: PostView, body: string) => Promise<boolean>;
  onRemoveComment: (p: PostView, c: CommentView, mine: boolean) => void;
  onEdit: (p: PostView) => void;
  onPin: (p: PostView, pinned: boolean) => void;
  onKeep: (p: PostView) => void;
  onDelete: (p: PostView) => void;
  onCopyLink: (p: PostView) => void;
  /* P8: on another's post, tell the server's admin (report.tsx). */
  onReport: (p: PostView, anchor: HTMLElement) => void;
}

const itemStyle = (c: WallChaos, first: boolean, raised: boolean): React.CSSProperties =>
  ({ '--w': `${c.w}%`, '--xf': c.xf, '--mt': `${first ? 6 : c.mt}px`, '--z': raised ? 40 : c.z } as React.CSSProperties);
const cardStyle = (c: WallChaos, sticky: boolean): React.CSSProperties => {
  const s: Record<string, string> = { '--tilt': `${c.tilt}deg`, '--riso-x': `${c.risoX}px`, '--riso-y': `${c.risoY}px` };
  if (sticky) s['--sticky'] = c.sticky;
  return s as React.CSSProperties;
};
const ticketStyle = (rot: string, tint?: string): React.CSSProperties => {
  const s: Record<string, string> = { '--s-rot': rot };
  if (tint && /^#[0-9a-fA-F]{6}$/.test(tint)) s.background = tint;
  return s as React.CSSProperties;
};

/* Thunks with literal keys, so the copy gate sees every key. */
export const KIND_LABEL: Record<string, () => string> = {
  note: () => t('kind.note'), image: () => t('kind.image'), link: () => t('kind.link'),
  embed: () => t('kind.embed'), divider: () => t('kind.divider'),
};

// ── The board ──

export function Board({ posts, ctx, palette, feed, roomName, ends, keepBlocked, actions }: {
  posts: PostView[] | null;
  ctx: ShelfContext;
  palette: StampStyle[];
  feed: 'public' | 'friends' | 'archive' | 'room';
  roomName: string;
  ends: boolean;
  keepBlocked: boolean;
  actions: CardActions;
}) {
  if (posts === null) return <div className="logwall-empty" role="status">{t('board.fetching')}</div>;
  if (posts.length === 0) {
    const line = feed === 'archive' ? t('board.empty_shelf')
      : feed === 'room' ? t('board.empty_room', { name: roomName })
      : feed === 'friends' ? t('board.empty_friends')
      : t('board.nothing_public');
    return (
      <div className="logwall-empty">
        <div className="logwall-empty-face" aria-hidden="true">( ˘ω˘ )</div>
        {line}
      </div>
    );
  }
  return (
    <>
      <div className="logwall-board">
        {posts.map((p, i) => (
          <Card key={cardKey(p)} p={p} first={i === 0} ctx={ctx} palette={palette}
            archive={feed === 'archive'} keepBlocked={keepBlocked} actions={actions} />
        ))}
      </div>
      {ends && <div className="logwall-endline">{t('board.thats_everyone')} <b>{t('board.go_make')}</b> ·</div>}
    </>
  );
}

// ── The days rail: the last ten days, a circled day jumps to its posts ──

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function DaysRail({ posts }: { posts: PostView[] }) {
  if (!posts.length) return null;
  const posted = new Set(posts.map((p) => wallDay(p.created_at)).filter(Boolean));
  const cells: { day: string; dow: string; num: number; has: boolean }[] = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    const day = wallDay(d.toISOString());
    cells.push({ day, dow: DOW[d.getDay()], num: d.getDate(), has: posted.has(day) });
  }
  const jump = (day: string) => document.querySelector(`[data-day="${day}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return (
    <nav className="dayrail" aria-label={t('board.days_with_posts')}>
      {cells.map((c, i) => (
        <button key={c.day} type="button" className={`dayrail-cell${c.has ? ' is-posted' : ''}${i === 0 ? ' is-today' : ''}`}
          style={{ '--dtilt': `${(wallHash(c.day) % 5) - 2}deg` } as React.CSSProperties}
          aria-label={c.has ? t('board.day_posted', { day: c.day }) : c.day} disabled={!c.has} onClick={() => jump(c.day)}>
          <small aria-hidden="true">{c.dow}</small>
          <b aria-hidden="true">{c.num}</b>
        </button>
      ))}
    </nav>
  );
}

// ── The stamp tray ──

function StampTray({ shelf, mine, onPick }: {
  shelf: ReturnType<typeof stampShelf>; mine: string; onPick: (face: string, custom: boolean) => void;
}) {
  const [style, setStyle] = useState(0);
  const [custom, setCustom] = useState('');
  const st = shelf.styles[Math.min(style, shelf.styles.length - 1)];
  const sendCustom = () => {
    const face = customFace(custom);
    if (!face) return;
    onPick(face, true);
    setCustom('');
  };
  return (
    <div className="logwall-tray" role="group" aria-label={t('stamp.tray')}>
      <div className="logwall-tray-tabs" role="tablist" aria-label={t('stamp.styles')}>
        {shelf.styles.map((s, i) => (
          <button key={s.style} type="button" role="tab" aria-selected={st === s} onClick={() => setStyle(i)}
            className="eyebrow-sm">{s.label}</button>
        ))}
      </div>
      {st?.groups.flatMap((g) => g.faces).map((f) => (
        <button key={f} type="button" className="face" aria-pressed={mine === f}
          aria-label={mine === f ? t('stamp.face_mine', { face: f }) : t('stamp.face', { face: f })}
          onClick={() => onPick(f, false)}>{f}</button>
      ))}
      {shelf.tier === 'nice' && <div className="logwall-tray-note">{t('stamp.nice_only')}</div>}
      {shelf.custom && (
        <div className="logwall-tray-custom">
          <input className="logwall-field" value={custom} maxLength={20} placeholder={t('stamp.custom_placeholder')}
            aria-label={t('stamp.custom_label')}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendCustom(); } }} />
          <button type="button" className="logwall-commit" onClick={sendCustom}>{t('stamp.press')}</button>
        </div>
      )}
    </div>
  );
}

// ── One card ──

function Card({ p, first, ctx, palette, archive, keepBlocked, actions }: {
  p: PostView; first: boolean; ctx: ShelfContext; palette: StampStyle[]; archive: boolean; keepBlocked: boolean; actions: CardActions;
}) {
  const [trayOpen, setTrayOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [shut, setShut] = useState(!!p.cw);
  const [playing, setPlaying] = useState(false);
  const c = wallChaos(chaosSeed(p));
  const own = p.author.handle === ctx.viewer;
  const room = isRoom(p.audience);
  const day = wallDay(p.created_at);
  const shelf = stampShelf(palette, p, { ...ctx, archive });
  const commentable = canComment(p, { ...ctx, archive });
  const myStamp = p.stamps.find((s) => s.author.handle === ctx.viewer);
  const age = fmtAge(p.created_at);
  const nameTag = own ? t('board.you') : p.author.name;
  const remote = p.origin === 'remote';

  const sendNote = async () => {
    const body = noteText.trim();
    if (!body) return;
    if (await actions.onComment(p, body)) { setNoteText(''); setNoteOpen(false); }
  };

  const ownVerbs = own && (
    <div className="logwall-ctl">
      {!archive && p.kind !== 'divider' && <button type="button" onClick={() => actions.onEdit(p)}>{t('card.edit')}</button>}
      {p.audience === 'public' && (
        <button type="button" onClick={() => actions.onPin(p, !p.pinned)}>{p.pinned ? t('card.unpin') : t('card.pin')}</button>
      )}
      {(room || archive) && (
        <button type="button" disabled={keepBlocked} title={keepBlocked ? t('card.keep_blocked') : t('card.keep_tip')}
          onClick={() => actions.onKeep(p)}>{t('card.keep')}</button>
      )}
      <button type="button" className="is-bad" onClick={() => actions.onDelete(p)}>{t('card.delete')}</button>
    </div>
  );

  if (p.kind === 'divider') {
    return (
      <div className="logwall-item logwall-item--divider" data-day={day || undefined} style={{ '--tilt': `${c.tilt}deg` } as React.CSSProperties}>
        <span className="logwall-divider" role="separator">{dividerGlyph(p.variant)}</span>
        {own && (
          <span className="logwall-ctl" style={{ display: 'inline-flex', marginLeft: 10 }}>
            <button type="button" className="is-bad" aria-label={t('card.remove_divider')} onClick={() => actions.onDelete(p)}>✕</button>
          </span>
        )}
      </div>
    );
  }

  const isNote = p.kind === 'note';
  const photo = p.kind === 'image' ? (p.image_url || '') : p.kind === 'link' ? (p.thumb_url || '') : '';
  const html = p.html || p.note_html || '';
  const label = KIND_LABEL[p.kind]();

  return (
    <article className={`logwall-item${trayOpen || noteOpen ? ' is-raised' : ''}`} data-day={day || undefined}
      id={`post-${p.author.handle}-${p.id}`} aria-label={t('card.aria', { kind: label, name: own ? t('board.you') : p.author.name })}
      style={itemStyle(c, first, trayOpen || noteOpen)}>
      <div className={`logwall-card${isNote ? ' logwall-card--note' : p.kind === 'link' ? ' logwall-card--link' : ''}`} style={cardStyle(c, isNote)}>
        <span className="logwall-tape" aria-hidden="true" style={{ '--tape-col': c.tape, '--tape-rot': `${c.tapeRot}deg` } as React.CSSProperties} />
        <a className="logwall-nametag" href={p.author.url} target="_blank" rel={remote ? 'nofollow noopener ugc' : 'noopener'}>
          {nameTag}{remote && <small> · {p.author.host}</small>}
        </a>
        {p.pinned && <span className="logwall-pin" role="img" aria-label={t('card.pinned')}>📌</span>}
        {ownVerbs}
        {p.cw && (
          <button type="button" className="logwall-cw" aria-expanded={!shut} onClick={() => setShut((s) => !s)}>
            <b>{t('card.cw')}</b> {p.cw} · {shut ? t('card.cw_show') : t('card.cw_hide')}
          </button>
        )}
        {!shut && (
          <>
            {photo && (p.href && p.kind === 'image'
              ? <a href={p.href} target="_blank" rel="nofollow noopener ugc"><img className="logwall-photo" src={photo} alt={p.alt || ''} width={p.width} height={p.height} loading="lazy" /></a>
              : <img className="logwall-photo" src={photo} alt={p.alt || p.label || ''} width={p.width} height={p.height} loading="lazy" />)}
            {p.kind === 'link' && (
              <div className="logwall-chin">
                {p.href
                  ? <a href={p.href} target="_blank" rel="nofollow noopener ugc" style={{ overflowWrap: 'anywhere' }}>→ {p.label || p.href}</a>
                  : <strong>{p.label}</strong>}
                {p.sub && <span className="logwall-sub">{p.sub}</span>}
              </div>
            )}
            {p.kind === 'embed' && p.src && (
              <div className={`logwall-embed${p.media_kind === 'audio' ? ' logwall-embed--audio' : ''}`}>
                {playing
                  ? <iframe src={p.src} title={t('card.embed_title', { provider: p.provider || '' })} loading="lazy"
                      allow="encrypted-media; fullscreen; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin"
                      sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" />
                  : <button type="button" className="logwall-cw" style={{ position: 'absolute', inset: 0, margin: 0, textAlign: 'center' }}
                      onClick={() => setPlaying(true)}>▶ {t('card.play', { provider: p.provider || '' })}</button>}
              </div>
            )}
            {html && <div className="logwall-notein" dangerouslySetInnerHTML={{ __html: html }} />}
            {!html && p.tree && <RemoteText tree={p.tree} className="logwall-notein" />}
            {remote && (p.media || []).slice(1).map((m) => (
              <img key={m.url} className="logwall-photo" src={m.url} alt={m.alt} width={m.width} height={m.height} loading="lazy" />
            ))}
            {remote && (p.links || []).map((l) => (
              <div key={l.url} className="logwall-chin">
                <a href={l.url} target="_blank" rel="nofollow noopener ugc" style={{ overflowWrap: 'anywhere' }}>→ {l.alt || t('card.attachment', { kind: l.kind })}</a>
              </div>
            ))}
            {remote && p.cut && <a className="logwall-quiet" href={p.url} target="_blank" rel="nofollow noopener ugc">{t('card.more_at_source')}</a>}
            {p.kaomoji && <div className="logwall-scrawl">{p.kaomoji}</div>}
          </>
        )}
        {age && <div className="logwall-age">· {age} ·</div>}
        {p.archived_from_name && <div className="logwall-age">{t('card.archived_from', { name: p.archived_from_name })}</div>}
        {!archive && (
          <div className="logwall-ctl">
            <button type="button" onClick={() => actions.onCopyLink(p)}>{t('card.copy_link')}</button>
            {!own && <button type="button" onClick={(e) => actions.onReport(p, e.currentTarget)}>{t('card.report')}</button>}
          </div>
        )}
        {(p.comments.length > 0 || commentable) && (
          <div className="logwall-notes">
            {p.comments.map((cm) => {
              const mineC = cm.author.handle === ctx.viewer;
              return (
                <div key={cm.id} className="logwall-comment">
                  <a href={cm.author.url} target="_blank" rel="noopener">{mineC ? t('board.you') : cm.author.name}</a>{' '}
                  <span>{cm.body}</span>
                  {cm.truncated && cm.source_url && <>{' '}<a className="logwall-quiet" href={cm.source_url} target="_blank" rel="nofollow noopener ugc">{t('card.more_at_source')}</a></>}
                  {(mineC || own) && (
                    <button type="button" className="logwall-quiet" aria-label={mineC ? t('card.take_back_note') : t('card.remove_note', { name: cm.author.name })}
                      onClick={() => actions.onRemoveComment(p, cm, mineC)}>✕</button>
                  )}
                </div>
              );
            })}
            {commentable && !noteOpen && (
              <button type="button" className="logwall-quiet" onClick={() => setNoteOpen(true)}>{t('card.leave_note')}</button>
            )}
            {noteOpen && (
              <div style={{ display: 'flex', gap: 5, marginTop: 4 }}>
                <input className="logwall-field" value={noteText} maxLength={280} placeholder={t('card.say_something')}
                  aria-label={t('card.note_label', { name: p.author.name })}
                  autoFocus
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); sendNote(); }
                    if (e.key === 'Escape') { setNoteOpen(false); }
                  }} />
                <button type="button" className="logwall-commit" onClick={sendNote}>{t('card.note_commit')}</button>
              </div>
            )}
          </div>
        )}
        <div className="logwall-stickers">
          {p.stamps.map((s) => {
            const st = ticketStyle(`${(c.rng() * 16 - 8).toFixed(1)}deg`, s.tint);
            const mineS = s.author.handle === ctx.viewer;
            if (mineS) {
              return (
                <button key={s.id} type="button" className="logwall-sticker" style={st} aria-label={t('stamp.take_back_aria', { face: s.kaomoji })}
                  onClick={() => actions.onTakeBackStamp(p, s)}>
                  {s.kaomoji}<span className="logwall-tip" aria-hidden="true">{t('stamp.yours')}</span>
                </button>
              );
            }
            if (own) {
              return (
                <button key={s.id} type="button" className="logwall-sticker" style={st} aria-label={t('stamp.remove_aria', { face: s.kaomoji, name: s.author.name })}
                  onClick={() => actions.onRemoveStamp(p, s)}>
                  {s.kaomoji}<span className="logwall-tip" aria-hidden="true">{s.author.name}</span>
                </button>
              );
            }
            return (
              <a key={s.id} className="logwall-sticker" style={st} href={s.author.url} target="_blank" rel="noopener"
                aria-label={t('stamp.from', { face: s.kaomoji, name: s.author.name })}>
                {s.kaomoji}<span className="logwall-tip" aria-hidden="true">{s.author.name}</span>
              </a>
            );
          })}
          {shelf.tier !== 'none' && (
            <button type="button" className="logwall-stampadd" aria-expanded={trayOpen}
              aria-label={t('stamp.leave')} title={t('stamp.leave')} onClick={() => setTrayOpen((o) => !o)}>＋</button>
          )}
        </div>
      </div>
      {trayOpen && shelf.tier !== 'none' && (
        <StampTray shelf={shelf} mine={myStamp && !myStamp.custom ? myStamp.kaomoji : ''}
          onPick={(f, custom) => { actions.onStamp(p, f, custom); setTrayOpen(false); }} />
      )}
    </article>
  );
}
