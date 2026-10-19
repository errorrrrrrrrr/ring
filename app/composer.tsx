/* ── The composer: a popover at the desk, a bottom sheet on the phone ─────────
 * Spec 13.1.
 *   - "Posting to ..." first: the audience is chosen HERE (Public or one of my
 *     rings, never the archive, which only the weekly sweep writes) and said
 *     in plain words, Public's line naming the followers' servers it reaches
 *   - the five kinds: note; image (upload with progress, alt text, an optional
 *     link); link (URL, title, an optional image and caption); embed
 *     (YouTube, Vimeo, SoundCloud); divider
 *   - the kaomoji decoration and the content warning (spec 3.2 `cw`)
 *   - EDIT reuses the form: the kind and the audience are fixed (the server
 *     ignores both on a PATCH), everything else can change
 * The server settles every field again (lib/ring.js settlePost): a bad link,
 * an unknown embed or someone else's image is refused there, and the message
 * it answers is the one shown here.
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Popover } from './popover.tsx';
import { t } from './strings.ts';
import { imgUrl, uploadImage, errorText } from './api.ts';
import { KIND_LABEL } from './board.tsx';
import type { Kind, StampStyle, StoredPost, PostMedia, DividerVariant } from './types.ts';
import { type Draft, draftReady, EMPTY_MEDIA } from './drafts.ts';

export interface AudienceOption { id: string; name: string; sub: string }

const KINDS: Kind[] = ['note', 'image', 'link', 'embed', 'divider'];
const DIVIDERS: [DividerVariant, () => string][] = [
  ['line', () => t('compose.divider_line')], ['dots', () => t('compose.divider_dots')],
  ['stars', () => t('compose.divider_stars')], ['wave', () => t('compose.divider_wave')],
];

export function Composer({ open, anchorRef, onClose, audience, options, editing, palette, onSubmit }: {
  open: boolean;
  anchorRef: { readonly current: HTMLElement | null };
  onClose: () => void;
  audience: string;
  options: AudienceOption[];
  editing: StoredPost | null;
  palette: StampStyle[];
  onSubmit: (d: Draft, editing: StoredPost | null) => Promise<boolean>;
}) {
  const fresh = (): Draft => editing
    ? {
        kind: editing.kind, audience: editing.audience, note: editing.note || '', cw: editing.cw || '', kaomoji: editing.kaomoji || '',
        media: { ...EMPTY_MEDIA, ...(editing.media || {}) },
      }
    : { kind: 'note', audience: options.some((o) => o.id === audience) ? audience : 'public', note: '', cw: '', kaomoji: '', media: { ...EMPTY_MEDIA } };
  const [d, setD] = useState<Draft>(fresh);
  const [audOpen, setAudOpen] = useState(false);
  const [kaoStyle, setKaoStyle] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // A fresh form on every open (or a new post to edit); `fresh` reads the props.
  useEffect(() => {
    if (!open) return;
    setD(fresh());
    setAudOpen(false);
    setError('');
    setPct(null);
  }, [open, editing?.id]);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const setMedia = (patch: PostMedia) => setD((x) => ({ ...x, media: { ...x.media, ...patch } }));
  const picked = options.find((o) => o.id === d.audience);
  const editingName = editing ? (options.find((o) => o.id === editing.audience)?.name || t('compose.this_room')) : '';

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setPct(0); setError('');
    try {
      const up = await uploadImage(file, setPct);
      setMedia({ key: up.key });
    } catch (err) { setError(errorText(err)); }
    setBusy(false); setPct(null);
  };

  const submit = async () => {
    if (!draftReady(d) || busy) return;
    setBusy(true); setError('');
    const ok = await onSubmit(d, editing).catch((err) => { setError(errorText(err)); return false; });
    setBusy(false);
    if (ok) onClose();
  };

  const withNote = d.kind === 'note' || d.kind === 'image' || d.kind === 'link';
  const st = palette[Math.min(kaoStyle, palette.length - 1)];

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} placement="bottom-start" sheet minWidth={340}
      surfaceProps={{ role: 'dialog', 'aria-modal': true, 'aria-label': editing ? t('compose.edit_title') : t('compose.title') }}>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {editing ? (
          <div>
            <div className="eyebrow">{t('compose.editing_in')} <b style={{ color: 'var(--black)' }}>{editingName}</b></div>
            <div className="small faint" style={{ marginTop: 3 }}>{t('compose.edit_note')}</div>
          </div>
        ) : (
          <div>
            <button type="button" className="composer-aud" aria-expanded={audOpen} onClick={() => setAudOpen((o) => !o)}>
              <span className="eyebrow">{t('compose.posting_to')} <b style={{ color: 'var(--black)' }}>{picked?.name}</b> {options.length > 1 ? (audOpen ? '▴' : '▾') : ''}</span>
            </button>
            <div className="small faint" style={{ marginTop: 3 }}>{picked?.sub}</div>
            {audOpen && options.length > 1 && (
              <div className="aud-list" role="radiogroup" aria-label={t('compose.audience')} style={{ marginTop: 6 }}>
                {options.map((o) => (
                  <button key={o.id} type="button" role="radio" aria-checked={o.id === d.audience} className="aud-opt"
                    onClick={() => { set({ audience: o.id }); setAudOpen(false); }}>
                    <div style={{ fontSize: 'var(--fs-md)' }}>{o.name}</div>
                    <div className="small faint">{o.sub}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!editing && (
          <div className="row" role="radiogroup" aria-label={t('compose.kind')}>
            {KINDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={d.kind === k}
                className={`btn btn-sm${d.kind === k ? ' btn-primary' : ''}`} onClick={() => set({ kind: k })}>{KIND_LABEL[k]()}</button>
            ))}
          </div>
        )}

        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={upload} hidden />

        {(d.kind === 'image' || d.kind === 'link') && (
          <div className="row">
            {d.media.key && <img className="thumb" src={imgUrl(d.media.key, 'thumb')} alt="" />}
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              {pct !== null ? t('compose.uploading', { pct }) : d.media.key ? t('compose.replace_image') : d.kind === 'image' ? t('compose.upload_image') : t('compose.add_image')}
            </button>
            {d.kind === 'link' && d.media.key && (
              <button type="button" className="btn-link" onClick={() => setMedia({ key: '' })}>{t('compose.remove_image')}</button>
            )}
            {pct !== null && <progress max={100} value={pct} aria-label={t('compose.upload_progress')} />}
          </div>
        )}
        {d.kind === 'image' && (
          <>
            <label className="field"><span>{t('compose.alt')}</span>
              <input className="form-input" value={d.media.alt || ''} maxLength={300} onChange={(e) => setMedia({ alt: e.target.value })} />
            </label>
            <label className="field"><span>{t('compose.image_link')}</span>
              <input className="form-input" type="url" inputMode="url" value={d.media.href || ''} maxLength={500} placeholder="https://"
                onChange={(e) => setMedia({ href: e.target.value })} />
            </label>
          </>
        )}
        {d.kind === 'link' && (
          <>
            <label className="field"><span>{t('compose.link_url')}</span>
              <input className="form-input" type="url" inputMode="url" value={d.media.href || ''} maxLength={500} placeholder="https://"
                onChange={(e) => setMedia({ href: e.target.value })} />
            </label>
            <label className="field"><span>{t('compose.link_title')}</span>
              <input className="form-input" value={d.media.label || ''} maxLength={200} onChange={(e) => setMedia({ label: e.target.value })} />
            </label>
            <label className="field"><span>{t('compose.link_caption')}</span>
              <input className="form-input" value={d.media.sub || ''} maxLength={300} onChange={(e) => setMedia({ sub: e.target.value })} />
            </label>
          </>
        )}
        {d.kind === 'embed' && (
          <label className="field"><span>{t('compose.embed_url')}</span>
            <input className="form-input" type="url" inputMode="url" value={d.media.url || ''} maxLength={500} placeholder="https://"
              onChange={(e) => setMedia({ url: e.target.value })} />
          </label>
        )}
        {d.kind === 'divider' && (
          <label className="field"><span>{t('compose.divider_style')}</span>
            <select className="form-select" value={d.media.variant || 'line'} onChange={(e) => setMedia({ variant: e.target.value })}>
              {DIVIDERS.map(([v, l]) => <option key={v} value={v}>{l()}</option>)}
            </select>
          </label>
        )}
        {withNote && (
          <label className="field"><span>{d.kind === 'note' ? t('compose.note') : t('compose.note_optional')}</span>
            <textarea className="form-textarea" value={d.note} maxLength={6000}
              placeholder={d.kind === 'note' ? t('compose.note_placeholder') : ''}
              style={{ minHeight: d.kind === 'note' ? 100 : 60 }}
              onChange={(e) => set({ note: e.target.value })} />
          </label>
        )}
        {d.kind !== 'divider' && (
          <label className="field"><span>{t('compose.cw')}</span>
            <input className="form-input" value={d.cw} maxLength={100} placeholder={t('compose.cw_placeholder')}
              onChange={(e) => set({ cw: e.target.value })} />
          </label>
        )}
        {withNote && st && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>{t('compose.decorate')}</div>
            <div className="face-tabs" role="tablist" aria-label={t('stamp.styles')}>
              {palette.map((s, i) => (
                <button key={s.style} type="button" role="tab" aria-selected={st === s} className="face-tab eyebrow-sm"
                  onClick={() => setKaoStyle(i)}>{s.label}</button>
              ))}
            </div>
            <div className="face-grid">
              {st.groups.flatMap((g) => g.faces).map((f) => (
                <button key={f} type="button" className="face-btn" aria-pressed={d.kaomoji === f}
                  aria-label={t('compose.decorate_with', { face: f })}
                  onClick={() => set({ kaomoji: d.kaomoji === f ? '' : f })}>{f}</button>
              ))}
            </div>
          </div>
        )}
        {error && <div className="error-line" role="alert">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !draftReady(d)}>{editing ? t('compose.save') : t('compose.post')}</button>
        </div>
      </form>
    </Popover>
  );
}
