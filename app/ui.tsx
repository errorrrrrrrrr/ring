/* ── The small primitives (spec 13.1) ─────────────────────────────────────────
 * Segmented, Checkbox, Menu, MenuList, Tooltip, Tip and Toast:
 *   Segmented  one button per choice, aria-pressed, the active one fills blue;
 *              the group carries the name of the choice
 *   Checkbox   a native checkbox in a label
 *   Menu       a ⋮ trigger and an ARIA menu on <Popover>: arrows, Home/End,
 *              Enter/Space, Esc. An item with `confirm` arms first: the row
 *              turns into its own named question ("Delete Print Club?") and a
 *              second press commits (the menu half of the house grammar; a
 *              destructive BUTTON asks useConfirm instead)
 *   Tip        what a label means, on hover, focus or tap; never a caption
 *   Toast      the one polite notice line
 * A friend row carries a Menu; there is no context menu.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover, type Placement } from './popover.tsx';
import { t } from './strings.ts';

// ── Segmented ──
export function Segmented<V extends string>({ options, value, onChange, label }: {
  options: [V, string][]; value: V; onChange: (v: V) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="seg">
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

/** Off before On, the house order. */
export function OnOff({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <Segmented label={label} value={on ? 'on' : 'off'} onChange={(v) => onChange(v === 'on')}
    options={[['off', t('common.off')], ['on', t('common.on')]]} />;
}

// ── Checkbox ──
export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="ctl-check">
      <input type="checkbox" className="ctl-check-input" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// ── Menu ──
export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  confirm?: boolean;
  confirmLabel?: string;
  confirmNote?: string;
}

function MenuList({ items, onClose, label }: { items: MenuItem[]; onClose: () => void; label: string }) {
  const firstEnabled = () => items.findIndex((it) => !it.disabled);
  const [active, setActive] = useState(firstEnabled);
  const [armed, setArmed] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const invoke = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    if (it.confirm && armed !== i) { setArmed(i); return; }
    onClose();
    it.onClick();
  };
  const move = (dir: number) => setActive((a) => {
    let n = a;
    for (let k = 0; k < items.length; k++) {
      n = (n + dir + items.length) % items.length;
      if (!items[n].disabled) return n;
    }
    return a;
  });
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(firstEnabled()); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); invoke(active); }
  };
  return (
    <div ref={listRef} role="menu" tabIndex={0} aria-label={label} onKeyDown={onKeyDown}
      aria-activedescendant={active >= 0 ? `${label}-item-${active}`.replace(/\s+/g, '-') : undefined}
      style={{ outline: 'none', minWidth: 180 }}>
      {items.map((it, i) => (
        <div key={it.label} id={`${label}-item-${i}`.replace(/\s+/g, '-')} role="menuitem"
          aria-disabled={it.disabled || undefined}
          className={`ctl-item${i === active ? ' is-active' : ''}`}
          style={it.danger || armed === i ? { color: 'var(--bad)' } : undefined}
          onMouseEnter={() => !it.disabled && setActive(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); invoke(i); }}>
          {armed === i
            ? <span className="ctl-item-confirm">
                <span>{it.confirmLabel || t('menu.confirm_item', { label: it.label })}</span>
                {it.confirmNote && <span className="ctl-item-note">{it.confirmNote}</span>}
              </span>
            : <span>{it.label}</span>}
        </div>
      ))}
    </div>
  );
}

export function Menu({ items, label, trigger = '⋮', className = 'btn btn-sm' }: {
  items: (MenuItem | null | false)[]; label: string; trigger?: React.ReactNode; className?: string;
}) {
  const list = items.filter((it): it is MenuItem => Boolean(it));
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (!list.length) return null;
  return (
    <>
      <button ref={btnRef} type="button" className={className} aria-haspopup="menu" aria-expanded={open}
        aria-label={label} title={label}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}>
        {trigger}
      </button>
      <Popover open={open} anchorRef={btnRef} onClose={close} placement="bottom-end" minWidth={180} sheet>
        <MenuList items={list} onClose={close} label={label} />
      </Popover>
    </>
  );
}

// ── Tooltip and Tip ──
let tipSeq = 0;

export function Tip({ text, children, placement = 'top-start' }: { text: string; children: React.ReactNode; placement?: Placement }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [id] = useState(() => `tip-${++tipSeq}`);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!text) return <>{children}</>;
  const show = (d: number) => { clearTimeout(timer.current); if (d) timer.current = setTimeout(() => setOpen(true), d); else setOpen(true); };
  const hide = () => { clearTimeout(timer.current); setOpen(false); };
  return (
    <>
      <span ref={ref} className="tip" role="button" tabIndex={0} aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => show(400)} onMouseLeave={hide} onFocus={() => show(0)} onBlur={hide}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}>
        {children}
      </span>
      <Popover open={open} anchorRef={ref} onClose={hide} placement={placement} trapFocus={false}
        className="ctl-tooltip" surfaceProps={{ role: 'tooltip', id }}>
        {text}
      </Popover>
    </>
  );
}

// ── Toast ──
export function Toast({ text }: { text: string }) {
  return <div className="toast" role="status" aria-live="polite">{text}</div>;
}

/** A notice that clears itself. */
export function useToast(): [string, (msg: string) => void] {
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((msg: string) => {
    clearTimeout(timer.current);
    setText(msg);
    timer.current = setTimeout(() => setText(''), 4000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [text, say];
}

