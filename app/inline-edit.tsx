/* ── InlineText: click the value, type, Enter (spec 13.1) ─────────────────────
 * The value is the affordance (a
 * ring's name renames in place, any member). Enter or blur commits a changed,
 * non-empty value; Esc puts the old one back. The trigger is a real button
 * with an aria-label naming what it edits, so a keyboard reaches it.
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';

export function InlineText({ value, onCommit, label, display, maxLength }: {
  value: string; onCommit: (next: string) => void; label: string; display?: React.ReactNode; maxLength?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) { done.current = false; inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
  };
  const cancel = () => { done.current = true; setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <button type="button" className="inline-trigger" aria-label={label} title={label} onClick={() => setEditing(true)}>
        {display ?? value}
      </button>
    );
  }
  return (
    <input ref={inputRef} className="form-input" aria-label={label} data-own-escape value={draft} maxLength={maxLength}
      style={{ width: 200, height: 'var(--ctl-sm)', fontSize: 'var(--fs-sm)', padding: '0 8px' }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      }} />
  );
}
