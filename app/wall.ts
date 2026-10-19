/* ── The wall's pure rules (spec 13.1) ────────────────────────────────────────
 * Everything the board decides that needs no DOM, no React and no fetch, so
 * node --test can hold it (test/app-pure.test.js):
 *   - THE CHAOS (wallHash, wallRng, wallChaos): byte for byte the same
 *     functions as public/assets/page.js. Seeded from the post's OBJECT
 *     URL, never Math.random, so a card leans the same way on every Ring server
 *     and on the member's wall (P4 ports the same three functions).
 *   - the day a post belongs to, a ring's initials, the divider glyphs
 *   - STAMP TIERS (stampShelf): which faces this viewer may press on this post
 *     (spec 3.7): nobody stamps their own post or the shelf; a ring-mate on a
 *     room post gets the full palette and a custom face; a confirmed friend the
 *     full palette; any other member the nice shelf. The server enforces the
 *     same rule; this only decides what the tray offers.
 *   - FEED MERGE: appending a page of the square keeps one card per post
 *   - reaction updates, unread rooms, the theme's font stack
 * The palette is a parameter (lib/palette.js is a UMD the bundle imports), so
 * this module imports nothing at run time.
 */
import type { PostView, StampStyle, StampView, CommentView, Theme } from './types.ts';

export function wallHash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function wallRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Riso tape and sticky-note stock: register material, not chrome. */
export const WALL_TAPE = ['rgba(150,205,195,.7)', 'rgba(245,196,182,.72)', 'rgba(196,181,253,.68)', 'rgba(253,224,138,.72)', 'rgba(147,197,253,.66)', 'rgba(244,171,196,.68)'];
export const WALL_STICKY = ['#fdf0a8', '#ffd6e0', '#c9f2d4', '#cfe4ff', '#ffe6c7', '#e7dcff'];

export interface WallChaos {
  tilt: string; risoX: string; risoY: string; tape: string; tapeRot: string;
  sticky: string; w: number; xf: string; mt: number; z: number; rng: () => number;
}

export function wallChaos(seed: string): WallChaos {
  const r = wallRng(wallHash(seed));
  return {
    tilt: (r() * 7 - 3.5).toFixed(2),
    risoX: (3 + r() * 3).toFixed(1),
    risoY: (4 + r() * 3).toFixed(1),
    tape: WALL_TAPE[Math.floor(r() * WALL_TAPE.length)],
    tapeRot: (r() * 10 - 5).toFixed(1),
    sticky: WALL_STICKY[Math.floor(r() * WALL_STICKY.length)],
    w: Math.round(46 + r() * 32),
    xf: r().toFixed(3),
    mt: Math.round(r() * 40 - 8),
    z: 1 + Math.floor(r() * 9),
    rng: r,
  };
}

/** The seed of a card: its object URL (the same on every server), else author and id. */
export const chaosSeed = (p: Pick<PostView, 'url' | 'id' | 'author'>): string => p.url || `${p.author.handle}:${p.id}`;

/** The viewer's LOCAL calendar day of an ISO instant, `YYYY-MM-DD`, or ''. */
export function wallDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A ring's face on the rail: the first letters of its first two words. */
export function initials(name: string): string {
  return (String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] || '').join('') || '·').toUpperCase();
}

export const DIVIDER_GLYPHS: Record<string, string> = {
  line: '───────', dots: '· · · · ·', stars: '✦ ✦ ✦', wave: '∿∿∿∿∿∿',
};
export const dividerGlyph = (variant?: string): string => DIVIDER_GLYPHS[variant || 'line'] || DIVIDER_GLYPHS.line;

/** Is this audience a room (a ring id)? */
export const isRoom = (audience: string | undefined): boolean => typeof audience === 'string' && audience.startsWith('ring_');

// ── Stamp tiers (spec 3.7) ────────────────────────────────────────────────────

export interface ShelfContext {
  viewer: string;          // my handle
  friends: ReadonlySet<string>;
  archive?: boolean;       // the shelf takes no reactions
}

export interface Shelf {
  /** 'none': no tray at all; 'nice': the open shelf; 'full': every face. */
  tier: 'none' | 'nice' | 'full';
  /** The styles the tray shows, each with only the groups this tier may press. */
  styles: StampStyle[];
  /** A ring-mate on a room post may type a face of their own. */
  custom: boolean;
}

export function stampTier(p: Pick<PostView, 'author' | 'audience' | 'stamps_off'>, ctx: ShelfContext): Shelf['tier'] {
  if (ctx.archive || p.audience === 'archive' || p.stamps_off) return 'none';
  if (p.author.handle === ctx.viewer) return 'none';
  if (isRoom(p.audience)) return 'full';
  return ctx.friends.has(p.author.handle) ? 'full' : 'nice';
}

export function stampShelf(palette: StampStyle[], p: Pick<PostView, 'author' | 'audience' | 'stamps_off'>, ctx: ShelfContext): Shelf {
  const tier = stampTier(p, ctx);
  if (tier === 'none') return { tier, styles: [], custom: false };
  const styles = palette
    .map((s) => ({ ...s, groups: s.groups.filter((g) => tier === 'full' || g.nice) }))
    .filter((s) => s.groups.length > 0);
  return { tier, styles, custom: isRoom(p.audience) };
}

/** May this viewer leave a comment here? Confirmed friends only (spec 3.7). */
export function canComment(p: Pick<PostView, 'author' | 'audience' | 'comments_off'>, ctx: ShelfContext): boolean {
  if (ctx.archive || p.audience === 'archive' || p.comments_off) return false;
  if (p.author.handle === ctx.viewer) return false;
  return ctx.friends.has(p.author.handle);
}

/** The custom face as the server will keep it: one line, 20 characters. */
export function customFace(raw: string): string {
  return Array.from(String(raw || '').replace(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 20).join('');
}

// ── Feeds ─────────────────────────────────────────────────────────────────────

export const cardKey = (p: Pick<PostView, 'author' | 'id'>): string => `${p.author.handle}:${p.id}`;

/** Append a page of the square under what is on screen: one card per post,
 *  whatever a page boundary repeats; the order the server gave is kept. */
export function mergeFeed(current: readonly PostView[], page: readonly PostView[]): PostView[] {
  const seen = new Set(current.map(cardKey));
  const out = current.slice();
  for (const p of page) {
    const k = cardKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** The same posts with one card's stamps, comments or fields replaced. */
export function patchCard(posts: readonly PostView[], key: string, patch: Partial<PostView>): PostView[] {
  return posts.map((p) => (cardKey(p) === key ? { ...p, ...patch } : p));
}

export const withoutStamp = (stamps: readonly StampView[], id: string): StampView[] => stamps.filter((s) => s.id !== id);
export const withoutComment = (comments: readonly CommentView[], id: string): CommentView[] => comments.filter((c) => c.id !== id);

/** Rooms with a post newer than this browser last looked: a dot, never a count. */
export function unreadRooms(newest: Readonly<Record<string, string>>, lastSeen: Readonly<Record<string, string>>): Set<string> {
  const out = new Set<string>();
  for (const [id, at] of Object.entries(newest)) if (at && at > (lastSeen[id] || '')) out.add(id);
  return out;
}

/** How many requests wait on an answer (the one count the rail shows). */
export const waitingCount = (inbox: { join_requests: unknown[]; follow_requests: unknown[] } | null): number =>
  inbox ? inbox.join_requests.length + inbox.follow_requests.length : 0;

// ── The theme on the Public board (spec 3.3: enums, hex only) ─────────────────

export const FONT_STACKS: Record<string, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '"Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, Menlo, Consolas, monospace',
  cursive: '"Comic Sans MS", "Comic Neue", cursive',
  fantasy: 'Impact, fantasy',
  system: 'system-ui, sans-serif',
};

export const safeHex = (c: string): string => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '').trim()) ? String(c).trim() : '');

/** The board's style for a theme: a flat hex replaces the paper dots; an
 *  uploaded background tiles over it; the font and cursor ride along. */
export function themeStyle(theme: Theme | null, imageUrl: (key: string) => string): Record<string, string> {
  const s: Record<string, string> = {};
  if (!theme) return s;
  const bg = safeHex(theme.bg);
  if (bg) { s.backgroundColor = bg; s.backgroundImage = 'none'; }
  if (theme.bg_image_key) { s.backgroundImage = `url("${imageUrl(theme.bg_image_key)}")`; s.backgroundRepeat = 'repeat'; s.backgroundSize = 'auto'; }
  if (Object.hasOwn(FONT_STACKS, theme.font) && FONT_STACKS[theme.font]) s.fontFamily = FONT_STACKS[theme.font];
  if (/^[a-z]+$/.test(theme.cursor || '')) s.cursor = theme.cursor;
  return s;
}

/** A same-origin path to come back to after signing in, or ''. */
export function safeNext(next: string | null | undefined): string {
  const s = String(next || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\u0000-\u001f]/.test(s)) return '';
  return s;
}
