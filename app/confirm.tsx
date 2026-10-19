/* ── useConfirm(): THE house destructive dialog (spec 13.1) ───────────────────
 * window.confirm and alert are
 * banned: a native dialog makes "OK" the commit verb on an irreversible act and
 * cannot say WHICH thing it destroys. This one:
 *   - is a dialog (role, aria-modal), named by the question it asks
 *   - puts Cancel first (Off before On), and focuses it: Enter on arrival
 *     never destroys anything
 *   - carries the VERB and the NAME on the commit ("Delete Print Club"), in
 *     var(--bad) when destructive
 *   - owns Escape while open, so a confirm raised inside Settings answers "no"
 *     without taking the panel behind it down too
 * A destructive item chosen from a MENU confirms in the menu (ui.tsx Menu's
 * armed two-step); this dialog is for destructive BUTTONS.
 *
 *   const [ask, confirmUI] = useConfirm();
 *   if (!await ask({ title: t('…'), verb: t('…'), name })) return;
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from './popover.tsx';
import { t } from './strings.ts';

export interface ConfirmRequest {
  title: string;
  verb: string;
  name?: string;
  note?: React.ReactNode;
  danger?: boolean;
}

export type AskConfirm = (req: ConfirmRequest) => Promise<boolean>;

/* The element the person was on when ask() ran: the dialog hangs off it and
 * focus goes back to it. Safari does not focus a clicked <button>, so the last
 * pointer target is tracked as well. */
const INTERACTIVE = 'button,[role="button"],[role="menuitem"],a[href],input,select,textarea,[tabindex]';
let lastPointer: HTMLElement | null = null;
let tracking = false;
function track() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('mousedown', (e) => {
    const el = e.target;
    lastPointer = el instanceof HTMLElement ? el.closest<HTMLElement>(INTERACTIVE) : null;
  }, true);
}
function triggerElement(): HTMLElement | null {
  const a = document.activeElement;
  if (a instanceof HTMLElement && a !== document.body && a.isConnected) return a;
  return lastPointer?.isConnected ? lastPointer : null;
}

/** A long name keeps its head and its tail; the aria-label keeps all of it. */
export function clampName(name: string, max = 26): string {
  const s = String(name).trim();
  return s.length <= max ? s : `${s.slice(0, max - 11)}…${s.slice(-10)}`;
}

export function useConfirm(): [AskConfirm, React.ReactElement | null] {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  useEffect(() => { track(); }, []);
  // An unmount mid-question answers "no": never a promise left pending.
  useEffect(() => () => { const r = resolveRef.current; resolveRef.current = null; r?.(false); }, []);

  const settle = useCallback((v: boolean) => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setReq(null);
    r?.(v);
  }, []);

  const ask = useCallback<AskConfirm>((r) => {
    const prev = resolveRef.current;
    resolveRef.current = null;
    prev?.(false);
    anchorRef.current = triggerElement();
    setReq(r);
    return new Promise<boolean>((res) => { resolveRef.current = res; });
  }, []);

  return [ask, req ? <ConfirmDialog req={req} anchorRef={anchorRef} onSettle={settle} /> : null];
}

function ConfirmDialog({ req, anchorRef, onSettle }: {
  req: ConfirmRequest; anchorRef: { readonly current: HTMLElement | null }; onSettle: (v: boolean) => void;
}) {
  const fallbackRef = useRef<HTMLDivElement>(null);
  const danger = req.danger !== false;
  const commitLabel = req.name ? `${req.verb} ${clampName(req.name)}` : req.verb;
  const commitName = req.name ? `${req.verb} ${req.name}` : undefined;
  const anchored = !!anchorRef.current?.isConnected;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onSettle(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onSettle]);

  return (
    <>
      {!anchored && (
        <div ref={fallbackRef} aria-hidden="true"
          style={{ position: 'fixed', top: '32%', left: '50%', width: 0, height: 0, pointerEvents: 'none' }} />
      )}
      <Popover open anchorRef={anchored ? anchorRef : fallbackRef} onClose={() => onSettle(false)}
        placement="bottom-end" minWidth={260} sheet
        surfaceProps={{ role: 'dialog', 'aria-modal': true, 'aria-label': req.title }}>
        <div className="ctl-confirm">
          <div className="ctl-confirm-title">{req.title}</div>
          {req.note != null && <div className="ctl-confirm-note">{req.note}</div>}
          <div className="ctl-confirm-row">
            <button type="button" className="btn btn-sm" onClick={() => onSettle(false)}>{t('common.cancel')}</button>
            <button type="button" className={`btn btn-sm${danger ? ' btn-danger' : ''}`}
              aria-label={commitName} onClick={() => onSettle(true)}>{commitLabel}</button>
          </div>
        </div>
      </Popover>
    </>
  );
}
