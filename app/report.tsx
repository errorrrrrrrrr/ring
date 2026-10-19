/* ── Report: a member tells the server's admin (spec 6.2, 13.1; P8) ───────────
 * One small panel for every Report verb (a card, a From elsewhere row, a
 * looked-up person). It sends POST /api/reports with what names the thing (a
 * post's URL, a person's handle, a row's id) and an optional comment; the
 * server resolves who is reported from its own rows. For someone on another
 * server it offers "also send to <host>": a report from this server itself,
 * never with the member's name. The admin reads it on /admin.
 */
import type React from 'react';
import { useRef, useState } from 'react';
import { Popover } from './popover.tsx';
import { t } from './strings.ts';
import { post, errorText } from './api.ts';
import { Checkbox } from './ui.tsx';

export interface ReportTarget {
  body: Record<string, string>;   // { kind, url } | { kind, handle } | { kind, id } | ...
  label: string;                  // whose thing, for the heading
  host?: string;                  // another server's host: offers "also send"
  anchor: HTMLElement | null;
}

export function ReportPanel({ target, onClose, say }: { target: ReportTarget | null; onClose: () => void; say: (m: string) => void }) {
  const [comment, setComment] = useState('');
  const [forward, setForward] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = target?.anchor || null;
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    try {
      const r = await post<{ forwarded: boolean }>('/api/reports', { ...target.body, comment, forward: !!target.host && forward });
      say(r.forwarded ? t('report.sent_forwarded', { host: target.host || '' }) : t('report.sent'));
      setComment(''); setForward(false);
      onClose();
    } catch (err) { say(errorText(err)); }
    setBusy(false);
  }
  return (
    <Popover open={!!target} anchorRef={anchorRef} onClose={onClose} placement="bottom-end" sheet minWidth={300} trapFocus
      surfaceProps={{ role: 'dialog', 'aria-label': t('report.title') }}>
      <form className="composer" onSubmit={send}>
        <div className="eyebrow">{t('report.title')}</div>
        <p className="small" style={{ margin: 0, overflowWrap: 'anywhere' }}>{t('report.about', { name: target?.label || '' })}</p>
        <label className="field">
          <span>{t('report.comment')}</span>
          <textarea className="form-textarea" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </label>
        {target?.host && (
          <Checkbox checked={forward} onChange={setForward}>{t('report.forward', { host: target.host })}</Checkbox>
        )}
        <p className="muted small" style={{ margin: 0 }}>{target?.host ? t('report.note_remote') : t('report.note')}</p>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>{t('report.send')}</button>
          <button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Popover>
  );
}
