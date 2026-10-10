'use client';

import { useState } from 'react';
import type { AdminUser } from '../../../../../packages/contracts/admin';
import { api } from '@/lib/api';
import { Search, Trash2 } from '@/components/ui/icons';
import { button, copy, danger, date, Feedback, Heading, Loading, primary, useAction, useResource } from './shared';

export function UsersPanel({ selfId, onSelfChanged }: { selfId: string; onSelfChanged: () => void }) {
  const resource = useResource<{ users: AdminUser[] }>('/admin/users');
  const [query, setQuery] = useState(''), [selected, setSelected] = useState('');
  const users = resource.data?.users.filter(user => user.status !== 'deleted' && `${user.username} ${user.email || ''}`.toLowerCase().includes(query.trim().toLowerCase())) || [];
  const current = users.find(user => user.id === selected) || users[0];
  return <section><Heading title="Users" onRefresh={resource.reload} loading={resource.loading}>Manage access to this Studio. Images and prompt histories remain private to each account.</Heading>
    <Feedback error={resource.error} />
    {resource.loading && <Loading>Loading users…</Loading>}
    <div className="grid min-w-0 gap-7 xl:grid-cols-[minmax(230px,300px)_minmax(0,1fr)]">
      <div className="min-w-0"><label className="mb-4 flex min-h-11 items-center gap-2 border-b border-line text-ink-2"><Search size={17} /><input aria-label="Search users" placeholder="Username or email" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-ink outline-none" /></label>
        <ul className="max-h-[55dvh] overflow-y-auto">{users.map(user => <li key={user.id}><button type="button" aria-pressed={current?.id === user.id} onClick={() => setSelected(user.id)} className={`flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-3 text-left ${current?.id === user.id ? 'bg-chip' : 'hover:bg-panel-2'}`}><span className="break-words text-sm font-medium">{user.username}{user.id === selfId ? ' (you)' : ''}</span><span className="break-all text-xs text-ink-2">{user.email || 'No email address'}</span><span className="text-xs capitalize text-ink-2">{user.role} · {user.status}</span></button></li>)}</ul>
        {!resource.loading && !users.length && <p className={copy}>No users match your search.</p>}
      </div>
      {current && <UserDetails key={`${current.id}:${current.revision}`} user={current} selfId={selfId} onChanged={() => { resource.reload(); if (current.id === selfId) onSelfChanged(); }} />}
    </div>
  </section>;
}

function UserDetails({ user, selfId, onChanged }: { user: AdminUser; selfId: string; onChanged: () => void }) {
  const [role, setRole] = useState(user.role), [status, setStatus] = useState(user.status === 'suspended' ? 'suspended' : 'active');
  const [removing, setRemoving] = useState(false), [confirmation, setConfirmation] = useState('');
  const action = useAction();
  const deleting = user.status === 'deleting';
  return <div className="min-w-0" data-admin-user={user.id}><h2 className="break-words text-lg font-medium">{user.username}</h2><p className={`mt-2 ${copy}`}>Created {date(user.createdAt)}</p>
    <form className="mt-6" onSubmit={event => { event.preventDefault(); void action.run(async signal => { await api(`/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: JSON.stringify({ revision: user.revision, role, status }), signal }); onChanged(); }); }}>
      <fieldset disabled={action.busy || deleting || user.id === selfId} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="field">Role<select name="user-role" value={role} onChange={event => setRole(event.target.value as AdminUser['role'])}><option value="user">User</option><option value="admin">Administrator</option></select></label>
        <label className="field">Account status<select name="user-status" value={status} onChange={event => setStatus(event.target.value)}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
        <p className={`sm:col-span-2 ${copy}`}>{user.id === selfId ? 'Another administrator can change your role or account status.' : 'Administrators manage users, shared models and server settings. Suspending an account prevents sign-in and new jobs.'}</p>
        <div className="sm:col-span-2"><button disabled={action.busy || role === user.role && status === user.status} className={primary}>{action.busy ? 'Saving…' : 'Save access'}</button></div>
      </fieldset>
    </form>
    <Feedback error={action.error} notice={action.notice} />
    {action.error && <button type="button" className={button} onClick={onChanged}>Reload saved user</button>}
    <div className="mt-8 border-t border-line pt-6"><h3 className="text-sm font-medium">Delete account</h3><p className={`mt-2 ${copy}`}>{user.id === selfId ? 'You cannot delete the account you are signed in with.' : deleting ? 'Deletion is in progress.' : 'Permanently remove this account and its private images, inputs and access tokens. Queued jobs are cancelled. Active jobs must finish first.'}</p>
      {user.id !== selfId && !deleting && (!removing ? <button type="button" disabled={action.busy} className={`${danger} mt-4`} onClick={() => setRemoving(true)}><Trash2 size={16} />Delete account</button> : <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); if (confirmation !== user.username) return; void action.run(async signal => { await api(`/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE', body: JSON.stringify({ revision: user.revision, confirmation }), signal }); onChanged(); }); }}>
        <label className="field">Type {user.username} to confirm<input name="delete-confirmation" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={action.busy} /></label>
        <div className="flex flex-wrap gap-2"><button disabled={action.busy || confirmation !== user.username} className={danger}>{action.busy ? 'Deleting…' : 'Permanently delete account'}</button><button type="button" disabled={action.busy} className={button} onClick={() => { setRemoving(false); setConfirmation(''); }}>Cancel</button></div>
      </form>)}
    </div>
  </div>;
}
