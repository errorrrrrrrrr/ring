/* ── The composer's data shapes (spec 13.1, 11.1) ─────────────────────────────
 * The shapes Ring's server
 * answers (routes/*.js, lib/feeds.js, lib/projection.js, lib/inbox.js): five
 * kinds; `cw`, `url`; an
 * author is a handle with a name, a wall URL and a host. `origin` marks a
 * remote card (P6): a remote friend's post on the Friends feed, or a looked-up
 * one, whose text is a node tree (`tree`, never HTML) unless it came from a
 * Ring server (then `html` is THIS server's own rendering of its markdown).
 */
import type { StampStyle } from '../lib/palette.js';

export type { StampStyle };
export type Kind = 'note' | 'image' | 'link' | 'embed' | 'divider';
export type DividerVariant = 'line' | 'dots' | 'stars' | 'wave';

/** Who wrote a post, pressed a stamp or left a comment. */
export interface Who { handle: string; name: string; url: string; host: string; remote?: boolean; avatar_url?: string; gone?: boolean }

/** A node of another server's text (lib/remote-html.js): text, or an allowed tag. */
export type RemoteNode = string | { t: string; c?: RemoteNode[]; href?: string };
/** A remote post's image, re-encoded into the media cache (members only). */
export interface RemoteMedia { url: string; thumb_url: string; alt: string; width?: number; height?: number }
/** A remote post's attachment shown as a link to its source (video, audio). */
export interface RemoteLink { kind: string; url: string; alt: string }

export interface StampView { id: string; kaomoji: string; at: string; author: Who; custom?: boolean; tint?: string }
export interface CommentView { id: string; body: string; at: string; author: Who; truncated?: boolean; source_url?: string }

/** A post as a feed or the archive shows it (the projection plus its author). */
export interface PostView {
  id: string;
  kind: Kind;
  created_at: string;
  updated_at?: string;
  audience: string;
  url: string;
  pinned?: boolean;
  kaomoji?: string;
  cw?: string;
  html?: string;
  note_html?: string;
  image_key?: string;
  image_url?: string;
  thumb_url?: string;
  width?: number;
  height?: number;
  alt?: string;
  href?: string;
  label?: string;
  sub?: string;
  provider?: string;
  src?: string;
  media_kind?: string;
  page?: string;
  variant?: string;
  author: Who;
  stamps: StampView[];
  comments: CommentView[];
  stamps_off?: boolean;
  comments_off?: boolean;
  expires_at?: string;
  archived_from?: string;
  archived_from_name?: string;
  archived_at?: string;
  origin?: 'local' | 'remote';
  tree?: RemoteNode[];
  cut?: boolean;
  title?: string;
  media?: RemoteMedia[];
  links?: RemoteLink[];
}

export interface Muted extends Who { reason: string }

export interface FeedAnswer {
  posts: PostView[];
  ends: boolean;
  next_cursor?: string | null;
  muted?: Muted[];
  palette: StampStyle[];
  me_page_off: boolean;
  ring?: { id: string; name: string };
}

export interface PostMedia {
  key?: string; alt?: string; href?: string; label?: string; sub?: string; url?: string; variant?: string;
}

/** A post as its author stores it (GET /api/me/page): the raw fields an edit needs. */
export interface StoredPost {
  id: string;
  kind: Kind;
  created_at: string;
  updated_at?: string;
  audience: string;
  note?: string;
  cw?: string;
  kaomoji?: string;
  pinned?: boolean;
  stamps_off?: boolean;
  comments_off?: boolean;
  media?: PostMedia;
  archived_from?: string;
  archived_at?: string;
  url: string;
  wall_url: string;
}

export interface Theme { bg: string; bg_image_key: string; font: string; marquee: string; blink: boolean; cursor: string }
export interface PageLink { label: string; href: string }

export interface PageStore {
  enabled: boolean;
  indexable: boolean;
  open_follows: boolean;
  stamps_off: boolean;
  comments_off: boolean;
  blocked: string[];
  blocked_domains: string[];
  theme: Theme;
  bio: string;
  avatar_key: string;
  links: PageLink[];
  posts: StoredPost[];
}

export interface Me {
  name: string;
  handle: string;
  display_name: string;
  email: string;
  role: 'member' | 'admin';
  created_at: string;
  actor: string;
  page_url: string;
  page: { enabled: boolean; indexable: boolean; open_follows: boolean; stamps_off: boolean; comments_off: boolean };
  invites: { live: number; limit: number };
  storage: { used: number; limit: number };
  unseen: number;
}

export interface RingMember { handle: string; name: string; url: string; host: string; joined_at: string; remote?: boolean }
export interface RingRequest { handle: string; name: string; host: string; asked_at: string; kicked?: boolean; remote?: boolean }
export interface Ring {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  mine: boolean;
  rev: number;
  members: RingMember[];
  requests: RingRequest[];
  join: { url: string; code: string; expires_at: string } | null;
  full: boolean;
  /** Every server that holds the room (P7, the trust notice). */
  hosts: string[];
  /** false: a ring hosted on another server (P7); its home is `home_host`. */
  home: boolean;
  home_host: string;
}
export interface RingsAnswer { rings: Ring[]; max_members: number; max_rings: number }

export interface JoinOffer {
  name: string;
  offered_by: string;
  members: number;
  max_members: number;
  already_member: boolean;
  requested: boolean;
  full: boolean;
  at_my_cap: boolean;
  hosts: string[];
}

export interface InboxJoin { ring: { id: string; name: string }; handle: string; name: string; url: string; short_name: string; asked_at: string; kicked?: boolean }
export interface InboxFollow { handle: string; name: string; url: string; at: string; host?: string }
/** A reply or mention from outside that is not a comment (From elsewhere, P6). */
export interface InboxElsewhere {
  id: string; kind: 'reply' | 'mention'; author: Who; tree: RemoteNode[]; cut?: boolean; summary: string;
  url: string; at: string; published: string; seen: boolean; post_id?: string;
}
export interface InboxStamp extends StampView { post_id: string; seen: boolean }
export interface InboxComment extends CommentView { post_id: string; seen: boolean }
export interface Inbox {
  join_requests: InboxJoin[];
  follow_requests: InboxFollow[];
  stamps: InboxStamp[];
  comments: InboxComment[];
  elsewhere: InboxElsewhere[];
  /** P8: what the server told me about my own things (a post an admin removed). */
  notices?: { id: string; kind: 'post_removed' | 'comment_removed' | 'stamp_removed'; at: string; seen: boolean }[];
  unseen: number;
}

export interface FriendsAnswer {
  friends: Who[];
  pending_in: (Who & { at: string })[];
  pending_out: (Who & { at: string; state: string })[];
}
export interface FollowersAnswer {
  followers: (Who & { at: string })[];
  requests: (Who & { at: string })[];
  open_follows: boolean;
}

export interface Invite {
  id: string;
  code: string;
  url: string;
  state: 'live' | 'used' | 'expired';
  created_at: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
}
export interface InvitesAnswer { invites: Invite[]; live: number; limit: number }

export interface Uploaded { key: string; url: string; thumb_url: string; width: number; height: number }

/** GET /api/lookup (P6, spec 8.5). */
export type Lookup =
  | ({ type: 'person'; local: boolean; status: 'none' | 'pending' | 'friends' | 'self'; actor?: string; bio?: RemoteNode[] } & Who)
  | { type: 'post'; local: true; owner: string; id: string; url: string }
  | { type: 'post'; local: false; post: PostView; friends: boolean }
  | { type: 'join'; local: true; code: string }
  | { type: 'join'; local: false; url: string; name: string; hosts: string[]; already_member: boolean; requested: boolean; at_my_cap: boolean; max_members: number };

/** Where the board stands: the square, the Friends feed, a ring id, or the shelf. */
export type FeedId = 'public' | 'friends' | 'archive' | string;
