'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PublicInvitation } from '../../../../../packages/contracts/admin';
import { Logo } from '@/components/layout/Logo';
import { Eye, EyeOff, LoaderCircle } from '@/components/ui/icons';
import { api, errorMessage } from '@/lib/api';
import { date, duration } from './shared';

export function InvitationPage() {
  const token = useRef('');
  const [invitation, setInvitation] = useState<PublicInvitation | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (!token.current) token.current = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    if (token.current && window.location.hash) window.history.replaceState(null, '', '/invite');
    if (!token.current) { setError('This invitation link is incomplete. Ask your administrator for a new link.'); setLoading(false); return; }
    void api<{ invitation: PublicInvitation }>('/invitations/inspect', { method: 'POST', body: JSON.stringify({ token: token.current }), signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setInvitation(result.invitation); })
      .catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function accept(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (password !== confirm) { setError('The passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      await api('/invitations/accept', { method: 'POST', body: JSON.stringify({ token: token.current, username: username.trim(), password }) });
      token.current = ''; setPassword(''); setConfirm('');
      window.history.replaceState(null, '', '/invite');
      window.location.replace('/image');
    } catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  }
  return <main className="grid min-h-dvh place-items-center overflow-auto px-4 py-8"><div className="w-full max-w-[480px] rounded-[28px] border border-white/[0.07] bg-[#151819] p-7 sm:p-[34px]">
    <div className="mb-8 flex items-center gap-2.5 text-[15px] font-medium"><Logo className="size-[29px] text-volt" />Gravity Studio</div>
    <h1 className="text-[30px] font-medium leading-[1.18] tracking-[-.03em]">You’re invited.</h1>
    {loading && <p role="status" className="mt-5 flex items-center gap-2 text-sm text-ink-2"><LoaderCircle size={17} className="animate-spin" />Checking your invitation…</p>}
    {invitation && <><p className="mb-5 mt-3 text-sm leading-relaxed text-ink-2">Create your {invitation.role === 'admin' ? 'administrator ' : ''}account to use this Studio. Your images and uploads are private to your account.</p>
      <dl className="mb-7 space-y-2 border-y border-line py-4 text-xs text-ink-2">{invitation.email && <div className="flex flex-wrap justify-between gap-2"><dt>Invited email</dt><dd className="break-all text-ink">{invitation.email}</dd></div>}<div className="flex flex-wrap justify-between gap-2"><dt>Server time</dt><dd className="text-ink">{invitation.role === 'admin' ? 'Unlimited' : duration(invitation.initialTimeMs)}</dd></div><div className="flex flex-wrap justify-between gap-2"><dt>Invitation expires</dt><dd>{date(invitation.expiresAt)}</dd></div></dl>
      <form className="space-y-[18px]" onSubmit={event => void accept(event)}><fieldset disabled={busy} className="space-y-[18px]">
        <label className="field">Username<input name="username" autoComplete="username" required minLength={3} maxLength={64} autoFocus value={username} onChange={event => setUsername(event.target.value)} /></label>
        <label className="field">Password<span className="relative"><input className="pr-12!" name="password" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={12} value={password} onChange={event => setPassword(event.target.value)} /><button type="button" aria-label={visible ? 'Hide password' : 'Show password'} className="absolute right-1 top-0 grid h-full w-10 place-items-center" onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span><span className="text-xs">Use at least 12 characters.</span></label>
        <label className="field">Confirm password<input name="confirmPassword" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={12} value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
        {error && <p role="alert" className="error-notice">{error}</p>}
        <button className="flex min-h-[59px] w-full items-center justify-center gap-2 rounded-[15px] bg-volt text-lg font-semibold text-on-volt hover:bg-volt-hi disabled:opacity-50" disabled={busy}>{busy && <LoaderCircle size={19} className="animate-spin" />}{busy ? 'Creating your account…' : 'Join Studio'}</button>
      </fieldset></form>
    </>}
    {!invitation && error && <div className="mt-5"><p role="alert" className="error-notice">{error}</p><p className="mt-3 text-sm leading-relaxed text-ink-2">Invitations can only be used once. Ask your administrator for another if this link has expired or was revoked.</p></div>}
    <p className="mt-7 text-center text-xs text-ink-2">Already have an account? <Link href="/image" className="text-ink underline underline-offset-4">Sign in</Link></p>
  </div></main>;
}
