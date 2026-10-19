/* ── Settings (spec 13.1) ─────────────────────────────────────────────────────
 * One Settings popover (a Segmented
 * sub-nav, the panel beside the rail chip that opened it, Esc and click-away
 * close it; a bottom sheet on the phone). Six sections:
 *   Friends   app/friends.tsx
 *   Rings     app/rings-panel.tsx
 *   Stamps    accept stamps, accept notes, blocked people and blocked domains
 *   Theme     the wall's dress, live on the Public board (WYSIWYG)
 *   Page      on or off ("not a recall"), indexable, bio, avatar, links
 *   Account   app/account.tsx
 * Every page setting is one PUT /api/me/page through the parent's savePage;
 * the server settles it (lib/ring.js settlePageInput) and answers the store.
 */
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Popover } from './popover.tsx';
import { t } from './strings.ts';
import { imgUrl, uploadImage, errorText } from './api.ts';
import { Segmented, OnOff, Checkbox, Tip } from './ui.tsx';
import { FriendsPanel } from './friends.tsx';
import { RingsPanel } from './rings-panel.tsx';
import { AccountPanel } from './account.tsx';
import { safeHex } from './wall.ts';
import type { Me, PageStore, Ring, JoinOffer, Theme, PageLink } from './types.ts';

export type Section = 'friends' | 'rings' | 'stamps' | 'theme' | 'page' | 'account';
export type SavePage = (patch: Record<string, unknown>, done?: string) => Promise<PageStore | null>;

export function SettingsPanel(props: {
  open: boolean;
  anchorRef: { readonly current: HTMLElement | null };
  onClose: () => void;
  section: Section;
  onSection: (s: Section) => void;
  me: Me;
  myHost: string;
  store: PageStore;
  savePage: SavePage;
  rings: Ring[];
  caps: { max_members: number; max_rings: number };
  offer: JoinOffer | null;
  onAcceptOffer: () => void;
  onDismissOffer: () => void;
  onRingsChanged: () => void;
  onRingCreated: (r: Ring) => void;
  onFriendsChanged: () => void;
  onMeChanged: (me: Me) => void;
  onBlock: (handle: string, name: string) => Promise<void>;
  onLookup: (q: string) => void;
  say: (m: string) => void;
}) {
  const { open, anchorRef, onClose, section, onSection, store, savePage, say } = props;
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} placement="right-end" sheet minWidth={320}
      surfaceProps={{ role: 'dialog', 'aria-label': t('settings.title') }}>
      <div className="panel">
        <div className="panel-head">
          <Segmented label={t('settings.sections')} value={section} onChange={onSection} options={[
            ['friends', t('settings.friends')],
            ['rings', props.offer && !props.offer.already_member ? t('settings.rings_pending') : t('settings.rings')],
            ['stamps', t('settings.stamps')],
            ['theme', t('settings.theme')],
            ['page', t('settings.page')],
            ['account', t('settings.account')],
          ]} />
        </div>
        {section === 'friends' && (
          <FriendsPanel say={say} onChanged={props.onFriendsChanged} onBlock={props.onBlock} onLookup={props.onLookup}
            openFollows={store.open_follows} onOpenFollows={(on) => { savePage({ open_follows: on }, on ? t('friends.open_follows_on') : t('friends.open_follows_off')); }} />
        )}
        {section === 'rings' && (
          <RingsPanel rings={props.rings} me={props.me.handle} myHost={props.myHost} maxMembers={props.caps.max_members}
            maxRings={props.caps.max_rings} offer={props.offer} onAcceptOffer={props.onAcceptOffer} onDismissOffer={props.onDismissOffer}
            onChanged={props.onRingsChanged} say={say} onCreated={props.onRingCreated} />
        )}
        {section === 'stamps' && <StampSettings store={store} savePage={savePage} rings={props.rings} me={props.me.handle} onRings={() => onSection('rings')} />}
        {section === 'theme' && <ThemePanel theme={store.theme} savePage={savePage} say={say} />}
        {section === 'page' && <PagePanel me={props.me} store={store} savePage={savePage} say={say} />}
        {section === 'account' && <AccountPanel me={props.me} say={say} onMeChanged={props.onMeChanged} />}
      </div>
    </Popover>
  );
}

// ── Stamps: the two switches and the block lists ──

/* The rings a blocked handle shares with me (P7 review F4, spec 6.1): a block
 * keeps my room posts from them only where no other ring member shares their
 * server, so the full remedy is to remove them (my ring) or leave it. */
export function blockedRingmates(blocked: string[], rings: Ring[], me: string): { handle: string; ring: Ring }[] {
  const out: { handle: string; ring: Ring }[] = [];
  for (const h of blocked) {
    for (const r of rings) if (h !== me && r.members.some((m) => m.handle === h)) out.push({ handle: h, ring: r });
  }
  return out;
}

function StampSettings({ store, savePage, rings, me, onRings }: { store: PageStore; savePage: SavePage; rings: Ring[]; me: string; onRings: () => void }) {
  const [who, setWho] = useState('');
  const [domain, setDomain] = useState('');
  const mates = blockedRingmates(store.blocked, rings, me);
  return (
    <div className="setting-card">
      <div className="setting-row">
        <div className="grow"><Tip text={t('stamps.stamps_help')}>{t('stamps.accept_stamps')}</Tip></div>
        <OnOff label={t('stamps.accept_stamps')} on={!store.stamps_off}
          onChange={(on) => { savePage({ stamps_off: !on }, on ? t('stamps.stamps_on') : t('stamps.stamps_off')); }} />
      </div>
      <div className="setting-row">
        <div className="grow"><Tip text={t('stamps.notes_help')}>{t('stamps.accept_notes')}</Tip></div>
        <OnOff label={t('stamps.accept_notes')} on={!store.comments_off}
          onChange={(on) => { savePage({ comments_off: !on }, on ? t('stamps.notes_on') : t('stamps.notes_off')); }} />
      </div>

      <div className="eyebrow sub-head"><Tip text={t('stamps.blocked_help')}>{t('stamps.blocked')}</Tip></div>
      {store.blocked.length === 0 && <p className="small faint" style={{ margin: '4px 0' }}>{t('stamps.nobody_blocked')}</p>}
      <div className="row" style={{ gap: 6 }}>
        {store.blocked.map((h) => (
          <span key={h} className="chip mono">{h}
            <button type="button" className="btn-link small" onClick={() => { savePage({ unblock: h }, t('stamps.unblocked', { name: h })); }}>{t('stamps.unblock')}</button>
          </span>
        ))}
      </div>
      {/* Only a ring-mate on another server: a local block is complete (spec 6.1). */}
      {mates.filter(({ handle }) => handle.includes('@')).map(({ handle, ring }) => (
        <p key={`${handle} ${ring.id}`} className="small blocked-ringmate" role="note">
          {ring.mine ? t('stamps.blocked_ringmate_mine', { name: handle, ring: ring.name }) : t('stamps.blocked_ringmate', { name: handle, ring: ring.name })}{' '}
          <button type="button" className="btn-link small" onClick={onRings}>{ring.mine ? t('stamps.blocked_ringmate_kick') : t('stamps.blocked_ringmate_leave')}</button>
        </p>
      ))}
      <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => {
        e.preventDefault();
        const h = who.trim();
        if (h) savePage({ block: h }, t('stamps.blocked_one', { name: h })).then((s) => { if (s) setWho(''); });
      }}>
        <input className="form-input" style={{ maxWidth: 260, height: 'var(--ctl-sm)', fontSize: 'var(--fs-sm)' }} value={who} maxLength={330}
          placeholder={t('stamps.block_placeholder')} aria-label={t('stamps.block_label')} onChange={(e) => setWho(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!who.trim()}>{t('stamps.block')}</button>
      </form>

      <div className="eyebrow sub-head"><Tip text={t('stamps.domains_help')}>{t('stamps.blocked_domains')}</Tip></div>
      <div className="row" style={{ gap: 6 }}>
        {store.blocked_domains.map((d) => (
          <span key={d} className="chip mono">{d}
            <button type="button" className="btn-link small" onClick={() => { savePage({ unblock_domain: d }, t('stamps.unblocked', { name: d })); }}>{t('stamps.unblock')}</button>
          </span>
        ))}
      </div>
      <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => {
        e.preventDefault();
        const d = domain.trim();
        if (d) savePage({ block_domain: d }, t('stamps.blocked_one', { name: d })).then((s) => { if (s) setDomain(''); });
      }}>
        <input className="form-input" style={{ maxWidth: 260, height: 'var(--ctl-sm)', fontSize: 'var(--fs-sm)' }} value={domain} maxLength={253}
          placeholder={t('stamps.domain_placeholder')} aria-label={t('stamps.domain_label')} onChange={(e) => setDomain(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!domain.trim()}>{t('stamps.block')}</button>
      </form>
    </div>
  );
}

// ── Theme: the wall's dress ──

const BG_SWATCHES = ['', '#fff8e7', '#e7f0ff', '#fde7f0', '#e7fdf0', '#1a1a1a', '#000080', '#2d004d'];
const FONT_OPTS = (): [string, string][] => [
  ['', t('theme.font_default')], ['serif', t('theme.font_serif')], ['sans', t('theme.font_sans')], ['mono', t('theme.font_mono')],
  ['cursive', t('theme.font_cursive')], ['fantasy', t('theme.font_fantasy')], ['system', t('theme.font_system')],
];
const CURSOR_OPTS = (): [string, string][] => [
  ['', t('theme.cursor_default')], ['pointer', t('theme.cursor_pointer')], ['crosshair', t('theme.cursor_crosshair')],
  ['cell', t('theme.cursor_cell')], ['help', t('theme.cursor_help')], ['progress', t('theme.cursor_progress')],
  ['grab', t('theme.cursor_grab')], ['wait', t('theme.cursor_wait')],
];

function ThemePanel({ theme, savePage, say }: { theme: Theme; savePage: SavePage; say: (m: string) => void }) {
  const [draft, setDraft] = useState<Theme>(theme);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(theme); }, [theme]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Keystrokes (the marquee) stream: the PUT waits half a second.
  const set = (patch: Partial<Theme>, now = false) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    clearTimeout(timer.current);
    if (now) savePage({ theme: next });
    else timer.current = setTimeout(() => { savePage({ theme: next }); }, 500);
  };
  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { const up = await uploadImage(file); set({ bg_image_key: up.key }, true); } catch (err) { say(errorText(err)); }
    setBusy(false);
  };
  return (
    <div className="setting-card stack" style={{ gap: 14 }}>
      <div className="small faint">{t('theme.intro')}</div>
      <div>
        <div className="eyebrow" style={{ marginBottom: 4 }}>{t('theme.background')}</div>
        <div className="row" style={{ gap: 6 }}>
          {BG_SWATCHES.map((c) => (
            <button key={c || 'none'} type="button" aria-pressed={draft.bg === c} aria-label={c || t('theme.none')} title={c || t('theme.none')}
              onClick={() => set({ bg: c }, true)}
              style={{ width: 28, height: 28, cursor: 'pointer', border: `1px solid ${draft.bg === c ? 'var(--blue)' : 'var(--border)'}`,
                background: c || 'transparent', color: 'var(--faint)', boxShadow: draft.bg === c ? 'inset 0 0 0 1px var(--blue)' : undefined }}>{c ? '' : '∅'}</button>
          ))}
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(safeHex(draft.bg)) ? draft.bg : '#ffffff'} aria-label={t('theme.custom_colour')}
            onChange={(e) => set({ bg: e.target.value })}
            style={{ width: 32, height: 28, padding: 0, border: '1px solid var(--border)', background: 'none', cursor: 'pointer' }} />
        </div>
      </div>
      <div className="row">
        {draft.bg_image_key && <img className="thumb" src={imgUrl(draft.bg_image_key, 'thumb')} alt="" />}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={upload} />
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? t('theme.uploading') : draft.bg_image_key ? t('theme.replace_bg_image') : t('theme.bg_image')}
        </button>
        {draft.bg_image_key && <button type="button" className="btn-link" onClick={() => set({ bg_image_key: '' }, true)}>{t('theme.remove_bg_image')}</button>}
      </div>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <label className="field" style={{ flex: 1, minWidth: 140 }}><span>{t('theme.font')}</span>
          <select className="form-select" value={draft.font} onChange={(e) => set({ font: e.target.value }, true)}>
            {FONT_OPTS().map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="field" style={{ flex: 1, minWidth: 140 }}><span>{t('theme.cursor')}</span>
          <select className="form-select" value={draft.cursor} onChange={(e) => set({ cursor: e.target.value }, true)}>
            {CURSOR_OPTS().map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <label className="field"><span>{t('theme.marquee')}</span>
        <input className="form-input" value={draft.marquee} maxLength={200} onChange={(e) => set({ marquee: e.target.value })} />
      </label>
      <Checkbox checked={draft.blink} onChange={(v) => set({ blink: v }, true)}>{t('theme.blink')}</Checkbox>
    </div>
  );
}

// ── Page: the switch, the profile ──

function PagePanel({ me, store, savePage, say }: { me: Me; store: PageStore; savePage: SavePage; say: (m: string) => void }) {
  const [bio, setBio] = useState(store.bio);
  const [links, setLinks] = useState<PageLink[]>(store.links);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setBio(store.bio); setLinks(store.links); }, [store.bio, store.links]);
  const dirty = bio !== store.bio || JSON.stringify(links) !== JSON.stringify(store.links);
  const setLink = (i: number, patch: Partial<PageLink>) => setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { const up = await uploadImage(file); await savePage({ avatar_key: up.key }, t('page.avatar_saved')); } catch (err) { say(errorText(err)); }
    setBusy(false);
  };
  const save = () => {
    const clean = links.map((l) => ({ label: l.label.trim(), href: l.href.trim() })).filter((l) => l.href);
    savePage({ bio, links: clean }, t('page.saved'));
  };
  return (
    <>
      <div className="setting-card">
        <div className="setting-row">
          <div className="grow"><Tip text={t('page.enabled_help')}>{t('page.enabled')}</Tip></div>
          <OnOff label={t('page.enabled')} on={store.enabled}
            onChange={(on) => { savePage({ enabled: on }, on ? t('page.on') : t('page.off')); }} />
        </div>
        <div className="small faint">{t('page.not_a_recall')}</div>
        <div className="setting-row" style={{ marginTop: 6 }}>
          <div className="grow"><Tip text={t('page.indexable_help')}>{t('page.indexable')}</Tip></div>
          <OnOff label={t('page.indexable')} on={store.indexable}
            onChange={(on) => { savePage({ indexable: on }, on ? t('page.indexable_on') : t('page.indexable_off')); }} />
        </div>
        <div className="small faint">
          {t('page.address', { url: me.page_url })}
          {store.enabled && <> · <a href={me.page_url} target="_blank" rel="noopener">{t('page.open_wall')}</a></>}
        </div>
      </div>
      <div className="setting-card stack" style={{ gap: 12 }}>
        <div className="row">
          {store.avatar_key
            ? <img className="thumb" src={imgUrl(store.avatar_key, 'thumb')} alt={t('page.avatar_alt')} style={{ borderRadius: '50%' }} />
            : <span className="thumb" aria-hidden="true" style={{ borderRadius: '50%', border: '1px dashed var(--border)' }} />}
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden onChange={upload} />
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? t('theme.uploading') : store.avatar_key ? t('page.replace_avatar') : t('page.add_avatar')}
          </button>
          {store.avatar_key && <button type="button" className="btn-link" onClick={() => { savePage({ avatar_key: '' }, t('page.avatar_removed')); }}>{t('page.remove_avatar')}</button>}
        </div>
        <label className="field"><span><Tip text={t('page.bio_help')}>{t('page.bio')}</Tip></span>
          <textarea className="form-textarea" value={bio} maxLength={500} onChange={(e) => setBio(e.target.value)} />
        </label>
        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}><Tip text={t('page.links_help')}>{t('page.links')}</Tip></div>
          {links.map((l, i) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <input className="form-input" style={{ width: 140 }} value={l.label} maxLength={40} placeholder={t('page.link_label')}
                aria-label={t('page.link_label_n', { n: i + 1 })} onChange={(e) => setLink(i, { label: e.target.value })} />
              <input className="form-input grow" type="url" inputMode="url" value={l.href} maxLength={500} placeholder="https://"
                aria-label={t('page.link_href_n', { n: i + 1 })} onChange={(e) => setLink(i, { href: e.target.value })} />
              <button type="button" className="chip-x" aria-label={t('page.remove_link_n', { n: i + 1 })}
                onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {links.length < 4 && (
            <button type="button" className="btn-link" onClick={() => setLinks((ls) => [...ls, { label: '', href: '' }])}>{t('page.add_link')}</button>
          )}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty} onClick={save}>{t('page.save')}</button>
        </div>
      </div>
    </>
  );
}
