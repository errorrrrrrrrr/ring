/* ── Another server's text, as React elements (spec 5.8) ──────────────────────
 * The server never hands the app remote HTML: it hands the node tree
 * lib/remote-html.js built (`string` text, or `{ t, c, href? }`). This renders
 * that tree with React elements ONLY: the same small allowlist, every string a
 * text child (React escapes it), `href` the one attribute and only on `a` when
 * it is http(s). Nothing reaches dangerouslySetInnerHTML, so even a tree that
 * somehow carried more could not inject markup: an unknown tag renders its
 * children as text, an unknown attribute is never read.
 */
import type React from 'react';
import type { RemoteNode } from './types.ts';

const TAGS = new Set(['p', 'br', 'a', 'strong', 'em', 'b', 'i', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li']);
const safeHref = (h: unknown): string => (typeof h === 'string' && /^https?:\/\//i.test(h) && h.length <= 2000 ? h : '');

function render(nodes: readonly RemoteNode[] | undefined, depth: number): React.ReactNode[] {
  if (!Array.isArray(nodes) || depth > 24) return [];
  return nodes.map((n, i) => {
    if (typeof n === 'string') return n;
    if (!n || typeof n !== 'object') return null;
    const kids = render(n.c, depth + 1);
    if (!TAGS.has(n.t)) return <span key={i}>{kids}</span>;
    if (n.t === 'br') return <br key={i} />;
    if (n.t === 'a') {
      const href = safeHref(n.href);
      return href ? <a key={i} href={href} target="_blank" rel="nofollow noopener ugc">{kids}</a> : <span key={i}>{kids}</span>;
    }
    const Tag = n.t as 'p';
    return <Tag key={i}>{kids}</Tag>;
  });
}

export function RemoteText({ tree, className }: { tree: readonly RemoteNode[]; className?: string }) {
  return <div className={className}>{render(tree, 0)}</div>;
}

/** The tree as one line of plain text (an Inbox preview). */
export function remotePlain(tree: readonly RemoteNode[] | undefined, max = 160): string {
  const parts: string[] = [];
  const walk = (ns: readonly RemoteNode[] | undefined) => {
    for (const n of ns || []) {
      if (typeof n === 'string') parts.push(n);
      else if (n && typeof n === 'object') { if (n.t === 'br' || n.t === 'p' || n.t === 'li') parts.push(' '); walk(n.c); }
    }
  };
  walk(tree);
  const s = parts.join('').replace(/\s+/g, ' ').trim();
  return Array.from(s).length > max ? `${Array.from(s).slice(0, max).join('')}…` : s;
}
