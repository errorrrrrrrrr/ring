/* ── Dates on the board (spec 13.1) ───────────────────────────────────────────
 * English, and only what Ring shows:
 *   fmtAge(iso)   how old, coarse on purpose: `today`, `Nd` under three
 *                 weeks, then `Nw` (the wall's narrow age)
 *   fmtDay(iso)   a calendar day, `15 Oct 2026`, in the viewer's zone
 *   fmtMB(bytes)  storage, one decimal
 * Never toLocaleDateString at a render site: one door, so the board and the
 * panels agree. Pure; `now` is a parameter for the tests.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000;

const stamp = (iso: unknown): number => (typeof iso === 'string' && iso ? Date.parse(iso) : Number.NaN);

export function fmtAge(iso: unknown, now: number = Date.now()): string {
  const t = stamp(iso);
  if (!Number.isFinite(t)) return '';
  const ms = now - t;
  if (!(ms >= 0)) return 'today';   // a clock a little ahead is still today
  const days = Math.floor(ms / DAY);
  if (days < 1) return 'today';
  if (days < 21) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export function fmtDay(iso: unknown): string {
  const t = stamp(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtMB(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 MB';
  return `${(n / 1_048_576).toFixed(1)} MB`;
}
