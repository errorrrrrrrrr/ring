'use strict';
/* ── The activity builders (spec 4) ───────────────────────────────────────────
 * THE one place a Ring act becomes ActivityStreams. P2 delivers every one of
 * these in-process (lib/outbox.js emit); P5 to P7 sign and POST the same objects,
 * so a shape changes here or nowhere. test/activity-shapes.test.js pins each one.
 *
 * Pure: every builder takes the origin (PUBLIC_ORIGIN, or the request's own in
 * development), names, ids and rows, and returns plain JSON. Ids come from
 * lib/ids.js (CSPRNG) and URLs from lib/urls.js (derived, never stored).
 *
 * Rules carried from the spec:
 *   - every top-level document carries CONTEXT (4.1); embedded objects do not
 *   - everything Ring-only lives in ONE property, `ring`, with `v: 1`
 *   - a public Note: to as:Public, cc followers; a room Note: to [Group],
 *     audience Group, no Public and no followers, ring.room and ring.expires (4.5)
 *   - `content` is built by this server's own escaping renderer (lib/ring.js);
 *     a Ring reader renders from `source` and `ring`, never another server's HTML
 *   - a divider and an archive post never become an activity (noteOf answers null
 *     for a divider; callers never pass an archive post)
 *   - collections and counts: none here; no builder emits a count (10.1)
 */
const { renderRingMarkdown, renderInline, ringSafeHref, ringResolveEmbed, escapeHtml } = require('./ring');
const { STAMP_STYLES } = require('./palette');
const { newActivityId } = require('./ids');
const { RING_POST_TTL_MS } = require('./ring-reset');
const urls = require('./urls');

const RING_NS = 'https://github.com/errorrrrrrrrr/ring/ns#';
const AS_PUBLIC = urls.AS_PUBLIC;

const CONTEXT = Object.freeze([
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  {
    toot: 'http://joinmastodon.org/ns#',
    featured: { '@id': 'toot:featured', '@type': '@id' },
    discoverable: 'toot:discoverable',
    indexable: 'toot:indexable',
    manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
    sensitive: 'as:sensitive',
    schema: 'http://schema.org#',
    PropertyValue: 'schema:PropertyValue',
    value: 'schema:value',
    litepub: 'http://litepub.social/ns#',
    EmojiReact: 'litepub:EmojiReact',
    misskey: 'https://misskey-hub.net/ns#',
    _misskey_reaction: 'misskey:_misskey_reaction',
    ring: `${RING_NS}data`,
  },
]);

const doc = (o) => ({ '@context': CONTEXT, ...o });
/* An activity as it rides inside another (Undo, Accept, Announce): no context. */
const bare = (a) => { const { '@context': _c, ...rest } = a; return rest; };

const actorOf = (origin, name) => urls.actorUrl(origin, name);
const followersOf = (origin, name) => urls.collectionUrl(origin, name, 'followers');
const act = (origin, name) => urls.activityUrl(origin, name, newActivityId());
const groupAct = (origin, ringId) => urls.groupActivityUrl(origin, ringId, newActivityId());
const hostOf = (origin) => urls.hostOf(origin);
const expiresOf = (post) => new Date((Date.parse(post.created_at) || 0) + RING_POST_TTL_MS).toISOString();

// ── Posts (4.4, 4.5) ───────────────────────────────────────────────────────────

/* The addressing of a post by its audience. */
function addressOf(post, { origin, name, groupOf }) {
  if (post.audience === 'public') return { to: [AS_PUBLIC], cc: [followersOf(origin, name)] };
  // A ring hosted elsewhere (P7) is addressed by its Group's own URL (`ap_id`).
  const group = groupOf?.(post.audience) || urls.groupUrl(origin, post.audience);
  return { to: [group], cc: [], audience: group };
}

const p = (html) => (html ? `<p>${html}</p>` : '');
const linkHtml = (href, text) => `<a href="${escapeHtml(href)}" rel="nofollow noopener ugc" target="_blank">${escapeHtml(text)}</a>`;

/* The Note of a post (4.4), or null for what never federates (a divider, an
 * unrenderable husk). `imageRow(key)` answers the images.json row (web variant
 * width, height, type). `addressAs` overrides the audience the Note is addressed
 * to (Keep re-addresses a room post to Public). */
function noteOf(post, { origin, name, imageRow = () => null, addressAs, groupOf } = {}) {
  if (!post || post.kind === 'divider') return null;
  const audience = addressAs || post.audience;
  if (audience === 'archive') return null;
  const m = post.media || {};
  const id = urls.postUrl(origin, name, post.id);
  const ring = { v: 1, kind: post.kind };
  const parts = [];
  const attachment = [];
  const imageAtt = (key, alt) => {
    const r = imageRow(key);
    const a = { type: 'Image', mediaType: r?.type || 'image/webp', url: origin + urls.imagePath(key, 'web'), name: alt || '' };
    if (r?.width) { a.width = r.width; a.height = r.height; }
    return a;
  };
  const noteHtml = post.note ? renderRingMarkdown(post.note) : '';
  if (post.kind === 'note') {
    if (!noteHtml) return null;
    parts.push(noteHtml);
  } else if (post.kind === 'image') {
    if (!m.key) return null;
    if (noteHtml) parts.push(noteHtml);
    const href = ringSafeHref(m.href);
    if (href) parts.push(p(linkHtml(href, href)));
    attachment.push(imageAtt(m.key, m.alt));
    ring.href = href;
  } else if (post.kind === 'link') {
    const href = ringSafeHref(m.href);
    const label = m.label || href;
    if (!label) return null;
    parts.push(p(href ? linkHtml(href, label) : escapeHtml(label)));
    if (m.sub) parts.push(p(escapeHtml(m.sub)));
    if (noteHtml) parts.push(noteHtml);
    if (m.key) attachment.push(imageAtt(m.key, label));
    if (href) attachment.push({ type: 'Link', href, name: label });
    ring.link = { href, label: m.label || '', sub: m.sub || '' };
  } else if (post.kind === 'embed') {
    const e = ringResolveEmbed(m.url);
    if (!e) return null;
    if (noteHtml) parts.push(noteHtml);
    parts.push(p(linkHtml(e.page, e.page)));
    ring.embed = e.page;
  } else {
    return null;
  }
  if (post.kaomoji) {
    parts.push(p(escapeHtml(post.kaomoji)));
    ring.kaomoji = post.kaomoji;
  }
  const address = addressOf({ ...post, audience }, { origin, name, groupOf });
  if (audience !== 'public') {
    ring.room = address.audience;
    ring.expires = expiresOf(post);
  }
  const note = {
    id,
    type: 'Note',
    attributedTo: actorOf(origin, name),
    published: post.created_at,
    to: address.to,
    cc: address.cc,
    content: parts.join(''),
    source: { content: post.note || '', mediaType: 'text/markdown' },
    summary: post.cw || null,
    sensitive: !!post.cw,
    url: urls.wallAnchor(origin, name, post.id),
    attachment,
    ring,
  };
  if (address.audience) note.audience = address.audience;
  if (post.updated_at) note.updated = post.updated_at;
  return note;
}

/* Create{Note}: its id is `<post url>/activity` (2.5). */
function createPost(post, ctx) {
  const note = noteOf(post, ctx);
  if (!note) return null;
  const a = { id: `${note.id}/activity`, type: 'Create', actor: note.attributedTo, published: note.published, to: note.to, cc: note.cc, object: note };
  if (note.audience) a.audience = note.audience;
  return doc(a);
}

/* Update{Note} (an edit; Keep's re-address passes addressAs: 'public' and goes
 * to the Group the Create reached, `deliverTo`). */
function updatePost(post, ctx, { deliverTo } = {}) {
  const note = noteOf(post, ctx);
  if (!note) return null;
  if (!note.updated) note.updated = post.updated_at || post.created_at;
  const a = { id: act(ctx.origin, ctx.name), type: 'Update', actor: note.attributedTo, to: deliverTo || note.to, cc: deliverTo ? [] : note.cc, object: note };
  if (!deliverTo && note.audience) a.audience = note.audience;
  return doc(a);
}

/* Delete{Tombstone} (4.9), addressed as the Create was. */
function deletePost(post, { origin, name, deleted, groupOf }) {
  const address = addressOf(post, { origin, name, groupOf });
  const a = {
    id: act(origin, name), type: 'Delete', actor: actorOf(origin, name), to: address.to, cc: address.cc,
    object: { id: urls.postUrl(origin, name, post.id), type: 'Tombstone', formerType: 'Note', deleted },
  };
  if (address.audience) a.audience = address.audience;
  return doc(a);
}

/* Pin and unpin: Add / Remove with target featured, to followers (4.9). */
function pinPost(post, { origin, name, pinned }) {
  return doc({
    id: act(origin, name), type: pinned ? 'Add' : 'Remove', actor: actorOf(origin, name),
    to: [AS_PUBLIC], cc: [followersOf(origin, name)],
    object: urls.postUrl(origin, name, post.id), target: urls.collectionUrl(origin, name, 'featured'),
  });
}

// ── Follows (4.6) ──────────────────────────────────────────────────────────────

/* A Follow from a local member to an actor URL. */
function follow({ origin, name, object, id }) {
  return doc({ id: id || act(origin, name), type: 'Follow', actor: actorOf(origin, name), object });
}

/* The Follow `follower` sent `followee`, as an Accept, Reject or Undo carries it. */
const followRef = ({ id, actor, object }) => ({ id, type: 'Follow', actor, object });

/* Accept or Reject of a Follow, by its followee. */
const answerFollow = (type, { origin, name, follow: f }) => doc({ id: act(origin, name), type, actor: actorOf(origin, name), object: followRef(f) });
const acceptFollow = (ctx) => answerFollow('Accept', ctx);
const rejectFollow = (ctx) => answerFollow('Reject', ctx);

/* Undo of one's own Follow. */
const undoFollow = ({ origin, name, follow: f }) => doc({ id: act(origin, name), type: 'Undo', actor: actorOf(origin, name), object: followRef(f) });

// ── Stamps and comments (4.8) ──────────────────────────────────────────────────

/* A stamp to a Ring server: Like, content = the face, ring { face, custom? }.
 * On a room post it goes to the Group (to, audience). `stampId` names the Like. */
function like({ origin, name, stampId, postUrl, postAuthor, face, custom = false, group = null }) {
  const a = {
    id: urls.stampUrl(origin, name, stampId), type: 'Like', actor: actorOf(origin, name), object: postUrl,
    content: face, to: [group || postAuthor], ring: { v: 1, face },
  };
  if (custom) a.ring.custom = true;
  if (group) a.audience = group;
  return doc(a);
}

/* What the other side's software makes of a stamp (spec 4.8), from its NodeInfo
 * row (lib/hosts.js): 'ring' (ringProtocol 1 or more), 'litepub' (Pleroma,
 * Akkoma), 'misskey' (Misskey and its forks) or 'other' (Mastodon and the rest). */
const MISSKEY_FAMILY = new Set(['misskey', 'sharkey', 'firefish', 'iceshrimp', 'iceshrimp.net', 'foundkey', 'calckey', 'catodon', 'cherrypick', 'meisskey']);
function softwareKind(row) {
  if (!row) return 'other';
  if (Number(row.ring_protocol) >= 1) return 'ring';
  const name = String(row.software || '').toLowerCase();
  if (name === 'pleroma' || name === 'akkoma') return 'litepub';
  if (MISSKEY_FAMILY.has(name)) return 'misskey';
  return 'other';
}

/* Is this palette face in the Emoji style (what EmojiReact and Misskey show)? */
const EMOJI_FACES = new Set(STAMP_STYLES.filter((s) => s.style === 'emoji').flatMap((s) => s.groups.flatMap((g) => g.faces)));
const isEmojiFace = (face) => EMOJI_FACES.has(face);

/* A stamp on a REMOTE post, shaped for the recipient's software (4.8):
 *   ring     Like, content = the face, ring { v, face }: the exact face
 *   litepub  EmojiReact with content when the face is an emoji, else Like
 *   misskey  Like with content and _misskey_reaction when an emoji, else a
 *            plain Like (their default reaction)
 *   other    Like, content included (Mastodon ignores it): a favourite
 * Only a Ring recipient gets the Ring term: a Like that carries it is held to
 * the sender's tier at the other end (refused, never mapped). */
function stampRemote({ origin, name, stampId, postUrl, postAuthor, face, kind }) {
  const emoji = isEmojiFace(face);
  const type = kind === 'litepub' && emoji ? 'EmojiReact' : 'Like';
  const a = { id: urls.stampUrl(origin, name, stampId), type, actor: actorOf(origin, name), object: postUrl, to: [postAuthor] };
  if (kind === 'ring') { a.content = face; a.ring = { v: 1, face }; }
  else if (kind === 'litepub') { if (emoji) a.content = face; }
  else if (kind === 'misskey') { if (emoji) { a.content = face; a._misskey_reaction = face; } }
  else a.content = face;
  return doc(a);
}

/* Delete{Person} (4.9, 11.4): the account is gone, actor = object. */
const deletePerson = ({ origin, name }) => doc({
  id: act(origin, name), type: 'Delete', actor: actorOf(origin, name), object: actorOf(origin, name), to: [AS_PUBLIC],
});

/* Undo of any of one's own activities (a Like, here), addressed as it was. */
function undo({ origin, name, activity }) {
  const inner = bare(activity);
  const a = { id: act(origin, name), type: 'Undo', actor: actorOf(origin, name), to: inner.to || [], object: inner };
  if (inner.audience) a.audience = inner.audience;
  return doc(a);
}

/* A comment: a Note in reply, the text escaped in one <p>, a Mention of the
 * author; public: to the author, cc Public (an unlisted reply); room: to the
 * Group. `source` carries the plain text a Ring reader settles from. */
function commentNote({ origin, name, commentId, postUrl, postAuthor, postAuthorHandle, body, published, group = null }) {
  const mentionHost = hostOf(origin);
  const note = {
    id: urls.commentUrl(origin, name, commentId),
    type: 'Note',
    attributedTo: actorOf(origin, name),
    inReplyTo: postUrl,
    published,
    to: group ? [group] : [postAuthor],
    cc: group ? [] : [AS_PUBLIC],
    content: `<p>${escapeHtml(body)}</p>`,
    source: { content: body, mediaType: 'text/plain' },
    tag: [{ type: 'Mention', href: postAuthor, name: `@${postAuthorHandle.includes('@') ? postAuthorHandle : `${postAuthorHandle}@${mentionHost}`}` }],
    ring: { v: 1 },
  };
  if (group) note.audience = group;
  return note;
}

function createComment(ctx) {
  const note = commentNote(ctx);
  const a = { id: act(ctx.origin, ctx.name), type: 'Create', actor: note.attributedTo, published: note.published, to: note.to, cc: note.cc, object: note };
  if (note.audience) a.audience = note.audience;
  return doc(a);
}

/* Taking a comment back: Delete{Tombstone}, addressed as the comment was. */
function deleteComment({ origin, name, objectId, to, audience, deleted }) {
  const a = { id: act(origin, name), type: 'Delete', actor: actorOf(origin, name), to, cc: [], object: { id: objectId, type: 'Tombstone', formerType: 'Note', deleted } };
  if (audience) a.audience = audience;
  return doc(a);
}

/* A reaction the post's own server refused or its owner removed, on a room
 * post: Remove { object: reaction, target: post } to the Group, announced (4.7). */
function removeReaction({ origin, name, reactionId, postUrl, group }) {
  return doc({ id: act(origin, name), type: 'Remove', actor: actorOf(origin, name), object: reactionId, target: postUrl, to: [group], audience: group });
}

// ── Actors and collections (4.3, P5) ──────────────────────────────────────────

/* A member's Person. `member` is the members.json row, `store` the page store
 * (or null), `publicKeyPem` theirs. Page OFF (store.enabled !== true): only the
 * fields keys, friends and rings need (id type preferredUsername name inbox
 * outbox followers following featured endpoints manuallyApprovesFollowers
 * publicKey), never the bio, avatar, links, theme or switches. No counts. */
function personDoc({ origin, member, store, publicKeyPem }) {
  const name = member.slug;
  const id = actorOf(origin, name);
  const on = store?.enabled === true;
  const p = {
    id,
    type: 'Person',
    preferredUsername: name,
    name: member.display_name || name,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    featured: `${id}/featured`,
    endpoints: { sharedInbox: `${origin}/inbox` },
    manuallyApprovesFollowers: store?.open_follows !== true,
    publicKey: { id: urls.keyIdOf(origin, name), owner: id, publicKeyPem },
  };
  if (!on) return doc(p);
  const indexable = store.indexable === true;
  Object.assign(p, {
    summary: store.bio ? `<p>${renderInline(store.bio)}</p>` : '',
    url: urls.pageUrl(origin, name),
    published: member.created_at || undefined,
    discoverable: indexable,
    indexable,
  });
  if (store.avatar_key) p.icon = { type: 'Image', mediaType: 'image/webp', url: origin + urls.imagePath(store.avatar_key, 'thumb') };
  p.attachment = (store.links || []).map((l) => {
    const href = ringSafeHref(l.href);
    let shown = l.label || href;
    try { if (!l.label) shown = new URL(href).host + new URL(href).pathname.replace(/\/$/, ''); } catch { /* keep */ }
    return { type: 'PropertyValue', name: l.label || 'link', value: `<a href="${escapeHtml(href)}" rel="me nofollow noopener" target="_blank">${escapeHtml(shown)}</a>` };
  });
  const theme = {};
  if (store.theme?.bg) theme.bg = store.theme.bg;
  if (store.theme?.bg_image_key) theme.bg_image = origin + urls.imagePath(store.theme.bg_image_key, 'web');
  for (const k of ['font', 'marquee', 'cursor']) if (store.theme?.[k]) theme[k] = store.theme[k];
  if (store.theme?.blink) theme.blink = true;
  p.ring = { v: 1, theme, stamps_off: store.stamps_off === true, comments_off: store.comments_off === true };
  return doc(p);
}

/* The instance actor (4.3): an Application with only the required fields. */
function instanceActorDoc({ origin, publicKeyPem }) {
  const id = `${origin}/actor`;
  const host = hostOf(origin);
  return doc({
    id,
    type: 'Application',
    preferredUsername: host,
    name: host,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    url: `${origin}/`,
    endpoints: { sharedInbox: `${origin}/inbox` },
    manuallyApprovesFollowers: true,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
  });
}

/* Update{Person} (4.9): the actor as it now is, to the followers. */
function updatePerson({ origin, name, person }) {
  return doc({
    id: act(origin, name), type: 'Update', actor: actorOf(origin, name),
    to: [AS_PUBLIC], cc: [followersOf(origin, name)], object: bare(person),
  });
}

/* An OrderedCollection with NO totalItems, ever (4.3). `first` names its first
 * page; `items` (embedded) when the collection is one page. */
function collectionDoc({ id, first, items }) {
  const c = { id, type: 'OrderedCollection' };
  if (first) c.first = first;
  if (items) c.orderedItems = items;
  return doc(c);
}

function collectionPageDoc({ id, partOf, items, next, prev }) {
  const c = { id, type: 'OrderedCollectionPage', partOf, orderedItems: items };
  if (next) c.next = next;
  if (prev) c.prev = prev;
  return doc(c);
}

/* A deleted post's object (4.9): 410 with this body. */
const tombstoneDoc = ({ origin, name, id, deleted }) => doc({ id: urls.postUrl(origin, name, id), type: 'Tombstone', formerType: 'Note', deleted });

// ── Rings: the Group and its acts (4.7) ───────────────────────────────────────

/* A ring's handles as actor URLs: a bare name is a member here; a remote handle
 * (P7) is its cached actor id, which the caller resolves (`actorOf`). */
const actorOfHandle = (origin, handle, resolve) => (handle.includes('@') ? (resolve ? resolve(handle) : '') : actorOf(origin, handle));
const hostsOfRing = (ring, origin) => {
  const out = new Set();
  for (const m of ring.members) out.add(m.handle.includes('@') ? m.handle.slice(m.handle.indexOf('@') + 1) : hostOf(origin));
  return [...out].sort();
};

/* The Group document. `view`: 'members' (the full ring), 'asker' (a live code
 * holder or a pending requester: no members, requests or link). Both carry the
 * hosts the members are on (4.7: the asker sees where the room is held) and,
 * from P7, the ring's own key (`publicKeyPem`, its home's keys/rings/<id>.pem).
 * `actorOf(handle)` resolves a remote member's actor id. */
function groupDoc(ring, { origin, view = 'members', actorOf: resolve, publicKeyPem } = {}) {
  const id = urls.groupUrl(origin, ring.id);
  const g = {
    id, type: 'Group', name: ring.name,
    attributedTo: actorOfHandle(origin, ring.created_by, resolve),
    inbox: `${id}/inbox`, outbox: `${id}/outbox`, followers: `${id}/members`,
    manuallyApprovesFollowers: true,
    ring: { v: 1, rev: ring.rev, capacity: 6, hosts: hostsOfRing(ring, origin) },
  };
  if (publicKeyPem) g.publicKey = { id: `${id}#main-key`, owner: id, publicKeyPem };
  if (view === 'members') {
    g.ring.members = ring.members.map((m) => ({ actor: actorOfHandle(origin, m.handle, resolve), joined_at: m.joined_at })).filter((m) => m.actor);
    g.ring.requests = ring.requests.map((q) => ({ actor: actorOfHandle(origin, q.handle, resolve), asked_at: q.asked_at, join: q.join_id })).filter((q) => q.actor);
    if (ring.join) {
      g.ring.join_url = urls.joinUrl(origin, ring.join.code);
      g.ring.join_expires = ring.join.expires_at;
    }
  }
  return g;
}

const memberActors = (ring, origin, resolve) => ring.members.map((m) => actorOfHandle(origin, m.handle, resolve)).filter(Boolean);

/* By the Group, to every member: the ring as it now is (rev). */
const updateGroup = (ring, { origin, actorOf: resolve, publicKeyPem }) => doc({
  id: groupAct(origin, ring.id), type: 'Update', actor: urls.groupUrl(origin, ring.id),
  to: memberActors(ring, origin, resolve), object: groupDoc(ring, { origin, actorOf: resolve, publicKeyPem }),
});

/* By a member's server, to the Group: ask by link. */
const gUrl = (origin, ringId, group) => group || urls.groupUrl(origin, ringId);
const joinGroup = ({ origin, name, ringId, code, group }) => doc({
  id: act(origin, name), type: 'Join', actor: actorOf(origin, name), object: gUrl(origin, ringId, group),
  to: [gUrl(origin, ringId, group)], ring: { v: 1, code },
});

const joinRef = ({ id, actor, object }) => ({ id, type: 'Join', actor, object });

/* A member approves or declines a request: Accept / Reject { object: <Join id> }. */
const answerJoin = (type, { origin, name, ringId, joinId, group }) => doc({
  id: act(origin, name), type, actor: actorOf(origin, name), object: joinId, to: [gUrl(origin, ringId, group)],
});

/* The Group to the joiner: Accept / Reject of the Join, embedded. */
const groupAnswerJoin = (type, { origin, ringId, join }) => doc({
  id: groupAct(origin, ringId), type, actor: urls.groupUrl(origin, ringId), object: joinRef(join), to: [join.actor],
});

const leaveGroup = ({ origin, name, ringId, group }) => doc({
  id: act(origin, name), type: 'Leave', actor: actorOf(origin, name), object: gUrl(origin, ringId, group), to: [gUrl(origin, ringId, group)],
});

/* Kick: the creator to the Group; the Group to the kicked member. `group` is
 * the Group's URL (a ring hosted elsewhere, P7: its `ap_id`); `memberActor` a
 * remote member's actor id. */
const removeMember = ({ origin, name, ringId, member, group, memberActor }) => doc({
  id: act(origin, name), type: 'Remove', actor: actorOf(origin, name), object: memberActor || actorOfHandle(origin, member),
  target: group || urls.groupUrl(origin, ringId), to: [group || urls.groupUrl(origin, ringId)],
});
const groupRemoveMember = ({ origin, ringId, member, memberActor }) => doc({
  id: groupAct(origin, ringId), type: 'Remove', actor: urls.groupUrl(origin, ringId), object: memberActor || actorOfHandle(origin, member),
  target: urls.groupUrl(origin, ringId), to: [memberActor || actorOfHandle(origin, member)],
});

/* Rename, or rotate / close the link: Update of part of the Group, to the Group. */
const updateGroupBy = ({ origin, name, ringId, object, group }) => doc({
  id: act(origin, name), type: 'Update', actor: actorOf(origin, name),
  object: { id: gUrl(origin, ringId, group), type: 'Group', ...object }, to: [gUrl(origin, ringId, group)],
});
const renameGroup = (ctx) => updateGroupBy({ ...ctx, object: { name: ctx.ringName } });
const linkGroup = (ctx) => updateGroupBy({ ...ctx, object: { ring: { v: 1, join: ctx.join } } });

/* Delete the ring: the creator to the Group; the Group to its members. */
const deleteGroup = ({ origin, name, ringId, group }) => doc({
  id: act(origin, name), type: 'Delete', actor: actorOf(origin, name), object: gUrl(origin, ringId, group), to: [gUrl(origin, ringId, group)],
});
const groupDeleted = ({ origin, ringId, to }) => doc({
  id: groupAct(origin, ringId), type: 'Delete', actor: urls.groupUrl(origin, ringId), object: urls.groupUrl(origin, ringId), to,
});

/* The Group hands an activity to its member servers. */
const announce = ({ origin, ringId, activity, to }) => doc({
  id: groupAct(origin, ringId), type: 'Announce', actor: urls.groupUrl(origin, ringId), object: bare(activity), to,
  audience: urls.groupUrl(origin, ringId),
});

module.exports = {
  CONTEXT, RING_NS, AS_PUBLIC, bare, doc,
  personDoc, instanceActorDoc, updatePerson, collectionDoc, collectionPageDoc, tombstoneDoc,
  noteOf, createPost, updatePost, deletePost, pinPost,
  follow, acceptFollow, rejectFollow, undoFollow, followRef,
  like, undo, commentNote, createComment, deleteComment, removeReaction,
  stampRemote, deletePerson, softwareKind, isEmojiFace,
  groupDoc, updateGroup, joinGroup, answerJoin, groupAnswerJoin, leaveGroup, removeMember, groupRemoveMember,
  renameGroup, linkGroup, deleteGroup, groupDeleted, announce,
};
