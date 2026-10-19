/* ── t(): every word the composer shows (spec 13.1, 14) ───────────────────────
 * One call: t(key) or
 * t(key, { name }). The catalog is app/strings.en.ts; the key is TYPED, so a
 * key that does not exist fails the typecheck, and test/copy.test.js holds the
 * same rule for npm test (and no em dash in any value). No owner overrides:
 * Ring has no UI-text editor. Server errors bring their own `message`
 * (lib/strings.js); the client shows that, never a second copy of it.
 */
import { EN } from './strings.en.ts';

export type StringKey = keyof typeof EN;

export function t(key: StringKey, vars?: Record<string, string | number>): string {
  let s: string = EN[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
  return s;
}
