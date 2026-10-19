/* ── Settings › Friends (spec 3.5, 13.1) ──────────────────────────────────────
 * Friends are two accepted follows; followers are one-way (routes/friends.js).
 *   - add by handle: `name` here, `name@host` elsewhere (P6: the server
 *     resolves it by WebFinger and sends a Follow; their Accept and follow
 *     back make you friends)
 *   - look up: a handle, a profile or a post URL from anywhere (P6, GET
 *     /api/lookup), opened with its verbs
 *   - requests for me: Befriend (confirm and follow back), Let follow
 *     (accept as a follower), Decline
 *   - waiting on them: Cancel
 *   - friends: a menu per row (visit the wall, block, unfriend), the menu's
 *     armed two-step confirming the last two
 *   - followers: Befriend (follow back) or Remove
 *   - a follower from another server (`name@host`, a Mastodon account):
 *     Befriend (P6), Let follow, Decline or Remove
 *   - open follows: accept followers without asking
 * Zero permission: friendship widens the stamp palette, opens notes and fills
 * the Friends feed, nothing else.
 */
import { useCallback, useEffect, useState } from 'react';
import { t } from './strings.ts';
import { get, post, del, enc, errorText } from './api.ts';
import { Menu, OnOff, Tip } from './ui.tsx';
import type { FriendsAnswer, FollowersAnswer } from './types.ts';

export function FriendsPanel({ say, onChanged, onBlock, onLookup, openFollows, onOpenFollows }: {
  say: (m: string) => void;
  onChanged: () => void;
  onBlock: (handle: string, name: string) => Promise<void>;
  onLookup: (q: string) => void;
  openFollows: boolean;
  onOpenFollows: (on: boolean) => void;
}) {
  const [friends, setFriends] = useState<FriendsAnswer | null>(null);
  const [followers, setFollowers] = useState<FollowersAnswer | null>(null);
  const [handle, setHandle] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [f, g] = await Promise.all([get<FriendsAnswer>('/api/friends'), get<FollowersAnswer>('/api/followers')]);
      setFriends(f); setFollowers(g);
    } catch (e) { say(errorText(e)); }
  }, [say]);
  useEffect(() => { reload(); }, [reload]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); say(done); await reload(); onChanged(); } catch (e) { say(errorText(e)); }
    setBusy(false);
  };

  const befriend = async () => {
    const h = handle.trim();
    if (!h) return;
    setBusy(true);
    try {
      const r = await post<{ status: string }>('/api/friends', { handle: h });
      say(r.status === 'friends' ? t('friends.now_friends', { name: h }) : t('friends.asked', { name: h }));
      setHandle('');
      await reload();
      onChanged();
    } catch (e) { say(errorText(e)); }
    setBusy(false);
  };

  if (!friends || !followers) return <div className="setting-card" role="status">{t('board.fetching')}</div>;
  const empty = !friends.friends.length && !friends.pending_out.length && !followers.requests.length && !followers.followers.length;

  return (
    <div className="setting-card">
      <h3><Tip text={t('friends.help')}>{t('friends.title')}</Tip></h3>
      <form className="row" onSubmit={(e) => { e.preventDefault(); befriend(); }}>
        <input className="form-input grow" style={{ maxWidth: 320 }} value={handle} maxLength={330}
          placeholder={t('friends.add_placeholder')} aria-label={t('friends.add_label')} onChange={(e) => setHandle(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={busy || !handle.trim()}>{t('friends.befriend')}</button>
      </form>

      <form className="row" onSubmit={(e) => { e.preventDefault(); if (query.trim()) onLookup(query.trim()); }}>
        <input className="form-input grow" style={{ maxWidth: 320 }} value={query} maxLength={2000}
          placeholder={t('lookup.placeholder')} aria-label={t('lookup.label')} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!query.trim()}>{t('lookup.go')}</button>
      </form>

      {empty && <p className="small faint">{t('friends.empty')}</p>}

      {followers.requests.length > 0 && (
        <>
          <div className="eyebrow sub-head">{t('friends.requests')}</div>
          {followers.requests.map((f) => (
            <div key={f.handle} className="list-row">
              <a className="who" href={f.url} target="_blank" rel="noopener">{f.name}</a>
              <span className="faint mono small">{f.handle}</span>
              <span className="verbs">
                <button type="button" className="btn-link" disabled={busy}
                  onClick={() => act(() => post(`/api/friends/${enc(f.handle)}/confirm`), t('friends.now_friends', { name: f.name }))}>{t('friends.befriend')}</button>
                <button type="button" className="btn-link" disabled={busy}
                  onClick={() => act(() => post(`/api/followers/${enc(f.handle)}/accept`), t('friends.let_followed', { name: f.name }))}>{t('friends.let_follow')}</button>
                <button type="button" className="btn-link is-bad" disabled={busy}
                  onClick={() => act(() => post(`/api/followers/${enc(f.handle)}/reject`), t('friends.declined'))}>{t('friends.decline')}</button>
              </span>
            </div>
          ))}
        </>
      )}

      {friends.pending_out.length > 0 && (
        <>
          <div className="eyebrow sub-head">{t('friends.waiting')}</div>
          {friends.pending_out.map((f) => (
            <div key={f.handle} className="list-row">
              <a className="who" href={f.url} target="_blank" rel="noopener">{f.name}</a>
              <span className="faint mono small">{f.handle}</span>
              <span className="verbs">
                <button type="button" className="btn-link is-bad" disabled={busy}
                  onClick={() => act(() => del(`/api/friends/${enc(f.handle)}`), t('friends.cancelled'))}>{t('common.cancel')}</button>
              </span>
            </div>
          ))}
        </>
      )}

      {friends.friends.length > 0 && (
        <>
          <div className="eyebrow sub-head">{t('friends.friends')}</div>
          {friends.friends.map((f) => (
            <div key={f.handle} className="list-row">
              <a className="who" href={f.url} target="_blank" rel="noopener">{f.name}</a>
              <span className="faint mono small">{f.handle}</span>
              <span className="verbs">
                <Menu label={t('friends.actions', { name: f.name })} items={[
                  { label: t('friends.visit'), onClick: () => { window.open(f.url, '_blank', 'noopener'); } },
                  { label: t('friends.block'), danger: true, confirm: true, confirmLabel: t('friends.block_confirm', { name: f.name }),
                    confirmNote: t('friends.block_note'), onClick: () => { onBlock(f.handle, f.name).then(reload); } },
                  { label: t('friends.unfriend'), danger: true, confirm: true, confirmLabel: t('friends.unfriend_confirm', { name: f.name }),
                    onClick: () => act(() => del(`/api/friends/${enc(f.handle)}`), t('friends.unfriended', { name: f.name })) },
                ]} />
              </span>
            </div>
          ))}
        </>
      )}

      {followers.followers.length > 0 && (
        <>
          <div className="eyebrow sub-head"><Tip text={t('friends.followers_help')}>{t('friends.followers')}</Tip></div>
          {followers.followers.map((f) => (
            <div key={f.handle} className="list-row">
              <a className="who" href={f.url} target="_blank" rel="noopener">{f.name}</a>
              <span className="faint mono small">{f.handle}</span>
              <span className="verbs">
                <button type="button" className="btn-link" disabled={busy}
                  onClick={() => act(() => post('/api/friends', { handle: f.handle }), t('friends.asked', { name: f.name }))}>{t('friends.befriend')}</button>
                <button type="button" className="btn-link is-bad" disabled={busy}
                  onClick={() => act(() => post(`/api/followers/${enc(f.handle)}/reject`), t('friends.follower_removed', { name: f.name }))}>{t('friends.remove')}</button>
              </span>
            </div>
          ))}
        </>
      )}

      <div className="setting-row" style={{ marginTop: 12 }}>
        <div className="grow"><Tip text={t('friends.open_follows_help')}>{t('friends.open_follows')}</Tip></div>
        <OnOff label={t('friends.open_follows')} on={openFollows} onChange={onOpenFollows} />
      </div>
    </div>
  );
}
