/* ── /app: the composer (spec 13.1) ───────────────────────────────────────────
 * The rail is the whole chrome: there is no shell around the composer.
 *
 *   THE RAIL      Public (a globe), Friends, each ring by its initials with an
 *                 unread dot (this browser's last look, localStorage, never a
 *                 count), + New ring (makes it, copies the link); then the verbs:
 *                 Inbox (requests counted, reactions a dot), Archive, Settings.
 *   THE BOARD     the feed the rail picked, in the wall register (board.tsx):
 *                 the square pages 20 at a time behind a sentinel; Friends says
 *                 whose page is off; a room keeps its "clears after a week"
 *                 line; the shelf its own. The Public board wears my theme live.
 *   THE COMPOSER  a blank sticky on the board opens it (composer.tsx); an Edit
 *                 on my card opens it on that post.
 *   ?ring=<code>  a join link landed here (/rings/join/<code> sends a member):
 *                 Settings › Rings opens on the offer, "Ask to join".
 *   ?open=<uri>   P6: /authorize_interaction sent a member here with a handle, a
 *                 profile, a post or a join link from anywhere: the lookup
 *                 (GET /api/lookup) opens it with its verbs (Befriend; stamp,
 *                 and a note when friends; Ask to join for a link here).
 *                 Settings › Friends has the same lookup field.
 *   REMOTE CARDS  a stamp or a note on another server's post goes through
 *                 /api/remote/*: the server shapes it for the other side's
 *                 software and keeps it so it can be taken back.
 *
 * The server is the authority for every rule (audience, tiers, blocks, caps);
 * this decides only what to offer, and shows the server's own message when it
 * refuses. Every write goes through api.ts; nothing is stored client-side
 * except the rooms' last-seen marks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { t } from './strings.ts';
import { get, post, put, patch, del, enc, copyText, errorText, imgUrl } from './api.ts';
import { PALETTE } from './palette.ts';
import { Popover } from './popover.tsx';
import { useConfirm } from './confirm.tsx';
import { Toast, useToast } from './ui.tsx';
import { Board, DaysRail, type CardActions } from './board.tsx';
import { Composer, type AudienceOption } from './composer.tsx';
import { draftBody, type Draft } from './drafts.ts';
import { InboxPanel } from './inbox.tsx';
import { LookupPanel } from './lookup.tsx';
import { ReportPanel, type ReportTarget } from './report.tsx';
import { SettingsPanel, type Section } from './settings.tsx';
import { cardKey, initials, isRoom, mergeFeed, patchCard, themeStyle, unreadRooms, waitingCount, withoutComment, withoutStamp } from './wall.ts';
import type {
  CommentView, FeedAnswer, FeedId, FriendsAnswer, Inbox, JoinOffer, Lookup, Me, Muted, PageStore, PostView, Ring, RingsAnswer, StampView, StoredPost,
} from './types.ts';

const hostOfUrl = (u: string): string => { try { return new URL(u).host; } catch { return ''; } };

export function App() {
  const [toastText, say] = useToast();
  const [ask, confirmUI] = useConfirm();
  const [me, setMe] = useState<Me | null>(null);
  const [store, setStore] = useState<PageStore | null>(null);
  const [rings, setRings] = useState<Ring[]>([]);
  const [caps, setCaps] = useState({ max_members: 6, max_rings: 3 });
  const [friends, setFriends] = useState<Set<string>>(new Set());
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [loadError, setLoadError] = useState('');

  const [feed, setFeed] = useState<FeedId>('public');
  const [posts, setPosts] = useState<PostView[] | null>(null);
  const [ends, setEnds] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [muted, setMuted] = useState<Muted[]>([]);
  const [mePageOff, setMePageOff] = useState(false);
  const [nonce, setNonce] = useState(0);
  const feedRef = useRef(feed);
  feedRef.current = feed;

  const [composer, setComposer] = useState<{ open: boolean; editing: StoredPost | null }>({ open: false, editing: null });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<Section>('friends');
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [newRingOpen, setNewRingOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [offer, setOffer] = useState<JoinOffer | null>(null);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [looked, setLooked] = useState<{ q: string; result: Lookup | null; error: string } | null>(null);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);

  const postNoteRef = useRef<HTMLButtonElement>(null);
  const composerAnchor = useRef<HTMLElement | null>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const inboxRef = useRef<HTMLButtonElement>(null);
  const newRingRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const topMark = useRef<HTMLDivElement>(null);
  const moreEl = useRef<HTMLDivElement>(null);

  const viewer = me?.handle || '';
  const myHost = me ? hostOfUrl(me.page_url) : '';
  const palette = PALETTE.STAMP_STYLES;
  const shelfCtx = useMemo(() => ({ viewer, friends }), [viewer, friends]);

  // ── loads ──
  const loadMe = useCallback(async () => setMe(await get<Me>('/api/me')), []);
  const loadStore = useCallback(async () => { try { setStore(await get<PageStore>('/api/me/page')); } catch (e) { say(errorText(e)); } }, [say]);
  const loadRings = useCallback(async () => {
    try {
      const d = await get<RingsAnswer>('/api/rings');
      setRings(d.rings);
      setCaps({ max_members: d.max_members, max_rings: d.max_rings });
      // A board that dissolved under me (left, deleted, kicked) falls back to the square.
      setFeed((f) => (isRoom(f) && !d.rings.some((r) => r.id === f) ? 'public' : f));
    } catch (e) { say(errorText(e)); }
  }, [say]);
  const loadFriends = useCallback(async () => {
    try { setFriends(new Set((await get<FriendsAnswer>('/api/friends')).friends.map((f) => f.handle))); } catch { /* the tray falls back to the nice shelf */ }
  }, []);
  const loadInbox = useCallback(async () => {
    try { setInbox(await get<Inbox>('/api/inbox')); } catch { /* the dot waits for the next look */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([loadMe(), loadStore(), loadRings(), loadFriends(), loadInbox()]);
      } catch (e) { setLoadError(errorText(e)); }
      // Sent here by /authorize_interaction (P6)? Look it up.
      const opened = new URLSearchParams(location.search).get('open') || '';
      if (opened) lookUp(opened);
      // Followed a join link? Offer the ask (the link asks, it never admits).
      const code = new URLSearchParams(location.search).get('ring') || '';
      if (code) {
        setJoinCode(code);
        setSection('rings');
        setSettingsOpen(true);
        try { setOffer(await get<JoinOffer>(`/api/rings/join/${enc(code)}`)); }
        catch { say(t('rings.link_dead')); clearRingParam(); }
      }
    })();
  }, [loadMe, loadStore, loadRings, loadFriends, loadInbox, say]);

  // The Inbox dot follows the person back to the tab: one look on focus, no poller.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') loadInbox(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [loadInbox]);

  const clearRingParam = () => {
    try {
      const u = new URL(location.href);
      u.searchParams.delete('ring');
      history.replaceState(null, '', u.toString());
    } catch { /* the offer simply comes back on reload */ }
  };

  // ── the feed ──
  const feedUrl = (f: FeedId): string => (f === 'public' ? '/api/feed' : f === 'friends' ? '/api/feed/friends' : f === 'archive' ? '/api/archive' : `/api/rings/${enc(f)}/feed`);

  // `nonce` re-reads the board after a write.
  useEffect(() => {
    let dead = false;
    setPosts(null);
    setCursor(null);
    setEnds(true);
    setMuted([]);
    get<FeedAnswer>(feedUrl(feed)).then((d) => {
      if (dead || feedRef.current !== feed) return;
      setPosts(d.posts);
      setEnds(d.ends !== false);
      setCursor(d.ends === false && d.next_cursor ? d.next_cursor : null);
      setMuted(d.muted || []);
      setMePageOff(!!d.me_page_off);
      if (isRoom(feed)) markSeen(feed, d.posts[0]?.created_at || '');
    }).catch((e) => { if (!dead) { setPosts([]); say(errorText(e)); } });
    return () => { dead = true; };
  }, [feed, nonce, say]);

  const loadingMore = useRef(false);
  const loadMore = useCallback(() => {
    if (loadingMore.current || !cursor || feed !== 'public') return;
    loadingMore.current = true;
    const wanted = feed;
    get<FeedAnswer>(`/api/feed?cursor=${enc(cursor)}`).then((d) => {
      if (feedRef.current !== wanted) return;
      setPosts((ps) => mergeFeed(ps || [], d.posts));
      setEnds(d.ends !== false);
      setCursor(d.ends === false && d.next_cursor ? d.next_cursor : null);
    }).catch(() => {}).finally(() => { loadingMore.current = false; });
  }, [cursor, feed]);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const el = moreEl.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMoreRef.current(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [feed, ends, cursor, posts === null]);

  const [showHome, setShowHome] = useState(false);
  useEffect(() => {
    const el = topMark.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => setShowHome(!es.some((e) => e.isIntersecting)), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [me]);

  // ── unread rooms: the room's newest post against this browser's last look ──
  const seenKey = `ring_last_seen:${viewer}`;
  const lastSeen = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(seenKey) || '{}') || {}; } catch { return {}; } };
  const markSeen = (id: string, newest: string) => {
    try {
      const m = lastSeen();
      m[id] = newest > (m[id] || '') ? newest : (m[id] || new Date().toISOString());
      localStorage.setItem(seenKey, JSON.stringify(m));
    } catch { /* private mode: the dot just stays honest per session */ }
    setUnread((s) => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n; });
  };
  useEffect(() => {
    if (!viewer || !rings.length) return;
    let dead = false;
    (async () => {
      const newest: Record<string, string> = {};
      for (const r of rings) {
        if (r.id === feedRef.current) continue;
        try { newest[r.id] = (await get<FeedAnswer>(`/api/rings/${enc(r.id)}/feed`)).posts[0]?.created_at || ''; } catch { /* no dot */ }
      }
      if (!dead) setUnread(unreadRooms(newest, lastSeen()));
    })();
    return () => { dead = true; };
  }, [rings, viewer]);

  // ── writes ──
  const reread = () => setNonce((n) => n + 1);
  const savePage = useCallback(async (body: Record<string, unknown>, done?: string): Promise<PageStore | null> => {
    try {
      const s = await put<PageStore>('/api/me/page', body);
      setStore(s);
      if (done) say(done);
      if ('enabled' in body || 'theme' in body || 'block' in body || 'unblock' in body) reread();
      if ('enabled' in body) loadMe().catch(() => {});
      return s;
    } catch (e) { say(errorText(e)); return null; }
  }, [say, loadMe]);

  const roomName = (id: string) => rings.find((r) => r.id === id)?.name || '';
  const whereName = (id: string) => (id === 'public' ? t('rail.public') : roomName(id) || t('compose.this_room'));

  const submitPost = async (d: Draft, editing: StoredPost | null): Promise<boolean> => {
    const body = draftBody(d);
    if (editing) {
      await patch(`/api/posts/${enc(editing.id)}`, body);
      say(t('compose.saved'));
    } else {
      await post('/api/posts', body);
      say(t('compose.posted_to', { where: whereName(d.audience) }));
      if (d.audience !== feed && !(d.audience === 'public' && feed === 'friends')) setFeed(d.audience);
    }
    reread();
    loadStore();
    return true;
  };

  const ownStored = (p: PostView): StoredPost | null => store?.posts.find((s) => s.id === p.id) || null;
  const anchorFrom = (): HTMLElement | null => {
    const a = document.activeElement;
    return a instanceof HTMLElement && a !== document.body ? a : postNoteRef.current;
  };

  const updateCard = (p: PostView, patchIt: Partial<PostView>) => {
    setPosts((ps) => (ps ? patchCard(ps, cardKey(p), patchIt) : ps));
    // A looked-up remote post is its own card (the lookup panel's).
    setLooked((l) => (l?.result?.type === 'post' && !l.result.local && l.result.post.id === p.id ? { ...l, result: { ...l.result, post: { ...l.result.post, ...patchIt } } } : l));
  };
  const stampPath = (p: PostView) => `/api/pages/${enc(p.author.handle)}/posts/${enc(p.id)}`;
  const meWho = () => ({ handle: viewer, name: me?.display_name || viewer, url: me?.page_url || '', host: myHost });

  // ── another server's post (P6): /api/remote/* ──
  const remoteActions = {
    stamp: async (p: PostView, face: string) => {
      try {
        const r = await post<{ action: string; mine: string; id?: string; stamps?: StampView[] }>('/api/remote/stamp', { object: p.id, face });
        // A room copy (P7) answers with the ring's stamps on it; any other remote post, only mine.
        updateCard(p, { stamps: r.stamps ?? (r.action === 'removed' || !r.id ? [] : [{ id: r.id, kaomoji: r.mine, at: new Date().toISOString(), author: meWho() }]) });
        say(r.action === 'removed' ? t('stamp.taken_back') : t('stamp.pressed', { face }));
      } catch (e) { say(errorText(e)); }
    },
    unstamp: async (p: PostView, s: StampView) => {
      // A room copy's stamp is named by its Like's URL; its last segment is my row's id.
      try { await del(`/api/remote/stamp/${enc(s.id.split('/').pop() || s.id)}`); updateCard(p, { stamps: withoutStamp(p.stamps, s.id) }); } catch (e) { say(errorText(e)); }
    },
    comment: async (p: PostView, body: string) => {
      try {
        const r = await post<{ comments: { id: string; body: string; at: string; author?: CommentView['author'] }[] }>('/api/remote/comment', { object: p.id, body });
        updateCard(p, { comments: r.comments.map((c): CommentView => ({ ...c, author: c.author ?? meWho() })) });
        return true;
      } catch (e) { say(errorText(e)); return false; }
    },
    uncomment: async (p: PostView, c: CommentView) => {
      try { await del(`/api/remote/comment/${enc(c.id.split('/').pop() || c.id)}`); updateCard(p, { comments: withoutComment(p.comments, c.id) }); } catch (e) { say(errorText(e)); }
    },
  };

  const actions: CardActions = {
    onStamp: async (p, face) => {
      if (p.origin === 'remote') return remoteActions.stamp(p, face);
      try {
        const r = await post<{ action: string; stamps: StampView[]; mine: string }>(`${stampPath(p)}/stamp`, { kaomoji: face });
        updateCard(p, { stamps: r.stamps });
        say(r.action === 'removed' ? t('stamp.taken_back') : t('stamp.pressed', { face }));
      } catch (e) { say(errorText(e)); }
    },
    onTakeBackStamp: async (p, s) => {
      if (!await ask({ title: t('stamp.take_back_confirm', { face: s.kaomoji }), verb: t('stamp.take_back'), danger: false })) return;
      if (p.origin === 'remote') return remoteActions.unstamp(p, s);
      try { await del(`${stampPath(p)}/stamp/${enc(s.id)}`); updateCard(p, { stamps: withoutStamp(p.stamps, s.id) }); } catch (e) { say(errorText(e)); }
    },
    onRemoveStamp: async (p, s) => {
      if (!await ask({ title: t('stamp.remove_confirm', { face: s.kaomoji, name: s.author.name }), verb: t('common.remove'), note: t('stamp.remove_note') })) return;
      try { await del(`${stampPath(p)}/stamp/${enc(s.id)}`); updateCard(p, { stamps: withoutStamp(p.stamps, s.id) }); } catch (e) { say(errorText(e)); }
    },
    onComment: async (p, body) => {
      if (p.origin === 'remote') return remoteActions.comment(p, body);
      try {
        const r = await post<{ comments: PostView['comments'] }>(`${stampPath(p)}/comment`, { body });
        updateCard(p, { comments: r.comments });
        return true;
      } catch (e) { say(errorText(e)); return false; }
    },
    onRemoveComment: async (p, c, mine) => {
      const ok = await ask(mine
        ? { title: t('card.take_back_note_confirm'), verb: t('stamp.take_back'), danger: false }
        : { title: t('card.remove_note_confirm', { name: c.author.name }), verb: t('common.remove'), note: t('stamp.remove_note') });
      if (!ok) return;
      if (p.origin === 'remote') return remoteActions.uncomment(p, c);
      try { await del(`${stampPath(p)}/comment/${enc(c.id)}`); updateCard(p, { comments: withoutComment(p.comments, c.id) }); } catch (e) { say(errorText(e)); }
    },
    onEdit: (p) => {
      const s = ownStored(p);
      if (!s) { say(t('card.edit_missing')); loadStore(); return; }
      composerAnchor.current = anchorFrom();
      setComposer({ open: true, editing: s });
    },
    onPin: async (p, pinned) => {
      try {
        await patch(`/api/posts/${enc(p.id)}`, { pinned });
        updateCard(p, { pinned });
        say(pinned ? t('card.pinned_done') : t('card.unpinned_done'));
        loadStore();
      } catch (e) { say(errorText(e)); }
    },
    onKeep: async (p) => {
      if (!await ask({ title: t('card.keep_confirm'), note: t('card.keep_note'), verb: t('card.keep_verb'), danger: false })) return;
      try { await post(`/api/posts/${enc(p.id)}/keep`); say(t('card.kept')); reread(); loadStore(); } catch (e) { say(errorText(e)); }
    },
    onDelete: async (p) => {
      if (!await ask({ title: t('card.delete_confirm'), note: t('card.delete_note'), verb: t('card.delete_verb') })) return;
      try {
        await del(`/api/posts/${enc(p.id)}`);
        setPosts((ps) => (ps ? ps.filter((x) => cardKey(x) !== cardKey(p)) : ps));
        say(t('card.deleted'));
        loadStore();
      } catch (e) { say(errorText(e)); }
    },
    onCopyLink: async (p) => { say(await copyText(p.url) ? t('card.link_copied') : t('rings.clipboard_failed')); },
    // P8: a remote card names its object by its id, a post here by its URL.
    onReport: (p, anchor) => setReporting({
      body: { kind: 'post', url: p.origin === 'remote' ? p.id : p.url }, label: p.author.name,
      host: p.origin === 'remote' ? p.author.host : undefined, anchor,
    }),
  };

  // ── lookup (P6) ──
  async function lookUp(q: string) {
    setLooked({ q, result: null, error: '' });
    try { setLooked({ q, result: await get<Lookup>(`/api/lookup?q=${enc(q)}`), error: '' }); }
    catch (e) { setLooked({ q, result: null, error: errorText(e) }); }
  }
  const closeLookup = () => {
    setLooked(null);
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('open')) { u.searchParams.delete('open'); history.replaceState(null, '', u.toString()); }
    } catch { /* stays in the address bar */ }
  };
  const befriendHandle = async (handle: string, name: string) => {
    try {
      const r = await post<{ status: string }>('/api/friends', { handle });
      say(r.status === 'friends' ? t('friends.now_friends', { name }) : t('friends.asked', { name }));
      setLooked((l) => (l?.result?.type === 'person' ? { ...l, result: { ...l.result, status: r.status as 'pending' | 'friends' } } : l));
      await Promise.all([loadFriends(), loadInbox()]);
    } catch (e) { say(errorText(e)); }
  };
  const joinFromLookup = (code: string) => {
    closeLookup();
    setJoinCode(code);
    setSection('rings');
    setSettingsOpen(true);
    get<JoinOffer>(`/api/rings/join/${enc(code)}`).then(setOffer, () => say(t('rings.link_dead')));
  };
  /* P7: a ring on another Ring server, asked from here (the Join goes from this server). */
  const askRemoteRing = async (url: string, name: string) => {
    try {
      await post('/api/rings/join', { url });
      closeLookup();
      say(t('rings.asked', { name }));
      await loadRings();
    } catch (e) { say(errorText(e)); }
  };

  // ── the Inbox ──
  const toggleInbox = async () => {
    const opening = !inboxOpen;
    setInboxOpen(opening);
    if (!opening) return;
    await loadInbox();
    // Opening is the reading: reactions are marked seen (requests stay until answered).
    try { await post('/api/inbox/seen'); } catch { /* the dot comes back next time */ }
  };
  const closeInbox = () => {
    setInboxOpen(false);
    setInbox((i) => (i ? { ...i, stamps: i.stamps.map((s) => ({ ...s, seen: true })), comments: i.comments.map((c) => ({ ...c, seen: true })), elsewhere: i.elsewhere.map((x) => ({ ...x, seen: true })) } : i));
  };
  const answerJoin = async (ringId: string, handle: string, approve: boolean, name: string, ringName: string) => {
    setInboxBusy(true);
    try {
      await post(`/api/rings/${enc(ringId)}/requests/${enc(handle)}`, { approve });
      say(approve ? t('rings.member_joined', { name, ring: ringName }) : t('rings.request_declined'));
    } catch (e) { say(errorText(e)); }
    await Promise.all([loadInbox(), loadRings()]);
    setInboxBusy(false);
  };
  const answerFollow = async (handle: string, how: 'befriend' | 'let' | 'decline', name: string) => {
    setInboxBusy(true);
    try {
      if (how === 'befriend') { await post(`/api/friends/${enc(handle)}/confirm`); say(t('friends.now_friends', { name })); }
      else if (how === 'let') { await post(`/api/followers/${enc(handle)}/accept`); say(t('friends.let_followed', { name })); }
      else { await post(`/api/followers/${enc(handle)}/reject`); say(t('friends.declined')); }
    } catch (e) { say(errorText(e)); }
    await Promise.all([loadInbox(), loadFriends()]);
    setInboxBusy(false);
  };

  // ── rings ──
  const createRing = async (name: string) => {
    try {
      const r = await post<Ring>('/api/rings', { name });
      setNewRingOpen(false);
      ringCreated(r);
    } catch (e) { say(errorText(e)); }
  };
  const ringCreated = async (r: Ring) => {
    await loadRings();
    setFeed(r.id);
    if (r.join?.url) say(await copyText(r.join.url) ? t('rings.started_copied', { name: r.name }) : t('rings.started_nocopy', { name: r.name }));
    else say(t('rings.started', { name: r.name }));
  };
  const acceptOffer = async () => {
    try {
      const d = await post<{ requested?: boolean; name: string; id?: string }>(`/api/rings/join/${enc(joinCode)}`);
      say(d.requested ? t('rings.asked', { name: d.name }) : t('rings.joined', { name: d.name }));
      dismissOffer();
      await loadRings();
      if (d.id) setFeed(d.id);
    } catch (e) { say(errorText(e)); }
  };
  const dismissOffer = () => { setOffer(null); setJoinCode(''); clearRingParam(); };

  const block = async (handle: string, name: string) => {
    // A ring-mate (P7 review F4): the block alone may not keep a copy from
    // them (spec 6.1), so the notice points at kick or leave.
    const mate = rings.find((r) => r.members.some((m) => m.handle === handle));
    await savePage({ block: handle }, mate && handle.includes('@') ? t('stamps.blocked_ringmate_toast', { name, ring: mate.name }) : t('stamps.blocked_one', { name }));
    await Promise.all([loadFriends(), loadInbox()]);
  };

  if (loadError) return <main className="logwall"><div className="logwall-empty" role="alert">{loadError}</div></main>;
  if (!me || !store) return <main className="logwall"><div className="logwall-empty" role="status">{t('board.fetching')}</div></main>;

  const options: AudienceOption[] = [
    { id: 'public', name: t('rail.public'), sub: store.enabled ? t('compose.public_sub') : t('compose.public_sub_off') },
    ...rings.map((r) => ({ id: r.id, name: r.name, sub: t('compose.room_sub', { count: r.members.length, name: r.name }) })),
  ];
  const kind: 'public' | 'friends' | 'archive' | 'room' = feed === 'public' || feed === 'friends' || feed === 'archive' ? feed : 'room';
  const feedLabel = feed === 'public' ? t('rail.public') : feed === 'friends' ? t('rail.friends') : feed === 'archive' ? t('rail.archive') : roomName(feed);
  const waiting = waitingCount(inbox);
  const unseen = inbox ? inbox.stamps.some((s) => !s.seen) || inbox.comments.some((c) => !c.seen) || inbox.elsewhere.some((x) => !x.seen) : false;
  const boardStyle = feed === 'public' ? themeStyle(store.theme, (k) => imgUrl(k, 'web')) as React.CSSProperties : undefined;

  return (
    <div className="log-layout">
      <nav className="ringrail" aria-label={t('rail.label')}>
        <div className="ringrail-grp">
          <RailChip label={t('rail.public')} face={<GlobeFace />} active={feed === 'public'} onClick={() => setFeed('public')} />
          <RailChip label={t('rail.friends')} face={<FriendsFace />} active={feed === 'friends'} onClick={() => setFeed('friends')} />
          {rings.map((r) => (
            <RailChip key={r.id} label={r.name} face={initials(r.name)} active={feed === r.id} dot={unread.has(r.id)} onClick={() => setFeed(r.id)} />
          ))}
          <RailChip label={t('rail.new_ring')} face="+" cls=" ringchip--new" refEl={newRingRef} expanded={newRingOpen} onClick={() => setNewRingOpen((o) => !o)} />
        </div>
        <div className="ringrail-grp ringrail-grp--verbs">
          <RailChip label={t('rail.inbox')} face="✉" cls=" ringchip--verb" refEl={inboxRef} dot={unseen && !waiting} count={waiting}
            expanded={inboxOpen} onClick={toggleInbox} />
          <RailChip label={t('rail.archive')} face="▤" cls=" ringchip--verb" active={feed === 'archive'} onClick={() => setFeed('archive')} />
          <RailChip label={t('rail.settings')} face="⚙︎" cls=" ringchip--verb" refEl={settingsRef} dot={!!offer && !offer.already_member}
            expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)} />
        </div>
      </nav>

      <main className="log-main" ref={mainRef} aria-label={feedLabel}>
        {feed === 'public' && mePageOff && (
          <div className="notice">
            <span>{t('board.public_off')}</span>
            <button type="button" className="btn btn-sm" onClick={() => savePage({ enabled: true }, t('page.on'))}>{t('board.turn_on')}</button>
          </div>
        )}
        <div className="logwall" style={boardStyle}>
          <div ref={topMark} aria-hidden="true" />
          <h1 className="sr-only">{feedLabel}</h1>
          {feed === 'public' && store.theme.marquee && (
            <div className="logwall-marquee" aria-label={t('board.marquee')}><span>{store.theme.marquee}</span></div>
          )}
          {kind === 'room' && <div className="logwall-clears">{t('board.clears_weekly')}</div>}
          {kind === 'archive' && <div className="logwall-clears">{t('board.shelf_note')}</div>}
          {kind === 'friends' && muted.length > 0 && (
            <div className="logwall-muted">{t('board.muted', { names: muted.map((m) => m.name).join(', ') })}</div>
          )}
          {kind !== 'archive' && (
            <button ref={postNoteRef} type="button" className="logwall-postnote"
              onClick={() => { composerAnchor.current = postNoteRef.current; setComposer({ open: true, editing: null }); }}>
              ✎ <b>{t('compose.posting_to')} {kind === 'friends' ? t('rail.public') : feedLabel}</b>
            </button>
          )}
          <DaysRail posts={posts || []} />
          <Board posts={posts} ctx={shelfCtx} palette={palette} feed={kind} roomName={roomName(feed)} ends={ends}
            keepBlocked={!store.enabled} actions={actions} />
          {feed === 'public' && !ends && <div ref={moreEl} className="logwall-more">{t('board.more')}</div>}
          {showHome && (
            <button type="button" className="logwall-home" aria-label={t('board.back_to_top')}
              onClick={() => topMark.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{t('board.home')}</button>
          )}
        </div>
      </main>

      <Composer open={composer.open} anchorRef={composerAnchor} onClose={() => setComposer({ open: false, editing: null })}
        audience={isRoom(feed) ? feed : 'public'} options={options} editing={composer.editing} palette={palette} onSubmit={submitPost} />
      <InboxPanel open={inboxOpen} anchorRef={inboxRef} onClose={closeInbox} inbox={inbox} busy={inboxBusy}
        onJoin={answerJoin} onFollow={answerFollow}
        onElsewhere={async (handle, how, name) => {
          setInboxBusy(true);
          if (how === 'befriend') await befriendHandle(handle, name);
          else if (await ask({ title: t('friends.block_confirm', { name }), note: t('friends.block_note'), verb: t('friends.block') })) await block(handle, name);
          setInboxBusy(false);
        }}
        onReport={setReporting} />
      {looked && (
        <LookupPanel looked={looked} onClose={closeLookup} onLookup={lookUp} onBefriend={befriendHandle} onJoin={joinFromLookup} onAskRemote={askRemoteRing} onReport={setReporting}
          ctx={shelfCtx} palette={palette} actions={actions} />
      )}
      <NewRingPopover open={newRingOpen} anchorRef={newRingRef} onClose={() => setNewRingOpen(false)}
        atCap={rings.length >= caps.max_rings} maxRings={caps.max_rings} onCreate={createRing} />
      <SettingsPanel open={settingsOpen} anchorRef={settingsRef} onClose={() => setSettingsOpen(false)}
        section={section} onSection={setSection} me={me} myHost={myHost} store={store} savePage={savePage}
        rings={rings} caps={caps} offer={offer} onAcceptOffer={acceptOffer} onDismissOffer={dismissOffer}
        onRingsChanged={() => { loadRings(); loadInbox(); }} onRingCreated={ringCreated}
        onFriendsChanged={() => { loadFriends(); loadInbox(); reread(); }} onMeChanged={setMe} onBlock={block} say={say}
        onLookup={(q) => { setSettingsOpen(false); lookUp(q); }} />
      <ReportPanel target={reporting} onClose={() => setReporting(null)} say={say} />
      {confirmUI}
      <Toast text={toastText} />
    </div>
  );
}

function RailChip({ label, face, active, dot, count, cls = '', refEl, expanded, onClick }: {
  label: string; face: React.ReactNode; active?: boolean; dot?: boolean; count?: number; cls?: string;
  refEl?: React.RefObject<HTMLButtonElement | null>; expanded?: boolean; onClick: () => void;
}) {
  const extra = count ? t('rail.waiting', { n: count }) : dot ? t('rail.something_new') : '';
  return (
    <button type="button" ref={refEl} className={`ringrail-item${active ? ' active' : ''}`} onClick={onClick}
      aria-current={active ? 'page' : undefined} aria-expanded={expanded} title={label}
      aria-label={extra ? `${label}, ${extra}` : label}>
      <span className={`ringchip${cls}`} aria-hidden="true">
        {face}
        {count ? <span className="ringchip-count">{count}</span> : dot ? <span className="ringchip-dot" /> : null}
      </span>
      <span className="ringrail-lbl" aria-hidden="true">{label}</span>
    </button>
  );
}

function GlobeFace() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="10" cy="10" r="7.5" />
      <ellipse cx="10" cy="10" rx="3.4" ry="7.5" />
      <path d="M3 7.4h14M3 12.6h14" />
    </svg>
  );
}

function FriendsFace() {
  return (
    <svg viewBox="0 0 22 20" width="20" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="7.5" cy="7" r="3" />
      <circle cx="14.5" cy="7" r="3" />
      <path d="M2.5 17c0-3 2.2-5 5-5s5 2 5 5M9.5 17c0-3 2.2-5 5-5s5 2 5 5" />
    </svg>
  );
}

/* + New ring, at the chip: name it, get the board and the link. */
function NewRingPopover({ open, anchorRef, onClose, atCap, maxRings, onCreate }: {
  open: boolean; anchorRef: { readonly current: HTMLElement | null }; onClose: () => void;
  atCap: boolean; maxRings: number; onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const submit = () => { const n = name.trim(); if (n) { onCreate(n); setName(''); } };
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} placement="right-start" sheet minWidth={260}
      surfaceProps={{ role: 'dialog', 'aria-label': t('rail.new_ring') }}>
      <form style={{ padding: '12px 14px', maxWidth: 320 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {atCap ? (
          <div className="small muted">{t('rings.at_cap_new', { max: maxRings })}</div>
        ) : (
          <>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="form-input" value={name} maxLength={60} placeholder={t('rings.name_new')} aria-label={t('rings.name_new')}
                style={{ height: 'var(--ctl-sm)', fontSize: 'var(--fs-sm)' }} onChange={(e) => setName(e.target.value)} />
              <button type="submit" className="btn btn-sm" disabled={!name.trim()}>{t('rings.make_it')}</button>
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>{t('rings.new_desc')}</div>
          </>
        )}
      </form>
    </Popover>
  );
}
