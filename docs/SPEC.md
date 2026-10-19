# Ring, standalone product spec (v2, federated)

v2 (2026-10-14) folds in the answers to v1's open questions: Ring is self-hostable and
federates over ActivityPub. This spec decides; open questions live only in section 18.

## 0. Decisions (binding)

| # | Question | Decision |
|---|---|---|
| 1 | Signup | **Invite-only**: 5 live invites per member; `SIGNUP=open` opens it later |
| 2 | Hosting | **Self-hostable and federated**: anyone runs a server; friends, rings, stamps and comments work across servers |
| 3 | Protocol | **ActivityPub**. Mastodon and other fediverse software can follow a wall, reply and like |
| 4 | Picture stamps | **None**: every face is text, in four styles, plus custom faces in rooms |
| 5 | Public square | **Members only**: signed-in members of a server see that server's public posts. Each `/@name` wall is public on its own switch |
| 6 | Name | **Ring**, for good: `software.name` `ring`, `RING_NS` = `https://github.com/errorrrrrrrrr/ring/ns#`, kept forever once federated |
| 7 | Rings and Mastodon | **Ring servers only**: a ring peer must declare `ringProtocol` in NodeInfo. Mastodon accounts follow walls, reply and like, never join a ring |
| 8 | Account moving (`Move`) | **Later**, outside P1 to P9. The export carries `following.csv` |
| 9 | Federation policy | **Blocklist only** (P8). No allowlist mode for now |

What v2 changes from v1: identity becomes URLs and `name@host` handles (section 2); friends
become mutual follows (3.5); a ring becomes a Group actor on its home server (4.5, 4.7); stamps
and comments ride Like, EmojiReact and replies (4.8); new sections for federation security (5),
moderation (6), delivery (7), discovery (8) and self-hosting (15); routes, tests and phases are
rewritten; P9 is the member export and the admin backup (12, 15.4).

## 1. What it is

1. A small social register for artists: each member keeps a wall of posts at `/@name`.
2. Every post is addressed: to **Public** (the open web, the members' square, and the
   member's followers anywhere in the fediverse), or to one **ring**, a private room of up to
   6 members, possibly on several Ring servers, where it lives for a week.
3. Members befriend each other, here or on any server, and press **stamps** (faces, never
   likes); friends leave short **comments**. Nothing is counted, summed or ranked, and no count
   leaves the server either.
4. One process per server, JSON files on one disk. Anyone can run a server; servers speak
   ActivityPub to each other and to the rest of the fediverse.
5. Invite-only signup with email and password.
6. A member takes their posts with them: a self-serve export zip (12); the admin keeps a full
   backup (15.4).

**Who:** working artists, their small circles, the people who visit their walls, and fediverse
users who follow them.
**Not:** inventory, portfolio, CV, payments, plans, credits, AI, organizer accounts, team
roles, link unfurling, direct messages, boosts, hashtags, mentions inside posts, polls, a
timeline of other servers, account migration (`Move`, Q3).

## 2. Identity and ids

> **The domain is permanent.** Every actor and object id embeds the server's host, and other
> servers store those ids for good. Once a server has federated, its `PUBLIC_ORIGIN` can never
> change: a new domain is a new server with an empty data dir. The server refuses to boot under
> a different origin (15.2), and federation stays off until the admin turns it on.

### 2.1 Host

`PUBLIC_ORIGIN` (https in production) names the server. The account domain is the web domain:
no split domain, no `host-meta`.

### 2.2 Actors

| What | Canonical id | Notes |
|---|---|---|
| member | `https://<host>/users/<name>` | `type: Person`; exists for every active member, page on or off |
| member's page | `https://<host>/@<name>` | the actor's `url`, HTML; asked for with an AP `Accept`, it redirects to the actor id |
| ring | `https://<host>/rings/<ring id>` | `type: Group`, on the ring's home server (4.5) |
| server | `https://<host>/actor` | `type: Application`, `preferredUsername` = host; signs server fetches and `Flag`s |

**Why `/users/<name>` is canonical, not `/@name`:** the actor must answer while the page is
off (keys, friends and rings work with the page off) and `/@name` must 404 then (rule 10.2);
one URL cannot do both. It is also Mastodon's path, the one other software is most tested
against.

### 2.3 WebFinger

`acct:<name>@<host>` resolves to the actor (8.1). The handle a fediverse user types is
`@name@host`.

### 2.4 Handles in stored rows

**Handle rule.** Every stored field that can point at a member of another server holds a
**handle**: a bare `name` is a member of this server; `name@host` is a remote member
(lowercase, host in punycode, `:port` only in tests). `name@<this host>` is never written:
`toHandle()` folds it to the bare name. `toHandle(actor)` is the one writer and `actorFor(handle)`
(the actor cache, 5.3) the one reader. The actor URL is the protocol identity, the handle the
row identity, and the cache binds them one to one: the handle comes from the actor's
`preferredUsername` and host, and WebFinger for it must answer with that same actor id, else
the actor is refused. A handle later seen with a different actor id is a different person; old
rows keep pointing at the gone one.

A stored handle is at most 330 characters (a 64-character remote name, `@`, a 253-character
host, a test port). Every read keeps only values already in stored handle shape (`isHandle`)
and drops the rest; a handle is **never cut**, because a cut handle matches nobody and a block
holding one would fail open.

The UI shows a remote member as `name@host` and signs their stamps and comments
"Firstname L. · host", so a remote name can never pass as a local friend.

### 2.5 Object and activity ids

| Thing | Id | Served? |
|---|---|---|
| post | `/users/<name>/posts/<post id>` | yes (11.2) |
| comment | `/users/<name>/comments/<comment id>` | yes, when its post is visible to the signer |
| stamp (`Like`) | `/users/<name>/stamps/<stamp id>` | unique, answers 404 |
| a post's `Create` | `<post url>/activity` | unique, answers 404 |
| other activities | `/users/<name>/activities/<id>`, `/rings/<ring id>/activities/<id>` | unique, answer 404 |
| collections | `/users/<name>/outbox` `followers` `following` `featured`; `/rings/<ring id>/members` `outbox` | yes (11.2) |

Ids are minted from a CSPRNG: post `p` + base36(ms) + 8 random base36 chars, ring `ring_` +
20 hex, stamp `stmp_` and comment `lc_` the same way (never `Math.random`). An id is never
reused: a deleted post keeps a tombstone (4.9) and a deleted member's name retires (3.1). The
post row stores the short id; the URL is derived from host, name and id, which never change.

### 2.6 Keys

- An RSA 2048 keypair per member, generated at signup confirm **before** the member row is
  written (the row is the commit). `keyId` = `<actor id>#main-key`.
- The private key lives in `DATA/keys/<name>.pem`, mode 0600 in a 0700 dir, read only by
  `lib/keys.js`. It never appears in an HTTP response, a log line, an audit row or an error
  report. It goes into a member export only when the member ticks "include my signing key"
  (12). It is always in the admin's full tar (15.4), which is therefore a secret.
- The instance actor and each home ring have their own keys (`keys/_instance.pem`,
  `keys/rings/<ring id>.pem`). **A ring's key arrives in P7** with the Group actor: a P2 ring
  is a home row with no key, and needs none, since every recipient of its activities is
  in-process (7). **As built in P7**: with `FEDERATION=on` the key is made (RSA 2048, 0600 in a
  0700 `keys/rings/`) in the tick that creates the ring on its home; a ring made before P7
  gets one the first time it is needed (its Group served, or anything it signs queued). It is
  `<group>#main-key`, it signs only what the Group sends (the queue's signer `_ring:<id>`), and
  it is deleted with the ring once no delivery job it signs is left (the queue's idle hook,
  and housekeeping's `ring_keys` step for a key whose ring and jobs are gone). A replica (a
  ring hosted elsewhere) has no key here.
- Rotation: `scripts/member.js rotate-key <name>` writes a new key and sends `Update{Person}`
  to every known server. No UI. A deleted member's key is kept until the last delivery job
  they sign ends (7), then removed (P5: the `Undo` and `Reject` their severs send; housekeeping
  sweeps a retired name's key with no job left).
- **Decided in P6: signing after deletion.** The moment a member is deleted their actor URL
  answers 410 with a `Tombstone` that carries **no key**. Their last jobs are still signed with
  their own key (kept until the last one ends, as above), and a receiver verifies them with the
  key **it already holds**: every server with something to undo (a follow either way, a
  reaction either way, a From elsewhere row) fetched that key to verify the member's earlier
  traffic, and Mastodon also accepts a `Delete` from an actor it finds gone. Not chosen: the
  instance actor as signer (a receiver checks that the signer is the activity's actor, so a
  `Delete{Person}` signed by anyone else is a forgery by 5.4's own rule), and a key on the
  tombstone (a receiver that fetches it would read a 410, which software treats as gone without
  reading the body). To keep that window to **one job per server**, a remote edge is no longer
  severed with its own `Undo` and `Reject` at deletion: `Delete{Person}` alone ends it (11.4).

### 2.7 What this changes in the v1 data model

| v1 | v2 |
|---|---|
| a `slug` in every edge (`from_slug`, `to_slug`, `author_slug`, `owner_slug`, `members[].slug`, `requests[].slug`, `created_by`, `blocked[]`) | a handle (2.4); fields drop `_slug`: `author`, `members[].handle`, `requests[].handle` |
| `friends.json`, one global row per pair | `members/<name>/follows.json`; friendship is derived (3.5) |
| stamp and comment `thread_anchor` | `post_id` (the file names the owner) plus the activity or object id |
| post ids from `Math.random` | CSPRNG ids, derived URLs |
| ring ids from `Math.random` | CSPRNG; the Group id is the ring's URL on its home server |
| `members.json` row | gains `role` and `invited_by`; keys live in `DATA/keys/` |

## 3. Concepts and data model

### 3.1 Member

`members.json` row: `{ slug, email, email_lc, password_hash, display_name, role:
'member'|'admin', invited_by, created_at, status: 'active'|'suspended', sessions_from }`.
`sessions_from` (ISO) is the session cutoff: a session stamped before it is no session (10.9).

- `slug` is the name in `/@name`, `/users/name` and `name@host`. **Immutable, forever**: it is
  inside permanent actor URLs. Shape `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$`, minus a
  reserved list (`api app login signup logout reset rings ring feed assets static admin help
  about settings me health users actor inbox outbox nodeinfo media authorize_interaction ns
  well-known`). A name is public the moment it is taken. A deleted member's name goes to
  `retired-handles.json` and is never reissued: other servers still hold its actor, key and
  follows.
- `display_name`, 60 chars: in full on the member's own wall, "Firstname L." when it signs
  someone else's (`shortDisplayName`, kept).
- `role`: `admin` only for the `ADMIN_EMAIL` account confirmed while the server has no
  members, decided at confirm (6.3); every other account is `member`.

### 3.2 Post (`lib/ring.js`)

| field | rule |
|---|---|
| `id` | server-minted, CSPRNG (2.5); the object URL is derived, never stored |
| `kind` | `note` · `image` · `link` · `embed` · `divider` |
| `created_at` | ISO, server-minted |
| `updated_at` | set by an edit that changes what federates as the Note's content (`note`, `cw`, `kaomoji`, `media`); a pin or a switch is not an edit, and a PATCH that changes nothing writes nothing |
| `audience` | `'public'` · a ring id `ring_...` · `'archive'`; absent reads as `public` |
| `archived_from`, `archived_at` | only on `archive`: the room it left, its expiry instant |
| `note` | 6000 chars of the markdown subset; required on `note`, optional elsewhere |
| `cw` | optional content warning, 100 chars plain text; federates as `summary` + `sensitive` (new: fediverse readers expect it and remote posts carry it) |
| `kaomoji` | optional author decoration, 40 chars, rendered escaped |
| `pinned`, `stamps_off`, `comments_off` | optional `true` |
| `shown` | server-set `true` once the post was public on an enabled page (4.9); never from the client, immutable on an edit |

| kind | `media` (any other key dropped) | required |
|---|---|---|
| `note` | none | `note` |
| `image` | `{ key, alt (300), href (500) }` | `key`, owned by the author |
| `link` | `{ href (500), label (200), key? (owned image), sub? (300) }` | `href` or `label` |
| `embed` | `{ url (500) }` | resolves to YouTube (nocookie), Vimeo or SoundCloud, else dropped |
| `divider` | `{ variant: line·dots·stars·wave }` | none |

**The kinds are closed.** Any other `kind` is refused at write, and a stored one normalizes to
nothing.

### 3.3 Page store, `members/<name>/log.json`

`{ enabled, indexable, open_follows, stamps_off, comments_off, blocked[], blocked_domains[],
theme, bio, avatar_key, links[], posts[], shown_tracked }`.

- `shown_tracked` (server-set): this store marks its shown posts (4.9). A store without it was
  written before the mark, and every public post in it reads as shown.

- `enabled` is the publish switch: **one switch** decides
  whether Public posts reach anyone, here or on other servers.
- `indexable` (default `false`): a published page is `noindex` unless on; it also sets the
  actor's `discoverable` and `indexable` (Mastodon's directory and search opt-ins).
- `open_follows` (default `false`): follows are accepted as followers without asking (4.6).
- `theme`: `{ bg (hex only), bg_image_key (owned), font, marquee (200), blink, cursor }`, enums
  unchanged.
- `bio` (500 chars, inline markdown subset: links, emphasis), `avatar_key` (owned image),
  `links` (up to 4 `{label (40), href (500)}`, http(s) only, rendered `rel="me"`, 8.4). New in
  v2: a fediverse profile without them reads as empty. All optional.
- `blocked`: handles, max 500, each up to 330 characters, shape-checked on every read and never
  cut (2.4). `blocked_domains`: hosts, max 100 (6.1).
- Posts: max **500**, archive included.

### 3.4 Audiences

| audience | who sees it on this server | where it travels |
|---|---|---|
| `public`, page on | anyone at `/@name`; every member of this server in the square; friends in their Friends feed | `Create` to followers' servers; the outbox; `featured` when pinned; RSS |
| `public`, page off | the author only (feeds report `me_page_off`; Keep refuses with 409) | nowhere new; the AP door and RSS answer as for an absent post (10.2) |
| ring id | that ring's members, page on or off (the 3.6 read grant), until `created_at + 7d` | to the ring's Group only, which hands it to member servers (4.7) |
| `archive` | the author only; written by the sweep, never by the composer | nowhere, ever |

"Friends" is not an audience: it is a feed over friends' already-public posts. There is no
followers-only, unlisted or direct audience.

A room post past its week is gone from every reader at once (read-time expiry, 3.8), and from
that moment its author's shelf (`GET /api/archive`) lists it as archived, before the sweep has
re-addressed the row.

### 3.5 Friends and followers (carried on follows)

v2 replaces v1's friend rows with follows, the edge ActivityPub has.
`members/<name>/follows.json`: `{ following: [{ handle, state: 'pending'|'accepted',
follow_id, at, accepted_at }], followers: [same] }`. A follow between two members of this
server is written into both files in one tick.

- **Friends are two accepted follows, one each way.** Nothing else is stored.
- **Request; only the recipient confirms.** Befriend sends a `Follow`. Confirm sends `Accept`
  and a `Follow` back. **A crossing request confirms at once**: a `Follow` from someone the
  member already follows, or has asked to, is accepted without asking. **Either side severs**:
  sever undoes the member's follow and removes the other's (`Undo` + `Reject`); a friend who
  unfollows has severed, so this side undoes its own follow too.
- **Followers are one-way**: someone, typically on Mastodon, follows a member who does not
  follow back. A follower gets the member's public posts delivered while the page is on, and
  nothing else: no wider palette, no comments, no Friends feed, no ring rights. A follow needs
  the member's answer (`manuallyApprovesFollowers: true`): **Befriend** (accept and follow
  back), **Let follow** (accept), or **Decline** (`Reject`). `open_follows` accepts as follower
  automatically; friendship still needs the member's own follow back.
- **Zero permission.** Friendship widens the stamp palette, opens comments on posts the viewer
  could already see, and selects whose public posts fill the Friends feed. **Friend-gating any
  read is forbidden, and so is follower-gating**: every read a follower gets, a stranger gets
  at `/@name`.
- Followers and following lists are private: the member sees them in Settings; the AP
  collections carry no items and no counts (4.3).
- Caps (file bounds, never shown): following 1000, **accepted** followers 10 000, friends 500;
  past a cap a new follow is refused with `Reject` (a courtesy job, 7: refused itself past the
  queue's caps). **Pending requests have caps of their own and never count toward the
  10 000**: at most 500, oldest out (the oldest request is forgotten unanswered, as any
  unanswered request is), and at most 20 from one remote host (past that a new one from it is
  dropped silently, as a blocked handle's is). Letting a request follow past 10 000 accepted
  answers 409 `follower_limit`.
- **A `Follow` from someone already accepted** (their server sending it again) is re-answered
  `Accept` at most once an hour per follower; the rest get the 202 and nothing else.
- **A blocked handle's `Follow` is dropped silently** (6.1): no row, no `Reject`, nothing in
  the blocker's Inbox. The asker's side keeps a pending request that is never answered
  (`GET /api/friends/with/:handle` says `pending`, never `none`), the answer any unanswered
  request gets. Befriending again while pending asks again, so a request dropped under a block
  that has since been lifted lands then: between two members here the same `Follow` goes
  again; to another server a **new** `Follow` goes (P6), because the receiver drops an activity
  id it has seen in the past 7 days (5.5); either way the other side keeps one row, and this
  row keeps the newest id.

A friend request is a plain in-app request under the real session (local) or a `Follow`
(remote). Every wall is a path on its own server, so no cookie or handoff crosses hosts.

### 3.6 Named rings (federated)

`rings.json` row: `{ id, ap_id, home: true|false, name, created_by, created_at,
members[{handle, joined_at}], requests[{handle, asked_at, join_id}], kicked[handle], join:
{code, created_by, created_at, expires_at} | null, join_url, rev }`. A **home** row is the ring itself (this server
hosts its Group). A non-home row is a **replica** a member's server keeps of a ring hosted
elsewhere, replaced whole by each higher `rev` (4.7); a replica never holds the code, only the
`join_url` members may copy. `id` is always minted locally; `ap_id` is the Group's URL.

The bounds: 6 members hard (pending requests hold a seat), 3 rings per member, name 60
(plain text: control characters and bidi overrides stripped, as a custom face and a comment
are), join link 14 days, 2000 rings per file. One standing multi-use 160-bit join code,
shared as `<origin>/rings/join/<code>`; any member rotates it or switches it off (both drop
pending requests). **The link asks, it never admits**: a member approves, and both caps are
re-checked then. Any member renames; the creator kicks and deletes; a leaving creator hands
the role to the oldest member; the last to leave dissolves it. Rename, rotate and switch-off
share one budget (10 a minute, 60 a day: each rewrites `rings.json` and the audit log);
approve and decline have their own (30 a minute, 300 a day).

- **Every dropped request is answered**: rotate, switch-off, a kick, an expiry (7), a deleted
  member's code (11.4) and a ring dissolved or deleted each send `Reject{Join}` from the Group
  to every requester they drop, so no asker waits on a request the ring no longer holds.
- **A kick sticks.** The kicked member held the code, so the link rotates (a dead one closes),
  the pending requests drop, and the handle is kept in `kicked` (100 at most, oldest out).
  A kicked handle may ask again through a link someone shares, but **only the creator
  re-admits it**: any other member's approval is refused (403 `ring_creator_only`); declining
  stays anyone's. Re-admission, or the purge, takes the handle off the list. A request from a
  kicked handle is marked `kicked: true` in the ring view and the Inbox.
- **A deleted member's code closes.** The purge rotates a join code whose `created_by` is
  the deleted member to the ring's (new) creator and drops the requests it filed, so a code
  never outlives the person it is signed with.
- **A block holds here too** (6.1): a request from a handle the viewer blocks is left out of
  the viewer's ring view, Inbox and unseen count, as if it never came. It stays the asker's
  unanswered request; another member may still answer it. Non-members get an opaque 404 on every ring route, AP routes included. A
ring carries one permission, its members read posts addressed to it and their images;
ring-gating anything else is forbidden, and membership implies nothing pairwise.

Federation adds: members may be on any Ring server (Q1); the **home** enforces the seat cap,
the code and approvals; each member's own server enforces that member's 3-ring cap; the home
never moves (a creator handoff passes the role, not the server).

**As built in P7** (`lib/groups.js` the home, `lib/ring-fed.js` the member servers):

- **One tick decides.** Every Join and every approval, from any number of servers at once,
  is checked and written in one synchronous tick at the home: requests hold seats, so at most
  five can wait beside a lone creator, and a seventh member is never seated (gate: fed-rings,
  eight askers on two servers at once).
- **A replica** row (`home: false`) keeps what the Group's members view says: name, creator,
  members and requests (as handles: a remote member's actor is resolved and bound first, at
  most 12 a document), the link a member may copy (`join_url`, `join_expires`, never the
  code) and `rev`. A higher `rev` replaces it whole; an equal or lower one is ignored. It is
  made by the Group's `Accept` of a Join this server sent, or by an `Update{Group}` that
  overtakes that `Accept` and lists the asker. A replica with no member here left is dropped
  with its copies. **A home names no one here by itself** (P7 review, F1): a member of THIS
  server enters a replica (as a member or a request) only while they have an open ask to that
  Group (`fed/ring-asks.json`), and stays only while the previous row held them; any other
  local handle a Group's document lists is left out, so a home can never seat someone here who
  never asked, nor make their server send a `Leave` for them (the 3-ring cap's `Leave` below
  is only ever for one who asked). At most 6 seats, members and requests together.
- **The asks this server sent** live in `fed/ring-asks.json` (member, Group, the Join's id,
  the ring's name and hosts; 14 days, 10 per member, 2000 rows): the Group's `Accept` or
  `Reject` is taken only about one of them. Each row is settled on every read (P7 review, F3):
  a Group and a Join id of at most 2000 chars, http(s); the name a ring name; at most 6 hosts,
  each a host name (the handle rules' shape, a port only under the test hook) of at most 255
  chars. A row is a few hundred bytes, whatever a Group's document said.
- **The joiner's 3-ring cap** is checked again the moment a member here first appears in a
  replica, whichever activity says so: past it (they asked at 2 and joined another
  meanwhile), their server sends `Leave` at once (`ring.over_cap_left`).
- **A block holds at approval.** An approval of an asker that any member HERE blocks (by
  handle or domain) is refused (409 `ring_blocked`) and the request is answered `Reject{Join}`:
  admitting them would hand the blocked person the room's read grant over the blocker's
  posts. The ask itself still lands, hidden from the blocker as in P2. A remote member's own
  blocks are their server's (the home cannot see them): the honest limit.
- **A member's own domain block** keeps them from asking into a ring hosted on that domain
  (the 404 an unknown link gets); `BLOCKED_DOMAINS` refuses the inbound Join (403, 5.2) and
  housekeeping's `rings_blocked` step takes a blocked domain's people out of the home rings
  here and drops a replica hosted on one.
- **A remote actor gone** (5.3) loses its seats, requests and code in every home ring here, as
  the purge does for a member here; an account deleted here leaves its replicas at once and
  its farewell's `Delete{Person}` goes to the Group of each, whose home drops it.

### 3.7 Stamps and comments

- **Rows.** Stamp `{ id: 'stmp_...', post_id, author, kaomoji, custom?, activity_id, at, seen }`.
  Comment `{ id: 'lc_...', post_id, author, body, truncated?, source_url?, object_id, at,
  seen }`. `author` is a handle. Rows for this server's posts live per owner in
  `members/<owner>/log-stamps.json` and `log-comments.json` (sharded per owner, so a stamp
  rewrites one owner's file, never a global one). Reactions on remote room posts live with the copy (3.10). A member's
  own stamps and comments on remote posts are kept in `members/<name>/sent.json` so they can
  be taken back.
- **`STAMP_STYLES`: four styles, 56 faces, 30 in `nice` groups**, a closed enum: kaomoji,
  emoji, ASCII, symbols. Every face is text, never a picture (decision 4). One face per (sender, post): same face toggles off.
- **Tiers.** Any signed-in member, here or elsewhere, presses a **nice** face on a post they
  can see; confirmed friends, and ring-mates on a room post, get the **full palette**; a
  ring-mate may press a **custom face** (one line, 20 chars, emoji-safe) on a room post only,
  decided by the **stored** audience. Comments: confirmed friends only, plain text, 280 chars
  (a decision, not a placeholder), control characters and bidi overrides stripped (the same
  rule as a custom face and a ring name). Faces arriving from other software are mapped (4.8).
- **Keep sheds the room's crowd.** A live room post kept to Public (3.8) sheds every reaction
  made under the ROOM GRANT: all its comments (written to the room, never to Public), and every
  stamp outside its sender's Public tier, that is a custom face, or a non-nice face from
  someone who is not the owner's confirmed friend at Keep. What any Public reader could have
  left (a nice face, a friend's full-palette face) stays. A lapsed or archived post loses its
  whole crowd, as the sweep would have.
- **The owner outranks all of it**: `stamps_off`/`comments_off` per page or post, remove any
  row, block a sender (opaque 403 identical to "closed", retroactive, enforced at render). A
  blocked viewer reads the blocker's wall, square and room posts with `stamps_off` and
  `comments_off` true, so what the page says matches the 403 their press would get.
  Authors take back their own. **The post's own server is the authority for its reactions**:
  it applies tiers, friendship, blocks and switches, and a reaction it refuses or its owner
  removes on a room post is withdrawn on every server that holds a copy (4.7). It applies only
  a reaction signed by its reactor and delivered to it (P7 review, F2): a ring's Group relaying
  one updates the copies on member servers, never the authority's rows.

### 3.8 The ring reset

`lib/ring-reset.js`, always on: a room post re-addresses to
`archive` at `created_at + 7d` (`archived_at` = that instant), its reactions are deleted,
nothing else moves, idempotent and restart-safe. **A room clears** because a week-long room is the
reason to post into a ring rather than to Public. Boot catch-up after 30 s, then hourly,
in-process. Reads also treat a lapsed room post as gone, so it never shows in the hour before
the sweep, and the author's archive lists it from the moment it lapses (3.4). Keep (`/keep`)
re-addresses room or archive to Public, one-way, 409 `page_off` while the page is off; a kept
live room post drops the reactions made under the room grant (3.7), a lapsed or archived one
its whole crowd.

Over federation: at expiry the author's server sends `Delete` through the Group, and every
Ring server expires its own copies on `ring.expires` by itself, Delete or not (4.7). The same
hourly sweep expires local posts and remote copies. As built in P7: a copy is never read past
its `expires` (min of `ring.expires` and `published` + 7 days), so it vanishes on time even
when the home is down and no sweep has run; the sweep then deletes it and its cached images.

### 3.9 Feeds

**Public square**: this server's members' public posts from enabled pages, newest first, 20 a
page behind an opaque base64url cursor `[created_at, id, slug]`; **members of this server
only, and never posts from other servers**. **Friends**: confirmed friends' public posts,
local and remote, ends at 200, reports `muted`. **Ring**: posts addressed to that room, from
members here and elsewhere, ends at 200. **Archive**: my shelf, no reactions. Only dated posts
feed; dividers stay page furniture. Each member's public projection is memoized and dropped on
their write.

### 3.10 What this server keeps from others

| Store | Holds | Bound |
|---|---|---|
| `fed/actors/<sha256(actor id)>.json` | remote actor: id, handle, inbox, shared inbox, key id and PEM, name, bio (node tree, 5.8), avatar URL and its media id (cached), url, outbox, a Ring server's `stamps_off`/`comments_off`, fetched_at, used_at; `named` once a member's row names it, and the avatar's `avatar_src`/`avatar_at` (6.4); a **gone** actor keeps only id, handle and `gone_at` (5.3); an **unbound** server key (5.3) has no handle | fresh 24 h; dropped 90 days after last use unless a row references it (follows, reactions, `sent.json`, From elsewhere, blocks, rings, walls); `used_at` written at most once a day; gone records stay |
| `fed/hosts.json` | per host: software name and version, `ringProtocol`, shared inbox, `failing_since`, `unavailable`, `last_success_at`, `nodeinfo_at`, `media_hosts` (the hosts a friend's posts from it carried images on, at most 8: where its avatars may come from, 6.4) | one row per host seen, 50 000 (healthy rows out first); held in memory, read once, written (atomically) on a 2 s debounce and at shutdown |
| `fed/walls/<sha256(handle)>.json` | a remote friend's recent public and unlisted posts (settled, 4.10: a Ring post's markdown and Ring term, anyone else's node tree), for the Friends feed, shared by every friend here | 200 posts, 90 days; dropped with the friendship (when no member here is still their friend), and swept hourly |
| `fed/rooms/<ring id>/<key>.json` | remote members' live room posts in a ring a member here belongs to, with their reactions, ONE FILE PER COPY (P7 review, F7; `key` the first 32 hex of SHA-256 of the copy's id). As built in P7 (`lib/rooms.js`): a settled Ring post (5.8: its markdown source, never another software's node tree) plus `author` (a handle), `expires` (min of the Note's `ring.expires` and `published` + 7 days), `stamps` `[{id, author, face, custom?}]`, `comments` `[{id, author, body}]`; the ring id is the LOCAL one (a home row or a replica). An index in memory (built once per process, kept by every write: each copy's ring, author, expiry, media ids and comment ids) means a stamp, a comment, a find or a comment's lookup reads one file and writes at most one, and the media ids, the sweep and the caps read none | live posts only (every read drops one past `expires`); a settled copy at most 64 KB; 500 a ring and 200 live per author a ring (oldest out, the author's own first); 200 stamps a post (one per author), 200 comments a post and 20 per author on one post (the 21st refused); gone at expiry (the hourly sweep), with their author leaving, or when no member here remains |
| `fed/ring-asks.json` | (P7) the Joins this server sent by a link of another server: member, Group, Join id, name, hosts, when; each row settled on read to bounded fields (3.6, F3) | 14 days, 10 per member, 2000 rows |
| `fed/media/` + `fed/media.json` | remote images, re-encoded (5.7): `<id>__web` and `<id>__thumb`, the id `m_` + 32 hex of SHA-256(url) (a room image, P7: of the url plus `#room:<ring id>`, so it never shares a row with a public copy nor with another ring's, marked `room` with its LOCAL ring id; P7 review, F6); the index in memory, written on a 1 s debounce | `REMOTE_MEDIA_MB`, least recently used out (the row stays `trimmed`, a miss refetches); 50 000 image rows and 10 000 avatar rows, counted apart (6.4); a row no store names goes after an hour |
| `members/<name>/sent.json` | the member's stamps and comments on remote posts, each with the activity as sent (what an `Undo` or `Delete` names; a comment's Note is served from here, 11.2) | 2000 rows |
| `members/<name>/elsewhere.json` | replies and mentions from outside (6.4): a PREVIEW of the node tree (never HTML): 2000 characters and 200 nodes, `cut` and the source's `url` when there was more (the Inbox links "more at source") | 30 days, 500 rows, 1 MB (oldest out); the unseen count is kept per author in memory, so `GET /api/me` never reads the rows |
| `members/<name>/tombstones.json` | deleted post ids and when, and whether the post was ever shown (4.9) | 10 000 rows, oldest out (then 404) |
| `fed/seen/<YYYY-MM-DD>.txt` | a fixed-length hash (128 bits of SHA-256) of each inbound activity id HANDLED (5.5) | 7 days; 100 000 in memory, oldest out; a day file past 200 000 lines is rewritten from memory |
| `fed/replay/<YYYY-MM-DDTHH>.txt` | SHA-256 of each inbound POST signature value (5.5) | the hour plus the 2 h window |

### 3.11 Disk layout

```
DATA/instance.json                               origin, schema version, federated_at (15.2)
DATA/members.json invites.json retired-handles.json rings.json audit.log (JSONL, 90 days)
DATA/pending-signups.json password-resets.json   token HASHES only, 24 h / 1 h (10.11)
DATA/mail-outbox.jsonl                           the `log` mail provider's outbox (15.3)
DATA/images.json                                 key -> { owner, bytes, created_at, width, height, type, source }
DATA/images/<key> <key>__web <key>__thumb
DATA/sessions/<sha256(session id)>.json
DATA/keys/<name>.pem _instance.pem rings/<ring id>.pem      0600, dir 0700
DATA/members/<name>/log.json log-stamps.json log-comments.json log-visits.json
DATA/members/<name>/follows.json sent.json elsewhere.json tombstones.json
DATA/fed/actors/ hosts.json walls/ rooms/ media/ media.json seen/ ring-asks.json
DATA/queue/<job id>.json                         delivery jobs (7)
DATA/queue/damaged/                              job files that could not be read, moved aside (15.4)
DATA/moderation/domain-blocks.json actor-blocks.json reports.jsonl   (P8, 6.3; reports append-only, 6.2)
DATA/signup-release/<sha256 of an address>      a shell release waiting for the server (P8 review, 10.11)
DATA/members/<name>/notices.json                 what the server told the member (P8, 6.3)
DATA/backups/                                    pre-migration tars (15.5)
DATA/.lock                                       one process per data dir, a lease (15.4)
```

An `images.json` row's `width`, `height` and `type` are the web variant's (`image/webp`, 10.4),
what a post's `Image` attachment carries (4.4); `source` is the sniffed format of the upload
(`jpeg`, `png`, `gif`, `webp`). A pending-signup row also holds the bcrypt hash of the password
chosen at signup (10.11).

Every write goes through `lib/store.js` `writeJSON` (a unique hidden temp in the same
directory, fsync, rename, then fsync the directory, so an acknowledged write survives a power
cut). **Every read-modify-write runs in one synchronous tick, never an await between load and
save**: one process, so that is the whole concurrency story. Federation keeps it by doing all
its awaiting (fetch, verify, media) before the tick that writes.

- **Reads fail closed.** `readJSON` answers its fallback only when the file does not exist
  (ENOENT). Bad JSON, an empty file, EACCES or EIO is a `StoreReadError` naming the file, never
  an empty value a later write would persist over the real data. At boot every top-level data
  file (`members.json`, `images.json`, `invites.json`, `retired-handles.json`, `instance.json`,
  `pending-signups.json`, `password-resets.json`, and from P2 `rings.json`) is read and
  shape-checked first; a damaged one
  refuses the boot, naming the file. While running, a damaged file fails the request that reads
  it, and housekeeping skips what it cannot read (7).
- **The JSONL exception.** `audit.log` and `mail-outbox.jsonl` are appended to. Pruning one
  streams the kept lines to a temp, fsyncs and renames (the same atomic replace), so a crash
  mid-prune leaves the old file whole and no single string holds it.
- **Hand edits are read.** The files kept in memory (`members.json`, `retired-handles.json`,
  `images.json`) are stat-checked on every access and re-read when they changed underneath (an
  operator's edit while the server runs is P1's only admin tool), so the next write never
  reverts it; every other file is read from disk on every access.
- **Modes.** Data files are 0600 and directories 0700, whatever the umask: the data dir holds
  password hashes, emails and signing keys.

## 4. The ActivityPub mapping

### 4.1 Reading and writing ActivityStreams

Every document carries this inline context (no remote context fetch, no `@version`):

```json
"@context": [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  { "toot": "http://joinmastodon.org/ns#",
    "featured": { "@id": "toot:featured", "@type": "@id" },
    "discoverable": "toot:discoverable", "indexable": "toot:indexable",
    "manuallyApprovesFollowers": "as:manuallyApprovesFollowers", "sensitive": "as:sensitive",
    "schema": "http://schema.org#", "PropertyValue": "schema:PropertyValue", "value": "schema:value",
    "litepub": "http://litepub.social/ns#", "EmojiReact": "litepub:EmojiReact",
    "misskey": "https://misskey-hub.net/ns#", "_misskey_reaction": "misskey:_misskey_reaction",
    "ring": "<RING_NS>data" }
]
```

- **The Ring term.** Everything Ring-only lives inside one property, `ring`, a plain JSON
  object with `v: 1`. Other software ignores one unknown key (a JSON-LD processor drops its
  unmapped insides on expansion). Ring readers settle it against a closed registry: unknown
  keys dropped, wrong types dropped, never coerced. `RING_NS` is a constant fixed before the
  first federating release and never changed (Q2).
- **Reading** is plain JSON over the compacted AS2 form, as Mastodon does: no JSON-LD
  expansion. `type`, `to`, `cc` may be a string or an array; a referenced object may be
  embedded or an id (fetched only when needed, 5.6); unknown properties are ignored.
- **Media types.** Sent: `application/activity+json`. Inbox accepts that,
  `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` and
  `application/json`. A fetched document must be one of the first two.

### 4.2 The mapping

| Ring | ActivityPub | A Mastodon user sees |
|---|---|---|
| member | `Person` at `/users/name` (4.3) | a profile: name, bio, avatar, verified links, a lock unless `open_follows`; no counts, or zeros |
| page off | the same `Person`, minimal; empty outbox and `featured` | a bare profile with no posts |
| public post | `Create{Note}`, `to: as:Public`, `cc: followers` (4.4) | an ordinary public post |
| image post | `Note` + `Image` attachment, `name` = alt | the image with its alt text |
| link post | `Note`, the link in `content`; optional `Image`; a `Link` attachment | text with a link (Mastodon builds its own card) |
| embed post | `Note`, the media's canonical page URL in `content` | a link with a preview card, never an iframe |
| divider | not federated | nothing |
| kaomoji decoration | last paragraph of `content`, and `ring.kaomoji` | the kaomoji as a last line |
| `cw` | `summary` + `sensitive: true` | a content warning, media blurred |
| theme, stamp and comment switches | `ring.theme`, `ring.stamps_off`, `ring.comments_off` on the `Person` | nothing |
| pinned | `featured` collection; `Add`/`Remove` (`target: featured`) to followers | pinned posts on the profile |
| room post | `Create{Note}` to the ring's `Group` only, announced to members (4.5, 4.7) | nothing, ever |
| archive | never an activity | nothing |
| befriend | `Follow` | a new follower, or a follow request if their account is locked |
| confirm | `Accept{Follow}` + own `Follow` | follow accepted, and followed back |
| sever | `Undo{Follow}` (own) + `Reject{Follow}` (theirs) | no longer following each other |
| a follower | their `Follow`, answered `Accept` or `Reject` | "requested" until answered, then public posts in the home timeline |
| stamp | `Like`, `EmojiReact` or `Like` + `content`, by target software (4.8) | a favourite |
| take back a stamp | `Undo` of the same activity | the favourite goes |
| custom face | `Like` + `content` + `ring.custom` (rooms only) | never reaches Mastodon |
| comment | `Note` with `inReplyTo`, `to: author`, `cc: as:Public`, a `Mention` | an unlisted reply in the thread |
| take back a comment | `Delete{Tombstone}` | the reply goes |
| edit | `Update{Note}` | the edited marker |
| delete | `Delete{Tombstone}`; the URL answers 410 | the post goes |
| profile change | `Update{Person}` | new name, bio, avatar |
| block | no activity; `Undo{Follow}` + `Reject{Follow}` | they quietly stop following and being followed |
| report | `Flag` from the instance actor | a report in their moderators' queue |
| account deletion | `Delete{Person}`; the actor answers 410 | the account goes |
| ring | `Group` at `/rings/<id>` on its home (4.7) | nothing (rings are Ring-only, Q1) |

### 4.3 The actor

```json
{ "id": "https://h/users/ana", "type": "Person", "preferredUsername": "ana", "name": "Ana Lima",
  "summary": "<p>bio</p>", "url": "https://h/@ana", "published": "...",
  "icon": { "type": "Image", "mediaType": "image/webp", "url": "https://h/api/images/<key>/thumb" },
  "inbox": "https://h/users/ana/inbox", "outbox": "https://h/users/ana/outbox",
  "followers": "https://h/users/ana/followers", "following": "https://h/users/ana/following",
  "featured": "https://h/users/ana/featured", "endpoints": { "sharedInbox": "https://h/inbox" },
  "manuallyApprovesFollowers": true, "discoverable": false, "indexable": false,
  "attachment": [{ "type": "PropertyValue", "name": "site",
                   "value": "<a href=\"https://ana.example\" rel=\"me nofollow noopener\">ana.example</a>" }],
  "publicKey": { "id": "https://h/users/ana#main-key", "owner": "https://h/users/ana",
                 "publicKeyPem": "-----BEGIN PUBLIC KEY-----..." },
  "ring": { "v": 1, "theme": { "bg": "#ffeedd", "bg_image": "https://h/api/images/<key>/web" },
            "stamps_off": false, "comments_off": false } }
```

- `manuallyApprovesFollowers` = `!open_follows`; `discoverable` and `indexable` = the page's
  `indexable`. `summary` is the bio rendered by the inline subset.
- **Page off**: only `id type preferredUsername name inbox outbox followers following featured
  endpoints manuallyApprovesFollowers publicKey`; outbox and `featured` empty. **Suspended**:
  404. **Deleted**: 410 with a `Tombstone`.
- **Collections** are `OrderedCollection`s with **no `totalItems`**, anywhere. `followers` and
  `following` carry no items (the member sees their lists through the app's own API). `outbox`
  holds the `Create` of each public post, newest first, pages of 20. `featured` holds pinned
  public posts as embedded `Note`s, at most 10. A remote server may show no count or a zero;
  either is fine, Ring publishes no counts.
- The instance actor (`/actor`, `Application`) has only the required fields; `Follow`s to it
  are answered `Reject`, **once per actor per day** (a repeat inside the day gets the 202 and
  nothing else), as a courtesy job (7). Its inbox is `/actor/inbox` (its `sharedInbox` is `/inbox`), served
  by the shared inbox's own code: the same checks (5.2), the same routing by the activity's
  object, one handler for both paths.

### 4.4 Posts

```json
{ "id": "https://h/users/ana/posts/pmf3k2q9a7xd4e", "type": "Note",
  "attributedTo": "https://h/users/ana", "published": "2026-10-14T09:12:00Z",
  "to": ["https://www.w3.org/ns/activitystreams#Public"], "cc": ["https://h/users/ana/followers"],
  "content": "<p>new prints drying</p><p>(´ ▽ ` )</p>",
  "source": { "content": "new prints drying", "mediaType": "text/markdown" },
  "summary": null, "sensitive": false, "url": "https://h/@ana#pmf3k2q9a7xd4e",
  "attachment": [{ "type": "Image", "mediaType": "image/webp", "url": "https://h/api/images/<key>/web",
                   "name": "three prints on a line", "width": 1600, "height": 1067 }],
  "ring": { "v": 1, "kind": "image", "kaomoji": "(´ ▽ ` )", "href": "" } }
```

| kind | `content` (what other software shows) | `attachment` | `ring` |
|---|---|---|---|
| `note` | the note through `renderRingMarkdown` | none | `kind` |
| `image` | the note, then the image's link when `href` is set | one `Image`: web variant, `mediaType` (`image/webp`), `width`, `height` (all three from the `images.json` row, 3.11), `name` = alt | `kind`, `href` |
| `link` | `<a href>label</a>`, then `sub`, then the note | the image if any; one `Link` (`href`, `name` = label) | `kind`, `link {href, label, sub}` |
| `embed` | the note, then the media's canonical page URL as a link | none | `kind`, `embed` (canonical URL) |
| `divider` | not federated: wall furniture | | |

- Every federated post: the kaomoji is the last paragraph of `content` and `ring.kaomoji`;
  `cw` becomes `summary` and `sensitive: true`; `url` is the wall anchor `/@name#<id>`;
  `source` carries the raw markdown.
- **A Ring reader renders from `source` and `ring`** through its own `renderRingMarkdown` and
  `ringResolveEmbed`, and ignores `content`: no Ring server ever inserts another server's HTML.
  Other software reads `content`, which this server built from its own escaping renderer.
- A public post's image URL is its public web variant (10.6 serves it to anyone while the page
  is on). A room post's image URL answers only a signed fetch by a ring member (4.7).

### 4.5 Audiences, and the ring decision

- **Public**: `to: as:Public`, `cc: followers`, delivered to followers' shared inboxes.
- **Archive**: never an activity, never in a collection, its object URL 404 to everyone.
- **Ring (room)**: `to: [<Group id>]`, `audience: <Group id>`, no `as:Public`, no followers;
  `ring.room` = the Group, `ring.expires` = `created_at + 7d`. Delivered to the Group's inbox
  only.

**Decision: one `Group` actor per ring, hosted on the ring's home server (the creator's), that
distributes the way FEP-1b12 (Group federation) describes; membership by AS2 `Join`, `Leave`
and `Remove`.** Why, for 3 to 6 members on several servers, invites, and a weekly reset:

1. **One authority.** The 6-seat cap (pending requests included), the join code, approvals,
   kicks and the creator role need one place that decides. With direct addressing every
   author's server holds its own member list, and two servers can admit two different sixth
   members.
2. **A kick or leave takes effect at the one fan-out point.** The next room post never reaches
   the kicked member's server, whatever any author's server still believes.
3. **Authors need no member list.** A room post is addressed to the Group and delivered to one
   inbox; the Group knows who gets it.
4. **The reset fans out the same way**: one `Delete` to the Group reaches every server that
   got the post.
5. **Join links already live on one server**, and the Group is where they point.

Cost: the home is a single point of failure for its ring. While it is down, room posts and
reactions queue (7) and nobody joins; copies elsewhere still expire on time, because every
Ring server enforces `ring.expires` itself. A home gone for good leaves a read-only ring that
empties within a week; its members start a new one.

Rejected: **direct addressing** (each room post `to:` every member actor) needs a replicated
member list on every author's server, makes kicks eventually consistent at every author, and
has no place to enforce the cap. Rejected: FEP-1b12's **`Follow`-to-join**, because a Mastodon
user could then "follow" a ring, and a `Follow` here already means friendship; the Group
drops a `Follow` unanswered (P8 decision, 4.7).

### 4.6 Friends and followers

| Ring act | Sent | At the other end |
|---|---|---|
| A befriends B | `Follow` A to B | B: a request in Inbox (or, with `open_follows`, a follower plus a Befriend offer) |
| B confirms | `Accept{Follow}`, then `Follow` B to A | A's server accepts the crossing follow at once: friends |
| both ask at once | two `Follow`s | each side accepts the other's as crossing: friends |
| either severs | `Undo{Follow}` of its own, `Reject{Follow}` of theirs | both edges gone |
| a friend unfollows | their `Undo{Follow}` | this side sends `Undo` of its own follow: severed |
| someone follows B | `Follow` to B | B's Inbox: Befriend / Let follow / Decline |
| B lets follow | `Accept{Follow}` | they get B's public posts |
| B declines, or later removes them | `Reject{Follow}` | not following |

- A remote friend may be on Mastodon: friendship is two accepted follows whatever the software.
  Their public and unlisted posts then fill the member's Friends feed (on confirm, the first
  page of their outbox is read once); their replies become comments; their favourites become
  stamps (4.8). **A reply is a conversation, not a wall post** (P6): a friend's reply to
  someone else never enters their wall; it reaches a member only as a comment (a reply to
  their post) or From elsewhere (a public mention of them).
- **Befriending across servers** (P6): a typed `name@host` is resolved by WebFinger (the
  answer's canonical handle is the one kept: a split domain may differ), and a `Follow` goes.
  The other side's `Accept` (embedded, or naming the `Follow` by its id alone, as some software
  does) comes only from the followee about a `Follow` this server sent (5.4); their `Follow`
  back crosses the member's accepted follow and is accepted at once: friends. An unlocked
  Mastodon account accepts by itself; a member who never follows back stays a pending request.
- **An inbound `Block`** (4.10) drops the follow rows between that actor and the member, both
  ways, and shows and sends nothing.
- **What a follower sees**: public posts from an enabled page, delivered as they are made, and
  the outbox and `featured` on demand. Never a room, the archive, a friends list, a follower
  list or a count.
- **Follows from outside need approval** by default, exactly like follows from members here;
  `open_follows` is the member's switch.
- Sever sends `Undo` for its own follow and `Reject` for theirs because a server can only
  undo its own activity; Mastodon reads that `Reject` as "removed follower". Sever never sends
  `Block`: a sever is not a block (6.1).
- A member following an account that never follows back is a pending friend request from
  their side; that account's posts are not stored (the Friends feed shows friends only), and
  the member can withdraw.

### 4.7 Rings across servers

**The Group.** Served at `/rings/<ring id>` to a signed GET from a current member (or that
member's server's instance actor). Its `publicKey` (2.6) arrives with it in P7; P2's home rows
are shaped like this document but have no key and no AP route:

```json
{ "id": "https://home/rings/ring_9f0c...", "type": "Group", "name": "Thursday",
  "attributedTo": "<creator actor>", "inbox": ".../inbox", "outbox": ".../outbox",
  "followers": ".../members", "manuallyApprovesFollowers": true, "publicKey": { "...": "..." },
  "ring": { "v": 1, "rev": 12, "capacity": 6,
            "members": [{ "actor": "...", "joined_at": "..." }],
            "requests": [{ "actor": "...", "asked_at": "...", "join": "<Join id>" }],
            "join_url": "https://home/rings/join/<code>", "join_expires": "..." } }
```

A holder of a live join code (a signed GET of `/rings/join/<code>` with an AP `Accept`) and a
pending requester's server get the same Group without `members`, `requests` and `join_url`,
plus `ring.hosts` (the hosts members are on), so the asker sees where the room is held.
Everyone else gets the opaque 404.

**The protocol.** Everything addressed to a room goes to the Group; only the Group fans out.
There is no `Invite` activity: the v1 join link is the invite, and a pushed invite would put a
ring in front of someone whose server never asked for it.

| Ring act | From, to | Activity |
|---|---|---|
| create a ring | local | a home row and a Group with its own key |
| ask by link | joiner's server to Group | `Join {object: Group, ring: {code}}` |
| show the request | Group to member servers | `Update{Group}` (`rev`+1, request listed) |
| approve | a member to Group | `Accept {object: <Join id>}` |
| admitted | Group to joiner; then all | `Accept {actor: Group, object: Join}`; `Update{Group}` to every member; the live room `Announce`d to the newcomer |
| decline | a member to Group; Group to joiner | `Reject {object: Join}` |
| leave | member to Group; Group to the rest | `Leave {object: Group}`; `Update{Group}` |
| kick (creator) | creator to Group; Group to kicked, then the rest | `Remove {object: member, target: Group}`; the link rotates and the handle joins `kicked` (3.6); `Reject{Join}` to each dropped requester; `Update{Group}` |
| rename (any member) | member to Group | `Update {object: {id: Group, name}}`; Group sends `Update{Group}` |
| rotate or close the link | member to Group | `Update {object: {id: Group, ring: {join: 'rotate'|'off'}}}`; `Reject{Join}` to each dropped requester; `Update{Group}` (the new URL in the members-only view) |
| the link expires | the home's housekeeping (7) | the code goes, its requests drop: `Reject{Join}` to each requester; `Update{Group}` (`rev`+1) to the members |
| delete the ring (creator), or the last leaves | to Group; Group to members | `Delete {object: Group}`; `Reject{Join}` to each pending requester |
| room post, stamp, comment, take back, edit, delete | actor to Group | the activity; Group sends `Announce{activity}` to member servers. A stamp, a comment and their take-backs also go, signed by the reactor, to the post's author (P7 review, F2: the authority applies only that copy) |
| a refused or removed reaction | the post's author to Group | `Remove {object: <reaction id>, target: <post>}`, announced |
| the weekly reset | the author's server to Group | `Delete{post}` at `ring.expires`, announced |

- **Checks at the home.** An activity to the Group applies only when signed by a current
  member, or, for `Join`, by anyone holding a live code. `Remove` of a member and `Delete` of
  the ring only from the creator, and so is an `Accept` of a kicked handle's request (403
  `ring_creator_only`). Code, seats (members plus requests under 6) and request state are
  re-checked at approval. A `Create` must be a `Note` by its signer, addressed to
  this Group, with `ring.expires` no later than `published + 7d` and `published` no more than
  5 minutes in the future.
- **Checks at a member's server.** An `Announce` is taken only from the Group of a ring a
  member here belongs to, signed by the Group's key. The inner activity is taken from the
  Announce only when its actor is on the Group's host; otherwise it is fetched from its own
  host, signed as a member here, and the fetched copy is what lands. Room copies expire at
  `min(ring.expires, published + 7d)` whatever happens to the `Delete`. A reaction the Group
  relays changes copies only, never a post of a member here (P7 review, F2).
- **Replicas** apply only an `Update{Group}` with a higher `rev`, so reordering cannot roll
  membership back. A kicked member's server gets the `Remove` and drops the ring, its copies
  and its cached room images at once.
- **The 3-ring cap** is the member's own server's: it refuses to send a `Join` past it, and on
  receiving `Accept` past it (a race) sends `Leave` at once and tells the member.
- **Room images**: the author's server serves a room image only to a signed GET whose signer
  is a current member of the ring of a live post that holds it, and whom the image's owner
  does not block (P7 review, F4). Each member's server fetches it once into its media cache
  (5.7), serves it only to its own members of that ring, and drops it with the copy. A fetch by
  a kicked member's server in the moment before the author's server sees the `Update{Group}`
  is served: that window is accepted. **As built (P7 review, F6)**: a copy's image is fetched
  only from its author's host (or a media host recorded for that host, `hosts.json`
  `media_hosts`), never from a host the copy merely names; its media id is the ring's own
  (`#room:<ring id>`); the fetch is signed as a member here of THAT ring, and only while a
  live copy in that ring, by a current member, names it (asked again at every fetch, a miss's
  included). Each member here of the ring is tried in turn on a 401, 403 or 404 (the author
  may block one of them).
- **Joining from another server.** The join link is `https://home/rings/join/<code>`. Opened by
  someone signed in at the home, it is v1's flow. Otherwise the page asks for their handle,
  resolves it by WebFinger, and sends them to their own server's
  `/authorize_interaction?uri=<join URL>`. Their server (a Ring server, Q1) fetches the Group,
  shows the name, the hosts and the trust notice, checks the 3-ring cap, and on "Ask to join"
  sends the `Join`. A member can also paste a join link into Settings › Rings. **The hosts are
  host names only** (P7 review, F3): at most 6, each of the handle rules' shape and at most 255
  chars; anything else in the Group's `ring.hosts` is left out, and with nothing left the link's
  own host stands for them. A members view's `join_url` is kept only when it is http(s), on the
  Group's own host, at `/rings/join/<code>` with no query or fragment.

> **The honest limit.** A room post that reaches another server is a copy on a machine its
> author does not run. Ring servers delete it at the reset by code, and the Group sends the
> `Delete` as well, but a modified server, a backup, a log or a screenshot can keep it. The
> weekly reset across servers is a promise between cooperating servers, not a guarantee.
> **Admitting a member from another server is consenting to trust that server with the
> room.** The approve dialog says so ("<name@host>'s server, <host>, will hold copies of this
> room's posts and is trusted to delete them after a week"); the ask page tells the joiner the
> same about every host already in the ring; the ring's header always lists the hosts that
> hold it. **As built in P7** the dialog also says the server is trusted to delete them when
> the member leaves or is removed: a removed member's server is told by the Group's `Remove`
> and deletes its copies and their cached images by itself, and nothing can check that it
> did.

**As built in P7** (`lib/groups.js`, `lib/ring-fed.js`, `lib/rooms.js`, `routes/federation.js`;
gates fed-rings and the room half of fed-audience). Where it departs from or settles the
text above:

- **Routing.** An inbound activity is a ring's when it is signed by a `group` record of the
  actor cache (the `ring` table: `Accept{Join}`, `Reject{Join}`, `Update{Group}`, `Remove`,
  `Delete{Group}`, `Announce`), or when its `to`, `audience`, `target` or object names a Group
  whose home is here (that Group's table). It never reaches a member's table or the server's.
- **The Group as an actor elsewhere.** A Group has no WebFinger and no handle: a member's
  server caches it as a `group` record (its inbox, its key, its name) read from the join link
  (the asker's view, fetched with an AP `Accept` and redirects off, its id on the link's own
  host) and refreshed from `/rings/<id>` (served to that server's instance actor once a member
  there is in the ring). A `group` record names no one and acts as no one: what it signs goes
  only to the ring tables, and only for the ring whose `ap_id` it is.
- **Join.** The home reads the joiner's NodeInfo before the Join's tick; a Join from a server
  that does not declare `ringProtocol` (a Mastodon account holding the code) is refused and
  answered `Reject{Join}`, as is one into a full ring: every ask is answered. A member here
  asks by a link of another server from Settings › Rings or the lookup (11.1): the link's host
  must declare `ringProtocol` first (400 `ring_server_only`, nothing fetched past NodeInfo).
- **Fan-out.** The Group Announces to every member's actor; the members here are in-process
  (a no-op: they read the ring live), the others one job per server, never to the server the
  activity came from (it has it). **The block wins at the home** (P7 review, F4): a room post
  (its `Create` or `Update`) of a member here is not Announced to a server whose ring members
  there are ALL people the author blocks (by handle or domain), and the Group's outbox read by
  such a server leaves that author's posts out; their `Delete` still goes. The home cannot see
  a remote author's blocks: for those, the author's own server refuses the blocked member's
  signed fetch of the Note and its images (6.1).
- **Copies.** A remote member's room post is kept as a copy on every server with a member of
  the ring, the home included (`lib/rooms.js`). A copy is a Ring post (a markdown `source` and
  the Ring term; anything else is refused), within 3.10's caps (P7 review, F7). Its images are
  fetched under the read grant, signed as a member there (5.1, 5.7), as F6 above says. It is removed by its author's `Delete` (the reset's
  included), by Keep (the `Update` re-addressing it to Public removes the copy), when its
  author leaves the ring, when the ring leaves the server, and in any case at its own
  `expires`, by read and by the hourly sweep.
- **The Announce checks.** The inner activity must be addressed to the ring (`to` or
  `audience` names the Group) and its actor a CURRENT member of the replica (a member here is
  ignored: this server made it). A room `Note` (a post or a comment) whose actor is not on the
  Group's host is fetched from its own host signed as a member here (each member here of the
  ring in turn, since the author may block one: F4), and only that copy lands; the author's
  server serves a room post (and a room comment kept in `sent.json`) only to a signer who is a
  current member of its ring and whom the author does not block. **Decided in the P7 review (F2): a reaction is
  NOT taken on the Group's word by the post's own server.** A `Like`, its `Undo`, a comment
  and its `Delete` have no document to fetch (a stamp's id answers 404, 2.5), so the reactor's
  server delivers each room reaction, signed by the reactor, both to the Group (which relays
  copies to the members' servers) and to the post author's actor. The post's own server, the
  authority, applies ONLY that reactor-signed copy, with its own rules (tiers, friendship,
  switches, blocks): a `Like`, `EmojiReact` or comment `Create` addressed to the ring, on a
  live room post of a member there in a ring hosted elsewhere, goes to that member's table,
  and one it refuses (from a current ring member) is withdrawn on every copy by its author's
  `Remove`, Announced; the reaction's `Undo` and a comment's `Delete` go through the member's
  and the server's tables like any other. When the author is on the Group's host the Group's
  inbox is that server, and it is one delivery. An Announced reaction (and a `Remove`)
  updates copies on member servers only: a home that lists a member can put a reaction "by"
  them on the copies elsewhere (the trust the home already holds over the room), never on
  the post's own server. Ring sends no comment `Update`.
- **A reaction on a copy.** A member here pressing a stamp (any palette face or a custom
  face: ring-mates get the full palette) or writing a comment (confirmed friends only, in a
  room too) on a remote member's post sends it to the Group and to the post's author (F2,
  above; their server's NodeInfo is read first, so it goes only to a Ring server); on a
  replica it is recorded on the copy at once (the Group never Announces it back), at the home
  the Group's handler records it. It is kept in the member's `sent.json` with its Group, so
  taking it back (`Undo`, `Delete`) goes to the Group and the author too. A member's ring
  activity goes to the ring's Group and, for a reaction, to a current member of that ring,
  never anywhere else (`lib/federation.js`). On a post of a member here in a ring hosted
  elsewhere, this server is the authority: it applies the act in-process first and only what
  it applied goes on to the Group.
- **A room reply is the room's**: on a room post, a reply from a non-friend, or with comments
  off or blocked, is refused (and so withdrawn), never From elsewhere; a room reply is
  private (`to` the Group) and is accepted as a comment only when addressed to the ring of
  the post it answers.
- **The newcomer's room.** The Group Announces the live posts of its members here to a new
  member, and the new member's server also reads the Group's outbox once (`/rings/<id>/outbox`:
  the members' posts here as `Create`s, a copy's by its id alone, so it is fetched from its
  own host), since an Announce that overtakes the `Accept` finds no replica and is dropped.
- **A `Follow` of a Group is dropped (202), never answered** (P8 decision, 4.5). A `Reject`
  would tell anyone holding the Group's URL that the ring exists, while its document is the
  opaque 404 to everyone but its members and askers (11.2); a ring is joined by `Join`, and
  a `Follow` here means friendship. The cost is honest: a Mastodon user who presses follow
  on a ring sees it pending for good. Gate: `moderation` (no answer either way, at the
  Group's inbox and the shared one, the ring unchanged).

### 4.8 Stamps and comments

**Stamps out.** A stamp on a public post goes to the post author's inbox; on a room post, to
the Group and (P7 review, F2) to the author's actor, signed by its sender: the author's server
applies only that copy (4.7). The activity depends on the recipient server's software (NodeInfo, 8.2):

| Recipient software | Sent as | The other side shows |
|---|---|---|
| Ring (`ringProtocol` 1 or more) | `Like`, `content` = the face, `ring: {face, custom?}` | the exact face |
| Pleroma, Akkoma | `EmojiReact` with `content` when the face is in the Emoji style, else `Like` | that emoji, or a favourite |
| Misskey and forks (Sharkey, Firefish, Iceshrimp) | `Like` with `content` and `_misskey_reaction` when the face is in the Emoji style, else a plain `Like` | that emoji, or their default reaction |
| Mastodon and anything else | `Like` (`content` included; Mastodon ignores it) | a plain favourite |

Taking a stamp back sends `Undo` of the same activity. P6, as built: the software is the host's
NodeInfo `software.name` (`pleroma`, `akkoma`; `misskey` and its forks by name), read into
`hosts.json` once a day on use (a failed read is asked again after an hour, and reads as
"anything else"); only a Ring recipient gets the Ring term; a plain `Like` to Pleroma, Akkoma
or Misskey carries no `content`. A stamp on a remote post goes to the author's own inbox
(7), is kept in `sent.json` with the activity as sent, and a different face is the `Undo` of the
old one and a new activity (Mastodon cannot change a favourite). The member's tiers hold out
too: a palette face only (a custom face is a room's), the nice shelf unless the author is a
confirmed friend, never on a blocked author, never while their Ring server says stamps are off
(`ring.stamps_off` on its Person).

**Stamps in.** `Like` and `EmojiReact` both. The face is `ring.face`, else `content`, else
`_misskey_reaction`, compared after NFC with U+FE0F removed. A palette face within the
sender's tier lands as itself; **anything else lands as ♥** (a nice face in the symbols
`garden` group): a reaction is never lost and never widened, and no free text or remote image
ever becomes a stamp. **Refuse versus ♥**: the ♥ mapping is for other software. A `Like` that
carries the Ring term (`ring.v` 1) came from a Ring server, which checks its own sender's tier
before it sends, so out of tier it is **refused** with the key a local press gets (400
`stamp_invalid` for a face outside the palette, 403 `friends_only` for a non-nice face from a
non-friend on a public post, 403 `custom_room_only` for a custom face off a room post), never
mapped: a Ring server that sends one out of tier has a bug, and ♥ would hide it. A plain Mastodon favourite is ♥. A custom face is accepted only from a
Ring server, on a room post, from a ring member (`ring.custom: true`, 20 chars). `Undo` by its
sender removes it.

**Why custom faces are not `Emoji` tags.** A v1 custom face is text (one line, 20 chars), not
an image; an `Emoji` tag is a shortcode plus an image URL, so the mapping would have to invent
an image, and rooms never reach non-Ring software (Q1). Inbound custom emoji reactions
(`:blobcat:` with an `Emoji` tag) land as ♥, and their image is never fetched.

**Comments out.** A `Note` with `inReplyTo` = the post, `tag` = a `Mention` of its author,
`content` = the escaped plain text in one `<p>`. On a public post: `to: [author]`,
`cc: [as:Public]`, delivered to the author's inbox; Mastodon shows an unlisted reply in the
thread. On a room post: `to: [Group]`, `audience: Group`, delivered to the Group and to the
author's actor (4.7, F2). Taking it back sends `Delete`, the same way.

**Comments in.** A `Create{Note}` whose `inReplyTo` is a post here:

- From a confirmed friend, on a post they can see, comments open, not blocked: a comment row.
  The text is the node tree (5.8) flattened to plain text, a leading mention of the owner
  removed, cut at 280 with `truncated: true` and `source_url`, and the card links "more at
  source". From a Ring server (`ring.v` 1), its plain `source` instead.
- From anyone else (a friend whose post's comments are off included): **not a comment, never
  on the wall**: it lands in the owner's From elsewhere (6.4). A blocked sender's lands nowhere.
- **Only a public or unlisted reply** (as:Public in `to` or `cc`) is either: a followers-only or
  direct reply is dropped, because a comment shows on a public wall and a private reply must
  never become public (P6).
- An `Update` by its author re-settles the text; a `Delete` by its author removes it (only rows
  whose stored author is the signer move, 5.4). The owner removes it locally, with no
  activity: the reply stays on its own server. **An edit keeps the comment's rules** (P6
  review, F5): an `Update` that is not public or unlisted removes the comment (a private reply
  never shows on a wall); one from someone who is no longer a friend, whom the owner blocks,
  or on a post whose comments are now off (or that they can no longer see) changes nothing.

### 4.9 Edits, deletes, Keep, pins, profile, accounts

- **Edit** (`PATCH /api/posts/:id`) sends `Update{Note}` with `updated` to the audience the
  `Create` reached (followers' servers or the Group). Kind, audience and `published` never
  change. Only a content change (`note`, `cw`, `kaomoji`, `media`) moves `updated_at` and is an
  `Update`; a pin or a switch changes the row but is not an edit, and a PATCH that changes
  nothing writes nothing and sends nothing (3.2).
- **Shown.** Every save of an enabled page marks each of its public posts `shown`: from then on
  that post was public to the world (on `/@name`, in the outbox, delivered). Its tombstone
  keeps the mark. A page store written before the mark existed counts every public post as
  shown (the safe side).
- **Delete** sends `Delete{Tombstone}` to that audience plus the servers of everyone who
  stamped or commented, **even while the page is off** when the post was ever **shown**:
  copies already delivered or read must be recalled, and the switch only stops new delivery.
  A public post written and deleted while the page was off was never anyone's: no `Delete`
  goes. The weekly reset's `Delete` goes through
  the Group **only while the ring exists**: a dissolved or deleted ring has no Group to carry
  it, and every Ring server expires its copies on `ring.expires` by itself (4.7). The object URL
  of a deleted post that was **shown**, of a page that is **on**, then answers 410 with `{ type:
  Tombstone, formerType: Note, deleted }` from `tombstones.json`. Every other deleted post
  answers 404, as if it never existed: a post never shown, a room or archive post, a divider,
  any post while the page is off, and every post of a suspended or deleted member (whose actor
  answers 404 or 410 itself). A tombstone written before the mark existed keeps the old rule
  (a public post).
- **Keep** of a live room post sends `Update{Note}` to the Group re-addressing it to Public
  (the one audience change a Ring server accepts: room to Public, from the author, which drops
  the expiry and every reaction made under the room grant, 3.7), then `Create` to followers,
  who never had it. Keep from
  the archive sends only the `Create`. A Ring server treats a reset `Delete` that came through
  a room as "left the room": it never tombstones the id against a later Public `Create` by the
  same author.
- **Pin and unpin** send `Add`/`Remove` (`target: featured`) to followers.
- **Profile** changes (display name, bio, avatar, links, theme, switches, page on or off,
  `indexable`, `open_follows`) send `Update{Person}` to every server with a follow either way
  or a shared ring, coalesced to one a minute.
- **Page off** stops new delivery and closes the AP door at once (minimal `Person`, empty
  collections, public post URLs 404). A `Create`, `Update{Note}`, `Add` or `Remove` still
  queued when the page goes off is not sent (7: checked at fan-out and before every attempt);
  the `Update{Person}` saying the page is off still goes. Copies other servers already hold stay there until the
  member deletes those posts: **the switch is not a recall**, and Settings › Page says so.
  Turning it on delivers nothing retroactively; posts made while off are in the outbox.
- **Account deletion** sends `Delete{Person}` (actor = object) to every known server: every
  remote handle the member has a follow with either way, a stamp or comment with either way,
  or a From elsewhere row; one job per server (its shared inbox). The actor URL answers 410
  forever; the name retires. Every queued job the member signs is cancelled except `Delete`,
  `Reject` and `Undo`. **Decided in P6: a remote edge is not severed with its own `Undo` and
  `Reject` any more**: the `Delete{Person}` says it all (Mastodon, Pleroma, Akkoma, Misskey and
  Ring all drop every follow, stamp and comment of a deleted actor), and one job per server is
  the only thing the gone member's key still signs (2.6). A local edge is severed in-process as
  before. The purge queues it through its `farewell` hook, just before that cancel, while the
  member is still active; being a `Delete`, it survives the cancel.
- **`Delete{Person}` in** (P6): from the actor itself only (any other sender's is a 403; a
  `Delete` naming a known actor by its bare id is read as a `Delete{Person}`, whoever sends it).
  The actor is gone (5.3).
- **Suspension** (admin, or a hand edit of `members.json` the server reads in): actor and
  objects 404, deliveries stop at once (every queued job they sign is cancelled except
  `Delete`, `Reject` and `Undo`), inbound for them is dropped; lifting it restores everything
  but the cancelled deliveries. **Decided in P8: nothing is sent on suspension.** A
  `Delete{Person}` would be final on every server while a suspension can be lifted, and an
  `Update{Person}` saying so has no reading other software shares; other servers learn it
  when the actor answers 404. As built: an activity for a suspended member is for no one
  (`lib/federation.js` targetsOf names active members only), so it is never recorded as
  seen and lands if sent again after the suspension is lifted; their personal inbox answers
  the unknown name's 404; their session is no session (`lib/auth.js` loadMember) and their
  wall is the unknown name's 404. The last active admin cannot be suspended. **P8 review**:
  a suspension also cancels every queued `Announce` a home ring's Group (`_ring:<id>`) signs
  that carries the member's room post (a `Create` or `Update` whose actor is theirs), fan-out
  and deliver jobs alike (`lib/queue.js` cancelAnnouncesBy); an `Announce` of their `Delete`
  stays, as their own `Delete` does.

### 4.10 What this server accepts

A closed registry (`lib/ap-inbound.js` `HANDLERS`); anything else answers 202 and is dropped:
`Follow`, `Accept` and `Reject` of a `Follow` or `Join`, `Undo` of a `Follow`, `Like` or
`EmojiReact`, `Create{Note}`, `Update` of a `Note`, `Person` or `Group`, `Delete` of a `Note`,
`Tombstone`, `Person` or `Group`, `Like`, `EmojiReact`, `Announce` (from a ring's Group only),
`Join`, `Leave`, `Remove`, `Flag`, `Block`.

A `Create{Note}` is routed in this order:

1. `inReplyTo` a post here: a comment or From elsewhere (4.8).
2. Inside an `Announce` from a ring's Group: a room copy (4.7). A reply (a comment) inside one
   updates a copy only; on a post here it is taken only as the commenter's own delivery (1, F2).
3. Public or unlisted, from a remote friend of a member here, **and not a reply**: that friend's
   wall cache, for the Friends feed.
4. Public, with a `Mention` of a member here: From elsewhere.
5. Anything else, followers-only and direct Notes included: dropped (Ring has neither).

**As built in P6** (`lib/federation.js` `REMOTE_KEYS`, `ownership`, `targetsOf`):

- From another server the registry is, in P6: `Follow`, `Undo{Follow}`, `Accept` and `Reject` of
  a `Follow`, `Like`, `EmojiReact`, `Undo` of either, `Create`, `Update` of a `Note`, `Article`
  or `Page`, `Delete` of a `Note` (or a `Tombstone`, or a bare id), `Update{Person}`,
  `Delete{Person}` (an actor of any type counts as a Person) and `Block`. P7 adds the ring
  activities (`Join`, `Leave`, `Remove`, `Announce` from a Group, `Update` and `Delete` of a
  Group, `Accept` and `Reject` of a `Join`); **P8 adds `Flag`** (the reports queue, 6.2: the
  server's table, `lib/moderate.js` onFlag).
  **As built in P7** they are routed before the rest (4.7): to a Group whose home is here,
  its table (`lib/ap-inbound.js` `GROUP_KEYS`, a remote member's `Create`, `Update` and
  `Delete` of a Note held to the ownership rule below first; the Group's handlers check
  membership, the creator, the code and the seats); from a ring's Group elsewhere, a fourth
  table, `ring` (`RING_KEYS`: `Accept{Join}`, `Reject{Join}`, `Update{Group}`, `Remove`,
  `Delete{Group}`, `Announce`), reached only when the signer is a `group` record. A room
  reaction signed by its reactor (`Like`, `EmojiReact`, a comment's `Create`) addressed to a
  ring hosted elsewhere, on a live room post of a member here in it, goes to that member's
  table, ownership held first, and a refusal is withdrawn by `Remove` (P7 review, F2). What a ring
  needs fetched (a joiner's NodeInfo, the Group's members, a room Note from its own host) is
  fetched after the signature and before the handler's tick.
- **Ownership is checked before any handler** (5.4): a `Create` or `Update` embeds its object,
  on the actor's host, `attributedTo` the actor; a `Delete` names an object on the actor's
  host; an `Update{Person}` or `Delete{Person}` is the actor's own; an `Undo` embeds an
  activity of its own actor. A failure answers 403 and nothing runs. Then every store moves only
  rows whose stored author is the signer.
- **The route**: a member's table for what is about one member (a `Follow` of them, an answer
  to their `Follow`, a `Like` or reply on their post, a public mention of them, a `Block` of
  them), and the server's own table (`lib/remote-in.js`) for what every member here shares (a
  friend's wall post; an `Update` or `Delete` of a Note held anywhere; an actor's own
  `Update` or `Delete`). The path it arrived on (a personal, shared or instance inbox) never
  chooses: the activity says who it is for. A `Like` of something not here is not for us (202).
- Every route that keeps a remote Note needs it public or unlisted (4.8).
- A friend's `Article` or `Page` is a titled link to its `url` on the Friends feed.
- **Updates and deletes reach only what holds the object** (P6 review, F3): the wall that holds
  its id (the walls' own index) and the members whose comments or From elsewhere rows name it
  (`lib/holders.js`, an in-memory index from a remote object id to those members, built once
  and kept by the stores' writes). An `Update` or `Delete` of an id nothing here holds reads no
  member file and parses nothing. An object is parsed once per activity, however many members
  it reaches (F1).
- **An `Update` keeps the rules its `Create` met** (F5): one that makes a wall post
  followers-only or direct removes it from the wall; a comment's edit keeps the comment rules
  (4.8).
- **A wall entry belongs to its first author** (F11): another handle's `Create` with an id a
  wall already holds is dropped, never an overwrite, and an id in ANOTHER actor's path on the
  same host (`/users/bob/...` from `/users/mallory`) is never the sender's, so it is dropped
  before any wall sees it. Ids outside every actor path (Pleroma's `/objects/<uuid>`,
  Misskey's `/notes/<id>`) pass on the host rule of 5.4 alone, and the first holder keeps them.

Dropped by rule: `Announce` from anyone but a ring's Group (boosts); `Question` and every
object type other than `Note`, except a friend's `Article` or `Page`, which enters the Friends
feed as a titled link to its `url`; `Move` (Q3). An inbound `Block` removes the follow edges
between that actor and the member and shows nothing.

## 5. Federation security

Implementers follow this section exactly. Every rule here has a gate in 16.3.

### 5.1 Signing what goes out

- Every outgoing POST **and** GET is signed with draft-cavage HTTP Signatures, as Mastodon
  does: `Signature: keyId="<actor>#main-key",algorithm="rsa-sha256",headers="(request-target)
  host date digest",signature="<base64>"`. GETs sign `(request-target) host date accept`.
- `Date` (RFC 7231, GMT) is set at each attempt, never at queue time. `Digest:
  SHA-256=<base64>` covers the exact body bytes sent. `Content-Type: application/activity+json`.
  `User-Agent: Ring/<version> (+https://<host>/)`.
- Signer: the member for their own activities; the Group's key for Group activities; the
  instance actor for fetches the server makes for itself (actors, keys, NodeInfo) and for
  `Flag`s; **the member** for fetches of room objects made on their behalf (4.7).
- `lib/http-sig.js` on `node:crypto`. No package. RFC 9421 signatures can be added beside it
  later; cavage stays.

### 5.2 Verifying what comes in

Inbox POSTs, and signed GETs under authorized fetch (5.10), pass these checks in order; the
first failure ends the request (400 malformed, 401 signature, 403 blocked, 413 too large, 429
rate):

1. **Rate** (5.9): per client before anything is parsed (inbox POSTs and signed GETs each
   have their own client budget); a key the request makes this server fetch costs the client's
   key-fetch budget (step 7). The **per remote host** budget is spent only once the signature
   has verified (after step 8), on the verified signer's host: a request that merely names a
   host in its `keyId` spends nothing of that host's.
2. **Shape**: content type (4.1); `Content-Length` and the streamed raw body capped at 256 KB.
3. **Signature header** parses; `algorithm` is `rsa-sha256`, or `hs2019` with an RSA key; the
   signed headers include `(request-target)`, `host` and `date`, and on a POST `digest` or
   `content-digest`: a POST whose signature covers no digest is refused.
4. **Time**: `Date` within one hour of server time either way (Mastodon's own skew margin;
   Mastodon accepts signatures up to 12 hours old, but every sender we know signs at each
   attempt, and a short window keeps the replay set small). `Host` equals this host.
5. **Digest**: every digest header the signature **covers** (`Digest`, `Content-Digest`; their
   SHA-256 or SHA-512 values) equals the hash of the raw bytes. A digest header the signature
   does not cover may ride along only when it agrees with the bytes: a request whose `Digest`
   and `Content-Digest` disagree is refused, whichever is signed. An unsigned header never
   vouches for a body.
6. **Domain block** (admin, 6.3) on the `keyId` host: 403, before any key is fetched. In P6 the
   list was `BLOCKED_DOMAINS` (6.5); from P8 it is the admin's list (`lib/moderation.js`), which
   `BLOCKED_DOMAINS` only seeds. **A person the admin blocks server-wide** (an actor block,
   6.3) is known only once the signature is checked: their POST or signed GET answers 403
   right after step 8 (their key is fetched like anyone's), and so does a forwarded activity
   whose actor is blocked.
7. **Key**: the `keyId`'s actor from the cache, else fetched (5.6) signed by the instance
   actor; the key's `owner` is the actor that holds it; verify. On failure with a cached key,
   refetch the actor once (at most every 10 minutes per actor: that is key rotation) and verify
   again. A fetch costs the client's key-fetch budget (30 a minute, at most 4 in flight) and,
   for an IPv6 client, its /48's aggregate budget (60 a minute, at most 8 in flight), waits on
   the inbound gate (5.6) and takes **5 s** at most per document; a `keyId` whose fetch failed
   is not fetched again for 5 minutes (a negative cache of at most 10 000 keyIds, oldest out; a
   local congestion failure is never cached). **A refusal on this server's side is a 429 with
   `Retry-After`, never a 401**: a spent budget, a full slot set, and a full or slow inbound
   gate (`ERR_BUSY`: the remote was never asked) say "busy", not "your key is wrong". An
   **unbound** key (5.3) signs a GET, never a POST: an inbox POST signed by one is a 401. A
   remote's own answer (a 404 for its key) is never passed on as ours: an unknown key is a 401.
8. **Replay**, on POSTs only: the signature value must not have been seen inside the time
   window, across restarts (5.5). A signed GET has no replay check: an RSA signature is
   deterministic, so two honest fetches of one URL inside the same second carry the same
   value, and a replayed read reads only what its signer may read; the `Date` window bounds
   it.
9. **Body** (POST): parse JSON with a depth cap of 32, dropping `__proto__`, `constructor` and
   `prototype` keys. **The activity's `actor` must equal the key's owner.** When it does not (a
   forwarded activity), the body is not trusted: the activity is fetched by its `id` from its
   own host, with redirects off (5.3), and that copy is processed only when the URL asked for,
   the URL that answered and the copy's `id` are one string, its `actor` is on that host and
   resolves to exactly that actor (an actor on another host is never fetched); else dropped
   (202). An open redirect on a victim's host can never make an attacker's document count as
   the victim's. **That fetch is a key fetch's twin**: the same client and /48 budgets and
   slots (429 past them), the same inbound gate and 5 s, and the same negative cache (an id
   whose fetch failed, or whose copy did not match, is not fetched again for 5 minutes).
10. **Id**: required, an absolute https URL on the actor's host; seen within 7 days: 202 and
    nothing done.
11. **Ownership** (5.4), then member blocks (6.1), then the handler. Only an activity that
    reaches a handler (or the instance actor's answer, 4.3) is recorded as seen (5.5): one
    dropped as not for us, or outside the registry, costs no seen-id storage.

The inbox answers `202 Accepted` once 1 to 10 pass. Work that needs fetching (origin checks,
media) continues in the worker (7).

### 5.3 Actors and keys

- **Every AP document is fetched with redirects off** (actors, keys, forwarded activities): a
  3xx is a refusal, so the URL that answers is always the URL asked for.
- An actor document is accepted only when its `id` equals the URL fetched (else, when the `id`
  is another URL on the same host, it is fetched once more by that `id`, which must then
  match); `inbox`, `sharedInbox`,
  `outbox` and `publicKey.id` are on the actor's host; `publicKey.owner` is the actor id; and
  WebFinger for `acct:<preferredUsername>@<host>` answers with the same actor id (2.4). An
  inbox on another host would make this server POST wherever an attacker points.
- **A handle binds one to one, and rebinding fails closed.** The handle comes from that
  WebFinger pair; a handle already bound in the cache to another actor id refuses the
  newcomer (its document is not accepted, so its signatures do not verify), and every row
  naming the handle keeps pointing at the actor it named. Nothing in P5 moves a handle; the
  gone state below keeps it bound for good.
- Cached 24 hours; a stale entry is used, then refreshed in the worker; refetched at once on a
  signature failure (5.2 step 7). An `Update{Person}` signed by that actor replaces the cached
  fields after the same checks.
- A 410, or a `Delete{Person}` signed by the actor itself (with the cached key; a `Delete` for
  an actor never seen is ignored): the actor is gone. Its follows, friendships, ring seats,
  stamps and comments here are removed (v1's deletion rule, applied to remote people), and the
  cache keeps only id, handle and `gone_at`, so the handle cannot be quietly rebound. As built
  in P6: also its From elsewhere rows, its wall and the members' own reactions on its posts
  (`sent.json`); nothing verifies with its key again (the record has none, and a fetch of its
  document is refused); ring seats wait for P7, where remote members first exist. A 410 on a
  delivery to its INBOX drops only its follow rows (7). As built in P7: its seats, requests and
  join code go from every home ring here (`lib/groups.js` dropHandle, the purge's door); a
  `group` record that answers 410 (its ring deleted at its home) drops the replica here.
- **`Update{Person}` in** (P6): the embedded document passes the same checks a fetch gets
  (inbox, shared inbox, outbox and key on the actor's host, the key's owner), and its handle
  must be the one bound: **nothing moves a handle**, so a new `preferredUsername` is refused
  (that account would be a new actor). The name and bio are settled (5.8) and the walls that
  show the name are redrawn.
- **Decided in P6: an instance actor WebFinger does not answer for.** Pleroma and Akkoma sign
  their fetches with an instance actor (`/internal/fetch`, an `Application`) whose
  `acct:internal.fetch@host` WebFinger may not answer, so the check above would refuse its key
  and their authorized-fetch reads of a wall's outbox and posts would 401. Such an
  `Application` or `Service` key is accepted **for a signed GET only**, cached **unbound**: no
  handle, so it can name no one, act as no one and be blocked by no member (the honest limit of
  6.1 already says an instance-signed fetch cannot be told apart); a domain block still holds.
  It reads what a stranger reads. An inbox POST signed by it is refused (5.2 step 7). A later
  fetch whose WebFinger answers binds it as usual. Tested against a fake Akkoma
  (`fed-ownership`).
- **A transient WebFinger failure never unbinds** (P6 review): when a refetch of an actor
  already bound to the very handle its document names gets no ANSWER from WebFinger (a
  timeout, a refused socket, a 5xx or 429), the binding stays and the new document (a rotated
  key) is taken; only an answer that disagrees (a 200 naming another actor or none, a 404 or
  410) unbinds a server-type actor or refuses the document. A bot account (`Service`) whose
  server blinks keeps acting.

### 5.4 Ownership

- `Create`: the object's `attributedTo` is the actor and the object's id is on the actor's
  host.
- `Update`, `Delete`: **the object's id is on the actor's host**, and for an object held here
  its stored author is the actor (a `Person` updates or deletes only itself and its own
  objects; a `Group` itself). A remote server can never write anything about another host's
  objects or people.
- `Undo`: the undone activity, looked up by id among what was stored, has the same actor; an
  unknown one is dropped.
- `Accept`/`Reject` of a `Follow`: the actor is the followee of a `Follow` this server sent.
  Of a `Join`: the actor is the Group, or (into a Group) a current member.
- `Like`, `EmojiReact`, a reply: the object is a post here the actor can see (public on an
  enabled page, or a live room post of a ring the actor is in). A `Like` of something that is
  not a post here is not for us: 202, nothing recorded.
- `Announce`: only from a ring's Group, signed by it (4.7). As built in P7: the signer is the
  `group` record of the ring's `ap_id` (its key is the ring key on its home); the inner
  activity is addressed to the ring and its actor is a current member; a room Note from
  another host is fetched from that host (4.7).
- `Flag`: from any actor; objects that are not ours are dropped from it. As built in P8: a
  member here, one of their posts or comments counts as ours; a `Flag` with none left is
  dropped (202); at most 20 objects are kept and 50 read.

### 5.5 Idempotency and replay

- Inbound: activity ids deduplicated for 7 days (`fed/seen/`, loaded into a set at boot). Only
  HANDLED activities are recorded (5.2 step 11), each as a fixed-length hash (the first 128
  bits of its id's SHA-256), never the id a sender chose; at most 100 000 in memory, oldest
  out, and a day file past twice that is rewritten from memory (3.10);
  POST signature values deduplicated inside the time window **across restarts**: each value's
  SHA-256 is appended to `fed/replay/<YYYY-MM-DDTHH>.txt`, the hour files still inside the
  window are read back at boot, and housekeeping removes the ones past it (bounded: 200 000
  values in memory, oldest out, and as many lines per hour file); objects deduplicated in the
  stores (a `Create` for a held object id is a no-op; one stamp per sender and post).
- Outbound: a retry resends the same activity id; receivers deduplicate on it.

### 5.6 The fetcher

`lib/net.js` `fetchGuarded()`. **Every outgoing request goes through it,
deliveries included.**

- https only. http and loopback are allowed only under the test hook `FED_TEST_LOOPBACK=1`,
  which the server refuses when `NODE_ENV=production` **and whenever `PUBLIC_ORIGIN` is not
  itself a loopback origin** (`http://127.0.0.1:<port>`, `localhost`, `[::1]`): a server on a
  real domain never opens loopback to its fetcher, whatever `NODE_ENV` says. The hook opens
  loopback only; RFC 1918, link-local, CGNAT, ULA and the rest stay refused under it.
- Resolves **every** DNS answer and refuses the host if any is private: loopback, RFC 1918,
  link-local (169.254/16, fe80::/10), CGNAT (100.64/10), ULA (fc00::/7), multicast,
  unspecified, documentation ranges, and the IPv4-mapped, IPv4-translated (`::ffff:0:0:0/96`)
  and NAT64 forms of those (an embedded IPv4 keeps its IPv4 class). The approved address
  is pinned into the socket's lookup, so a second (rebinding) answer is never used.
- A GET follows at most 3 redirects, each re-resolved and re-checked, unless its caller turns
  them off (every AP document, 5.3); **a POST never follows a redirect** (a 3xx is a failure).
- Caps: AP JSON 1 MB, images 10 MB, avatars 2 MB; connect 5 s; total 10 s for JSON, 20 s for
  media, 15 s for a delivery. A body past its cap aborts the socket. `Accept-Encoding:
  identity`, so the cap is the true size. No cookies, no credentials.
- Content type: an AP document must be `application/activity+json` or `application/ld+json`
  (an HTML page is never parsed as JSON). Media must say `image/*`, and then the byte sniff
  decides.
- **THE host normalizer** (P8 review F4, `lib/handles.js` canonHost): every host a door
  compares or fetches is spelled one way first: lowercase, ONE trailing dot stripped, IDN to
  ASCII (punycode), an IPv4 literal dotted, an IPv6 literal bracketed and compressed as URL
  writes it, a port kept; a host with an empty label (`a..b`, a second trailing dot), a label
  outside `a-z 0-9 _ -` or a bad port is refused. The fetcher asks a URL whose host ends in
  one dot WITHOUT the dot (the name checked is the name resolved and asked), refuses a host
  the normalizer refuses, and checks the blocked domains by the normalized name on every hop.
  The same function is behind the admin's and the members' domain blocks (`hostBlocked`,
  `blocksHandle`, `hostUnder`), `hostOf` in `lib/federation.js`, `lib/actors.js`,
  `lib/queue.js`, `lib/ring-fed.js`, the media cache, the handle writer, and
  `BLOCKED_DOMAINS`. A host the normalizer refuses is blocked wherever a block is asked (fail
  closed). An actor or object whose id spells its host with a trailing dot is refused (its id
  is never the URL fetched, 5.3).
- At most 2 requests at once per remote host, 8 overall. At most 64 wait in line; past that a
  request is refused at once, and a request's wait for a slot counts against its own deadline
  (a waiter whose deadline passes leaves the line). **Inbound key fetches (5.2 step 7) wait on
  a gate of their own** (2 per host, 8 overall, 32 in line), so a flood of them never delays a
  delivery or a fan-out.

### 5.7 Remote media

**Decision: cache and re-encode, never hotlink.**

1. **Privacy**: a hotlinked image tells a remote server every viewer's IP and when they
   looked.
2. **Rooms cannot be hotlinked**: a browser cannot sign, and a room image answers only a
   signed ring member (4.7), so rooms need a server fetch anyway; one path beats two.
3. **CSP stays `img-src 'self'`.**
4. **One door**: every remote image passes the same sharp door as uploads (10.4: sniff, decode
   ceiling, re-encode, metadata stripped), so a remote file cannot carry a decoder payload or a
   GPS tag to a viewer.
5. A remote server going down or changing a file does not break a feed.

Rules: fetched only for what a member here will see (friends' posts and room posts on
receipt, through the worker; the avatars of actors a member's rows name, under 6.4's rules;
never for From elsewhere); only the
`web` (1600) and `thumb` (600) variants are kept, never the original; served at `/media/<id>/
web|thumb` to **signed-in members of this server only**, a room copy's images only to members
of that ring (P7: a `room` row is served only to a member here of ITS ring (the row names the
ring) while a LIVE copy there names it, else the 404 a miss gets; fetched signed as a member
of that ring, redirects off, only from the copy author's host or its media hosts, and
forgotten at once with the last copy that names it; P7 review, F6); never on a public page; dropped with what references them and trimmed least
recently used past `REMOTE_MEDIA_MB`; a miss refetches. At most 4 attachments per remote post;
video and audio attachments are shown as a link to the source and never fetched.

As built in P6 (`lib/remote-media.js`): a fetch goes through `lib/net.js` (the SSRF guard,
https only, `BLOCKED_DOMAINS`, 10 MB for an image and 2 MB for an avatar, the socket aborted
past it, 20 s), must say `image/*`, then the byte sniff, the header's decode ceiling and one
decode at a time (the upload door's own pieces, 10.4), and only the two re-encoded WebP
variants are written (`.rotate()` applied, every byte of metadata gone). At most 4 fetches at
once and 500 waiting; past that a wanted image stays pending and a miss fetches it. A failed
fetch is asked again after a minute. The id is `m_` + 32 hex of SHA-256 of the URL (one URL,
one copy). A lookup (8.5) fetches no media: its images are links to the source. Served with
`private, max-age=86400`.

P6 review (F8): **a miss is never a fetch of its own.** A `/media` miss joins the same line
(at most 4 fetches at once, 500 waiting; a full line answers 404 at once) and waits for its
turn, and a member's misses that put a NEW fetch in the line spend a budget of their own (30 a
minute, 600 a day); a miss waiting on a fetch already in line spends nothing. Avatars follow
6.4's rules and have their own row cap (10 000, apart from the 50 000 image rows), so no flood
of them can fill the table a friend's wall needs.

### 5.8 Remote text

- **Remote HTML is never stored or served as HTML.** `lib/remote-html.js` tokenizes it into a
  node tree of `p br a strong em b i del code pre blockquote ul ol li` and text. `a` keeps an
  `href` only when `ringSafeHref` passes it (http, https). Every other tag is unwrapped to its
  text; `script style template iframe object embed svg math` are dropped with their content;
  no attribute other than `href` survives; Mastodon's `span.invisible` text is dropped and
  `span.ellipsis` gains "…". Clients render the tree with `createElement` or React elements;
  nothing reaches `innerHTML`. **Safety comes from the emitter, not the tokenizer**: a
  tokenizer bug can garble text, never inject markup. No sanitizer package.
- Plain text fields (names, `summary` used as a warning, alt text, link labels): control
  characters and bidi overrides (U+202A to U+202E, U+2066 to U+2069) stripped, whitespace
  collapsed, capped (name 60, warning 200, alt 1500); content text 20 000 chars, then cut with
  a link to the source. Remote content over 60 KB is refused.
- **Invisible and filler characters** (P6 review, F12): every format character (Unicode Cf:
  U+00AD, U+061C, U+180E, U+200B, U+200E, U+200F, U+2060 to U+206F, U+FEFF and the rest) and the
  blank-drawing letters and symbols (U+115F, U+1160, U+3164, U+FFA0, U+2800) are stripped from
  every plain field (`lib/ring.js` `plainLine`). Three joiners stay where they do a job: U+200D
  inside an emoji sequence, U+200C between letters, the emoji tag characters after a black
  flag. A field with nothing visible left is empty, and a remote name that is empty shows as
  the handle. The source spells every such character as a `\u` escape, never literally.
- Custom emoji shortcodes stay text; their images are never fetched. No remote script, style,
  font or iframe, ever: a remote embed URL is rebuilt by `ringResolveEmbed` on its three fixed
  origins or shown as a link.
- As built in P6: the tree is `string` text or `{ t, c, href? }`; an `a` keeps its `href` only
  when it is **http(s)** and `ringSafeHref` passes it (a site-relative path would resolve
  against THIS origin, so it goes too); `noscript title head textarea select xmp noembed
  noframes frameset` are dropped with their content as well; at most 4000 nodes and 24 levels
  (deeper elements unwrapped). The tree is re-checked on every read (`settleTree`), so a hand
  edit cannot widen it, and the app renders it with React elements only (`app/remote-text.tsx`,
  the same allowlist again). `treeToHtml` is the reference emitter the gates read; nothing
  serves it.
- **The parse is linear in its input** (P6 review, F1): "inside a dropped element" and "where
  kept nodes go" are running counters and a stack of kept nodes, never a rescan; at most 64
  open elements are tracked (past it a tag is unwrapped and its closer swallowed; a dropped tag
  past it ends the parse, `cut`); a closer looks at no more than those 64; a tag is read by one
  forward scan that stops at the next `<` or `>` (a `<` with no `>` costs the distance to the
  next `<`); a raw-text element (`script style xmp textarea title noscript`) is skipped by one
  search for its closer; attributes are read (one pass, no regex) only for `a` and `span`. An
  `href` carrying whitespace, a quote, an angle bracket, a backtick or a control character is
  dropped. The gate counts the parser's steps: a 60 KB adversarial input stays under 32 steps
  a byte, and four times the input is about four times the steps.
- **Another Ring server's markdown** (a Ring post's `source`, rendered here by
  `renderRingMarkdown`) keeps **http(s) links only** (F10): a site-relative link would resolve
  against THIS origin, and a `mailto:` is not a web link. The link text stays as text.

### 5.9 Limits

A client is the rate limiter's client id: an IPv4 address, an IPv6 /64, behind `TRUST_PROXY`
the forwarded address. An IPv6 client's /48 has an aggregate bucket on top of its own for
unverified inbound (one site's allocation holds 65 536 /64s). Every refusal is a 429 with
`Retry-After`, a refusal of this server's own congestion (a full fetch line) included.

| What | Limit |
|---|---|
| inbound POSTs per client, before anything | 300/min |
| signed GETs per client, before verification | 120/min |
| key fetches and forwarded-activity fetches a request needs, per client (5.2 steps 7, 9) | 30/min, at most 4 in flight |
| the same, per IPv6 /48 (all its /64s together) | 60/min, at most 8 in flight |
| inbound POSTs per IPv6 /48, before anything | 1200/min |
| signed GETs per IPv6 /48, before verification | 480/min |
| one document fetched for an inbound request (a key, a forwarded activity) | 5 s |
| a `keyId` or forwarded id whose fetch failed | not fetched again for 5 min |
| inbound POSTs per **verified** remote host, after the signature | 120/min, 3000/hour |
| signed GETs per **verified** remote host, after the signature | 120/min, a bucket apart from the POSTs' |
| unsigned GETs (actor, WebFinger, NodeInfo, RSS, `/@name`, and every HTML answer of `/users/*`, spent before anything is read) per client | 60/min |
| inbound body | 256 KB |
| fetched JSON, image, avatar | 1 MB, 10 MB, 2 MB |
| attachments read per remote post | 4 |
| lookups per member | 30/min, 300/day |
| a visitor's "from your server" (8.5), per client | 10/min, 100/day |
| the WebFinger reads every visitor's "from your server" makes, all together | 30/min, 300/hour; 2 at once (1 per host), no line, 3 s each |
| `/media` misses that put a new fetch in line, per member | 30/min, 600/day |
| room copies (P7 review, F7) | 64 KB a settled copy; 500 a ring; 200 live per author a ring; 20 comments per author a copy |
| a join link's hosts, kept and shown (P7 review, F3) | 6, each a host name of at most 255 chars |
| reports per member | 5/min, 30/day |
| reports filed from `Flag`s of one remote SITE (P8; per site since the P8 review, F3) | 10/hour, 50/day (past it dropped, 202); at most 20 of its reports open, 1000 open from all other servers together. The site is `lib/handles.js` siteOf: the registrable domain (the last two labels, three under a common second-level label of a two-letter country code such as `co.uk`), an IPv4 literal itself, an IPv6 literal its /48, the port never counted, so subdomains and ports share one |
| signup confirm mails to one address (P8, 10.11; per day since the P8 review, F5) | 5/day per requester (a client's /48, or its IPv4 address), 30/day from all requesters; both asked before either is spent |
| live pending signups per requester (P8, 10.11) | 10 |
| the admin API, per admin | 60/min, 2000/day |

### 5.10 Separation and authorized fetch

- Federation routes (`/.well-known/*`, `/nodeinfo/*`, `/users/*`, `/inbox`, `/actor*`, the AP
  side of `/rings/*`) **never read a session**: the session middleware is not mounted on them.
  App routes never accept a signature. So the inbox needs no CSRF check, and a cookie can never
  act on it.
- **Authorized fetch** (`AUTHORIZED_FETCH=1`, the default): outbox, collections, posts,
  comments and Group documents answer only signed GETs from unblocked domains (401 unsigned).
  Actors, the instance actor, WebFinger and NodeInfo answer unsigned, because a verifier needs
  a key before it can sign. **Every answer of a signer-dependent route** (outbox, collections,
  posts), the 401 to an unsigned request and the 404 to a blocked or unknown signer included,
  is `Cache-Control: private, no-store` with `Vary: Signature` (`Vary: Accept, Signature` where
  negotiated), so no shared cache hands one signer's answer to another. A WebFinger 404 is
  `no-store` (only a found answer is cached). Negotiated URLs `Vary: Accept`. Negotiation
  honours `q`: an ActivityStreams type is chosen when its q is above 0 and not below
  `text/html`'s, so `application/activity+json;q=0` is a refusal of it, never a request.
- `GET /users/:name/posts/:id` spends its budget (the unsigned one, or the signed one) **before
  it reads anything**, in both its HTML and AP answers, and reads one post from the page
  store's by-id index (rebuilt only when `log.json` changes), never the whole log per request.
- Honest limit: authorized fetch keeps a blocked server from reading through the AP door, but
  `/@name` and RSS stay public on the member's switch, so it is a courtesy wall, not secrecy.

## 6. Moderation

Required for open federation. Ships in P8; P6 carries a stopgap (17).

### 6.1 A member's own tools

- **Block a person**, here or remote: v1's opaque block (their stamps, comments, follows and
  replies on the member's posts refused or hidden, retroactive, enforced at render), plus: the
  member's follow of them is undone and theirs removed (`Undo` + `Reject`), and their signed
  fetches of the member's objects 404. **No `Block` activity is sent**: the v1 block is opaque
  and stays so. Opaque on every surface: a new `Follow` from them is dropped silently, never
  rejected (3.5); their ask to a ring the member is in never reaches the member (3.6); their
  stamp and comment get the "closed" 403, and the member's wall, square and room posts read
  `stamps_off`/`comments_off` true to them, so the page never says open to a shut door. Honest limit: a fetch signed by their server's instance actor cannot be told
  apart from anyone else's on that server, so a PERSON block cannot shut it out; a DOMAIN block
  does (below).
- **A blocked ring-mate** (P7 review, F4). The block wins wherever this server answers: their
  signed GET of the member's room posts, room comments and room images is the stranger's 404,
  `AUTHORIZED_FETCH` on or off, and a ring hosted here never Announces the member's room posts
  to a server whose ring members are all people the member blocks. **The limit**: copies live
  on servers, not with people. A blocked ring-mate on a server that also holds another member
  of the ring (who is not blocked) can still read the copies there, since that server fetches
  and keeps them for the other member. Only the member's own block counts here (whom THEY
  block is their server's business, and the home cannot see it). The full remedy is to remove
  them from the ring (the creator's kick) or to leave it; the composer says so when a member
  blocks a ring-mate (13.1).
- **Block a domain**: every handle on that host and its subdomains is blocked for this member;
  every follow with a handle it matches ends at once, both ways, exactly as a person block's
  do (`Undo` of the member's follow, `Reject` of theirs, pending ones included; never a
  `Block`). Max 100. Spelled through THE host normalizer (5.6) when written and when read
  (`Evil.Example.` is `evil.example`, `bücher.example` its punycode, an IP literal names that
  address only; a hand edit it refuses is dropped), and the remote host the same way, so no
  spelling slips past it (P8 review F4). A member's lookup of a host they block asks it
  nothing (404 before any fetch). **It holds against an unbound key too** (P6 review, F6): a signed read by
  an instance actor that has no handle (5.3) is checked by its key owner's host against the
  member's domain blocks, and gets the stranger's 404 on their outbox, collections and posts.
- **A block holds at send time.** Delivery checks the member's blocks again for every follower
  a post's audience expanded to: a follower blocked (by handle or domain) after the post was
  written gets nothing, and a retry that serves only blocked followers is dropped. An actor
  addressed by name (the `Undo` and `Reject` a block itself sends) is not re-checked.
- **Decline or remove a follower** (3.5).
- **Report** (6.2).

### 6.2 Reports

- A member reports a post, comment, stamp, reply or person, with an optional comment (1000
  chars). It lands in the admin's queue. When the target is remote, the member may tick "also
  send to <host>": a `Flag` goes from the **instance actor** (the reporter's name never
  travels), `object: [actor, post URLs]`, `content` = the comment.
- An inbound `Flag` about a member or post here lands in the queue with the reporting host (and
  actor, if given).
- `reports.jsonl` row: `{ id, from (handle or host), target (handle), objects[], comment,
  forwarded, at, state: 'open'|'resolved'|'dismissed', resolved_by, note }`.
- **As built in P8**: the row adds `kind` (`post comment stamp reply person`), `remote` (a
  `Flag` from another server), `actor` (that Flag's signer's handle, when a person signed it)
  and `resolved_at`. **The server resolves the target**: `POST /api/reports` names the thing
  (a post's URL, a handle, a comment's or stamp's `{owner, post_id, id}`, a From elsewhere
  row's id) and who is reported and which object URLs are recorded come from this server's
  own rows: a post the reporter cannot see is the unknown one's 404, one's own post 400
  `own_post`, oneself 400 `own_handle`; a remote post is found on a friend's wall, in a
  recent lookup, as a room copy in a ring of the reporter's, or fetched. The comment is one
  plain line (5.8), 1000 characters. The outbound `Flag`: `{ id: <origin>/actor/activities/
  <id>, type: Flag, actor: <origin>/actor, object: [the reported actor, the reported objects
  on its host], content }`, to that actor's server (its shared inbox), signed by the instance
  actor; `mayLeave` lets a `Flag` leave only from the instance actor and only naming one
  remote host. The inbound `Flag`: the server's table, budgeted per site (5.9), only our
  objects (5.4), one report per member it names (the P8 review, below); the
  queue's bounds: 5000 rows (the oldest closed row out; all open, a new one refused, 503
  `reports_full`), at most 20 open from one site and 1000 from all other servers, closed
  rows gone after 90 days (housekeeping). The composer offers Report on another's card, a
  From elsewhere row and a looked-up person (13.1).
- **The P8 review** (F1 to F3):
  - **The reported thing has its own fields.** A row adds `post` (the reported post's URL, for
    kind `post`; for a comment or a stamp, the post it is on) and `ref` (for a comment or a
    stamp, which one: `{owner, post_id, id}`). `objects` is only what a `Flag` forwards; no
    removal reads it.
  - **An inbound `Flag` files one report per member it names** (decided: rather than keep
    only one target's objects). A member is named by their actor or by a post of theirs; each
    report keeps only that member's objects (their actor, the posts and comments of theirs the
    `Flag` names), at most 5 members per `Flag`. A report naming a post of theirs is kind
    `post` with the first such post as its `post`, else kind `person`. Each report filed
    spends one of the reporting site's budget (5.9).
  - **Budgets and the open share are per SITE** (5.9 siteOf), so one operator's subdomains and
    ports share 10 an hour and 20 open. **A domain block closes every open report from a host
    it covers, and an actor block every open report that person signed** (state `dismissed`,
    the admin as `resolved_by`, the note `domain_blocked` or `actor_blocked`), so the caps open
    again at once.
  - **The store is append-only** (`DATA/moderation/reports.jsonl`): a new or changed row is
    one line appended and fsync'd (the later line for an id wins, `{id, gone: true}` removes
    one), never the whole file rewritten per insert; it is compacted (one atomic rewrite) when
    its lines pass twice its rows plus 200, after the 90-day prune, or after a crash left a
    torn last line, which is ignored on read. Held in memory and stat-checked on every read
    (a hand edit is read); a damaged line refuses the boot (3.11).
  - **The admin's queue pages**: `GET /api/admin/reports?state=open|closed|all&limit=&cursor=`
    answers at most `limit` rows (50, at most 200), open first and newest first, and `next`,
    an opaque cursor for the page after ('' at the end); a cursor this server never wrote is
    400.

### 6.3 The server admin

- **Who.** While the server has no members, the signup whose email equals `ADMIN_EMAIL` needs
  no invite. **Only that account becomes admin, and it is decided at confirm**: the confirm tick
  asks again that the server still has no member and the email is still `ADMIN_EMAIL`. In that
  window every invite-less signup answers the same `202`, but only `ADMIN_EMAIL`'s gets a
  pending row and a mail, so the answer names no address (10.11). After the first member
  `ADMIN_EMAIL` grants nothing. Under `SIGNUP=open` another account can confirm first: it is a
  `member`, and the server has no admin until one is made from the shell (`scripts/member.js
  make-admin`; in P1, a hand edit of `members.json`, which the running server re-reads, 3.11).
  An admin may make another member admin or step down; the last admin cannot, nor can the last
  admin delete their account while other members remain (409 `last_admin`).
- **`/admin`** (admin only, `noindex`, the same session, CSRF and headers), four tabs:
  - **Reports**: the open queue; dismiss or resolve with a note; from a report, remove a local
    post (its `Delete` federates; its author is told in Inbox), suspend a local member, block a
    remote person server-wide, block their domain, forward to their host.
  - **Domains**: add a block (host, private reason), list, remove. A blocked domain and its
    subdomains: inbound refused (403), nothing delivered or fetched, follows and friendships
    with it removed, its people removed from home rings, its cached actors, walls, room copies
    and media deleted. The list is private.
  - **Members**: list, suspend, unsuspend, make admin, invites. A suspension cancels the
    member's queued deliveries at once, `Delete`, `Reject` and `Undo` excepted (4.9, 7).
  - **Federation**: hosts failing or unavailable (clear the mark), queue depth, the origin and
    `federated_at`. (Ops readouts for the admin, not social counts.)
- Server-wide person blocks (`actor-blocks.json`) work like a domain block for one actor.
- `scripts/member.js` stays for the shell: list, suspend, delete, make-admin, rotate-key.
- **As built in P8** (`lib/moderation.js` the lists, `lib/moderate.js` what a decision does,
  `routes/admin.js`, `routes/reports.js`, `app/admin.tsx`):
  - **A domain block** (and its subdomains) is in the list first, so every door refuses from
    that tick; then the queued deliver jobs to its hosts go, every follow either way,
    friendship, request, stamp, comment, From elsewhere row and reaction sent naming one of
    its handles goes from every member here, its walls go, its people leave the home rings
    (the purge's door: their requests answered, a code they minted closed), a replica of a
    ring hosted on it goes with its copies, its people's copies in rings hosted elsewhere go
    from this server, and its cached actors (a gone record stays: it keeps the handle bound,
    5.3) and media go. **Decided: nothing is sent to it**, not even the `Undo` and `Reject` a
    member's own block sends: the block says nothing is delivered there, and a follow its
    server still lists is inert, since everything from it is refused (Mastodon's suspension
    does the same). Lifting a block restores nothing: the ended follows stay ended.
  - **An actor block** is the same for one remote person: refused after the signature (5.2),
    skipped at fan-out and dropped before an attempt to their own inbox, their rows, wall,
    ring seats, copies and cached record purged. A `Flag` to their server is the one thing
    still sent to it: it is for their moderators. `/api/admin/actor-blocks` looks the handle
    up first (to learn the actor's id and inbox) when this server does not know it, and
    blocks an unreachable one by handle.
  - **What still shows is hidden at render**: a stamp, a comment, a friend tag on a wall, an
    Inbox row, a request, a remote wall or a room copy of a person or domain blocked
    server-wide never shows, whatever a skipped (damaged) file kept, and housekeeping's
    `moderation` step purges it within the hour.
  - **A report action** closes the report as resolved with the admin's note (`dismiss`
    closes it as dismissed); `forward` sends the `Flag` and leaves it open. **A closed
    report refuses every action (409 `report_closed`) but `reopen`**, which puts it back in
    the queue with its closing fields cleared (an open one's `reopen` is 409 `report_open`).
  - **The removals act on the report's own fields, never on `objects`** (P8 review F1).
    `remove_post` only on a kind `post` report, only the post in `post`, and only when that
    post is this server's and its owner IS the report's target: through the one delete (the
    route's; its `Delete` federates). `remove_comment` and `remove_stamp` only on their own
    kind, only the row `ref` names, only when its author IS the target, as the post's owner
    removes one (`lib/comments.js`, `lib/stamps.js` takeBack; a Remove through the Group on a
    live room post). Anything else is 409 `nothing_to_remove`. The notice
    (`post_removed`, `comment_removed`, `stamp_removed`; `members/<name>/notices.json`, 50
    rows, 90 days) goes to the removed thing's AUTHOR when they are a member here, and to no
    one else: never the reporter, never the post's owner; it names no reporter.
  - **After a lookup, asked again** (P8 review): `block_actor` from a report and `POST
    /api/admin/actor-blocks` may look the actor up first (an await); after it they ask again
    that the caller is still a signed-in, active admin (403 otherwise) and, for a report, that
    it is still open (409), before anything is blocked.
  - **An IP literal** (an IPv4 address, or an IPv6 address in any spelling, stored bracketed
    as URL writes it) may be domain-blocked; it covers that address only, at any port.
  - **Members**: `step_down` is one's own; the last active admin can neither step down nor
    be suspended (409 `last_admin`), nor suspend themselves (400 `own_handle`). A suspended
    admin is no admin (the session is gone).
  - **`/admin`** is the composer's page with the admin chunk lazy-loaded by its path; signed
    out it goes to sign-in and back, a member gets the 403 page; `noindex`, never cached.
    The Members tab also holds the signup door's counts and release (10.11).

### 6.4 Defaults

| Case | Default |
|---|---|
| a new follower, here or remote | asks (`manuallyApprovesFollowers: true`) unless `open_follows` |
| a reply or mention from a non-friend | **From elsewhere**: owner only, 30 days, never on the wall, never forwarded; Befriend, Block, Report from there |
| a followers-only or direct Note | dropped (Ring has neither) |
| a stamp from outside | the nice tier; anything else lands as ♥ |
| remote media | fetched only for what a member here will see; served only to members here |
| a remote avatar | fetched only for an actor some member's rows name (a follow either way, a friendship, a comment, a From elsewhere row), only from the actor's own host or a host its server's posts were seen carrying images on (`hosts.json` `media_hosts`), a new avatar URL at most once an hour per actor (the old copy stays meanwhile), and 10 000 avatar rows at most, apart from the images' (P6 review, F7) |
| a server never seen before | treated like any other; blocklist only (Q4) |
| an unavailable host | no deliveries until it speaks again (7) |
| federation itself | off until the admin sets `FEDERATION=on` (15.2) |

### 6.5 `BLOCKED_DOMAINS`, from stopgap to seed

P6 to P7: the operator blocked a domain with `BLOCKED_DOMAINS` (15.3), a comma list of hosts,
each covering its subdomains (a test may name a host with its port, which then matches
exactly): inbound 403 before any key fetch, nothing fetched or delivered, no befriending or
lookup, its cached walls and media swept hourly, its people taken out of home rings by
housekeeping's `rings_blocked` step.

**Decided in P8: the env var is a SEED of the admin's list, imported at boot.** Each listed
host not yet in the list file's `seeded` record is added to the domain blocks (reason
"BLOCKED_DOMAINS", by "env") and recorded as seeded, so an admin who removes it in `/admin` is
not overruled at the next boot, and naming a new host in the env adds it at the next boot.
Each host is read through THE host normalizer (5.6): `Evil.Example.` seeds `evil.example`, an
IP literal names that address (P8 review F4).
The file (`DATA/moderation/domain-blocks.json`) is the one truth; every door asks it
(`lib/moderation.js` hostBlocked): the inbox (5.2 step 6), the fetcher (`lib/net.js`
refuseHost), the queue (fan-out and each attempt), befriending, lookup, the ring doors, the
feeds. The env's import does everything an admin block does, through housekeeping's
`moderation` step (the hourly re-application of every block, `lib/moderate.js` sweep), which
also does what P7's `rings_blocked` step did; that step stays for the replicas and asks.
Gates: `admin` (the seed, a removal standing at the next boot), `fed-ownership` (the P6
behaviour, unchanged).

## 7. Delivery

- **One door.** `lib/outbox.js` `emit(activity, recipients)`: recipients on this server get the
  activity applied in-process by the same handler registry remote ones go through (minus the
  signature step: it never left the process); remote recipients become jobs. P2 runs this with
  no remote recipients, so every social action is an activity from the first social phase.
- **Fan-out.** An activity first lands as one fan-out job, written in the same synchronous tick
  as the change it carries. The worker expands it into one job per target inbox: the shared
  inbox when the actor has one, one per host; the personal inbox for one-recipient activities
  (`Follow`, `Accept`, `Reject`, `Like`, `EmojiReact`, `Undo`, a comment to its author).
- **Job file** `DATA/queue/<job id>.json`: `{ id, seq, kind (fanout or deliver), activity_id,
  activity_type, object_id, object_type, signer, courtesy (an answer to a stranger), recipients (fan-out) or inbox and host (deliver), followers
  (the recipients that came from the signer's followers collection, re-checked against blocks
  at send time, 6.1), body (the exact string), attempts, next_at, created_at, last_status }`.
  Signed afresh at each attempt (5.1).
- **Worker**: one in-process loop over **indexes, never a scan of every job**: a chain per
  (kind, object, inbox) whose head alone may run (ordering in O(1)), a heap of runnable heads
  by `next_at`, per-host heaps of the due ones, and indexes by signer, host, object and
  (activity, inbox). Boot reads every job file into them; one timer wakes for the next due
  job. 8 in flight, 2 per host, picked **round robin across hosts**. A **suspect** host (it has
  never answered a delivery with a 2xx, its last attempt failed transiently, or it is marked
  failing) gets one slot, and suspect hosts together at most 4: hosts that hang, or a crowd of
  new hosts that never answer, can never hold every slot while a proven host waits. A delivery
  POST takes **10 s** at most.
- **Caps**: at most 20 000 jobs, and 1000 deliver jobs per remote host. Past a cap a new job
  is refused with a `delivery_refused` audit line and a log line, **except `Delete`, `Reject`
  and `Undo` signed by a member**: those are never refused (a recall or a severed edge must
  reach the other side); past a cap they are written anyway and the log says so. A
  **courtesy** job (an answer to a stranger: the instance actor's `Reject` of a `Follow`, a
  `Reject` past a member's caps, 3.5) is never essential.
- **Still sendable**, checked when a fan-out runs and before every attempt: a signer who is no
  longer an active member (deleted, suspended) sends only `Delete`, `Reject` and `Undo`; a
  `Create`, `Update{Note}`, `Add` or `Remove` goes only while the page is on and the post is
  still public. Anything else is dropped (`delivery_dropped` audit, its reason). The purge and
  a suspension cancel every queued job the member signs at once, the same three excepted
  (4.9). **P7**: a ROOM post's `Create` or `Update` (to its Group) goes, page on or off, while
  the post is a live room post of a ring its author is still in (else `room_post_gone`); an
  `Update` of a Group (a rename or the link, to a ring hosted elsewhere) and a `Remove` of a
  reaction are no post and go while the signer is active; a Group signs (`_ring:<id>`) and
  is always sendable.
- **What a ring sends** (P7, `lib/federation.js`): only to Ring servers (a host whose
  NodeInfo declares `ringProtocol`, never Mastodon, never a followers collection, nothing
  addressed to Public). A Group's `Update{Group}` and `Announce` go only to the actors of its
  CURRENT members; its `Accept` or `Reject` of a Join goes to the asker whatever their
  software (a refusal to a non-Ring asker is a courtesy job); a member's ring activities go
  to the Group of a ring they are in (a Join, to one they asked by link) and nowhere else.
- **Outcomes**: 2xx deletes the job. 408, 429 (honouring `Retry-After` up to 24 h), 5xx and
  network errors retry. 410 from an actor's inbox drops the job and that actor's follow rows.
  Any other 4xx drops the job with an audit line.
- **Backoff**: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, then daily, with 10% jitter; given up 7
  days after creation (`delivery_gave_up` audit).
- **Dead servers**: a host with failures and no success for 7 days is marked `unavailable`;
  its queued jobs are dropped and none are written. Any verified inbound request from it clears
  the mark, and so can the admin. The hosts table lives in memory (3.10): a mark costs no file
  read, and its write is debounced.
- **Order, per object**: every job carries a sequence number. Jobs about one object reach one
  inbox in the order they were made: a deliver job waits while an earlier one about the same
  object to the same inbox is queued or in flight, and a fan-out waits for an earlier fan-out
  about the same object, so an `Update` never overtakes its `Create` and a receiver never drops
  an edit it saw before the post. A `Delete` cancels queued `Create` and `Update` jobs for its
  object (the `Delete` still goes). A newer `Update` replaces a queued `Update` of the same
  object to the same inbox. Nothing in flight is ever cancelled or replaced.
- **`Update{Person}`, merged within a minute**: at most one goes per actor a minute. The first
  goes at once; one made within a minute of the last waits for that minute to end; any made
  while one waits merge into it (the newest body, the recipients joined), so a burst of profile
  edits sends one `Update` carrying the latest profile.
- **Restart**: jobs are files, so a restart loses none. A job in flight at a crash is sent
  again (at least once; receivers deduplicate by activity id). Jobs past 7 days at boot are
  dropped with an audit line. A damaged job file is moved to `queue/damaged/` with a
  `delivery_damaged` audit line (15.4). Inbound, other servers keep retrying while this one is
  down.

**What runs on a timer, and why.** A federated server makes promises with times in them (a room post goes at a
week, a failed delivery is retried), and keeping them cannot wait for a visitor. On a timer
here, all in-process:

1. the delivery worker's next wake-up;
2. the room sweep: 30 s after boot, then hourly (local room posts and remote copies);
3. the odometer flush, each minute (v1);
4. housekeeping, once at boot and then hourly: activity-id files past 7 days, From elsewhere
   past 30 days, expired join codes and the media cache trim (from the phases that bring
   them), and from P1 the steps below.

P1's housekeeping steps, in order (`lib/housekeeping.js`): expired signup tokens; expired reset
tokens; expired unused invites; unposted uploads past 24 h; image files with no `images.json`
row past 1 h (a crash between the files and the row); hidden write temps past 1 h (in the data
root, `images/`, `keys/`, `members/` and each member dir); expired session files, and destroyed
session ids remembered past a day; staged key files past 1 h; `audit.log` past 90 days; the
`log` provider's mail outbox past 24 hours (the mailer's own prune, 15.3); idle rate-limit buckets and login-throttle
entries. P2 adds expired ring join codes (`lib/groups.js` `expireLinks`, the one door for a
ring change): the code is switched off, the requests it filed drop, each answered with
`Reject{Join}`, and the members are sent `Update{Group}` with the new `rev`. **Every step runs
on its own**: one that throws is logged by name with its stack, and the rest still run. A run that removed something logs one line saying what; an empty run logs
nothing.

The upload sweep never treats "could not read" as "references nothing": an owner whose
`members.json` row or `log.json` cannot be read is skipped, and logged. **The sweep brake**: a
run that would remove more than 20 rows **and** more than 20% of all `images.json` rows refuses,
deletes nothing and logs why.

Not on a timer: actor refresh (on use, when stale) and NodeInfo refresh (on use, daily).

## 8. Discovery and reach

### 8.1 WebFinger

`GET /.well-known/webfinger?resource=acct:<name>@<host>` (also the actor URL or `/@name` URL as
the resource) answers `application/jrd+json`, CORS `*`:

```json
{ "subject": "acct:ana@h", "aliases": ["https://h/users/ana", "https://h/@ana"],
  "links": [
    { "rel": "self", "type": "application/activity+json", "href": "https://h/users/ana" },
    { "rel": "http://webfinger.net/rel/profile-page", "type": "text/html", "href": "https://h/@ana" },
    { "rel": "http://ostatus.org/schema/1.0/subscribe",
      "template": "https://h/authorize_interaction?uri={uri}" } ] }
```

Every active member answers, page on or off (names are public); unknown, retired and suspended
names 404. The instance actor answers as `acct:<host>@<host>`. The subscribe template is
advertised from P5, but **`/authorize_interaction` itself arrives in P6** (8.5): until then it
answers the site's 404. A visitor from ANOTHER server reaches theirs through this server's
`/authorize_interaction/remote`: a same-origin `POST` from the wall's form, answered by a page
that names their server's host and links to its template (8.5), never a redirect.

### 8.2 NodeInfo

`/.well-known/nodeinfo` links to `/nodeinfo/2.1` and `/nodeinfo/2.0`. 2.1 carries `software:
{ name, version, repository, homepage }` (name per Q2); **2.0 is the same document with its
version and without `repository` and `homepage`**, which 2.0's schema does not allow in
`software`. Both carry `protocols: ["activitypub"]`, `services: { inbound: [], outbound:
["rss2.0"] }`, `openRegistrations: SIGNUP === 'open'`, **`usage: { users: {} }`**
(schema-valid, no numbers: Ring publishes no counts), `metadata: { nodeName, ringProtocol: 1
}`. Ring servers recognise each other by `ringProtocol`. This server reads other servers'
NodeInfo once a day per host, on use, into `hosts.json`.

### 8.3 RSS

`/@name.rss`: RSS 2.0 of the 20 newest public posts, under the page switch (404 when off,
`noindex` unless `indexable`), `Cache-Control: public, no-cache` (revalidated, so a page switched
off is gone at once). Item: title = the `cw` or the first line, description = the escaped
rendered post, link = the wall anchor, `guid` = the post's object URL with
`isPermaLink="false"`, enclosure = an image post's web variant with `length` its bytes on disk.
A warned post's title is its `cw` and its description still carries the content: feed readers
show it unhidden, since RSS has no warning. Never rooms, the archive or dividers.

### 8.4 The page head

`/@name` carries `<link rel="alternate" type="application/activity+json" href="<actor>">` (from
P5, and only while `FEDERATION=on`, when the actor answers),
`<link rel="alternate" type="application/rss+xml" href="/@name.rss">`, and renders the
member's `links` as `<a rel="me nofollow noopener">`, so a Mastodon profile that links here,
and that this page links back to, shows as verified. The same links ride the actor's
`attachment` (4.3).

### 8.5 Remote interaction

**P6.** `/authorize_interaction?uri=` (members; WebFinger's subscribe template points here) sends the
member to `/app?open=<uri>`, which resolves a person, post or ring join link through
`GET /api/lookup` (signed fetch, the 5.6 guard) and shows its verbs: Befriend, stamp, comment
when friends, Ask to join. On a wall, a visitor from another server gets "Follow from your
server" and "Stamp from your server": both ask their handle and send them to their own server's
template with the actor or post URL.

As built (with the P6 review's F4 and F9): the wall's "from your server" form **POSTs** the
visitor's handle and the URL to `/authorize_interaction/remote` (same origin, so CSP
`form-action 'self'` allows it). The POST is answered only when it came from this site's own
page (`Sec-Fetch-Site: same-origin`, or an `Origin` of this server; one with neither, or with
another site's, is a 403). The server reads the subscribe template of their handle's server by
WebFinger on a gate of its own (2 at once, 1 per host, no line: a full gate is a 429 at once),
3 s at most, under one budget for every visitor together (30 a minute, 300 an hour) besides the
client's own (10 a minute), so anonymous visitors can never hold the deliveries' or the
inbound gate. It then answers a **page that names their server's host** with a link to the
template ("Go to <host>") and a way back, **never a redirect**: the template must be **https**
(a loopback test host may be http), on the handle's own host, with no credentials in it. A
`GET` of the same path only renders that form (prefilled from `?uri=&handle=`) and fetches
nothing, so a link from anywhere costs no fetch. **Never an open redirect**: `uri` must be a
person or a post of THIS server. A signed-out member goes through `/login` first. The lookup
answers `{ type: 'person' | 'post' | 'join', local }`: a handle or profile URL is resolved by
WebFinger and the actor checks of 5.3; a post URL is fetched signed by the instance actor
(redirects off; an id that is another URL on the same host is fetched once more by that id),
settled (4.10: public or unlisted, by its own author) and remembered for an hour, so a stamp on
it needs no second fetch; a join link of another server (P7) answers the ring's name and the
hosts that hold it (read from the link, Ring servers only, 4.7), and whether the member is in
it, has asked, or is at their cap. A blocked
author, a blocked domain and anything unresolvable answer 404. Settings › Friends has the same
look-up field.

### 8.6 Search engines

Unchanged from v1: `noindex` unless the page is `indexable`; auth pages, `/app`, `/admin` and
AP documents are `noindex`.

## 9. The server's primitives

Every route is an injected Router: its dependencies arrive in `ctx`. These are the ones the
social layer is built on.

| Primitive | What it is |
|---|---|
| `requireMember` | a live, active member in the session, else 401 (pages: `/login?next=`) |
| `requireAdmin` | 403 for non-admins, for `/admin`; one login per member, no team roles |
| `req.member` | `{ slug, display_name, role }`, set once per request |
| `memberDir(slug)` | `DATA/members/<slug>`, path-only, slug validated; `path.join` |
| own read | `req.member?.slug === params.name` |
| a wall's owner | the `:name` path parameter, looked up in `members.json` |
| `pageOpen(slug)` | the store's `enabled`; denial is the same 404 as an unknown name |
| a wall's address | `'/@' + slug`, same origin |
| `PUBLIC_ORIGIN` | required in production, permanent once federated (15.2); the request origin in dev |
| `displayName(handle)` | `members.json` for local, the actor cache for remote, memoized |
| `friendHandles(slug)` | accepted follows both ways, from `follows.json` |
| the viewer | `req.member?.slug`: the session here; a remote viewer acts by signed activity, never by page |
| a reaction's target | `:name` + `pageOpen`, or a ring shared with the viewer |
| `loadStamps(owner)` / `saveStamps(owner, rows)` | the stamp rows on an owner's posts (3.7) |
| `loadComments(owner)` / `saveComments(owner, rows)` | the comment rows on an owner's posts (3.7) |
| `loadRings` / `saveRings` | `normalizeRings` on every read; `ap_id`, `home`, `rev`, replicas (3.6) |
| `imageGate.invalidate(slug)` | drops a member's public image list (10.6) |
| `lib/rate-limit.js` | `rateLimit` (IP), `memberLimit` (member), `missLimit`, `hostLimit` (remote host) |
| `audit(event, actor, details)` | JSONL, kept 90 days |
| `allMemberSlugs()` | every member of this server |
| `escapeHtml` (`lib/security.js`) | THE escape for user text going into HTML |

## 10. Privacy and security rules

1. **Zero new access, on any server.** The square and Friends feeds show only what each author
   made public on an enabled page, read live through that switch; a ring feed only posts
   addressed to that ring. The AP door serves no more than `/@name` does, plus room posts to
   that room's members. A ring-mate gets no other post, no archive, no settings; a follower
   gets nothing a stranger does not.
2. **A page that is off is absent:** `/@name`, `GET /api/pages/:name` and `/@name.rss` answer
   the same 404 (`noindex`) as an unknown name (for the HTML and the feed, the site's one 404
   page: the same status, body and headers), and its public images 404 to all but the
   author. Over AP the actor stays (minimal: keys and rings need it), outbox and `featured` are
   empty, and public post URLs 404. Copies already delivered stay where they are (4.9).
3. **Audience is immutable** after create; the only move is the author's one-way Keep (4.9).
4. **One image door** (`lib/images.js`: upload and remote media): real-bytes sniff
   (JPEG, PNG, GIF, WebP; SVG and all else refused); 10 MB per upload or remote image; the
   decode ceiling read from the header before
   anything is written (413 `too_many_pixels`): 80 MP for a still image, and for an animated
   one 25 MP counted over **all frames** (width x height x frames) and at most 200 frames;
   **every original re-encoded by sharp** in its own format (`.rotate()`, metadata dropped;
   GIF and WebP re-encoded too, animation kept), a failed re-encode refuses, never writes raw;
   variants `web` 1600 and `thumb` 600, **always WebP** (`image/webp`), made before the answer,
   so a 201 means servable. Bounded work: every sharp pipeline carries a 20 s timeout; decodes run one at a
   time with at most 4 waiting, past that 503 `busy`; the upload gate runs before a byte is
   read: 2 uploads at once, 4 waiting with their bodies unread, past that 503 `busy` with
   `Retry-After`, and one upload per member at a time (429 `upload_in_progress`). The owner is
   checked again in the commit tick: an upload whose owner was deleted, suspended or signed out
   while it decoded writes nothing (401 `not_signed_in`).
5. **Server-minted, unguessable keys:** `img_` + `imageStamp()` (`<ms>_<16 hex>`, 64
   CSPRNG bits); the client never names a key. Ownership in
   `images.json`; **a post, theme or avatar may only reference its author's images** (400).
   Quota `MEMBER_STORAGE_MB` (500), 413 `storage_full`.
6. **The walled-image rule.** `/api/images/:key/web|thumb` serves when the viewer owns it; or
   it is the avatar, the theme background or a public post's image of an **enabled** page
   (a page that is off serves none of them); or the viewer shares a ring with the owner
   and the key is on a live post in that room; **or the request is signed by a current member
   of the ring of a live room post that holds the key** (a member's server fetching for its
   cache, 4.7). **As built in P7** the signed branch is answered in `routes/federation.js`,
   mounted before the session (5.10: a route that takes a signature never reads a session):
   a request carrying a `Signature` is verified there (the signed-GET budgets of 5.9) and
   answered by it alone, a signer the image's owner blocks getting the 404 (P7 review, F4);
   one without goes on to the session's gate. Else 404. Room and archive
   images `private, no-store`, public `private, max-age=31536000`. Misses cost 100/min,
   1500/day per client id (10.7); a path whose %-escape cannot be decoded is a 404 miss too.
   Originals never serve. `/media/*` (remote copies) serves only to signed-in
   members here (401 to anyone else), a room copy's only to that ring's members (P7); its
   misses spend a budget like the image gate's (100 a minute, 1500 a day).
7. **Rate limits**: stamp 20/min 200/day; comment 6/min 100/day;
   friend request 5/min 30/day; ring create 5/min 30/day; link rotate 10/min 60/day; join
   preview 20/min 200/day; join ask 10/min 60/day; post 30/min 300/day (create and edit
   share it), upload 30/min 300/day, signup 5/min 20/day and 5 mails a day per address and requester, 30 per address (10.11),
   confirm 10/min 100/day, login 10/min 100/day, forgot 5/min 20/day and 3/hour per email,
   reset redeem 5/min 50/day, password change and account deletion 5/min 30/day (one bucket),
   handle check 30/min 1000/day, invite mint 10/day, settings writes (`PATCH /api/me`, `PUT
   /api/me/page`) 60/min 1000/day, wall reads (`GET /api/pages/:name`) 60/min 5000/day, and
   `/@name` and `/@name.rss` 60/min 5000/day each (their own buckets).
   **Signed in, the bucket is the member's; anonymous, it is the client id**: IPv4 as is, an
   IPv4-mapped IPv6 address unwrapped to its IPv4, any other IPv6 address cut to its /64 (one
   subscriber, one budget, however many addresses it holds); behind `TRUST_PROXY` the address
   is the client's from the proxy. The login throttle's pair key uses the same client id.
   Loopback is not exempt (behind a proxy on the same box every request is
   loopback). A refused call takes nothing; a 429 carries `Retry-After` and `retry_after`.
   The bucket map and the throttle's map are bounded (100 000 keys each, the oldest-touched 1%
   out when full), because their keys are typed by strangers. Federation limits in 5.9.
8. **Text:** `renderRingMarkdown`, `ringInline`, `ringSafeHref`, `ringResolveEmbed` change
   **only with a security review** (escape first, then a fixed grammar we emit; http(s), mailto or site-relative
   links with `rel="nofollow noopener ugc"`; embeds rebuilt on fixed origins). Comments and
   custom faces stored raw, bounded, escaped by every renderer. Bad hrefs also refused at
   write. Remote text follows 5.8. The sanitizer and `lib/remote-html.js` change only with a
   security review.
9. **Sessions:** `express-session`, `httpOnly`, `SameSite=Lax`, 30 days rolling (the file is
   rewritten at most hourly), path `/`. The cookie is `ring.sid` outside production and
   `__Host-ring.sid` in production, where it is `Secure` (so no sibling host can plant it for
   the parent domain); `TRUST_PROXY` is required there (15.3), or the Secure cookie is never
   set. The id **rotates at login**. Password change ends the other sessions and voids every
   outstanding reset link; reset and deletion end all. A session ends twice over: its file is
   deleted, and the member row's `sessions_from` cutoff (3.1) makes any session stamped
   earlier no session, so a request in flight cannot write one back. Session files are named by
   the SHA-256 of the id. **A damaged session file is no session**: it is logged, deleted, and
   that cookie is signed out; it never 500s a request nor stops a walk over the others.
   Federation routes never read a session (5.10).
10. **CSRF:** SameSite=Lax plus one middleware on every method but GET, HEAD and OPTIONS:
    403 `csrf` when `Sec-Fetch-Site` is `cross-site`, or when an `Origin` header is present and
    is not this server's origin (`PUBLIC_ORIGIN`; the request's own origin in development,
    never a Host-derived one when `PUBLIC_ORIGIN` is set). **A request with no `Origin` and no
    `Sec-Fetch-Site` passes**: it is not a browser's (every current browser sends `Origin` on a
    non-GET), so curl and scripts work; SameSite=Lax keeps the cookie off a cross-site POST anyway, and a cross-site form
    cannot send `application/json`. JSON routes require `application/json` (415
    `json_required`) and cap at 64 KB; only upload takes multipart. The inbox is
    outside this middleware because it never reads a session; it has its own checks (5.2).
    **One GET takes the same test**: `GET /api/me/export` spends a budget and a top-level
    cross-site navigation carries the Lax cookie, so it answers the same 403 `csrf` (one
    function, `foreignRequest` in `lib/http.js`) before the budget is touched (12).
11. **No email enumeration.** Signup always answers `202 { check_email: true }` once the
    request is well formed; the row exists only once the mailed link is used, and a taken email
    gets an "already have an account" mail instead. **Signup and forgot answer before doing
    their work**: signup hashes the password on every path, answers, then in the same tick
    does its store write and mail; forgot answers, then looks up, writes the token, audits and
    mails. Every path makes exactly one fsync'd write of the token file (a path with nothing to
    store rewrites it unchanged), so neither the answer's time nor its shape says which path
    ran. Signup's mails to one address are quiet: 5 a day per requester, 30 a day in all (past that, still 202, no mail).
    **The mailbox holder's password**: the pending row keeps the bcrypt hash of the password
    chosen at signup, and confirm takes `{ token, password }` and refuses (403
    `password_mismatch`) unless it matches, so a signup planted for someone else's address can
    never be completed by the mailbox owner with their own password. Pending rows are bounded:
    at most 3 live per email and client id, and 10 000 in the file; past either, the new row is
    refused (still 202, no mail), **never evicting** an existing one. Reset rows: 1 h, at most
    3 per member, the oldest out. Before the first member, every invite-less signup answers the
    same 202 and only `ADMIN_EMAIL` gets a row and a mail (6.3). Login has one `401
    invalid_credentials`, an unknown email costs a dummy bcrypt compare, the row is re-read
    after the compare (a reset that committed meanwhile wins), and
    `lib/login-throttle.js` is checked before the compare (10 per 15 min per client id and
    email, 30 per hour per email; a success clears its pair, a reset clears the email). Names
    are public: WebFinger and the actor answer for every active member.
    **Password work is bounded**: every bcrypt hash and compare goes through one FIFO queue,
    one at a time with a turn for the event loop between two, at most 32 waiting; past that, a
    route that hashes or compares a password (signup, confirm, login, password change, deletion,
    reset) answers 503 `busy` with `Retry-After: 5`, never a wrong-password answer. A password
    change or deletion re-reads the row after its awaits and answers 409 `password_changed`
    when a reset committed meanwhile.
    **P1's known limit, bounded in P8** (`lib/signup-guard.js`; made exact in the P8 review,
    F5): a stranger could spend an address's signup-mail budget, or fill the 10 000-row
    pending cap from many client ids, delaying a real signup. Now the REQUESTER is a client's
    /48 when it is IPv6 (one site holds 65 536 /64s), else its IPv4 address, and: the confirm
    mail's budget is 5 a DAY (rolling 24 hours) per address AND requester, so a stranger
    spends only their own and never the mailbox owner's; a ceiling of 30 a day per address
    from every requester together keeps the door from mail-bombing anyone; **both are asked
    before either is spent**, so a refused attempt spends nothing: a requester's attempts
    beyond its own 5 never count toward the ceiling, and an owner who tries while the door is
    held loses none of their own. Hence, exactly: **in any 24 hours one requester puts at
    most 5 mails into an address's ceiling, so holding an address shut takes six distinct
    requesters (six IPv4 addresses or six IPv6 /48s), each spending its whole day's 5 on that
    address; fewer can never close it.** A requester holds at most 10 live pending rows, so
    filling the file takes a thousand requesters. Three things open a held address: **the
    owner's own confirm** (a mailed link clicked through to an account clears the address's
    ceiling and its other pending rows); **the admin's release** in `/admin` › Members, which
    shows the door's counts (rows, the cap, requesters at their share: they name no one,
    never an address) and offers `release` (the admin types an address: its ceiling as if
    never spent, its pending rows gone; the same answer whether or not anything was held) and
    `clear` (every pending row; each person signs up again, no account is touched); and,
    **before any admin exists** (before the first member the held address may be
    `ADMIN_EMAIL` itself), **the shell**: `npm run signup-release -- <address>`
    (`scripts/signup-release.js`) leaves a release note `DATA/signup-release/<sha256 of the
    address>` (the address itself is written nowhere), which the running server applies at
    the next signup attempt for that address, or a stopped one at its first after boot (one
    `signups.released` audit line by `shell`). A release leaves each requester's own count as
    it was, so the requesters that held the door cannot refill it until their own day has
    rolled. Every path still answers the same 202 and makes
    the same one fsync'd write. It never hands over an account: the token goes only to the
    mailbox, and confirm needs the owner's password.
12. **Headers:** CSP `default-src 'self'; img-src 'self'; frame-src` the three embed origins;
    `style-src 'self' 'unsafe-inline'` (the wall's seeded inline vars); `script-src 'self'`,
    `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`;
    `X-Frame-Options: DENY`; `nosniff`; `strict-origin-when-cross-origin`;
    `Cross-Origin-Opener-Policy: same-origin`; in production
    `Strict-Transport-Security: max-age=31536000`. `img-src 'self'` holds because remote
    images are served from this origin (5.7). WebFinger, NodeInfo, actors and RSS send
    `Access-Control-Allow-Origin: *`; nothing else does. Auth pages, `/app` and `/admin` are
    `noindex`.

## 11. HTTP surface

Auth: `-` public, `M` member, `A` admin, `R` ring member (opaque 404 otherwise), `S` signed
(HTTP Signature, required under authorized fetch), `S*` signed by a ring member or a pending
requester, or their server's instance actor.

### 11.1 The app's JSON API

The target is a path segment, not a host: own
things under `/api/me` and `/api/posts`, someone's wall under `/api/pages/:name`. A `:handle`
in a path is URL-encoded (`ana%40h.example`).

| Method, path | Auth | Does |
|---|---|---|
| `POST /api/signup` | - | `{email, password (10 to 200), slug, display_name, invite}` → 202, answered before the work (10.11); `invite` required unless `SIGNUP=open` or the `ADMIN_EMAIL` signup before the first member (6.3) |
| `POST /api/signup/confirm` | - | `{token, password}` (the password chosen at signup; else 403 `password_mismatch`) → the keypair, then the member row; signs in |
| `GET /api/names/:slug` | - | `{ available }`; reserved and retired names are not |
| `POST /api/login` · `POST /api/logout` | - · M | 200 · 401 · 403 `suspended` · 429; logout destroys the session |
| `GET /api/me` · `PATCH /api/me` | M | profile, role, page switches, unseen count; `{display_name}` |
| `POST /api/me/password` | M | `{current, next}`; ends the other sessions, voids every outstanding reset link; 409 `password_changed` when a reset committed during the check |
| `POST /api/password/forgot` · `/reset` | - | `{email}` → 202, answered before the work; `{token, password}`, ends every session |
| `DELETE /api/me` | M | `{password}`: purge (11.4) and `Delete{Person}`; 409 `password_changed` as above, 409 `last_admin` (6.3) |
| `GET` · `POST /api/invites` · `DELETE /api/invites/:id` | M | list, mint (5 live, single use, 14 days), revoke |
| `GET /api/me/page` · `PUT /api/me/page` | M | the raw store; `enabled indexable open_follows stamps_off comments_off theme bio avatar_key links block unblock block_domain unblock_domain` |
| `POST /api/posts` | M | create; a room needs membership; `archive` and unknown kinds refused |
| `PATCH /api/posts/:id` | M | edit; `kind`, `created_at`, `audience` immutable; sends `Update` |
| `DELETE /api/posts/:id` | M | with its stamps, comments and its image when nothing else references it and **the author owns it** (a delete frees only the author's own images); a tombstone keeps the id; sends `Delete` |
| `POST /api/posts/:id/keep` · `GET /api/archive` | M | to Public (sheds what the room grant allowed, 3.7; 409 `page_off`); my shelf, lapsed room posts included before the sweep |
| `GET /api/pages/:name` | - | a wall of this server: theme, bio, avatar, links, public posts, stamps, comments, palette, friends `{name, handle, url}`, visits; 404 when off |
| `GET /api/feed?cursor=` · `/api/feed/friends` | M | the square (20 a page, this server only); friends, local and remote, `muted`, `me_page_off` |
| `POST`, `DELETE /api/pages/:name/posts/:id/stamp[/:sid]` | M | press, toggle, replace; owner or author removes, else opaque 404 |
| `POST`, `DELETE /api/pages/:name/posts/:id/comment[/:cid]` | M | friends only; owner or author removes |
| `POST`, `DELETE /api/remote/stamp[/:id]` | M | `{object, face}` on a remote post seen in a feed or by lookup (4.8: shaped for the other side's software; the same face again takes it back) → `{ action: added·changed·removed, mine, id, sent_as }`; take back (`Undo`). The stamp budget. P7: on a ROOM copy (a remote member's post in a ring of the member's), a palette or a custom face, to the ring's Group, and the answer adds the copy's `stamps` and `comments`; the comment route the same (friends only) |
| `POST`, `DELETE /api/remote/comment[/:id]` | M | `{object, body}` on a remote friend's post (403 `comments_friends_only` otherwise) → `{ id, comments }`; take back (`Delete`). The comment budget |
| `GET /api/inbox` · `POST /api/inbox/seen` | M | `{ join_requests: [{ring: {id, name}, handle, name, url, short_name, asked_at, kicked?}], follow_requests: [{handle, name, url, at}], stamps: [{id, kaomoji, custom?, tint?, at, author, post_id, seen}], comments: [{id, body, truncated?, source_url?, at, author, post_id, seen}], elsewhere: [{id, kind: reply·mention, author, tree, cut?, summary, url, at, published, seen, post_id?}], unseen }`, newest first; a blocked handle's rows and requests never show. `unseen` (also on `GET /api/me`) counts the unseen stamps, comments and From elsewhere rows (P6) plus every request waiting for an answer (join and follow); marking seen touches reactions and From elsewhere, a request stays until answered |
| `GET /api/friends` · `GET /api/friends/with/:handle` | M | friends here and elsewhere; `none·pending·friends` |
| `POST /api/friends` · `/api/friends/:handle/confirm` · `DELETE /api/friends/:handle` | M | `{handle}` befriends (or confirms a crossing); a remote `name@host` is resolved by WebFinger first (P6; unresolvable, or a blocked domain: 404); confirm; sever |
| `GET /api/followers` · `POST /api/followers/:handle/accept` · `/reject` | M | followers and requests; let follow; decline or remove |
| `GET /api/lookup?q=` | M | `name@host`, a profile URL, a post URL or a join link → a view (8.5): `{type: 'person', local, handle, name, url, host, avatar_url?, bio?, status}`, `{type: 'post', local: false, post (a remote card), friends}`, `{type: 'post', local: true, owner, id, url}`, `{type: 'join', local, code·url}`; 404 when nothing answers; 30 a minute, 300 a day |
| `/api/rings/*` | M · R | 13 routes, an opaque 404 to non-members on each: `GET`, `POST /api/rings` (create, 5 a minute, 30 a day); `PATCH /api/rings/:id` (rename), `POST`, `DELETE /api/rings/:id/link` (rotate, off), one budget of 10 a minute, 60 a day; `GET`, `POST /api/rings/join/:code` (preview 20 a minute, ask 10 a minute); `POST /api/rings/join {url}` (ask by a pasted link, the same budget; another Ring server's from P7: 200 `{requested, name, remote}`, 400 `ring_server_only` on a server that is not a Ring server, 404 for a blocked domain or a dead link; the Group's answer comes later); a ring view carries `home`, `home_host` and `hosts` (every server that holds the room) and each member's and asker's `host`; approving an asker any member here blocks is 409 `ring_blocked` (P7); `POST /api/rings/:id/requests/:handle {approve}` (30 a minute, 300 a day); `POST /api/rings/:id/leave`; `DELETE /api/rings/:id/members/:handle` (kick); `DELETE /api/rings/:id`; `GET /api/rings/:id/feed` |
| `POST /api/reports` | M | 6.2: `{kind: post·comment·stamp·reply·person, url·handle·owner,post_id,id·id, comment?, forward?}` → 201 `{id, forwarded}`; the server resolves the target (6.2 as built) |
| `POST /api/images` | M | multipart `image` → 201 `{ key, url, thumb_url, width, height }`; 429 `upload_in_progress`, 503 `busy` (10.4) |
| `GET /api/images/:key/web` · `/thumb` | gated | 10.6 |
| `GET /media/:id/web` · `/thumb` | M, gated | cached remote media (5.7) |
| `GET /api/me/export` · `POST /api/me/export {password, key: true}` | M | the export zip, streamed (12); the second form, with the password typed again, adds the signing key (403 `wrong_password`, 409 `password_changed`); the GET refused to another site (403 `csrf`) before the budget; 3 a minute, 20 a day; 2 at once on the server (503 `export_busy`, `Retry-After`); cut after 60 s without a read; 413 `export_too_large` over 2 GiB |
| `GET /api/admin/reports` · `POST /api/admin/reports/:id` | A | the queue a page at a time (`?state=open·closed·all`, `limit` 50 to 200, `cursor`) → `{reports, next}`, a bad cursor 400; `{action: dismiss·resolve·remove_post·remove_comment·remove_stamp·suspend·block_actor·block_domain·forward·reopen, note}`, a closed report 409 `report_closed` but for `reopen`, a removal with nothing it may remove 409 `nothing_to_remove` (6.3) |
| `GET` · `POST` · `DELETE /api/admin/domain-blocks[/:host]` | A | list, add `{host, reason}` (a host in any spelling THE normalizer reads, or an IP literal; the answer carries `reports_closed`), remove |
| `GET` · `POST` · `DELETE /api/admin/actor-blocks[/:handle]` | A | server-wide person blocks |
| `GET /api/admin/members` · `POST /api/admin/members/:name` | A | list; `{action: suspend·unsuspend·make_admin·step_down}` |
| `GET /api/admin/federation` · `POST /api/admin/federation/hosts/:host/clear` | A | failing and unavailable hosts, queue depth, origin; clear a mark |
| `GET` · `POST /api/admin/signups` | A | P8 (10.11): the signup door's counts; `{action: release, email}` or `{action: clear}` |

P8: every `A` route answers 401 signed out and 403 `forbidden` to anyone but an active
admin, never cached, on one budget (5.9). `GET /api/inbox` adds `notices: [{id, kind:
post_removed, at, seen}]` (6.3), counted in `unseen` and marked seen with the rest. P8's error
keys: 400 `host_invalid` `handle_invalid` `own_host` `not_local` `not_remote`; 409
`block_limit` `nothing_to_remove` `already_forwarded` `not_forwardable`; 503 `reports_full`.

**Errors.** Every error answers `{ error: <key>, message }`: the key is the contract a client
branches on, the message (`lib/strings.js`) what it may show. P1's keys, and P2's (the
social layer, marked P2 in each row):

| Status | Keys |
|---|---|
| 400 | `bad_json` `bad_request` `email_invalid` `password_short` `password_long` `name_invalid` `display_name_invalid` `invite_required` `invite_invalid` `token_invalid` `unknown_kind` `empty_post` `bad_href` `bad_embed` `foreign_image` `not_in_ring` `archive_refused` `posts_full` `invalid_field` (with `field` on `PUT /api/me/page`) `no_file` `unsupported_image` `image_failed`; P2: `own_post` (a stamp or comment on your own post) `stamp_invalid` `comment_empty` `own_handle` (befriending yourself) `ring_name_required` `ring_limit` (your 3 rings) `ring_limit_them` (their 3 rings, at approval) `ring_full` `leave_instead` (the creator kicking themself) `join_expired` (approval after the code lapsed; the request is spent) |
| 401 | `not_signed_in` (also a write whose member was deleted or whose session ended while it ran) `invalid_credentials` |
| 403 | `csrf` `forbidden` `suspended` `wrong_password` `password_mismatch` `invites_off`; P2: `custom_room_only` `friends_only` (a non-nice face from a non-friend on a public post) `stamps_closed` (stamps off, or a block: one opaque answer) `comments_friends_only` `comments_closed` (comments off, or a block) `ring_creator_only` (kick, delete, or approving a kicked handle) |
| 404 | `not_found` |
| 409 | `name_unavailable` `email_taken` `password_changed` `last_admin` `invite_limit`; P2: `page_off` (Keep while the page is off) `blocked_them` (befriending someone you block) `follow_limit` `friend_limit` |
| 413 | `too_large` `image_too_large` `too_many_pixels` `storage_full` |
| 415 | `json_required` |
| 429 | `rate_minute` `rate_hour` `rate_day` `too_many_attempts` (all with `Retry-After` and `retry_after`) `upload_in_progress` |
| 500 | `server_error` (logged with its stack, no detail in the answer) |
| 503 | `busy` (with `Retry-After`) `mail_unavailable` |

A client error (a malformed %-escape in a path, a garbage or wrongly encoded body) is a 4xx
and logs nothing, so a loop of them can neither flood the log nor pass for a server fault; a
path whose escape cannot be decoded names nothing that exists and is a 404.

### 11.2 Federation routes

Mounted only with `FEDERATION=on`; otherwise they 404, WebFinger included.

| Method, path | Auth | Does |
|---|---|---|
| `GET /.well-known/webfinger?resource=` | - | JRD (8.1) |
| `GET /.well-known/nodeinfo` · `/nodeinfo/2.1` · `/nodeinfo/2.0` | - | 8.2 |
| `GET /actor` | - | the instance actor |
| `GET /users/:name` | - | the `Person` (minimal when off, 410 when deleted, 404 when suspended); HTML `Accept` → `/@name` |
| `POST /users/:name/inbox` · `POST /inbox` · `POST /actor/inbox` | S | personal, shared and instance inbox (5.2) |
| `GET /users/:name/outbox` | S | public `Create`s, pages of 20, no counts |
| `GET /users/:name/followers` · `/following` | S | collections with no items and no counts |
| `GET /users/:name/featured` | S | pinned public posts |
| `GET /users/:name/posts/:id` | S | public on an enabled page: the `Note`; room: only a current member signer of its ring the author does not block, while live (P7; signed even under `AUTHORIZED_FETCH=0`, the block held in both modes, P7 review F4); archive, divider, page off: 404; deleted: 410 `Tombstone` only for a public post of an enabled page, every other deleted post 404 (4.9); HTML `Accept` → `/@name#id` for a public post, else 404 |
| `GET /users/:name/comments/:id` | S | **P6**: the comment `Note` of a comment the member left on a post of ANOTHER server (kept in `sent.json`), to a signer the member does not block; taken back, 404. **P7**: a comment in a ROOM (its row names the Group) only to a current member of that ring, signed (even under `AUTHORIZED_FETCH=0`) and not blocked by the commenter, while the post it answers is live. **Decided in P6**: a comment on a post of THIS server never leaves it (its `Create` is applied in-process), so nothing elsewhere holds its URL, and it answers 404 like any unknown one |
| `GET /rings/:id` | S* | the `Group` (4.7). As built in P7: SIGNED only, `AUTHORIZED_FETCH` or not; a member (or their server's instance actor, `<host>/actor`) gets the members view, a pending requester (or theirs) the asker's; both carry `ring.hosts` and the ring's `publicKey`; anyone else, and a ring not hosted here, the opaque 404; `private, no-store`, `Vary: Accept, Signature` |
| `POST /rings/:id/inbox` | S | the Group's inbox (5.2; who an activity is for is read from it, never from the path) |
| `GET /rings/:id/members` · `/outbox` | S* (members) | members; the live room's `Announce`s (P7: the members' posts here as `Create`s, a copy's as its id alone) |
| `GET /rings/join/:code` | S | P7, with an AP `Accept`: a live code's Group, the asker's view (name, hosts, key); a browser goes on to the page (11.3) |
| `GET /api/images/:key/web` · `/thumb` | S | P7, a request carrying a `Signature` only: a room image to a current member of the ring of a live post holding it whom its owner does not block (10.6), before any session is read; unsigned, the session's gate |

### 11.3 Pages

`/` (landing; signed in → `/app`), `/login`, `/signup` (reads `?invite=`), `/signup/confirm`
(asks for the password chosen at signup and confirms on submit, never on load: a mail scanner
that opens the link spends nothing), `/reset`, `/app`
(the composer), `/admin` (P8: the composer's page, the admin chunk lazy-loaded; signed out
to sign-in and back, a member 403; `noindex`, never cached), `/@:name` (the wall, 404 + `noindex` when off or unknown; an AP
`Accept` redirects to `/users/:name`), `/@:name.rss`, `/rings/join/:code` (→
`/app?ring=<code>` through login, same-origin `next` only; a visitor from another server is
asked their handle and sent home, 4.7; as built in P7, with `FEDERATION=on` a visitor who is
not signed in goes to `/authorize_interaction/remote?uri=<join link>`, whose form also offers
"sign in here", and whose page names their server and links to its subscribe template; their
server's lookup shows the ring and asks from there), `/authorize_interaction?uri=` (M, → `/app?open=`),
`/authorize_interaction/remote` (P6: a visitor from another server; `GET ?uri=&handle=` the
form only, `POST` from this site's form a page naming their server with a link to its
subscribe template, never a redirect, 8.5), `/robots.txt`, `/api/health` (liveness only).

### 11.4 Dropped, and deletion

There is no route to reorder posts (the wall shows pinned first, then newest) and no public
image `DELETE` (images die with what references them; an unposted upload is swept after 24 h).

Deletion removes the member dir, owned images, rows they authored anywhere, follows (with
`Undo`/`Reject` to remote ends), invites, ring requests and memberships (`dropFromRing`; a home ring passes on or dissolves per 3.6), and sends
`Delete{Person}` (from P6). The key is removed when the last job it signs ends (2.6). The name
retires. **Decided in P6** (2.6, 4.9): a remote edge is not severed with its own `Undo` and
`Reject`; `Delete{Person}` goes once per server that knows the member and ends every edge there,
signed by the member's key, which waits for that job; the tombstone carries no key, and a
receiver verifies with the key it already holds.

P1's purge (`lib/purge.js`, the one list of a member's traces): every session, every image they
own (bytes and rows), their member dir (page store, tombstones, visits), the invites they minted
and the mark of the one they used, their reset and signup tokens, every mail to their address
still in the `log` provider's outbox, their name in others' `invited_by`, their signing key (no
delivery queue yet), and last the member row, retiring the name; a crash midway leaves an
account that can be deleted again, never a free name. **A deleted member's in-flight write
never lands**: every write asks again in its commit tick whether its member is still active and
its session still current, the page store refuses to write a gone member's dir back, and the
image door re-checks the owner before it writes (401 `not_signed_in`).

P2's purge adds: every follow either way severed (the other side's rows go in the same tick),
every ring membership, request and `kicked` mark dropped (a ring passes on or dissolves), a
join code they minted rotated to the ring's creator with its requests answered (3.6), and every
stamp and comment they left on anyone's posts removed. **It never half-runs**:

- **Read and validate first, writing nothing**: their own follows, `rings.json`, the invite and
  token files, the image rows. A damaged one of these refuses the purge (500) before any
  change: their own data and the shared files are the operator's to fix, never guessed.
- **A damaged file of ANOTHER member never blocks the deleter**: it is skipped and logged
  (`[purge] <name>: skipped <other>`), never written over; its rows naming the deleted member
  stay until it is restored, and every reader drops a row whose member is gone. A per-member
  step that fails during the purge is skipped and logged the same way.
- **Sessions end, and the row goes, only after the point of no return.** A crash midway
  leaves an account still signed in, whose `DELETE /api/me` runs again and finishes: every
  step is idempotent, and the retry sweeps every other member's follows for a row naming them
  (a sever cut short on the other side).

## 12. Export

A member's posts leave in one self-serve zip: `routes/export.js`, written by `lib/zip.js`
(Ring's own writer, dependency-free: no zip library).

- **The doors.** `GET /api/me/export` is the zip without the key. `POST /api/me/export
  {password, key: true}` adds `key.pem` only when the member ticked "include my signing key"
  and typed their password again: the compare goes through the bcrypt queue (10.11), then in
  its own tick the row and the session must still be current, else 409 `password_changed` (a
  reset that lands during the check wins, as for deletion). A wrong or missing password is 403
  `wrong_password`; a `key` that is not a literal boolean is 400. `POST` without the tick is
  the plain export. The page shows, beside the tick: "Anyone with this file can sign as you
  until the server rotates your key. Keep it like a password." **The GET is refused to
  another site**: `Sec-Fetch-Site: cross-site`, or an `Origin` that is not this server's, is
  403 `csrf` (10.10) before the budget, so a third-party page cannot spend a member's
  exports; same-origin, same-site and a typed address pass.
- **The zip.** A standard zip that opens with a double-click (classic, 32-bit; JSON and CSV
  deflated, images stored), everything inside one folder `ring-<name>-<YYYY-MM-DD>/`:
  `README.txt` (what each file is); `posts.json` (every post, the archive and room posts
  included, as stored, plus its derived `url` and the `image_file` it shows); `settings.json`
  (display name, the five switches, theme, bio, avatar, links, blocked people as `name@host`
  and blocked domains; `avatar_file` and `theme.bg_image_file` name their images); `profile.json` (the actor
  document, 4.3, as other servers read it); `friends.csv` and `following.csv` in Mastodon's
  follow-import format (`Account address,Show boosts,Notify on new posts,Languages`, each row
  `name@host,true,false,`), so either imports into Mastodon as follows; `followers.csv` (one
  `Account address` column: a record, not a list to follow); `images/<key>.<ext>` (the stored
  original, already re-encoded by the door, of every image the page names: post and link
  images, the avatar, the theme background; the member's own only); `key.pem` only as above;
  `manifest.json` last (`format: 'ring-export'`, `version: 1`, name, handle, actor id, time,
  whether the key is in, counts, every other file's size and SHA-256, and `missing`: each
  image the page names whose original file is gone, as `{ key, file }`, never dropped
  silently; the export still answers 200). Only accepted follows are listed. A handle of this
  server is written `name@<host>` everywhere, `settings.blocked` included. Entry names are
  relative: the writer refuses a `..` segment, a leading `/`, a backslash, a NUL or a drive
  letter before a byte goes out.
- **Bounds.** Streamed (no zip is held whole in memory). **Each image is read once**: up to
  16 MiB (every original the upload door stores) in chunks into one buffer with a running
  CRC-32 and SHA-256, so the bytes hashed are the bytes sent; a larger, hand-placed file twice
  through one open handle, the data pass's own CRC checked against the first. The manifest
  goes last, written from those hashes. A file whose size differs from the plan, or that grows
  or changes meanwhile, fails the stream rather than writing a header that lies; one gone when
  the writer reaches it is listed in `missing`. CRC-32 is node's native `zlib.crc32`, with a
  table fallback that answers the same. From the plan (and the key form's tick) to the first
  byte there is no await. A size cap of 2 GiB, checked before anything is sent (413
  `export_too_large`), well under the classic zip's 4 GB. The export budget: 3 a minute and
  20 a day per member (429 with `Retry-After`). **At most 2 exports stream at once on the
  server** (`EXPORT_MAX_ACTIVE`): past it 503 `export_busy` with `Retry-After: 30`, checked
  before the budget; a slot is freed when the answer closes. **An answer whose reader stops
  reading for 60 s is cut** (`EXPORT_IDLE_MS`, the socket's idle timeout), so a stalled
  download cannot hold a slot. `Cache-Control: private, no-store`.
- **Audit.** `member.exported` with whether the key was in, the image count and the missing
  count; never a byte
  of the key, in the audit, the log or any answer but the key export itself.
- **Moving an account** (`Move`) stays Later (decision 8); `following.csv` is what a member
  takes to another server today.

The admin's full-data backup is in 15.4.

## 13. The UI

### 13.1 The composer, `/app`

- **Rail:** Public (globe), **Friends** (a chip over the friends feed; remote friends
  included), each ring by initials with an unread dot (localStorage, never a count),
  `+ New ring` (creates, copies the link), Inbox (join requests counted, follow requests,
  reactions a dot, From elsewhere), Archive, Settings. The rail is the whole chrome.
- **Board:** polaroids, stickies, tickets, torn-strip dividers; chaos seeded from the object
  URL, so every Ring server tilts a card the same way; the days rail; jump-home; endless Public
  via an IntersectionObserver sentinel; the room's standing "clears after a week" line;
  muted-friends and page-off notices. Remote cards render the node tree (5.8) and `/media`
  images, name their host, and keep a `cw` card shut until opened.
- **Composer popover:** "Posting to ..." first; audience picker (Public and my rings, never
  archive; Public reads "also sent to your followers' servers"); note, image (upload with
  progress, alt, link), link (URL, title, image, caption: this form replaces the record
  search), embed, divider; the kaomoji decoration; the content warning.
- **Report** (P8): on another's card (local or remote), on a From elsewhere row and on a
  looked-up person, a small panel: an optional comment and, for someone on another server,
  "Also send to <host>" (6.2). A `post_removed` notice shows in the Inbox (6.3).
- **Card verbs:** stamp tray (style tabs, nice or full shelf, custom face in rooms; on a
  non-Ring post a hint says how it will show there), comments, take back mine; on my posts
  delete (house confirm), Keep, Pin, Edit; on others' posts Report; Copy link.
- **Settings** (Segmented sub-nav): **Friends** (add by `name@host` or URL through lookup;
  friends here and elsewhere; followers and requests with Befriend, Let follow, Decline;
  `open_follows`), **Rings** (members with hosts, inline rename, link menu, kick, approve or
  decline with the trust notice for a remote requester, the `?ring=` offer reading "Ask to
  join", a field to paste a join link from another server, the hosts that hold each ring),
  **Stamps** (switches, blocked people and domains; a blocked ring-mate gets a notice under
  the list, naming the ring and the limit of 6.1, with a way to the ring to remove them, the
  creator, or leave it, and the block's toast says so too: P7 review, F4), **Theme** (live on the Public board),
  **Page** (on or off, with "not a recall" beside it; indexable; bio, avatar, links),
  **Account** (display name, password, invites, export with the optional key: the tick shows
  the warning and asks for the password again, 12; delete).
- **`/app?open=<uri>`**: a sheet showing the looked-up person, post or ring with its verbs.

The composer's modules:

| Module | What it holds |
|---|---|
| `app/api.ts` | `api()` (JSON in and out), `uploadImage(file, onPct)` (returns the server's key: the client never names one), `imgUrl(key, variant)` |
| `app/datetime.ts` | `fmtAge` (today, Nd, Nw) and `fmtDay` |
| `app/ui.tsx` | `Segmented`, `Checkbox`, `Menu`, `Tip`, `Toast`; menus keep the armed two-step confirm |
| `app/popover.tsx`, `app/confirm.tsx`, `app/inline-edit.tsx` | phone sheet, click-away, Esc; no `window.confirm` |
| `app/strings.ts` | `t()` over `app/strings.en.ts`, including the federation and moderation keys; no owner overrides |
| `app/types.ts` | 5 kinds; `PostView` with `cw`, `origin` (`local`/`remote`), `author {handle, name, host, url}` |
| `app/ring.css`, `app/tokens.css` | the wall register and the tool's tokens |
| `lib/palette.js` | one UMD (56 faces) for server and bundle; no drift possible |

As built in P8, `/admin` (`app/admin.tsx`, `app/admin.css`, a lazy chunk loaded only on that
path): Reports (open or all; each a card naming its kind, target, reporter or reporting host,
comment and objects, with Resolve, Dismiss, and as the target allows Remove post, Suspend,
Send to their server, Block person, Block domain, each destructive one asking first), Domains
(blocked domains and people blocked server-wide: add with a private reason, unblock), Members
(suspend, unsuspend, make admin, step down; the signup door), Federation. It reads at phone
width with no horizontal scroll.

Tool chrome stays sober (system sans, tokens, sharp corners), the wall inside keeps the Ring
register, and phone width is a first-class target. `/admin` uses the same tool register, four
tabs (Reports, Domains, Members, Federation), a lazy chunk of the same bundle.

### 13.2 The member page, `/@name`

Vanilla JS, no build: a server-rendered shell (`routes/wall.js`: the head tags, the name tag with
avatar, bio and `rel="me"` links, so a verifier needs no script) plus `public/assets/page.js` and
`page.css`, which fetch `GET /api/pages/:name` and lay out the wall; there is no `page.html`.
**The look is the sticker wall, not the plain early-web grid**: paper, polaroids, washi tape, riso offsets, marquee, odometer,
on the site's monospace base with `#0000ff` links; its rules carry (calm art, seeded chaos,
motion behind `prefers-reduced-motion`, 44 px targets). Landing, auth and 404 use the plain
early-web register (monospace, white, `#0000ff` underlined links, `1px solid #ddd`).

The wall holds the owner's name tag with avatar and bio, their `rel="me"` links, a befriend
sticker for a signed-in non-owner of this server, "Follow from your server" for anyone else,
friends' name tags (remote ones link off-site with `rel="nofollow noopener ugc"`), stamp and
comment controls for members here, "Stamp from your server" for visitors from elsewhere, faces
only for anonymous visitors, remote signers as "Firstname L. · host", and the odometer
(anonymous loads, buffered, flushed each minute; only an anonymous read of the API,
`GET /api/pages/:name`, counts, so a crawler that never runs the script is not a visitor).
**No remote image ever appears on the wall.** Head tags per 8.4. Strings:
`public/assets/strings.en.json`.

## 14. Tech stack

Node 24, Express 5, one process, no database. Runtime dependencies:

| Package | Why |
|---|---|
| `express` | routing and parsing |
| `express-session` | the session layer whose rotation login relies on |
| `bcryptjs` | password hashes, pure JS (no native build) |
| `multer` | multipart for upload, memory storage under hard limits |
| `sharp` | decode, re-encode, EXIF strip, orientation, variants, the pixel ceiling; remote media too |
| `nodemailer` | SMTP for self-hosters (no dependencies of its own); a self-hosted server without SMTP has no signup |

Not taken: any ActivityPub, JSON-LD, HTTP-signature or HTML-sanitizer package. Signatures are
`node:crypto` (`lib/http-sig.js`); AS2 is read as plain JSON (4.1); remote HTML goes through
the re-emitter (5.8); the guarded fetcher is `lib/net.js`. Also not taken:
`session-file-store` (no `all()`, so "end every session" is impossible; Ring's own small
`lib/session-store.js` over `writeJSON` adds `all` and `destroyFor(slug)`, 10.9); any zip library
(the export's writer is `lib/zip.js`, dependency-free, 12); any tar library (the backup's ustar
writer is `scripts/backup.js`, 15.4). Resend
runs over `fetch`. Composer: React 19, TypeScript strict, Vite into `app-dist/` (gitignored),
dev dependencies only. Tests `node:test`; lint Biome on errors.

New modules: `lib/keys.js`, `lib/http-sig.js`, `lib/net.js`, `lib/actors.js` (cache, 5.3),
`lib/activities.js` (builders), `lib/ap-inbound.js` (the registry), `lib/outbox.js` and
`lib/queue.js` (7), `lib/remote-html.js`, `lib/media-cache.js`, `lib/ring-group.js` (4.7),
`lib/moderation.js`, `lib/clock.js` (one `now()`, settable in tests only).

Copy is English, keyed from day one, no em dashes (`test/copy.test.js` checks every value).

## 15. Self-hosting

### 15.1 What a server needs

A domain its admin will keep forever; HTTPS in front (a reverse proxy such as Caddy or nginx,
or a host that terminates TLS, like Render); Node 24; a persistent disk; outbound HTTPS; an
SMTP account or a Resend key; a clock kept right by NTP (signatures carry the time). `deploy/`
carries an example Caddyfile, systemd unit and Dockerfile.

### 15.2 The domain is permanent

- `DATA/instance.json` records `origin` at first boot. `federated_at` is stamped at the first
  verified inbound activity, the first verified signed GET (another server read an object and
  holds its URL) or the first delivery.
- After that, **the server refuses to boot under a different `PUBLIC_ORIGIN`**, with the
  reason: "this server federated as <origin>; its actor URLs live in other servers' databases;
  a new domain is a new server: start with an empty DATA_DIR". There is no override.
- **The lock cannot be lost quietly.** `federated_at` is the lock: a valid date, or an
  explicit `null` ("not yet"). An `instance.json` that is missing, or says neither (`{}`,
  `federated_at: ""`), is no lock: before anything is written the data dir is searched for
  federation evidence (a remote follow row in any member's `follows.json`, a cached remote
  actor in `fed/actors/`, a seen activity in `fed/seen/`, the instance key
  `keys/_instance.pem`), and any of it refuses the boot, naming it: restore `instance.json`
  from a backup. With an explicit `null`, the evidence only a verified inbound activity leaves
  (a seen id, a remote follower) refuses the boot too: that file was edited by hand. With no
  evidence the file is written afresh, as at first boot. A damaged `instance.json` (not JSON,
  not an object) refuses the boot as every damaged data file does (15.4).
- `FEDERATION` defaults to `off`, so a server tried out on a temporary host never leaks a
  permanent identity. Turning it on logs the origin that is about to become permanent.
- **Never federate under a provider's default host** (`*.onrender.com`, a tunnel URL, a bare
  IP): it can never be moved to the real domain later. Enforced at boot with `FEDERATION=on`
  (`lib/config.js` `NEVER_FEDERATE`): `PUBLIC_ORIGIN` must be https on the default port, a
  name with a dot (never a bare IPv4 or IPv6 address, never `localhost`), and not the host or a
  subdomain of a listed provider. The list: platform hosts (`onrender.com`, `herokuapp.com`,
  `fly.dev`, `railway.app`, `vercel.app`, `netlify.app`, `pages.dev`, `workers.dev`,
  `azurewebsites.net`, `azurestaticapps.net`, `azurecontainerapps.io`, `cloudapp.azure.com`,
  `web.app`, `firebaseapp.com`, `appspot.com`, `run.app`, `cloudfunctions.net`,
  `amplifyapp.com`, `awsapprunner.com`, `elasticbeanstalk.com`, `amazonaws.com`,
  `cloudfront.net`, `ondigitalocean.app`, `koyeb.app`, `northflank.app`, `deno.dev`,
  `deno.net`, `replit.app`, `replit.dev`, `repl.co`, `glitch.me`, `github.io`, `gitlab.io`,
  `codeberg.page`, `surge.sh`, `sevalla.app`, `zeabur.app`, `csb.app`) and tunnels and dev
  environments (the `ngrok` hosts, `trycloudflare.com`, `loca.lt`, `localtunnel.me`,
  `lhr.life`, `localhost.run`, `serveo.net`, `pinggy.link`, `tunnelmole.net`, `ts.net`,
  `github.dev`, `gitpod.io`, `codesandbox.io`). A match is a whole label: `pages.devotion.example`
  passes. Loopback is allowed only under the test hook (5.6).
- **A trailing dot is refused, never normalised away**, federating or not: `ring.example.` and
  `ring.example` are one host to DNS but two strings in every id, handle and signature, so
  `PUBLIC_ORIGIN` is spelled the one way.

### 15.3 Environment

| Var | Default | Meaning |
|---|---|---|
| `PUBLIC_ORIGIN` | request origin in dev | required in production; https; an origin only (no path, no credentials, no trailing dot); permanent once federated; with `FEDERATION=on` also the rules of 15.2 (default port, a real name, never a provider's default host); required by `MAIL_PROVIDER=smtp` or `resend` in any mode |
| `SESSION_SECRET` | | **always required**; in production 32+ characters with at least 8 distinct (outside production a weaker one only warns) |
| `ADMIN_EMAIL` | | required in production: the admin's email (6.3); unset outside production, nobody becomes admin (a boot warning says so) |
| `DATA_DIR` | `./data` | the one data directory |
| `PORT` | 3000 | |
| `TRUST_PROXY` | off | **required in production** (Ring is always behind a TLS proxy there): a hop count (`1` to `99`), or a list of the proxy's addresses (`loopback`, `linklocal`, `uniquelocal`, an address, a CIDR). `true` is refused; `0` or unset is off. A list is best: only those peers are believed, so a client reaching the app port directly cannot pick its own rate bucket; a hop count believes any peer (a boot warning says so) |
| `SIGNUP` | `invite` | `open` lets anyone sign up |
| `INVITES_PER_MEMBER` | 5 | live invites each |
| `FEDERATION` | `off` | `on` mounts the AP routes and starts delivery |
| `AUTHORIZED_FETCH` | `1` | `0` serves AP documents to unsigned GETs |
| `MAIL_PROVIDER` | `log` outside production | `smtp` · `resend` · `log` (links go to the server log and `DATA/mail-outbox.jsonl`; the admin passes them on); unset in production, signup and reset answer 503 `mail_unavailable`. `smtp` and `resend` need `PUBLIC_ORIGIN` or the boot refuses: a mailed link never takes its origin from a Host header (only `log` outside production may use the request's origin) |
| `SMTP_URL` · `RESEND_API_KEY` · `MAIL_FROM` | `MAIL_FROM`: `Ring <ring@<host of PUBLIC_ORIGIN>>` | per provider; `smtp` needs `SMTP_URL` (a nodemailer URL), `resend` needs `RESEND_API_KEY` (sent over `fetch`, 15 s timeout) |
| `NODE_NAME` | the host | the server's name in NodeInfo and on the landing page |
| `MEMBER_STORAGE_MB` | 500 | per member |
| `REMOTE_MEDIA_MB` | 2048 | remote media cache cap |
| `BLOCKED_DOMAINS` | | comma list of hosts (each with its subdomains); since P8 a SEED of the admin's domain blocks, imported at boot, a host once (6.5) |
| `RING_RESET_DISABLED` | | test hook |
| `RING_TEST_IPC` | | test hook (16.1): with an IPC channel, only on a test server with `FED_TEST_LOOPBACK=1` and never in production, a suite moves the clock and runs the sweeps |
| `FED_TEST_LOOPBACK` | | test hook: the fetcher allows http and loopback (loopback only); refused when `NODE_ENV=production`, and refused unless `PUBLIC_ORIGIN` is itself a loopback origin (5.6) |
| `NODE_ENV` | | `production`: the `__Host-` Secure cookie, HSTS, and the requirements above enforced |

`lib/config.js` reads the environment once, into a frozen object; a setting production needs
and lacks refuses the boot with every reason at once. Mail never waits on the wire: a send is
fire and forget, so a route answers in the same time whether it mailed; a failed send is logged
without its body (a link in a log line is a leak). SMTP waits are bounded (connect 10 s,
greeting 10 s, idle socket 20 s), so a hung server ends in a logged failure. **The `log`
outbox holds live links in clear**: the mailer drops rows older than 24 h (the longest token
life) at boot, before an append (at most once an hour) and in the hourly housekeeping, so a
row lives at most about 25 h. A deleted member's rows are removed from it at once
(11.4).

### 15.4 Data and backups

- Layout: 3.11. **One process per data dir: `DATA/.lock` is a lease.** It holds `{ token,
  pid, hostname, boot_id, at }` and its mtime is a heartbeat, renewed every 30 s; each beat
  also re-reads the token, and a process that finds someone else's there has lost the data dir
  and exits at once. A second process refuses to start while the lock is live. The lock is
  **stale**, and taken over, when its heartbeat is older than 90 s, or when it was written on
  this host (same hostname and boot id) by a pid that is dead, or by our own pid but not held
  by this process (a container restart). A fresh lock from **another host** is a refusal even
  under our own pid (two containers sharing a volume both run as pid 1). The takeover renames
  the stale file aside (one renamer wins), checks it moved the stale one (else puts it back),
  then creates the new lock exclusively (`O_EXCL`). Release deletes the lock only while it
  holds our token.
- **Stopping is bounded.** The first SIGINT or SIGTERM stops the timers and new connections,
  closes idle ones, lets requests in flight finish for up to 8 s (then cuts them), flushes the
  odometer, waits up to 10 s for mail in flight, and releases the lock. A second signal, or a
  shutdown still running after 25 s, releases the lock synchronously and exits at once.
- **Member export**: self-serve, 12.
- **Admin full tar**: `node scripts/backup.js [--data <DATA_DIR>] [--out <dir>]` (`--data`
  defaults to `DATA_DIR`, then `./data`; `--out` to the current directory) writes
  `ring-<YYYYMMDD>T<HHMMSS>Z.tar.gz` (UTC; the time, so two runs a day get two names) of
  `DATA/` minus `sessions/`, `fed/media/` (refetchable), `backups/`, the `.lock` lease, hidden
  write temps, any earlier backup tar (`ring-<stamp>.tar.gz`, `.part` too) wherever it sits,
  and anything that is not a regular file or directory (symlinks are never followed). A
  gzipped POSIX ustar, entries relative to the data dir (no wrapping folder), owner 0, files
  0600 and directories 0700 in the headers; names up to 255 bytes through ustar's prefix
  field, a longer one (none of Ring's own) skipped and counted. Decided in P9: hand-written, no
  tar package and no shelling out. It refuses a dir without `instance.json` (not a Ring data
  dir), and **an output inside the data dir** other than its own `backups/` (spelled exactly):
  decided on real paths, the data dir resolved and the output's nearest existing directory
  resolved, then every directory up to the root compared with the data dir and its `backups/`
  by device and inode, so a symlinked `--out`, a symlinked `--data` or a case-insensitive
  spelling is no way in, and a refusal creates no directory. **An existing target file is
  refused, never overwritten**: checked before the run, and the finished `.part` is
  hard-linked into place (a name taken meanwhile fails the link), a checked rename where the
  filesystem has no hard links.
- **Consistency.** **A stopped server gives a fully consistent tar.** On a live one the tar
  is **consistent per account index**, by the order of the walk: a reference is read before
  what it names, and each directory is listed only when the walk reaches it (never one
  listing up front). At the top: the account dirs first (`members/<name>/`, whose page stores
  name images, rings and people; `fed/` and `queue/` with them), then the indexes
  (`members.json`, `images.json`, `rings.json` and every other top-level file), then `keys/`,
  then `images/`. Below the top, a directory's files are read before its subdirectories are
  listed. Ring writes a key file or an image before the row that names it, and the row before
  a post that names it, so every row in the tar has its file and every image a post names has
  its row. Every data file is replaced by rename, so a file read is a whole file, old or new.
  A file removed after its row was read is missing (a deletion in flight); anything written
  after the walk passed is not in the tar.
- **Reading.** A file up to 16 MiB is read whole before its header is written (its true
  size); a larger one is streamed from one open handle, exactly the size it had when opened
  (an appended log keeps that prefix; one that shrinks fails the run), so a file past 2 GiB
  travels. Past 8 GiB (what a ustar size field holds) the run fails and names the file. Only
  a file or directory gone between the listing and the read (ENOENT) is skipped and counted;
  **any other read error fails the run** with the file's path in the data dir and the error
  code, and leaves no tar and no `.part`.
- **It holds every private key, password hash and email, the mail outbox's live links (with
  mail set to `log`, `mail-outbox.jsonl` holds working account-confirm and password-reset
  links until they expire) and the invite codes in plain text (`invites.json`, each a way in
  until used, revoked or expired): keep it like a password.** It is written 0600, as `.part`
  and moved into place when complete, and the script prints only the path, the file count and
  the size: never a byte of a file, and a file's name only when it is the one a failed run
  names. Script only, never a web download.
- Restore: stop, then **as the user the server runs as** untar into an empty `DATA_DIR` with
  `tar --no-same-owner -xzf ring-....tar.gz -C <DATA_DIR>` (the headers record owner 0: a
  root extraction without `--no-same-owner` leaves root-owned 0600 files the server cannot
  read, so extract as root only with a `chown -R <server user> <DATA_DIR>` after), and start
  with the same `PUBLIC_ORIGIN` (the lock in 15.2 refuses another). `instance.json` is part of
  what must come back: a data dir that has federated refuses to boot without its lock (15.2).
  Queued jobs in the tar resend; receivers deduplicate. Posts made after the tar are gone here
  but stay on servers that received them.
- A queue job file that cannot be read, or has the wrong shape, is moved to
  `DATA/queue/damaged/` at boot with a `delivery_damaged` audit line naming the file and its
  activity id when that is readable (7): never left in the queue to be skipped silently, never
  deleted. The operator may inspect, fix and move it back.

### 15.5 Upgrades

`git pull`, `npm ci`, `npm run build`, restart. `instance.json` carries a schema version; boot
migrations run in order, each idempotent, after writing `DATA/backups/pre-<version>.tar.gz`
(the last 2 kept); a failed migration stops the boot with the data as the tar has it. **A
migration never changes an AP id.** Other servers retry deliveries while the server restarts.

### 15.6 A single-instance deploy

One instance with a persistent disk (Render or any host that keeps a disk), on a domain the
operator keeps for good (15.2), federation on only once that domain is final.

## 16. Tests

### 16.1 Harness

Each suite boots the app in-process on a free port with a temp `DATA_DIR`, the mail outbox and
the injected clock; `test/*.test.js` is discovered, never listed. `npm test` is `node --test
--test-timeout=60000 --test-force-exit 'test/*.test.js'`: the glob is quoted so node expands it
(only `test/*.test.js`, never `test/helpers/`), a test hung past 60 s fails, and a suite whose
setup throws after a boot ends the run red instead of hanging on its listening server. The
harness (`test/helpers/harness.js`) captures every log line (a suite can assert what reached
the log), removes its temp dirs even when a boot fails, and scales every rate limit up 1000
times unless the suite is about limits (`limitScale: 1`). Federation suites boot a Ring server
on a loopback port with `FED_TEST_LOOPBACK=1` and a loopback `PUBLIC_ORIGIN` (5.6), and talk to
it through in-process fake Mastodon servers (`test/helpers/fediverse.js`: their own RSA keys,
their own signer and an independent verifier, never `lib/http-sig.js`); P7's three-server
suite runs two more Ring servers as child processes, whose clocks, room sweep, housekeeping
and queue it drives through a TEST hook (`server.js`, `lib/test-ipc.js`: `RING_TEST_IPC=1`, an
IPC channel, not `NODE_ENV=production`, AND the loopback test hook on, `FED_TEST_LOOPBACK=1`
with a loopback `PUBLIC_ORIGIN`; so a process manager that forks a real server with an IPC
channel never has it. A clock move is a finite number of ms within a year either way, else
refused; P7 review, F5); the smoke suite runs
the Ring server as its own process. Nothing reaches a real server.

Fixtures in `test/fixtures/fediverse/`, as P5 has them:

- **Recorded** from a real Mastodon 4.x server (mas.to, 4.7.2): the WebFinger JRD, the actor,
  NodeInfo 2.0 and its `/.well-known/nodeinfo` links, and the outbox, followers and featured
  collections. Re-hosted onto the fake at test time; the actor gets the fake's own key.
- **Constructed** from Mastodon 4.x's serializers, not captured from a server: `Follow` and
  `Undo{Follow}` (body and the headers Mastodon signs), re-signed at test time with a fresh key
  and `Date`.
- **Vendored**: the NodeInfo 2.0 and 2.1 JSON schemas.

The phases that open the rest of 4.10 add recorded fixtures for what they accept: a `Note`
with attachment and warning, `Like`, `Undo{Like}`, a reply, `Flag`, `Delete{Person}`; Akkoma
`EmojiReact`; a Misskey `Like` with `_misskey_reaction`.

**P6's are CONSTRUCTED, not recorded** (a departure: the build never reaches a real server):
`test/fixtures/fediverse/p6-*.json` are built from each software's serializers and say so in
their `note`: a Mastodon public reply (its mention h-card and invisible and ellipsis spans), a
Mastodon status with a warning and an image `Document`, a Mastodon `Like` and its `Undo`, a
Mastodon `Delete{Person}`, an Akkoma `EmojiReact` (unicode, and a custom emoji with its `Emoji`
tag), a Misskey `Like` with `_misskey_reaction`, and the NodeInfo software blocks of Akkoma
and Misskey. `Flag` arrived in P8, CONSTRUCTED the same way (Mastodon's shape: the instance
actor, `object` an array of the account and statuses, `content`), in `moderation`. Replacing them with recordings is a task for the first real
interop run (16.4). The fake (`test/helpers/fediverse.js`) gains the other faces P6 needs: a
NodeInfo answering `mastodon`, `akkoma` or `misskey`; a `localhost` host (two loopback fakes
a `BLOCKED_DOMAINS` gate can tell apart); an Akkoma-style instance actor with no WebFinger;
and an unlocked account's automatic `Accept`. `fed-two-servers` runs a second REAL Ring
server in its own process (`test/helpers/ring-process.js`).

### 16.2 The core gates, by behaviour

- **ring:** own-store read needs a session; each kind persists with server ids (CSPRNG, URL
  derivable); unknown kind, empty note and husks refused; PATCH sets pinned,
  kaomoji and `cw`, kind immutable; delete then 404; non-hex bg stripped; pasted `<script>`
  inert; `friends[]` in the payload; the odometer counts anonymous reads; pinned leads; embeds
  canonical; theme rides out; page off empties the payload, on restores it live.
- **friends:** recipient-only confirm, crossing confirms, unfriend and re-request, no second
  row on a repeat click, a friend's unfollow severs both ways; the feed: pending feeds nothing,
  dated posts only, no dividers; followers get no friend rights.
- **stamps:** **56 faces, 4 styles, 30 nice; no face outside them**; anonymous and
  own-post refused; non-palette body refused on Public; signed with a return address; strangers
  get the nice shelf, friends everything; faces not counts; `seen` never leaks; toggle; mark
  seen; owner removes; block opaque, retroactive, enforced at render; per-post and page off;
  "Firstname L."; tint or plain paper; author retracts; a deleted post takes its crowd.
- **comments:** non-friends refused; signed; 280 cap; author retracts, third party cannot
  (opaque), owner moderates; per-post and page off; a blocked friend refused opaquely.
- **rings:** caps (3 per member, 6 counting requests, joiner's cap
  at ask and approval); the link mints with expiry, asks, rotates, closes, drops requests;
  opaque 404s, no peephole; the leak test (a room post never reaches Public, the square or
  another room, not even by edit); ring-mates stamp unpublished room posts; the image half
  (mate 200, outsider 404, kicked member 404 at once); kick, creator handoff, delete, dissolve.
- **ring-reset**, **custom-stamp**, **feed-pagination:** every case.

### 16.3 New gates

- **auth:** signup answers alike for new and taken emails; the row exists only after confirm;
  an invite is required and single-use, 5 live per member, revocable, expiring; `SIGNUP=open`
  skips it; `ADMIN_EMAIL` needs none before the first member and only that account is admin,
  decided at confirm, a later signup with that email is an ordinary invited member; tokens
  single-use and expiring; handle rules, reserved and retired words; one 401 for unknown email and wrong password; throttle 429; the
  session id rotates at login; reset and deletion end every session, password change the
  others; deletion purges every trace.
- **ids-and-keys:** a keypair exists before the member row; the key file is 0600 in a 0700
  dir; no HTTP response, log line, audit row or default export contains `PRIVATE KEY`; the
  export with `key: true` and the password does; post, ring, stamp and comment ids are CSPRNG
  and never reused after delete.
- **privacy:** page off equals unknown name for page, API, RSS and images; archive images
  author-only; a lapsed room post invisible before the sweep; a foreign image key refused in a
  post, theme or avatar; cross-site POST refused; `no-store` on room images; key entropy; miss
  budget.
- **images:** SVG or HTML renamed `.jpg` refused; size cap; `too_many_pixels`; a GPS-tagged
  fixture returns with no EXIF; orientation applied; client-named keys ignored; GIF and WebP
  re-encoded with animation kept; every frame counts against the animated budget; the decode
  timeout; the bounded decode queue and the upload gate (503 `busy`, 429
  `upload_in_progress`); an upload whose owner is deleted mid-decode writes nothing.
- **auth-signup:** a planted signup is never completed with the planter's password (403
  `password_mismatch`); pending rows past the per-client cap are refused, never evicted; before
  the first member every invite-less signup gets the same answer; the confirm page needs a
  submit; no enumeration, counted (one compare per login, one hash per signup, on every path);
  signup and forgot answer first, then do the same store work on both paths.
- **limits:** the client id (IPv4, IPv4-mapped, IPv6 /64, `TRUST_PROXY`); the bucket map is
  bounded; a bucket keeps only its longest window and `Retry-After` names the one that opens;
  every budget 10.7 names that a P1 door spends, at `limitScale` 1; the member bucket; the login
  throttle's account window, and a reset unlocking it.
- **auth-production:** the boot refuses a real mail provider without `PUBLIC_ORIGIN` and
  production without `TRUST_PROXY` (`true` refused); a mailed link never takes its origin from
  the Host header; behind the proxy, the `__Host-` Secure cookie and HSTS; CSRF on every
  DELETE and against `PUBLIC_ORIGIN`, not the Host-derived origin; a failing mail provider still
  answers 202 at once and logs no link; the outbox keeps a day and forgets a deleted member.
- **auth-races:** a reset that commits during a password change, a login or a deletion wins
  (409 `password_changed`, no sign-in, nothing deleted); a password change voids every
  outstanding reset link; the password queue is FIFO, one at a time, bounded, gives the loop
  its turns, and answers 503 `busy` with `Retry-After` when full.
- **csprng:** with `crypto.randomBytes` pinned, every bearer secret and id tail (link tokens,
  invite ids and codes, image key tails, post, stamp and comment ids) is exactly its CSPRNG
  bytes; with the real generator two draws differ.
- **auth-sessions:** a damaged session file signs that cookie out and stops nothing else; the
  SMTP transport carries its bounded waits, and a hung SMTP server fails within them.
- **store:** absent is the fallback, damaged is an error naming the file; a damaged file at boot
  refuses it, while running fails the request and is never written over; the image sweep keeps
  a damaged owner's images and brakes on a large share; a hand edit of `members.json` is read
  and kept; files 0600 and dirs 0700 whatever the umask; the directory is fsynced; the JSONL
  prune streams across chunk edges and leaves the file whole on failure.
- **lifecycle:** a deleted member's or ended session's in-flight write never lands; deletion
  ends every session at once; housekeeping runs each step on its own and sweeps crash leftovers
  (temps, orphan image files, staged keys) and the outbox past 24 hours; settings writes are
  limited; a malformed escape or garbage body is a quiet 4xx, a malformed image path a miss;
  `close()` drains and is bounded; the lock lease across processes and hosts, release and the
  heartbeat.
- **harness-hang:** a suite whose setup throws after a boot ends `npm test` red, not hung, and
  its temp dir is removed; positive control: without `--test-force-exit` the same file hangs.
- **activity-shapes (P2):** every local social action emits exactly the AS2 activity P5 to P7
  send, pinned as fixtures: befriend, confirm, sever, stamp, take back, comment, edit, delete,
  Keep, pin, every ring act.
- **social-hardening (P2):** the P2 review held fixed: a blocked member's `Follow` stays
  pending and unanswered, and the blocker's wall and feeds read shut to them; their ring ask
  never reaches the blocker (Inbox, dot, ring view); a kick rotates the link, answers the
  dropped requests and only the creator re-admits; a deleted member's code rotates; rename and
  switch-off spend the link budget, answers their own; the purge skips a damaged other's file,
  refuses on its own damage before any change, and a crashed purge finishes on retry with the
  sessions alive; Keep sheds the room grant's reactions; comments and ring names lose bidi
  overrides; expiry sends `Update{Group}` and every dropped request a `Reject`; a signature
  change drops only the walls that show it. Each with its positive control.
- **fed-signature:** accepts a valid Mastodon-style signed POST (the fixture, re-signed);
  refuses a tampered body (digest mismatch), a missing `Digest`, a signed-headers list without
  `(request-target)`, `host`, `date` or `digest`, a `Date` older than an hour or more than an
  hour ahead, a signature by another key, a key owner that is not the activity's actor, a
  replayed signature inside the window, an unknown algorithm, an unsigned POST (401); refetches
  a rotated key once and then accepts; a forwarded activity is processed only from its origin
  fetch.
- **fed-ownership:** an `Update` or `Delete` of an object on another host is refused; an
  `Update` of a `Note` whose `attributedTo` is not the actor is refused; an `Undo` of someone
  else's `Like` is refused; a `Delete{Person}` by another actor is refused; an `Accept{Follow}`
  from someone other than the followee is refused; an `Announce` from a non-Group is dropped.
  P6 adds: a `Like` or reply on a post the sender cannot see (a room, a page off) lands
  nowhere; a comment's `Delete` by another removes nothing; an `Accept` naming a `Follow` by
  its id alone counts only from that follow's followee; `Delete{Person}` makes the actor gone
  (rows out, its key never verifies again, its handle stays bound) and a 410 does too;
  `Update{Person}` moves no handle and keeps the same checks; `BLOCKED_DOMAINS` refuses
  inbound (403), delivery, fetches, befriending and lookups and leaves other hosts alone; an
  unbound instance actor reads and never posts; the 90-day actor prune keeps what a row names
  and every gone record; the media cache (members only, the sniff, a non-image type, no EXIF,
  never the original, least recently used out, a miss refetches).
- **fed-audience** (the leak test over federation): a room post is delivered only to the
  Group's inbox, and the Group's fan-out only to the inboxes of servers hosting a current
  member; it never appears in the outbox, `featured`, a followers delivery, RSS, the square, or
  a GET by a non-member signer or unsigned; a kicked member's server receives no later room
  post and its signed fetches 404; **archive never federates** (a spy on the queue sees no job
  for an archive post, and its URL 404s to everyone); dividers never federate; page off:
  nothing delivered, outbox empty, public post URLs 404.
- **fed-ssrf:** the fetcher refuses http under production, private IPv4 and IPv6, loopback,
  link-local, CGNAT, ULA, mapped, translated and NAT64 forms, a DNS answer mixing public and private, a
  redirect into a private address, a rebinding second answer (the pinned lookup is used),
  an oversize body, a slow body (timeout), an HTML content type for an AP fetch, an actor whose
  inbox is on another host; a delivery POST never follows a redirect.
- **fed-hardening:** a captured signature with a forged body and an UNSIGNED `Content-Digest`
  of it is refused, as are a `Digest` and `Content-Digest` that disagree and a POST whose
  signature covers no digest; the very same signed POST replayed after a restart is refused;
  a forwarded activity whose id is an open redirect on the victim's host is never processed
  (and the same activity served at its id is); a stranger naming a host's `keyId` spends none
  of its budget, signed GETs have a per-client budget, and a verified host's GET and POST
  buckets are apart; signed-looking GETs make at most 30 key fetches a minute per client and a
  dead `keyId` is fetched once per 5 minutes; silent key hosts hold neither a real remote's
  Follow nor a delivery (4 key fetches per client, a capped line, their own gate); the wait for
  a slot counts against the deadline; a domain block ends every follow it matches with `Undo`
  and `Reject`; a follower blocked after the emit gets nothing at send time, and a retry
  serving only blocked followers is dropped; `FED_TEST_LOOPBACK` boots only on a loopback
  origin; a trailing-dot origin and the platform hosts are refused; `::ffff:0:0:0/96` is
  classed like the mapped form.
- **fed-hardening-r2** (the review's second round): a full inbound gate answers 429 with
  `Retry-After`, never 401, and a silent key host is given up on after 5 s; a third /64 of a
  /48 whose other /64s spent 60 key fetches fetches nothing; 10 000 due jobs: the first pass
  under 200 ms and fewer than 20 index entries touched per delivery; a 3000-job chain on one
  object and inbox runs in `seq` order; six hanging new hosts hold at most 4 slots while a
  proven host delivers; past the caps a `Create` and a courtesy `Reject` are refused with an
  audit line and a `Delete` and an `Undo` are kept with a log line; a delivery waits 10 s at
  most; ten `Follow`s of the instance actor make one `Reject`, a day later another; five
  re-sent `Follow`s of an accepted follower inside the hour make no `Accept`, an hour later
  one; a suspension and a purge cancel the member's queued `Create` at once and keep the
  `Reject`, and a `Create` queued before the page went off is never sent; 20 HTML reads of a
  post read `log.json` at most twice and the 61st read of the minute is a 429, `/users/:name`
  in HTML included; seen ids are 32 hex characters, capped oldest out, kept across a restart,
  and a dropped `Like` records none; the hosts table is read once for 4000 calls, written on
  the debounce and at `flush()`, and read back by a new process; 20 pending requests per host
  and 500 overall, oldest out, and 9 999 accepted plus 500 pending still accept the 10 000th;
  a dead forwarded id is fetched once, and one client makes at most 30 forwarded fetches a
  minute (429 past it); outbox, collection and post answers (200, unsigned 401, blocked 404)
  are `private, no-store` with `Vary: Signature`, and a WebFinger 404 is `no-store`; a post
  written and deleted while the page was off sends no `Delete` and answers 404, one shown and
  then deleted sends its `Delete` and answers 410; a deleted, emptied or blanked
  `instance.json` over a federated data dir refuses the boot, and one with no evidence boots;
  a verified signed GET stamps `federated_at`; a torn and a misshapen job file are moved to
  `queue/damaged/` with audit lines naming their activities; `application/activity+json;q=0`
  gets the page. Each with its positive control (the fix reverted is red).
- **fed-shapes:** WebFinger for `acct:` and URL resources matches the recorded Mastodon
  WebFinger fixture's keys and types; the `Person` carries every field the recorded Mastodon
  actor carries that Mastodon requires (`id type inbox outbox followers following featured
  preferredUsername name url manuallyApprovesFollowers publicKey.{id,owner,publicKeyPem}
  endpoints.sharedInbox`); NodeInfo 2.1 validates against the vendored schema; no `totalItems`
  anywhere; a public `Note` has `to: as:Public`, `cc: followers`; the context carries the
  `ring` term.
- **fed-delivery:** a job survives a restart (stop the app mid-backoff, boot a new one over the
  same `DATA_DIR`, the job is sent); the backoff schedule; given up at 7 days with an audit
  line; a host failing 7 days goes unavailable and a verified inbound request clears it; a
  `Delete` cancels queued `Create`/`Update` for its object; one POST per shared inbox per
  activity; a 4xx other than 408 and 429 ends the job; 410 from an actor inbox drops that
  follower.
- **fed-interop (fixtures):** a Mastodon `Like` lands as ♥; an Akkoma `EmojiReact` 🌞 lands as
  🌞 and 🍕 as ♥; a Misskey `Like` with `_misskey_reaction` ✨ lands as ✨; a non-friend's
  full-palette face lands as ♥; an `Emoji`-tag reaction lands as ♥ and fetches nothing; a
  friend's Mastodon reply becomes a comment (plain text, leading mention stripped, cut at 280);
  a non-friend's reply lands only in From elsewhere; a remote `Note` with `<script>`,
  `<img onerror>`, a `javascript:` href, `style` and `class` attributes re-emits with none of
  them; a Mastodon boost is dropped; a followers-only `Note` is dropped; a `Flag` lands in
  reports; outbound stamps pick `Like`, `EmojiReact` or `_misskey_reaction` by NodeInfo.
  As built in P6, the `Flag` case was P8's (P8 holds it in `moderation`), and
  the suite adds: a Ring-term `Like` out of tier is refused, the same without the term mapped;
  a friend's status with a warning and an image fills the Friends feed with the image
  re-encoded, served to members only; an edit and a delete follow it; a friend's `Article` is
  a titled link; the tree itself (not only an emitter's output) carries no attribute but a safe
  `href`; befriending by handle, the one outbox read, a sever dropping the wall; the lookup and
  both remote-interaction routes, never an open redirect.
- **fed-write (P6):** a comment on a remote friend's post is an unlisted reply to their own
  inbox, its Note served to signers the member does not block and gone when taken back; a
  deleted post's `Delete` reaches every server that reacted; a profile change reaches the
  accounts the member follows; housekeeping's From elsewhere (30 days), walls (no friendship,
  90 days) and media (no store names it) steps; the lookup budget; with `FEDERATION=off` every
  remote door is absent.
- **fed-write-r2** (the P6 review): work is measured by counters, never a clock. The
  remote-HTML parse of a 60 KB adversarial input (nested, unwrapped and dropped tags, closers
  matching nothing, tags and quotes that never close) stays under 32 steps a byte and four
  times the input costs about four times the steps; a `Create` naming eight members is parsed
  once, an `Update` of an id nothing holds never, an `Update{Person}`'s bio once; From
  elsewhere keeps 2000 characters and 200 nodes a row with `cut` and the source's url, inside
  1 MB per member, and `GET /api/me` reads none of its rows (a block too); an `Update` or
  `Delete` of a remote Note reads only the holders' files (none for an id nobody holds); the
  visitor's GET renders a form and fetches nothing, a POST without this site's
  `Sec-Fetch-Site` or `Origin` is a 403, the answer is a page naming the host (no
  `Location`), the target is https on their own host; two silent visitor hosts hold the
  anonymous gate while a member's delivery goes, two more are refused at once, and past the
  shared budget nothing is fetched; a comment's edit after a sever, with comments off, lands
  nowhere, and one made followers-only removes it, as it removes a wall post; a domain block
  shuts out that domain's unbound instance key; no stranger's avatar is fetched, a friend's
  is, ten new avatar URLs inside the hour fetch none, an avatar on a host the server was never
  seen using is refused until a friend's post shows images there; avatars stop at their own
  cap while an image still gets a row; a `/media` miss joins the line (never more than 4
  fetches) and a member's 31st new miss a minute starts nothing; another Ring server's
  markdown keeps only its https link; an id in another actor's path never reaches a wall and a
  held id is never taken over (a stamp on it goes to its first author); every listed invisible
  character goes, an all-filler name shows as the handle, an emoji ZWJ sequence stays; a
  transient WebFinger failure keeps a bound bot bound and acting, a 404 unbinds it. Each with
  its positive control (the fix reverted is red).
- **fed-two-servers:** befriend across servers (`Follow`, `Accept`, `Follow` back, crossing);
  stamps with exact faces both ways; comments; edit and delete reach the other side; the same
  activity delivered twice applies once. As built in P6, two REAL Ring servers (one in the test
  process, one its own `node server.js`): also each one's post on the other's Friends feed (a
  Ring post rendered from its markdown by the reader's own renderer), a comment taken back, a
  block ending it both ways (and the blocked side's `Follow` dropped silently, then landing
  after the unblock: a fresh `Follow` id, 3.5), a domain block ending it from the other side,
  and an account deletion's `Delete{Person}` making the other server forget them.
- **fed-rings (two and three servers):** ask by link from another server, approve from a third,
  the seat cap held at the home under two concurrent approvals, the joiner's 3-ring cap at
  `Accept`; a room post, stamp and comment fan out to every member server and nowhere else; a
  refused reaction is withdrawn by `Remove` everywhere; an `Update{Group}` with a lower `rev`
  is ignored; after the clock moves 7 days, every server has archived or dropped the post and
  its reactions, with the home down at reset time too (local expiry); kick, leave, creator
  handoff, dissolve. **As built in P7** (`test/fed-rings.test.js`): THREE REAL Ring servers,
  A in the test process and B and C each its own `node server.js` (nothing faked between
  them). A ring made on A; bo@B and cy@C ask by its link from home (the asker's view: name
  and hosts, never the members); ana admits bo and bo admits cy from B (a third server); a
  room post with an image from C reaches A's and B's ring members (the image fetched under
  the read grant, served to ring members only), never cy's Mastodon follower nor a
  non-member here or by signed fetch at C; an edit; a custom-face stamp from B and a comment
  from A land on C (the authority) and every copy, a take-back too; a stamp C refuses
  (stamps off) is withdrawn by `Remove` from B's own copy and A's; forged Announces land
  nowhere: C posing as the Group with its member's real key, the Group's keyId with another
  key (401), the Group's genuine key relaying a non-member's post, a post addressed to
  another ring, a Note it claims C wrote (fetched from C: absent), and another ring's
  genuine Group relaying a post or a stamp for this ring; an `Update{Group}` with a lower
  `rev` changes nothing; every server a week on: the copies unread at once and gone from
  disk after the sweeps; a kick takes the ring, its copies and their images off C at once,
  a leave off B. A second test: eight askers on two servers at once, five requests, three
  answered `Reject`, five approvals at once and a late ask: six members, never seven. A
  third: the ring key (made with the ring, 0600; made lazily for a ring without one; gone
  after its last job), Ring servers only (a Mastodon account's Join refused and answered;
  a link on a Mastodon host refused, 400 `ring_server_only`), a member's own domain block,
  a block at approval (409 `ring_blocked`, the asker told; unblocked, admitted), an
  account deletion's farewell leaving the ring at its home, the joiner's 3-ring cap at
  `Accept` (Leave at once), the creator leaving (the role passes to bo@B, the home stays on
  A), a rename and the delete from B. **Positive controls** (each rule broken, the suite
  red, the file restored byte for byte, P7): the seat check at Join; Announces only from the
  ring's own Group; the inner actor a current member; addressed to the ring (both checks);
  a Note from another host fetched; `/media` room rows for ring members only; read-time
  expiry of copies; a removed member's server dropping the ring; the signed room-image gate;
  the signed room-post gate; a lower `rev` ignored; a refused reaction withdrawn; a block at
  approval; Joins from Ring servers only (home) and asks to Ring servers only (joiner); the
  joiner's 3-ring cap; a deleted ring's key removed (both paths); room content to current
  members only and to Ring servers only (fed-audience).
- **fed-rings-review (the P7 review, F1 to F7; `test/fed-rings-review.test.js`):** each
  finding's proof kept as a gate, against loopback fakes (a hostile home that declares
  `ringProtocol` and serves a Group with its own key; a member server; a foreign image host)
  and the real `server.js`. **F1**: an `Update{Group}` listing two members here who never
  asked (one at her 3-ring cap) and more members than seats seats neither, sends no `Leave`,
  and keeps at most 6; the one who asked is seated (the control). **F2**: the Group's
  `Announce` of a custom-face `Like` "by" a listed member leaves the post's own server's stamps
  empty; the same `Like` signed by that member and sent to the author lands; in fed-rings,
  the reaction reaches the authority only by its reactor's delivery and a refused one is still
  withdrawn from every copy. **F3**: the asker's view shows host names only (6 at most, junk,
  markup and a 150 000-char entry left out, the link's host when nothing is left), an ask row
  stays under 2 KB and an oversized hand-written one is settled on read, and a members view's
  `join_url` that is not http(s) at the join path on the Group's host (a `javascript:` URL, a
  query, another path, another host) is dropped while a real one is kept. **F4**, under
  `AUTHORIZED_FETCH=1` and `=0`: before the block the ring-mate's server gets the room post,
  and its signed GETs of the image and the post answer 200 (the control); after it, the room
  post is not Announced to their server, the Group's outbox holds none of the author's posts
  for it, and the image (new and old) and the post answer 404; with an unblocked member on the
  same server the post goes there again (the documented limit) and the blocked one still gets
  404 by their own key. **F5**: `lib/test-ipc.js` allows the hook only with the env var, the
  channel, not production and the loopback test hook; `advanceMs` refuses `Infinity`, NaN, a
  string and more than a year; the real `server.js` started with an IPC channel under an https
  origin (NODE_ENV unset, and `prod`) has no hook, and a loopback test server has it and
  refuses `Infinity` and ten years back. **F6**: a copy naming an image on its author's host
  and one on another host fetches only the first, signed as a member of ITS ring (two rings,
  one URL, two ids, each fetched as its own member); `/media` serves an id only to its ring's
  members; `roomSigner` signs nothing for another host, another ring, or once the copy is
  gone; a copy that is not a Ring post is refused. **F7** (counted, never timed): one file per
  copy; an author holds at most 200 live copies of a ring (a newer one pushes out their own
  oldest, never another author's), a 64 KB copy is refused and a large legitimate one fits; in
  a fresh process the index reads each copy once, then a find reads exactly one file (its
  bytes), a stamp one read and one write, `mediaIds`, `mediaRings` and a sweep none; 20
  comments per author a copy (the 21st refused, another author still writes); a week on, the
  sweep removes every file reading none. **Positive controls** (each rule broken, the suite
  red, the file restored byte for byte): F1 a local handle seated without an ask; F2 an
  Announced reaction applied at the authority, no direct send to the author (fed-rings), no
  withdraw on the direct path (fed-rings); F3 hosts unvalidated, `join_url` unchecked, ask
  rows unsettled; F4 `roomNoteFor` without the block, the signed image branch without the
  block, an Announce to an all-blocked server; F5 the hook without the loopback test hook, any
  `ms`; F6 an image from any host, a media id without the ring, a signer without a copy in that
  ring; F7 a find that reads the whole ring, no per-author comment cap, no per-author copy cap.
- **fed-audience, the room half (P7):** a room post is delivered once per member server, as
  the Group's `Announce` signed with the ring key, to the members and never the author's
  follower; an `Announce` handed to a non-member makes no job (a member's does); a member
  server that is not a Ring server gets nothing. The P5 halves (a room post is no job for a
  ring of members here only; archive and dividers never federate) hold unchanged.
- **moderation:** a member block of a remote handle drops their activities and sends
  `Reject{Follow}` but no `Block`; a member domain block covers subdomains; an admin domain
  block answers 403 inbound, stops delivery and fetches, and purges cached state; `Flag` in and
  out (the reporter's name absent from the outbound `Flag`); `/admin` and `/api/admin/*` refuse
  non-admins; the last admin cannot step down; suspension 404s the actor and stops delivery.
- **moderation, as built in P8** (`test/moderation.test.js` against fakes and a second Ring
  process, `test/admin.test.js` on one server, the signup half in `test/limits.test.js`): an
  admin domain block ends every follow both ways and emits nothing (not even an `Undo` or a
  `Reject`), drops its queued jobs, purges its wall, stamps, From elsewhere rows, cached
  actors and media, takes its stamp off the public wall, answers 403 inbound before any key
  fetch, and fetches and delivers nothing; another host untouched; lifting it hears the host
  again and restores no follow. An actor block: that person 403s (POST and signed GET), gets
  nothing at their inbox or their server's shared inbox; their neighbour is untouched. A
  `Flag` in keeps only our objects, its comment one plain line, 10 an hour per host; one
  naming nothing of ours is dropped. A forwarded report is a `Flag` from the instance actor,
  verified by the fake's own verifier, with no trace of the reporter's name; the admin
  forwards a kept one once. Suspension: the actor 404s, the member's queued `Create` goes
  and the `Reject` stays, inbound for them is for no one and lands once the suspension is
  lifted. Two Ring servers: B's admin blocks A's domain; B ends the friendship both ways,
  A hears nothing, A's post is refused and its job ended, B fetches nothing from A until the
  lift. The render-time filters hide a blocked person's stamp, friend tag and Inbox row with
  no purge run, and housekeeping then purges. A `Follow` of a Group is never answered. Every
  admin route and `/admin`: 401 signed out, 403 a member, the cross-site 403 even for the
  admin; the last admin; a local suspension (no sign-in, the wall 404s, lifted restores);
  reports (an unseen post 404, one's own 400, a comment; `remove_post` through the one delete
  with the author's notice, which names no reporter); the signup door's counts name no one,
  release and clear; `BLOCKED_DOMAINS` seeds once. Signup: a stranger on six /64s of one /48
  gets five mails, the mailbox owner elsewhere still gets theirs, 30 a day per address, a
  release reopens it; one requester holds 10 pending rows, another is unaffected. Every rule
  has its positive control (the rule broken, the gate red, the file restored byte for byte):
  21 of them, run in P8.
- **moderation, the P8 review** (`test/moderation-review.test.js`, `test/host-normalizer.test.js`,
  `test/signup-hold.test.js`; each finding's proof turned into a gate): F1, a comment report
  and a stamp report remove exactly that row and never the post it is on (`remove_post` on
  them 409, the post stays, another member's comment and stamp on it stay), the notice goes
  to the author only (never the reporter who owns the post), a post report still removes its
  post, and a post report whose post is not its target's removes nothing. F2, a `Flag` naming
  one member's actor and another's post files two reports, each with only its member's
  objects; `remove_post` on the first leaves the second's post, on the second removes it; a
  `Flag` naming seven members files five. F3, 40 subdomains and 10 ports of one site over
  three hours file 10 in the first hour and 20 in all, another site still files; a domain
  block closes the site's 20 open reports and leaves another origin's open; an actor block
  closes the two its person signed and leaves their neighbour's; 120 reports page 50, 50, 20
  by cursor, every one once, open first and newest first, a foreign cursor 400; 300 inserts
  make 300 appends and no rewrite, an update appends and keeps its place, a hand edit is
  read, a torn last line is ignored and compacted at the next write, a damaged line refuses
  the read. F4, THE normalizer's table (case, one trailing dot, IDN, IP literal forms; empty
  labels, junk and bad ports refused), the handle writer, the suffix walk, `BLOCKED_DOMAINS`
  and a hand-edited member list read the one way; an admin block spelled `LocalHost.`
  refuses the remote `localhost.` at the signed GET, the inbox POST, the lookup (by URL and
  by handle) and the media cache with no request reaching it, and the fetcher refuses its
  inbox (`ERR_BLOCKED`) with nothing delivered; unblocked, it is asked, by the name without
  its dot; a refuse rule that knows only `localhost:<port>` refuses `LOCALHOST.:<port>`, and
  `localhost..` is never asked; an admin block spelled `BÜCHER.LOCALHOST.` refuses
  `xn--bcher-kva.localhost` at the signed GET, the inbox, the lookup, the media cache (its
  cached image gone with the block) and delivery, every door open before the block; a
  member's blocks spelled `LOCALHOST.` and `Bücher.Localhost.` are stored the one way and hold
  at the signed GET (404, the neighbour's 200), the inbox (no request, the neighbour gets
  one), the lookup (404 and nothing asked, the neighbour's 200) and delivery. F5, one
  requester (one /48, a fresh /64 each time) at its full rate for thirty hours never closes
  an address (the owner is mailed every time they try); six requesters close it, the owner's
  five tries while held spend nothing of theirs, a release opens it and none of the six can
  refill it; the owner's confirm clears the ceiling and the strangers' rows; before the first
  member the shell's release (`scripts/signup-release.js`, the address as typed) opens
  `ADMIN_EMAIL` held by six, the six cannot refill it, the operator confirms as admin, the
  audit names `shell` and never the address. The lower findings: a closed report refuses
  resolve, dismiss, remove_post and suspend (409) and reopened acts again; `block_actor` and
  `actor-blocks` refuse (403, nothing blocked) when the admin stepped down during the lookup,
  and block when they did not; an IPv4 and an IPv6 literal (two spellings, one row) are
  domain blocks covering that address only; a suspension cancels the queued Group
  `Announce` of the member's room post and keeps another member's, which is delivered.
  Every rule has its positive control (the rule broken, the gate red, the file restored byte
  for byte): 33 of them, run in the P8 review.
- **origin-lock:** the server refuses to boot under a changed `PUBLIC_ORIGIN` after
  `federated_at`; boots under it before; `FEDERATION=off` 404s every AP route; a second process
  on one `DATA_DIR` refuses to start; a retired name is never reissued.
- **export (P9, `test/export.test.js`):** one folder in a standard zip (read back by a strict
  reader that checks every CRC, size and local header, and by the system's `unzip -t` when
  there is one); posts with ids and URLs, the archive included; settings, profile; friends,
  following (Mastodon's header and rows) and followers as `name@host`; the stored originals of
  the member's own page images and never another member's; the manifest lists exactly the other
  files at their sizes and SHA-256; no `key.pem` and no `PRIVATE KEY` in the GET or the POST
  without the tick; with the tick a wrong or missing password is 403 and a non-boolean `key`
  400, and the right one adds the key byte for byte (the control), audited without it; a reset
  landing inside the compare is 409 with no key; over the cap 413 before any zip byte; the
  fourth export in a minute is 429 with `Retry-After`; signed out 401. **Positive controls**
  (each rule broken, the suite red, the file restored byte for byte): the key without the
  password check; the key on the plain export; the stillCurrent tick skipped; another
  member's image let in; the size cap off; the export budget off; a file left out of the
  manifest.
- **backup (P9, `test/backup.test.js`):** on a live server the tar holds exactly the data
  files minus sessions, `fed/media/`, `backups/`, the lock, write temps and a symlink, each
  byte for byte, 0600 (directories 0700), with a long name through the prefix field and one
  past 255 bytes skipped and counted; the system's `tar -tzf` lists the same names; restored
  into an empty dir it boots, signs the member in and serves their post and image; the script
  prints the path and counts and no key, email, hash or inside name; it refuses a dir that is
  not a data dir and an output inside one (its own `backups/` allowed and left out), exiting 1.
  **Positive controls**: an exclusion dropped; the 0600 mode; symlinks followed; the
  inside-the-data-dir refusal off.
- **export-and-backup-hardening (P9 review, `test/export-hardening.test.js`,
  `test/backup-hardening.test.js`):** a cross-site navigation and a foreign `Origin` on the
  export GET are 403 `csrf` and spend nothing (three own exports then pass, the fourth is
  429), same-site, same-origin and a typed address pass; two paused exports hold the two
  slots, a third (GET or POST) is 503 `export_busy` with `Retry-After: 30`, a cut reader frees
  its slot and the next export is 200; a reader that never reads is cut by the idle bound
  (the slot comes back while it still does not read, and the answer it then reads is
  incomplete); `settings.blocked` reads `name@host` for a local block and keeps a remote one;
  an image whose original is gone is in `missing`, the export 200 with every other file and
  hash; the writer refuses `..`, a leading `/`, a backslash, a drive letter, a NUL and an
  empty name, and takes `..hidden` and `a..b`; the table CRC-32 equals `zlib.crc32` whole and
  running (and the check value); each image is opened once and read for exactly its size,
  with no separate hash pass; a file past the one-read size is one open and two passes, an
  in-place change during the data pass fails the stream, and an optional file gone is
  reported, not fatal. The backup, with a sign-up and an upload landing right after every
  directory it lists: every `members.json` row has its key, every `images.json` row its
  original, every image a post names its row; the output is refused through a symlink, below
  one, with a symlinked `--data`, through a case-insensitive spelling and as `BACKUPS/`, with
  no directory made; earlier tars and `.part` files anywhere inside are never carried; a file
  gone meanwhile is skipped, an unreadable one (EACCES) fails the run naming it and leaves
  nothing; a 20 MiB file streams byte for byte, a 2 GiB + 4 KiB one is recorded at its size,
  one past 8 GiB is refused by name; an existing target is refused and left byte for byte; the
  README and 15.4 name the outbox's links, the invite codes and `--no-same-owner`.
  **Positive controls** (each fix reverted, the suite red, the file restored byte for byte):
  the GET guard off; the concurrency cap off; the idle timeout off; `blocked` unmapped; the
  missing list dropped; the name check off; the table CRC broken; the native CRC off; a
  small image read in two passes; the data pass's CRC check off; `keys/` and `images/` walked
  before the indexes; the indexes read before the account dirs; the inside check on plain
  strings; earlier tars let in; every read error skipped; the whole-file read for every size;
  the overwrite allowed; the README's invite-code line gone.

### 16.4 Interop smoke: a manual checklist against a real Mastodon account

Run at the end of P5 (1 to 4, 12, 14), P6 (5 to 9, 13, 15), P7 (10) and P8 (11). Record the
Mastodon version used.

1. Search `@name@host` on Mastodon: the profile shows name, bio, avatar, the lock, verified
   links, pinned posts, and no counts or zeros.
2. Follow: the request shows in Ring's Inbox; Let follow; Mastodon shows "following".
3. Post a note, an image with alt text, a post with a warning, a link and an embed: each
   reaches the Mastodon home timeline; alt text present; the warning collapses; the embed is a
   link card.
4. Edit a post: Mastodon shows it edited. Delete one: it disappears.
5. Favourite on Mastodon: ♥ on the wall; unfavourite: gone.
6. Reply from Mastodon as a non-friend: From elsewhere only. Befriend from there; Mastodon
   gets a follow; reply again: a comment on the wall.
7. Stamp a Mastodon post from Ring: a favourite notification there. Comment: an unlisted reply
   in the thread.
8. Sever: neither follows the other on Mastodon.
9. Block the Mastodon account: their favourite no longer shows; they are no longer a follower.
10. Paste a room post's URL into Mastodon's search: nothing is found.
11. Report a Mastodon post with "also send": the report reaches that server's moderators (use
    a test Mastodon whose admin can look).
12. Turn the page off: the profile still resolves, new posts do not arrive, a pasted public
    post URL finds nothing.
13. Delete the Ring account: Mastodon drops it.
14. Open `/@name.rss` in a feed reader.
15. On Akkoma or Misskey: a 🌞 reaction shows as 🌞 on the wall; a Ring 🌞 stamp shows as that
    reaction there.

P6 automates the Ring side of items 5 to 9, 13 and 15 against fakes and a second real Ring
server (`fed-interop`, `fed-two-servers`, `fed-write`): what Ring sends is checked by each
fake's own verifier, and what it receives is the fixtures' shapes. **The manual run against a
real Mastodon, Akkoma and Misskey still has to be done** on a server on its final domain (no
build reaches a real server); record each software's version, and replace the constructed P6
fixtures with recordings from that run.

P8 automates the Ring side of item 11: the `Flag` a forwarded report sends is checked by the
fake's independent verifier (signed by the instance actor, Mastodon's shape, no reporter's
name); whether a real Mastodon shows it to its moderators stays the manual step, on a server
on its final domain with a test Mastodon whose admin can look.

P7 automates the Ring side of item 10: a room post's URL answers 404 to any signer who is
not a current member of its ring (a Mastodon search fetches it signed by its instance actor,
or unsigned), and room activities never reach a Mastodon host (`fed-audience`, `fed-rings`).
The manual step stays: paste a room post's URL into a real Mastodon's search on the final
domain and see nothing found.

## 17. Build phases

Each phase ships, runs and is tested on its own.

- **P1, L. Server, storage, accounts, posts.** Skeleton, store, session store, members,
  invite-only signup (`SIGNUP`, invites, the first admin by `ADMIN_EMAIL`) with confirm, login,
  logout, reset, deletion (local purge), **a keypair per member at confirm**, CSRF and headers,
  the image door and gate, own posts and page settings (`cw`, bio, avatar, links), `GET
  /api/pages/:name`, the projection cache, `instance.json`. **Federation-shaped from the
  start**: CSPRNG ids, derivable object URLs, the handle rule in every row; no AP route
  answers yet. Tests: auth, ids-and-keys, images, ring, privacy (public half), auth-signup,
  limits, auth-production, auth-races, csprng, auth-sessions, store, lifecycle, harness-hang,
  harness, copy.
  **P1's pages are placeholders** (`routes/site.js`): `/` (a landing line), `/signup/confirm`
  and `/reset` (the two pages a mailed link opens; `/reset` only redeems a token), a 404 page,
  `/robots.txt` and `/api/health`. P1's mails and invites already link to pages that arrive in
  P3: the "already have an account" mail points at `/login` and at `/reset` to ask for a link
  (asking is `POST /api/password/forgot`; its form is P3's), and an invite's URL is
  `/signup?invite=<code>`. Until P3, `/login` and `/signup` answer the 404 page; signup and login
  go through the JSON API.
- **P2, L. The local social layer, as activities.** `lib/activities.js`, `lib/ap-inbound.js`
  and `emit()` delivering in-process; follows (friends, followers, requests), rings as home
  rows shaped like Groups (`ap_id`, `rev`), stamps, comments, inbox, the three feeds, the sweep
  and read-time expiry, Keep, archive (`lib/rings.js`, `lib/ring-reset.js`), carried on
  activities. Tests: the remaining core suites (16.2), the rest of
  privacy, activity-shapes.
- **P3, L. The composer.** The board and Friends, the primitives, the CSS, strings, Settings with Friends (followers, requests), Page and Account, Pin,
  Edit, the warning field, the auth pages (`/login`, `/signup` reading `?invite=`, the forgot
  form beside `/reset`), which P1's mails and invite URLs already point at.
- **P4, M. The wall.** `/@name`: the vanilla wall, member stamps and comments, befriend
  sticker, odometer, bio, avatar, `rel="me"` links, head tags, `noindex` unless indexable;
  `/@name.rss`. From here an operator can run a real, private server on its final domain with
  `FEDERATION=off`.
- **P5, L. Federation, read side and following.** WebFinger, NodeInfo, the `Person` and
  instance actors, outbox, `featured`, followers and following, object URLs, `/@name`
  negotiation, authorized fetch, `lib/net.js`, `lib/http-sig.js` both ways, the actor cache,
  the delivery queue and worker, the origin lock and `FEDERATION=on`, and the narrow inbox
  slice following needs: `Follow` and `Undo{Follow}` in; `Accept`/`Reject`, and `Create`,
  `Update`, `Delete` of public posts, `Add`/`Remove` of pins and `Update{Person}` out to
  followers. **This is the first point an operator can run a real server on a domain and follow a
  wall from Mastodon**: search `name@host`, follow, approve, and posts, edits and deletes
  arrive. Tests: fed-signature, fed-ssrf, fed-hardening, fed-shapes, fed-delivery,
  fed-audience (public, archive and page-off halves), origin-lock; smoke 1 to 4, 12 and 14.
- **P6, L. Federation, write side.** The full inbox registry (4.10) with ownership checks;
  `Like`/`EmojiReact` both ways by software; replies in (comments, From elsewhere) and out;
  friendships across servers, Mastodon included; remote friends' posts in the Friends feed;
  the node-tree re-emitter; the remote media cache; lookup and `authorize_interaction`;
  `Update`/`Delete` in; `Delete{Person}` in and out; the member block extended to remote
  handles; `BLOCKED_DOMAINS` as the stopgap. Keep signup invite-only between P6 and P8. Tests:
  fed-ownership, fed-interop, fed-two-servers; smoke 5 to 9, 13 and 15.
  **As built:** `lib/remote-html.js` (the re-emitter), `lib/remote-note.js` (THE reader of a
  remote post), `lib/remote-media.js` (the cache), `lib/walls.js`, `lib/sent.js`,
  `lib/elsewhere.js`, `lib/remote-in.js` (the server's inbound table), `routes/remote.js`
  (`/api/remote/*`, `/api/lookup`, `/media`, `/authorize_interaction`), and P5's modules
  widened (the registry, `mayLeave`, the actor cache's gone, unbound and update, NodeInfo in
  `hosts.json`, `BLOCKED_DOMAINS` at the fetcher and the queue, the farewell in the purge). The
  composer un-hides Befriend for remote handles, renders remote cards (the node tree, the
  media cache's images), shows From elsewhere in the Inbox, and opens a lookup panel
  (`/app?open=`, Settings › Friends); a wall offers a visitor "follow" and "stamp from your
  server". Gates: fed-interop, fed-ownership, fed-two-servers, fed-write, each security rule
  with a positive control (the rule broken, the gate red, the file restored byte for byte).
  Decisions recorded in 2.6, 3.5, 4.6, 4.8, 4.9, 4.10, 5.3, 5.7, 5.8, 6.5, 8.5, 11.2, 11.4,
  16.1. **Left for P7**: the ring activities in the registry and their checks (4.7), remote
  ring members (a gone actor's ring seats, a blocked domain's people out of home rings, the
  room half of `/media`), room posts, stamps and comments over federation (`mayLeave` refuses
  anything with an `audience`, and a custom face), and a join link of another server in the
  lookup. **Left for P8**: `Flag` in and out, and the admin domain block that replaces
  `BLOCKED_DOMAINS` (ending follows, purging cached actors).
- **P7, M. Rings across servers.** The Group actor, its inbox, members and outbox, join by link
  from another server, `Accept`/`Reject`, `Leave`, `Remove`, `Update{Group}` replicas,
  `Announce` fan-out with origin checks, room copies and room image caching under the read
  grant, reaction authority (`Remove`), reset `Delete`s and local expiry of copies, the trust
  notices and host lists. Tests: fed-audience (room half), fed-rings; smoke 10.
  **As built:** `lib/ring-fed.js` (the member servers' half: asking by a link of another
  server, the replicas, the `ring` table, the Announce checks, copies and the authority's
  withdrawal, a replica's acts), `lib/rooms.js` (the copies), the ring key in `lib/keys.js`,
  the Group routes and the signed room-post and room-image branches in
  `routes/federation.js`, and P2 to P6's modules widened: `lib/groups.js` (remote handles,
  the Group's fan-out, a block at approval, Ring peers only, copies at the home),
  `lib/ap-inbound.js` (the `ring` table), `lib/federation.js` (what a ring may send and to
  whom, the ring route in, room jobs still sendable, `_ring:` signers), `lib/actors.js`
  (`group` records, member-signed fetches), `lib/remote-media.js` (room rows, `forget`),
  `lib/stamps.js` and `lib/comments.js` (the authority on a ring hosted elsewhere; a room
  reply), `lib/post-delivery.js` (a replica's `ap_id`), `lib/feeds.js` (copies in the ring
  feed), `routes/rings.js` and `routes/remote.js` (a remote link, a copy's reactions, the
  lookup), housekeeping (`rings_blocked`, `ring_keys`, room media named). The composer shows
  the hosts that hold a ring and where it is hosted, asks before admitting someone from
  another server with the trust notice, and offers "Ask to join" for another server's link
  in the lookup. Decisions recorded in 2.6, 3.6, 3.8, 3.10, 3.11, 4.7, 4.10, 5.3, 5.4, 5.7,
  6.5, 7, 8.5, 10.6, 11.1 to 11.3, 16.1, 16.3, 16.4. **Left for P8**: the admin domain block
  that replaces `BLOCKED_DOMAINS` (it takes over `rings_blocked`), `Flag`; the Group's `Reject`
  of a `Follow` (a `Follow` of a Group is dropped); a member's server cannot see a remote
  member's own blocks at approval (the honest limit of 3.6); the manual smoke 10 on a real
  domain.
- **P8, M. Moderation.** Member domain blocks, admin domain and person blocks, reports with
  `Flag` in and out, `/admin`, suspension over federation; replaces `BLOCKED_DOMAINS`. Also
  P1's known signup limit (10.11): a stranger can spend an address's signup-mail budget or
  fill the pending cap, delaying a real signup. Tests: moderation; smoke 11.
  **As built:** `lib/moderation.js` (the lists and their predicates), `lib/moderate.js` (what a
  block, a suspension, a report's forward and an inbound `Flag` do), `lib/notices.js`,
  `lib/signup-guard.js`, `routes/admin.js`, `routes/reports.js`, `app/admin.tsx` and
  `app/admin.css` (the lazy chunk), `app/report.tsx`, and P1 to P7's modules widened: the
  inbox, fetcher and queue ask the admin's list (`lib/federation.js`, `lib/queue.js`
  `actorBlocked`, `inboxBlocked`, `dropHosts`), `lib/actors.js` forget, `lib/ring-fed.js`
  sweepBlocked (actor blocks, copies in rings hosted elsewhere), the render-time filters
  (`lib/reactions.js`, `lib/inbox.js`, `lib/feeds.js`, the wall's friend tags), `lib/tokens.js`
  (a requester's share), `lib/rate-limit.js` forget, housekeeping (`reports`, `moderation`),
  THE post delete moved to `lib/app.js` deletePost. Decisions recorded in 3.11, 4.5, 4.7,
  4.9, 4.10, 5.2, 5.4, 5.9, 6.2, 6.3, 6.5, 10.11, 11.1, 11.3, 13.1, 15.3, 16.1, 16.3, 16.4.
  **Left**: the manual smoke 11 on a real domain; member domain blocks were built in P6 and
  are unchanged but for THE host normalizer (the review, below).
  **The P8 review** (F1 to F5 and four lower findings): a report's own `post` and `ref`
  fields and removals that act only on them (`remove_comment`, `remove_stamp`, the notice to
  the author only); one report per member an inbound `Flag` names; per-site `Flag` budgets
  and caps (`lib/handles.js` siteOf), a block closing its origin's open reports, the queue
  paged by cursor, the append-only report store; THE host normalizer (`lib/handles.js`
  canonHost, hostOfUrl) at every door; the signup door's exact claim (5 a day per requester,
  both budgets asked before either is spent, the owner's confirm and the shell's
  `scripts/signup-release.js` releasing); closed reports refusing all but `reopen`, the admin
  asked again after a lookup, IP-literal domain blocks, and a suspension cancelling the
  Group's queued `Announce` of the member's room posts. Recorded in 3.11, 4.9, 5.6, 5.9, 6.1,
  6.2, 6.3, 6.5, 10.7, 10.11, 11.1, 16.3.
- **P9, M. Export and backup.** The member export (12): one streamed zip of posts, settings,
  profile, images, the friend, following and follower lists (`following.csv` and
  `friends.csv` in Mastodon's follow-import format), the signing key only with the tick and
  the password typed again; a size cap and a rate limit. `scripts/backup.js`, the admin's
  full-data tar (15.4). Tests: export (the export half of ids-and-keys), backup,
  export-and-backup-hardening (the review's rules: 10.10, 12, 15.4).
  **As built:** `routes/export.js`, `lib/zip.js` (the writer), `lib/keys.js` `exportPem()`
  (the one serializer of a member's private key, for this door only), `scripts/backup.js`,
  the Export card in Settings › Account (`app/account.tsx`). **Decided in P9**: the export is a
  readable folder of plain files; the backup's name carries the time. Checked in the built-in browser at desktop and phone width
  (the card, the tick's warning and password field, a wrong password and the export budget
  said on the form, both downloads). Decisions recorded in 1, 2.7, 3.2, 3.4, 10.4, 10.10,
  11.1, 12, 13.1, 14, 15.4, 16.2, 16.3, 17.

## 18. Open questions

None open. Answered 2026-10-14: decisions 6 to 9 in section 0.
