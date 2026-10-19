'use strict';
/* ── Derived URLs (spec 2.2, 2.5) ─────────────────────────────────────────────
 * Every object URL is DERIVED from the origin, the member's name and the short
 * id, which never change; none is stored. The shapes are permanent once a server
 * federates (spec 2, "the domain is permanent"), so this file is the one place
 * they are spelled.
 *
 *   actor     <origin>/users/<name>
 *   key id    <origin>/users/<name>#main-key
 *   post      <origin>/users/<name>/posts/<post id>
 *   comment   <origin>/users/<name>/comments/<comment id>
 *   page      <origin>/@<name>            (the actor's `url`; a post's wall anchor is #<id>)
 *   image     /api/images/<key>/web|thumb (same origin, relative)
 *   stamp     <origin>/users/<name>/stamps/<stamp id>      (a Like's id)
 *   activity  <origin>/users/<name>/activities/<id>
 *   ring      <origin>/rings/<ring id>    (the Group; its activities under /activities/<id>)
 *   join      <origin>/rings/join/<code>
 *   collections <actor>/inbox outbox followers following featured; <ring>/inbox members outbox
 *
 * parseLocal(url, origin) is the one reader: it turns a URL of THIS server back
 * into what it names ({ kind, name, id }), or null. lib/ap-inbound.js and the
 * handlers read every actor and object id through it (P2 delivers in-process).
 *
 * The origin is PUBLIC_ORIGIN, or in development the request's own origin.
 *
 * A MAILED link is stricter (mailOriginOf, security-r1-03): PUBLIC_ORIGIN, or the
 * request's origin only for the `log` provider outside production (the admin
 * reads that mail themselves). Anything else is '' and the route answers 503
 * mail_unavailable: a Host header never chooses where a reset token goes.
 * lib/config.js already refuses smtp or resend without PUBLIC_ORIGIN.
 */

function originOf(req, cfg) {
  if (cfg.publicOrigin) return cfg.publicOrigin;
  return `${req.protocol}://${req.get('host')}`;
}

function mailOriginOf(req, cfg) {
  if (cfg.publicOrigin) return cfg.publicOrigin;
  if (cfg.mail?.provider === 'log' && !cfg.production) return `${req.protocol}://${req.get('host')}`;
  return '';
}

function hostOf(origin) {
  try { return new URL(origin).host; } catch { return ''; }
}

const enc = encodeURIComponent;

const actorUrl = (origin, name) => `${origin}/users/${enc(name)}`;
const keyIdOf = (origin, name) => `${actorUrl(origin, name)}#main-key`;
const postUrl = (origin, name, id) => `${actorUrl(origin, name)}/posts/${enc(id)}`;
const commentUrl = (origin, name, id) => `${actorUrl(origin, name)}/comments/${enc(id)}`;
const pageUrl = (origin, name) => `${origin}/@${enc(name)}`;
const wallAnchor = (origin, name, id) => `${pageUrl(origin, name)}#${enc(id)}`;
const imagePath = (key, variant = 'web') => (key ? `/api/images/${enc(key)}/${variant}` : '');
const stampUrl = (origin, name, id) => `${actorUrl(origin, name)}/stamps/${enc(id)}`;
const activityUrl = (origin, name, id) => `${actorUrl(origin, name)}/activities/${enc(id)}`;
const collectionUrl = (origin, name, which) => `${actorUrl(origin, name)}/${which}`;
const groupUrl = (origin, ringId) => `${origin}/rings/${enc(ringId)}`;
const groupActivityUrl = (origin, ringId, id) => `${groupUrl(origin, ringId)}/activities/${enc(id)}`;
const joinUrl = (origin, code) => `${origin}/rings/join/${enc(code)}`;

const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/* A URL of this server, read back: { kind: 'person'|'post'|'comment'|'stamp'|
 * 'activity'|'collection'|'group'|'group_activity'|'join', name?, id?, which? }
 * or null. Exact shapes only: a trailing path, a query or a fragment names nothing
 * (the key id `#main-key` is the one fragment, read as the person). */
function parseLocal(url, origin) {
  if (typeof url !== 'string' || !origin || !url.startsWith(origin + '/')) return null;
  let rest = url.slice(origin.length + 1);
  if (rest.endsWith('#main-key')) rest = rest.slice(0, -'#main-key'.length);
  if (/[?#]/.test(rest)) return null;
  let parts;
  try { parts = rest.split('/').map(decodeURIComponent); } catch { return null; }
  if (parts[0] === 'users' && parts[1]) {
    const name = parts[1];
    if (parts.length === 2) return { kind: 'person', name };
    if (parts.length === 3 && ['inbox', 'outbox', 'followers', 'following', 'featured'].includes(parts[2])) return { kind: 'collection', name, which: parts[2] };
    if (parts.length === 4 && parts[2] === 'posts') return { kind: 'post', name, id: parts[3] };
    if (parts.length === 5 && parts[2] === 'posts' && parts[4] === 'activity') return { kind: 'post_activity', name, id: parts[3] };
    if (parts.length === 4 && parts[2] === 'comments') return { kind: 'comment', name, id: parts[3] };
    if (parts.length === 4 && parts[2] === 'stamps') return { kind: 'stamp', name, id: parts[3] };
    if (parts.length === 4 && parts[2] === 'activities') return { kind: 'activity', name, id: parts[3] };
    return null;
  }
  if (parts[0] === 'rings' && parts[1]) {
    if (parts[1] === 'join' && parts.length === 3) return { kind: 'join', id: parts[2] };
    if (parts.length === 2) return { kind: 'group', id: parts[1] };
    if (parts.length === 4 && parts[2] === 'activities') return { kind: 'group_activity', id: parts[1], activity: parts[3] };
    if (parts.length === 3 && ['inbox', 'members', 'outbox'].includes(parts[2])) return { kind: 'group_collection', id: parts[1], which: parts[2] };
  }
  return null;
}

module.exports = {
  originOf, mailOriginOf, hostOf, actorUrl, keyIdOf, postUrl, commentUrl, pageUrl, wallAnchor, imagePath,
  stampUrl, activityUrl, collectionUrl, groupUrl, groupActivityUrl, joinUrl, parseLocal, AS_PUBLIC,
};
