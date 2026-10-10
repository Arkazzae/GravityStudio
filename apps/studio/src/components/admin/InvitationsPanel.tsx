'use client';

import { useRef, useState } from 'react';
import type { CreatedInvitation, Invitation, UserRole } from '../../../../../packages/contracts/admin';
import { api } from '@/lib/api';
import { Copy, Plus } from '@/components/ui/icons';
import { button, copy, date, duration, Feedback, Heading, Loading, primary, useAction, useResource } from './shared';

export function InvitationsPanel() {
  const resource = useResource<{ invitations: Invitation[] }>('/admin/invitations');
  const action = useAction();
  const [email, setEmail] = useState(''), [role, setRole] = useState<UserRole>('user'), [expires, setExpires] = useState('168'), [hours, setHours] = useState('2'), [sendEmail, setSendEmail] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null), [copied, setCopied] = useState('');
  const link = useRef<HTMLInputElement>(null);
  return <section><Heading title="Invitations" onRefresh={resource.reload} loading={resource.loading}>Invite someone to use this Studio with their own account and private image library.</Heading>
    <form className="max-w-[760px] space-y-5" onSubmit={event => { event.preventDefault(); void action.run(async signal => { const result = await api<CreatedInvitation>('/admin/invitations', { method: 'POST', body: JSON.stringify({ ...(email.trim() ? { email: email.trim() } : {}), role, expiresInHours: Number(expires), initialTimeMs: role === 'admin' ? 0 : Math.round(Number(hours) * 3_600_000), sendEmail }), signal }); setCreated(result); setCopied(''); resource.reload(); action.setNotice(result.invitation.delivery === 'sent' ? 'Invitation sent.' : 'Invitation created. Copy the link to share it.'); }); }}>
      <fieldset disabled={action.busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="field sm:col-span-2">Email address <span className="text-xs text-ink-2">Optional when sharing a link</span><input name="invitation-email" type="email" autoComplete="off" required={sendEmail} maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder="person@example.com" /></label>
        <label className="field">Role<select name="invitation-role" value={role} onChange={event => setRole(event.target.value as UserRole)}><option value="user">User</option><option value="admin">Administrator</option></select></label>
        <label className="field">Link expires after (hours)<input name="invitation-expiry" type="number" min={1} max={720} step={1} required value={expires} onChange={event => setExpires(event.target.value)} /></label>
        {role === 'user' ? <label className="field sm:col-span-2">Initial server time (hours)<input name="invitation-hours" type="number" min={0} max={8760} step={0.25} required value={hours} onChange={event => setHours(event.target.value)} /><span className="text-xs text-ink-2">You can adjust this later in Work time.</span></label> : <p className={`sm:col-span-2 ${copy}`}>Administrators can manage this Studio and have unlimited server time.</p>}
        <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2"><input type="checkbox" name="send-invitation-email" checked={sendEmail} onChange={event => setSendEmail(event.target.checked)} className="size-4 accent-volt" />Send invitation by email</label>
        <p className="text-xs leading-relaxed text-ink-2 sm:col-span-2">Email delivery uses the provider configured in Mail. The link is shown only when you create the invitation.</p>
        <div className="sm:col-span-2"><button className={primary} disabled={action.busy}><Plus size={16} />{action.busy ? 'Creating…' : sendEmail ? 'Send invitation' : 'Create invitation link'}</button></div>
      </fieldset>
    </form>
    <Feedback error={action.error || resource.error || created?.deliveryError} notice={action.notice} />
    {created && <div className="my-6 max-w-[760px] border-y border-line py-5"><label className="field">Invitation link<input ref={link} readOnly value={created.url} aria-label="Invitation link" /></label><div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" className={button} onClick={async () => { try { await navigator.clipboard.writeText(created.url); setCopied('Copied.'); } catch { link.current?.focus(); link.current?.select(); setCopied('The link is selected. Use your browser’s Copy command.'); } }}><Copy size={16} />Copy link</button><button type="button" className={button} onClick={() => { setCreated(null); setCopied(''); }}>Done</button>{copied && <p role="status" className="text-xs text-ink-2">{copied}</p>}</div></div>}
    <h2 className="mb-2 mt-8 text-lg font-medium">Invitation history</h2>{resource.loading && <Loading>Loading invitations…</Loading>}
    <ul className="divide-y divide-line">{resource.data?.invitations.map(invitation => <li key={invitation.id} data-invitation-id={invitation.id} className="flex flex-wrap items-center gap-4 py-5"><div className="min-w-0 flex-1"><h3 className="break-all text-sm font-medium">{invitation.email || 'Shareable invitation'}</h3><p className="mt-1 text-xs capitalize text-ink-2">{invitation.role} · {invitation.status} · {invitation.delivery.replace('_', ' ')}</p><p className="mt-2 text-xs leading-relaxed text-ink-2">Expires {date(invitation.expiresAt)} · {invitation.role === 'admin' ? 'Unlimited time' : `${duration(invitation.initialTimeMs)} initial time`}</p></div>{invitation.status === 'pending' && <button type="button" disabled={action.busy} className={button} onClick={() => void action.run(async signal => { await api(`/admin/invitations/${encodeURIComponent(invitation.id)}`, { method: 'DELETE', signal }); if (created?.invitation.id === invitation.id) setCreated(null); action.setNotice('Invitation revoked. Its link can no longer create an account.'); resource.reload(); })}>Revoke</button>}</li>)}</ul>
    {resource.data && !resource.data.invitations.length && <p className={`py-4 ${copy}`}>No invitations yet.</p>}
  </section>;
}
