/* ── Settings › Account (spec 13.1, 11.1, 10.11) ──────────────────────────────
 *   - display name (PATCH /api/me); the email shown, never editable here
 *   - password change: { current, next }; ends the other sessions; a reset
 *     that committed during the check answers 409 password_changed, said as is
 *   - invites: list, mint (5 live, 14 days), copy, revoke (house confirm)
 *   - sign out
 *   - DELETE THE ACCOUNT: the password typed again, then the house confirm
 *     naming the account. 403 wrong_password stays on the form; 409
 *     password_changed (a reset landed meanwhile) means this session is no
 *     longer the account's: say so and go to sign in; 409 last_admin is said.
 *     Success goes to the landing page: the session is gone with the account.
 *   - EXPORT (spec 12): one button downloads the zip (posts, settings,
 *     images, friends, follows; following.csv imports into Mastodon). The
 *     signing key goes in only with the tick, which shows the warning and asks
 *     for the password again (POST { key: true, password }); 403 and 429
 *     stay on the form as the server words them.
 */
import { useCallback, useEffect, useState } from 'react';
import { t } from './strings.ts';
import { get, post, patch, del, enc, copyText, errorText, ApiError } from './api.ts';
import { fmtDay, fmtMB } from './datetime.ts';
import { useConfirm } from './confirm.tsx';
import { Tip, Checkbox } from './ui.tsx';
import type { Me, Invite, InvitesAnswer } from './types.ts';

export function AccountPanel({ me, say, onMeChanged }: { me: Me; say: (m: string) => void; onMeChanged: (me: Me) => void }) {
  const [ask, confirmUI] = useConfirm();
  const [name, setName] = useState(me.display_name);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState('');
  const [invites, setInvites] = useState<InvitesAnswer | null>(null);
  const [delPw, setDelPw] = useState('');
  const [delError, setDelError] = useState('');
  const [busy, setBusy] = useState('');
  const [expKey, setExpKey] = useState(false);
  const [expPw, setExpPw] = useState('');
  const [expError, setExpError] = useState('');

  const loadInvites = useCallback(async () => {
    try { setInvites(await get<InvitesAnswer>('/api/invites')); } catch (e) { say(errorText(e)); }
  }, [say]);
  useEffect(() => { loadInvites(); }, [loadInvites]);
  useEffect(() => { setName(me.display_name); }, [me.display_name]);

  const saveName = async () => {
    setBusy('name');
    try { onMeChanged(await patch<Me>('/api/me', { display_name: name })); say(t('account.name_saved')); } catch (e) { say(errorText(e)); }
    setBusy('');
  };
  const changePassword = async () => {
    setBusy('pw'); setPwError('');
    try {
      await post('/api/me/password', pw);
      setPw({ current: '', next: '' });
      say(t('account.password_changed'));
    } catch (e) { setPwError(errorText(e)); }
    setBusy('');
  };
  const mint = async () => {
    setBusy('invite');
    try {
      const inv = await post<Invite>('/api/invites');
      await loadInvites();
      say(await copyText(inv.url) ? t('account.invite_copied') : t('account.invite_made'));
    } catch (e) { say(errorText(e)); }
    setBusy('');
  };
  const revoke = async (inv: Invite) => {
    if (!await ask({ title: t('account.revoke_confirm'), verb: t('account.revoke'), note: t('account.revoke_note') })) return;
    try { await del(`/api/invites/${enc(inv.id)}`); await loadInvites(); say(t('account.revoked')); } catch (e) { say(errorText(e)); }
  };
  const downloadExport = async () => {
    setExpError('');
    if (expKey && !expPw) { setExpError(t('account.export_needs_password')); return; }
    setBusy('export');
    try {
      let res: Response;
      try {
        res = await fetch('/api/me/export', expKey
          ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: true, password: expPw }) }
          : { credentials: 'same-origin' });
      } catch { throw new ApiError(0, 'network', t('common.offline')); }
      if (!res.ok) {
        const d = await res.json().catch(() => null) as { error?: string; message?: string } | null;
        if (res.status === 401 && d?.error === 'not_signed_in') location.assign('/login?next=/app');
        throw new ApiError(res.status, d?.error || 'server_error', d?.message || t('common.didnt_work'));
      }
      const file = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'ring-export.zip';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setExpPw('');
      say(t('account.export_done'));
    } catch (e) { setExpError(errorText(e)); }
    setBusy('');
  };
  const signOut = async () => {
    try { await post('/api/logout'); } catch { /* the session may be gone already */ }
    location.assign('/login');
  };
  const deleteAccount = async () => {
    setDelError('');
    if (!delPw) { setDelError(t('account.delete_needs_password')); return; }
    if (!await ask({ title: t('account.delete_confirm'), note: t('account.delete_note'), verb: t('account.delete_verb'), name: me.handle })) return;
    setBusy('delete');
    try {
      await del('/api/me', { password: delPw });
      location.assign('/');
      return;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'password_changed') {
        setDelError(t('account.password_changed_meanwhile'));
        setTimeout(() => location.assign('/login'), 2500);
      } else setDelError(errorText(e));
    }
    setBusy('');
  };

  return (
    <>
      <div className="setting-card stack">
        <div className="small muted">{t('account.signed_in_as', { email: me.email, handle: me.handle })}</div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
          <label className="field grow" style={{ maxWidth: 360 }}><span>{t('account.display_name')}</span>
            <input className="form-input" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-sm" style={{ alignSelf: 'flex-end' }}
            disabled={busy === 'name' || !name.trim() || name === me.display_name}>{t('common.save')}</button>
        </form>
        <div className="small faint">{t('account.storage', { used: fmtMB(me.storage.used), limit: fmtMB(me.storage.limit) })}</div>
        <div><button type="button" className="btn btn-sm" onClick={signOut}>{t('account.sign_out')}</button></div>
      </div>

      <form className="setting-card stack" onSubmit={(e) => { e.preventDefault(); changePassword(); }}>
        <h3><Tip text={t('account.password_help')}>{t('account.password')}</Tip></h3>
        <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
        <label className="field" style={{ maxWidth: 360 }}><span>{t('account.current_password')}</span>
          <input className="form-input" type="password" autoComplete="current-password" value={pw.current} required
            onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} />
        </label>
        <label className="field" style={{ maxWidth: 360 }}><span>{t('account.new_password')}</span>
          <input className="form-input" type="password" autoComplete="new-password" minLength={10} maxLength={200} value={pw.next} required
            onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} />
        </label>
        {pwError && <div className="error-line" role="alert">{pwError}</div>}
        <div><button type="submit" className="btn btn-sm" disabled={busy === 'pw' || !pw.current || pw.next.length < 10}>{t('account.change_password')}</button></div>
      </form>

      <div className="setting-card">
        <h3><Tip text={t('account.invites_help')}>{t('account.invites')}</Tip></h3>
        {invites && (
          <>
            <div className="row">
              <button type="button" className="btn btn-sm" disabled={busy === 'invite' || invites.live >= invites.limit} onClick={mint}>{t('account.new_invite')}</button>
              <span className="small faint">{t('account.invites_live', { n: invites.live, limit: invites.limit })}</span>
            </div>
            {invites.invites.map((inv) => (
              <div key={inv.id} className="list-row">
                <span className="who mono small">{inv.state === 'live' ? inv.url : inv.code.slice(0, 8)}</span>
                <span className="faint small">
                  {inv.state === 'live' ? t('account.invite_live', { date: fmtDay(inv.expires_at) })
                    : inv.state === 'used' ? t('account.invite_used', { name: inv.used_by || '' })
                    : t('account.invite_expired')}
                </span>
                {inv.state === 'live' && (
                  <span className="verbs">
                    <button type="button" className="btn-link" onClick={async () => say(await copyText(inv.url) ? t('account.invite_copied') : t('rings.clipboard_failed'))}>{t('rings.copy_link')}</button>
                    <button type="button" className="btn-link is-bad" onClick={() => revoke(inv)}>{t('account.revoke')}</button>
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <form className="setting-card stack" onSubmit={(e) => { e.preventDefault(); downloadExport(); }}>
        <h3><Tip text={t('account.export_help')}>{t('account.export')}</Tip></h3>
        <div className="small muted">{t('account.export_explainer')}</div>
        <Checkbox checked={expKey} onChange={(v) => { setExpKey(v); setExpError(''); if (!v) setExpPw(''); }}>{t('account.export_key')}</Checkbox>
        {expKey && (
          <>
            <div className="small" role="note" style={{ color: 'var(--bad)' }}>{t('account.export_key_warning')}</div>
            <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
            <label className="field" style={{ maxWidth: 360 }}><span>{t('account.export_password')}</span>
              <input className="form-input" type="password" autoComplete="current-password" value={expPw} onChange={(e) => setExpPw(e.target.value)} />
            </label>
          </>
        )}
        {expError && <div className="error-line" role="alert">{expError}</div>}
        <div><button type="submit" className="btn btn-sm" disabled={busy === 'export'}>{busy === 'export' ? t('account.export_working') : t('account.export_button')}</button></div>
      </form>

      <form className="setting-card stack" style={{ borderColor: 'var(--bad)' }} onSubmit={(e) => { e.preventDefault(); deleteAccount(); }}>
        <h3>{t('account.delete_title')}</h3>
        <div className="small muted">{t('account.delete_explainer')}</div>
        <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
        <label className="field" style={{ maxWidth: 360 }}><span>{t('account.delete_password')}</span>
          <input className="form-input" type="password" autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
        </label>
        {delError && <div className="error-line" role="alert">{delError}</div>}
        <div><button type="submit" className="btn btn-sm btn-danger" style={{ borderColor: 'var(--bad)' }} disabled={busy === 'delete'}>{t('account.delete_button')}</button></div>
      </form>
      {confirmUI}
    </>
  );
}
