/* ── Popover: the one floating surface (spec 13.1) ────────────────────────────
 * What Ring uses: anchored
 * placement that flips on collision, click-away, Esc, focus moved in and
 * returned to the trigger, Tab trapped inside, and the PHONE BOTTOM SHEET
 * (`sheet`: at 650 px and under, a full-width sheet with a backdrop, swipe-down
 * to dismiss, dialog semantics, lifted above the on-screen keyboard). Menus,
 * the tooltip, the confirm dialog, the composer, Settings and the Inbox all
 * build on it. A sheet nests at most one rung deep.
 * The skin is `.ctl-surface` (ring.css): hairline, flat, sharp, no shadow.
 */
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* `right-*` hangs a surface beside a rail chip: its top edge (start) or its
 * bottom edge (end) lines up with the chip, on the chip's right. */
export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'right-end';
type ReadRef = { readonly current: HTMLElement | null };

export const NARROW_MAX = 650;
export const isNarrowViewport = (): boolean => typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth <= NARROW_MAX;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/* Portals flatten the DOM: a menu opened inside another surface renders beside
 * it under <body>. Each surface records its anchor, so the outer surface's
 * click-away can recognise a click inside a nested child. */
const SURFACE_ANCHORS = new WeakMap<HTMLElement, HTMLElement>();
let sheetDepthNow = 0;

function insideNested(target: Node, outer: HTMLElement): boolean {
  const start = target instanceof HTMLElement ? target : target.parentElement;
  let surface = start?.closest('.ctl-surface');
  const seen = new Set<Element>();
  while (surface instanceof HTMLElement && surface !== outer && !seen.has(surface)) {
    seen.add(surface);
    const anchor = SURFACE_ANCHORS.get(surface);
    if (!anchor) return false;
    if (outer.contains(anchor)) return true;
    surface = anchor.closest('.ctl-surface');
  }
  return surface === outer;
}

const SWIPE_DISMISS_PX = 80;

interface PopoverProps {
  open: boolean;
  anchorRef: ReadRef;
  onClose?: () => void;
  placement?: Placement;
  minWidth?: number;
  trapFocus?: boolean;
  surfaceProps?: React.HTMLAttributes<HTMLDivElement> & { [k: `aria-${string}`]: unknown };
  className?: string;
  sheet?: boolean;
  children?: React.ReactNode;
}

export function Popover({
  open, anchorRef, onClose, placement = 'bottom-start', minWidth, trapFocus = true,
  surfaceProps = {}, className = '', sheet = false, children,
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [asSheet, setAsSheet] = useState(false);
  const [depth, setDepth] = useState(0);
  const [kbOffset, setKbOffset] = useState(0);
  const drag = useRef({ y0: 0, dy: 0, active: false });

  useLayoutEffect(() => { if (open) setAsSheet(sheet && isNarrowViewport()); }, [open, sheet]);
  useLayoutEffect(() => {
    if (!open || !asSheet) return;
    setDepth(sheetDepthNow++);
    return () => { sheetDepthNow = Math.max(0, sheetDepthNow - 1); };
  }, [open, asSheet]);

  const compute = useCallback(() => {
    const anchor = anchorRef.current;
    const surface = surfaceRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const sh = surface ? surface.offsetHeight : 0;
    const sw = surface ? surface.offsetWidth : 0;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    if (placement.startsWith('right') && vw > NARROW_MAX) {
      let top = placement === 'right-end' ? r.bottom - sh : r.top;
      top = Math.max(8, Math.min(top, vh - 8 - sh));
      const left = Math.max(8, Math.min(r.right + 6, vw - (sw || 0) - 8));
      setPos({ top, left });
      return;
    }
    const wantAbove = placement.startsWith('top');
    const below = vh - r.bottom;
    const above = r.top;
    let up = wantAbove;
    if (!wantAbove && sh && below < sh + 8 && above > below) up = true;
    if (wantAbove && sh && above < sh + 8 && below > above) up = false;
    let top = up ? r.top - sh : r.bottom;
    let left = placement.endsWith('end') ? r.right - (sw || r.width) : r.left;
    left = Math.max(8, Math.min(left, vw - (sw || 0) - 8));
    top = Math.max(8, Math.min(top, Math.max(8, vh - 8 - sh)));
    setPos({ top, left });
  }, [anchorRef, placement]);

  useLayoutEffect(() => {
    if (!open || asSheet) { setPos(null); return; }
    compute();
  }, [open, asSheet, compute]);

  useLayoutEffect(() => {
    if (!open) return;
    const surface = surfaceRef.current;
    const anchor = anchorRef.current;
    if (!surface || !anchor) return;
    SURFACE_ANCHORS.set(surface, anchor);
    return () => { SURFACE_ANCHORS.delete(surface); };
  }, [open, anchorRef]);

  // Focus in on open, back to the trigger on close.
  // a toggle keyed on `open` alone
  useEffect(() => {
    if (!open) return;
    returnTo.current = anchorRef.current || document.activeElement;
    if (trapFocus) {
      const s = surfaceRef.current;
      if (s) {
        const f = Array.from(s.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) => !el.classList.contains('tip') && !el.hasAttribute('data-no-autofocus'));
        (f || s).focus({ preventScroll: true });
      }
    }
    return () => {
      if (!trapFocus) return;
      const back = returnTo.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  // Click-away and Esc, in the capture phase.
  // refs are stable
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const s = surfaceRef.current;
      const a = anchorRef.current;
      const tgt = e.target;
      if (!(tgt instanceof Node)) return;
      if (s && (s.contains(tgt) || insideNested(tgt, s))) return;
      if (a?.contains(tgt)) return;
      onClose?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // A field that answers Esc itself (the inline editor) keeps it.
      if (e.target instanceof HTMLElement && e.target.closest('[data-own-escape]')) return;
      e.stopPropagation();
      onClose?.();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  // A surface whose content grows or shrinks (a list that loaded, a section
  // switched) is placed again, so it never runs past the edge.
  useEffect(() => {
    const s = surfaceRef.current;
    if (!open || asSheet || !s || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => compute());
    ro.observe(s);
    return () => ro.disconnect();
  }, [open, asSheet, compute]);

  // Track the anchor as the page scrolls or resizes.
  useEffect(() => {
    if (!open || asSheet) return;
    let raf = 0;
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(compute); };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, asSheet, compute]);

  // A sheet follows the on-screen keyboard.
  useEffect(() => {
    if (!open || !asSheet) { setKbOffset(0); return; }
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setKbOffset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, [open, asSheet]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!trapFocus || e.key !== 'Tab') return;
    const s = surfaceRef.current;
    const items = s ? Array.from(s.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const s = surfaceRef.current;
    if (!asSheet || !s || s.scrollTop > 0) return;
    drag.current = { y0: e.touches[0].clientY, dy: 0, active: true };
  };
  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const s = surfaceRef.current;
    if (!asSheet || !drag.current.active || !s) return;
    const dy = e.touches[0].clientY - drag.current.y0;
    if (dy <= 0 || s.scrollTop > 0) { drag.current.dy = 0; s.style.transform = ''; return; }
    drag.current.dy = dy;
    s.style.transform = `translateY(${dy}px)`;
  };
  const onTouchEnd = () => {
    if (!asSheet || !drag.current.active) return;
    const s = surfaceRef.current;
    drag.current.active = false;
    if (s) s.style.transform = '';
    if (drag.current.dy > SWIPE_DISMISS_PX) onClose?.();
  };

  const style: React.CSSProperties = asSheet
    ? {
        position: 'fixed', left: 0, right: 0, bottom: kbOffset, top: 'auto',
        maxHeight: kbOffset ? `min(85vh, calc(100vh - ${kbOffset}px - 24px))` : '85vh',
        overflowY: 'auto', zIndex: 1000 + depth * 2,
      }
    : { position: 'fixed', top: pos ? pos.top : -9999, left: pos ? pos.left : -9999, minWidth, zIndex: 1000 };

  return createPortal(
    <>
      {asSheet && <div className="ctl-sheet-backdrop" aria-hidden="true" style={{ zIndex: 999 + depth * 2 }} />}
      <div
        ref={surfaceRef}
        className={`ctl-surface ${asSheet ? 'ctl-sheet ' : ''}${className}`.trim()}
        onKeyDown={onKeyDown}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        tabIndex={-1}
        style={style}
        {...(asSheet ? { role: 'dialog', 'aria-modal': true } : {})}
        {...surfaceProps}
      >
        {asSheet && <div className="ctl-sheet-handle" aria-hidden="true" />}
        {children}
      </div>
    </>,
    document.body,
  );
}
