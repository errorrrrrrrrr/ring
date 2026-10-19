/* ── A post being written (spec 3.2, 13.1) ────────────────────────────────────
 * The composer's draft and the two pure rules about it, apart from React so
 * test/app-pure.test.js can hold them:
 *   draftReady(d)  may this be posted? A note needs words, an image its
 *                  uploaded key, a link a URL or a title, an embed a URL
 *   draftBody(d)   the JSON a create or an edit sends: only the media fields
 *                  this kind carries (lib/ring.js normalizeMedia drops the
 *                  rest anyway); an empty `cw` or `kaomoji` clears it on an edit
 */
import type { Kind, PostMedia } from './types.ts';

export const EMPTY_MEDIA: PostMedia = { key: '', alt: '', href: '', label: '', sub: '', url: '', variant: 'line' };

export interface Draft {
  kind: Kind;
  audience: string;
  note: string;
  cw: string;
  kaomoji: string;
  media: PostMedia;
}

/** The body a create or an edit sends: only the fields this kind carries. */
export function draftBody(d: Draft): Record<string, unknown> {
  const m = d.media;
  const media = d.kind === 'image' ? { key: m.key || '', alt: m.alt || '', href: (m.href || '').trim() }
    : d.kind === 'link' ? { href: (m.href || '').trim(), label: m.label || '', key: m.key || '', sub: m.sub || '' }
    : d.kind === 'embed' ? { url: (m.url || '').trim() }
    : d.kind === 'divider' ? { variant: m.variant || 'line' }
    : undefined;
  return {
    kind: d.kind,
    audience: d.audience,
    note: d.kind === 'divider' || d.kind === 'embed' ? '' : d.note.trim(),
    cw: d.cw.trim(),
    kaomoji: d.kaomoji,
    ...(media ? { media } : {}),
  };
}

export function draftReady(d: Draft): boolean {
  const m = d.media;
  switch (d.kind) {
    case 'note': return d.note.trim() !== '';
    case 'image': return !!m.key;
    case 'link': return !!(m.href || '').trim() || !!(m.label || '').trim();
    case 'embed': return !!(m.url || '').trim();
    default: return true;
  }
}
