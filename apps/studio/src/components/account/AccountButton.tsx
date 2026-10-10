'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, Check, Clock3, KeyRound, LoaderCircle, LogOut, MonitorIcon, Settings, UserRound, X } from '@/components/ui/icons';
import { AppSettings } from '@/components/setup/AppSettings';
import type { UnifiedSettingsSection } from '@/components/setup/UnifiedSettings';
import { OwnWorkTime } from '@/components/admin/WorkTimePanel';
import { AdminSession } from '@/components/admin/shared';
import { CompletionAlertSettings, type CompletionAlertSettingsProps } from '@/components/system/NotificationsPopover';
import { api, errorMessage, type AccountProfile } from '@/lib/api';
import { useRetainedDialog } from '@/lib/use-retained-dialog';
import styles from './AccountPanel.module.css';

const avatarThemes = [
  { id: 'studio', name: 'Studio', background: 'conic-gradient(at 30% 30%, #d3f94c, #3ad6a0, #7a5cff, #ff2d78, #d3f94c)', color: '#111619' },
  { id: 'lime', name: 'Lime', background: 'linear-gradient(135deg, #d1fe17, #83ba46)', color: '#182311' },
  { id: 'mint', name: 'Mint', background: 'linear-gradient(135deg, #a6edcd, #3baa98)', color: '#123d35' },
  { id: 'blue', name: 'Blue', background: 'linear-gradient(135deg, #a7d2fa, #5b79d9)', color: '#142341' },
  { id: 'violet', name: 'Violet', background: 'linear-gradient(135deg, #d2b2fa, #9865c9)', color: '#2c1844' },
  { id: 'rose', name: 'Rose', background: 'linear-gradient(135deg, #fac0c8, #cc778f)', color: '#451b28' },
] as const;

interface AccountButtonProps {
  user: { id: string; username: string; role: 'admin' | 'user' };
  signingOut: boolean;
  onSignOut: () => Promise<void>;
  onSessionExpired: () => void;
  onNotice: (title: string, body?: string) => void;
  onOpenSettings: (section?: UnifiedSettingsSection) => void;
  appBusy?: boolean;
  alertSettings: CompletionAlertSettingsProps;
}

function Avatar({ profile }: { profile: Pick<AccountProfile, 'displayName' | 'avatarTheme'> }) {
  const theme = avatarThemes.find(entry => entry.id === profile.avatarTheme) || avatarThemes[0];
  const words = profile.displayName.trim().split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? `${Array.from(words[0])[0]}${Array.from(words.at(-1)!)[0]}` : Array.from(words[0] || 'U').slice(0, 2).join('');
  return <span className={styles.avatar} style={{ background: theme.background, color: theme.color }} aria-hidden="true">{initials.toLocaleUpperCase()}</span>;
}

export function AccountButton(props: AccountButtonProps) {
  return <AccountControl key={props.user.id} {...props} />;
}

function AccountControl({ user, signingOut, onSignOut, onSessionExpired, onNotice, onOpenSettings, appBusy = false, alertSettings }: AccountButtonProps) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [draft, setDraft] = useState<Pick<AccountProfile, 'displayName' | 'avatarTheme'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const signingOutNow = useRef(false);
  const mounted = useRef(false);
  const callbacks = useRef({ onSignOut, onSessionExpired, onNotice });
  callbacks.current = { onSignOut, onSessionExpired, onNotice };
  const pending = saving || leaving || signingOut;
  const events = useRetainedDialog({ dialog, open, onClose: () => setOpen(false), triggerRef: trigger, initialFocus: closeButton, dismissible: !pending });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; reading.current?.abort(); writing.current?.abort(); };
  }, []);

  const load = useCallback(async () => {
    if (writing.current || signingOutNow.current) return;
    reading.current?.abort();
    const controller = new AbortController(); reading.current = controller;
    setLoading(true); setLoadError('');
    try {
      const result = await api<AccountProfile>('/account', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (!mounted.current || controller.signal.aborted || reading.current !== controller) return;
      setProfile(result); setDraft(result); setError(''); setConflict(false);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || reading.current !== controller) return;
      setLoadError(errorMessage(failure));
      if ((failure as { status?: number }).status === 401) callbacks.current.onSessionExpired();
    } finally {
      if (mounted.current && reading.current === controller) { reading.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => { void load(); return () => reading.current?.abort(); }, [load]);

  const changed = !!profile && !!draft && (draft.displayName.trim() !== profile.displayName || draft.avatarTheme !== profile.avatarTheme);
  const valid = !!draft?.displayName.trim();
  function update(patch: Partial<Pick<AccountProfile, 'displayName' | 'avatarTheme'>>) {
    setDraft(current => current ? { ...current, ...patch } : current);
    if (!conflict) setError('');
  }
  function cancel() {
    if (writing.current || signingOutNow.current || signingOut) return;
    setDraft(profile); setError(''); setConflict(false); setOpen(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !profile || !changed || !valid || loading || conflict || writing.current || signingOutNow.current || signingOut) return;
    const controller = new AbortController(); writing.current = controller;
    setSaving(true); setError('');
    try {
      const result = await api<AccountProfile>('/account', { method: 'PUT', body: JSON.stringify({ revision: profile.revision, displayName: draft.displayName.trim(), workspaceName: profile.workspaceName, avatarTheme: draft.avatarTheme }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (!mounted.current || controller.signal.aborted || writing.current !== controller) return;
      setProfile(result); setDraft(result); setConflict(false); setOpen(false);
      callbacks.current.onNotice('Account updated', 'Your profile is saved on your Studio server.');
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || writing.current !== controller) return;
      if ((failure as { status?: number }).status === 409) { setConflict(true); setError('Your profile changed in another window. Reload the saved profile before saving again.'); }
      else setError(errorMessage(failure));
      if ((failure as { status?: number }).status === 401) callbacks.current.onSessionExpired();
    } finally {
      if (mounted.current && writing.current === controller) { writing.current = null; setSaving(false); }
    }
  }
  async function signOut() {
    if (writing.current || signingOutNow.current || signingOut) return;
    signingOutNow.current = true; reading.current?.abort();
    setLeaving(true); setError('');
    try { await callbacks.current.onSignOut(); }
    catch (failure) {
      if (!mounted.current) return;
      setError(errorMessage(failure));
      if (!profile) { setLoadError('Your profile has not loaded. Try again.'); setLoading(false); }
      if ((failure as { status?: number }).status === 401) callbacks.current.onSessionExpired();
    } finally {
      signingOutNow.current = false;
      if (mounted.current) { setLeaving(false); if (reading.current?.signal.aborted) { reading.current = null; setLoading(false); } }
    }
  }
  function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]'))
      .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <AdminSession.Provider value={onSessionExpired}>
    <button ref={trigger} type="button" className={styles.trigger} aria-label="Account" aria-haspopup="dialog" aria-expanded={open} aria-controls={visited ? 'account-panel' : undefined} title={profile?.displayName || user.username} disabled={signingOut || leaving} onClick={() => { setVisited(true); setOpen(true); }}>
      <Avatar profile={profile || { displayName: user.username, avatarTheme: 'studio' }} />
    </button>
    {visited && <dialog ref={dialog} id="account-panel" className={styles.panel} aria-labelledby="account-title" onKeyDown={keepFocus} {...events}>
      <form className={styles.form} onSubmit={event => void save(event)} aria-busy={loading || pending}>
        <header className={styles.header}>
          <h1 id="account-title">Account</h1>
          <button ref={closeButton} data-dialog-dismiss type="button" className={styles.close} aria-label="Close account panel" disabled={pending} onClick={() => setOpen(false)}><X /></button>
        </header>
        <div data-dialog-scroll="account" className={styles.body}>
          <div className={styles.identity}>
            <Avatar profile={draft || profile || { displayName: user.username, avatarTheme: 'studio' }} />
            <div className={styles.identityText}><h2>{draft?.displayName.trim() || profile?.displayName || user.username}</h2><p>Signed in</p></div>
          </div>
          {loading && <p role="status" className={styles.status}>Loading your profile…</p>}
          {loadError && <div role="alert" className={styles.error}>{loadError}<button type="button" className={styles.retry} disabled={pending || loading} onClick={() => void load()}>Try again</button></div>}
          {error && <div role="alert" className={styles.error}>{error}{conflict && <><p className={styles.conflictHelp}>Reloading replaces your unsaved profile edits with the saved version.</p><button type="button" className={styles.retry} disabled={pending || loading} onClick={() => void load()}>Reload saved profile</button></>}</div>}
          {draft && <fieldset disabled={pending || loading} className={styles.profileFields}>
            <section className={styles.section} aria-labelledby="account-profile-heading">
              <h2 id="account-profile-heading"><UserRound strokeWidth={1.8} />Profile</h2>
              <fieldset aria-label="Avatar color">
                <legend className={styles.avatarLabel}>Avatar color</legend>
                <div className={styles.colors}>{avatarThemes.map(theme => <label key={theme.id} className={styles.color} style={{ background: theme.background, color: theme.color }} title={theme.name}>
                  <input type="radio" name="avatarTheme" aria-label={theme.name} value={theme.id} checked={draft.avatarTheme === theme.id} onChange={() => update({ avatarTheme: theme.id })} /><Check strokeWidth={2.5} />
                </label>)}</div>
              </fieldset>
              <label className={styles.field}><span>Display name</span><input name="displayName" autoComplete="nickname" required maxLength={64} value={draft.displayName} placeholder="Your name" onChange={event => update({ displayName: event.target.value })} /></label>
              <label className={styles.field}><span>Username<small>Sign-in name</small></span><input name="username" autoComplete="username" value={user.username} readOnly /></label>
            </section>
          </fieldset>}
          <section className={styles.section} aria-labelledby="account-settings-heading"><h2 id="account-settings-heading"><Settings strokeWidth={1.8} />Settings</h2><p className={styles.help}>{user.role === 'admin' ? 'Manage this Studio, its users and your preferences.' : 'Manage your preferences, server time and API access.'}</p><button type="button" disabled={pending} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi" onClick={() => { setOpen(false); onOpenSettings(user.role === 'admin' ? 'users' : 'app'); }}>Open Settings<ArrowRight size={16} /></button></section>
          <section className={styles.section} aria-labelledby="account-time-heading"><h2 id="account-time-heading"><Clock3 strokeWidth={1.8} />Work time</h2><details><summary className="cursor-pointer py-2 text-sm text-ink-2 hover:text-ink">View your allowance and activity</summary><div className="mt-3"><OwnWorkTime active={open} /></div></details></section>
          <section className={styles.section} aria-labelledby="account-api-heading"><h2 id="account-api-heading"><KeyRound strokeWidth={1.8} />API access</h2><p className={styles.help}>Connect your tools to your own images and jobs.</p><button type="button" disabled={pending} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi" onClick={() => { setOpen(false); onOpenSettings('api'); }}>Manage access tokens<ArrowRight size={16} /></button></section>
          <section className={`${styles.section} ${styles.notificationSection}`} aria-labelledby="account-notifications-heading">
            <h2 id="account-notifications-heading">Notifications on this device</h2>
            <p className={styles.help}>These preferences apply immediately in this browser.</p>
            <fieldset disabled={pending}><CompletionAlertSettings {...alertSettings} /></fieldset>
          </section>
          <div className={styles.section}><AppSettings compact headingId="account-app-heading" busy={appBusy || pending || loading || changed} /></div>
          <p className={styles.note}><MonitorIcon strokeWidth={1.7} />Your profile and images are saved on your Studio server. Prompt drafts and notification preferences are saved on this device.</p>
          <button type="button" className={styles.signOut} disabled={pending} onClick={() => void signOut()}>{leaving || signingOut ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <LogOut />}{leaving || signingOut ? 'Signing out…' : 'Sign out'}</button>
        </div>
        <footer className={styles.footer}>
          <button data-dialog-dismiss type="button" className={styles.cancel} disabled={pending || loading} onClick={cancel}>Cancel</button>
          <button type="submit" className={styles.save} disabled={!changed || !valid || pending || loading || conflict}>{saving ? 'Saving…' : 'Save changes'}</button>
        </footer>
      </form>
    </dialog>}
  </AdminSession.Provider>;
}
