'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, LoaderCircle, Trash2 } from 'lucide-react';
import { Chip } from '@/components/ui/Chip';
import { api, errorMessage } from '@/lib/api';

interface AccessToken { id: string; name: string; createdAt: string; lastUsedAt?: string | null }

export function ApiAccess() {
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [copied, setCopied] = useState('');
  const [loaded, setLoaded] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const endpointInput = useRef<HTMLInputElement>(null);
  async function load() {
    try { setTokens((await api<{ tokens: AccessToken[] }>('/tokens')).tokens); setLoaded(true); }
    catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => { setEndpoint(`${window.location.origin}/api/mcp`); void load(); }, []);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setCopied('');
    try { const created = await api<AccessToken & { token: string }>('/tokens', { method: 'POST', body: JSON.stringify({ name }) }); setSecret(created.token); setName(''); await load(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setRevoking(id); setError('');
    try { await api(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setRevoking(null); }
  }
  async function copy(value: string, kind: string, input: HTMLInputElement | null) {
    setError('');
    try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(value); setCopied(kind); }
    catch { input?.focus(); input?.select(); setCopied(`select-${kind}`); }
  }
  return <section>
    <h2 className="text-lg font-medium">API & MCP access</h2>
    <p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Connect your tools to the same models, queue, and images you use in Studio.</p>
    <label className="field">MCP server address<div className="flex items-center gap-2"><input ref={endpointInput} readOnly value={endpoint} aria-label="MCP server address" className="font-mono text-xs!" /><Chip aria-label="Copy MCP address" onClick={() => void copy(endpoint, 'endpoint', endpointInput.current)} icon={copied === 'endpoint' ? <Check /> : <Copy />}>{copied === 'endpoint' ? 'Copied' : 'Copy'}</Chip></div></label>
    <p className="mt-3 text-xs leading-relaxed text-ink-2">Use an HTTP MCP connection with <code>Authorization: Bearer YOUR_TOKEN</code>. The same token works with the Studio API at <code>/api</code>.</p>
    <form onSubmit={create} className="mt-8 border-t border-line pt-6">
      <h3 className="mb-2 text-sm font-medium">Create an access token</h3><p className="mb-4 text-xs leading-relaxed text-ink-2">A token can run jobs and access your saved images. Give each connected tool its own token.</p>
      <div className="flex items-end gap-3"><label className="field min-w-0 flex-1">Token name<input value={name} onChange={event => setName(event.target.value)} placeholder="My MCP client" maxLength={80} required /></label><button disabled={busy || !name.trim()} className="flex h-[42px] shrink-0 items-center gap-2 rounded-chip bg-volt px-4 text-sm font-semibold text-on-volt disabled:opacity-50">{busy && <LoaderCircle size={15} className="animate-spin" />}{busy ? 'Creating…' : 'Create token'}</button></div>
    </form>
    {secret && <div className="mt-5 rounded-panel bg-panel-2 p-4"><label className="field">Your new token<div className="flex items-center gap-2"><input ref={secretInput} readOnly value={secret} aria-label="New access token" className="font-mono text-xs!" /><Chip aria-label="Copy access token" icon={copied === 'secret' ? <Check /> : <Copy />} onClick={() => void copy(secret, 'secret', secretInput.current)}>{copied === 'secret' ? 'Copied' : 'Copy'}</Chip></div></label><p className="mt-3 text-xs leading-relaxed text-ink-2">Copy this token now. It will not be shown after you leave this page.</p><button type="button" onClick={() => setSecret('')} className="mt-3 text-xs text-ink-2 underline underline-offset-3">I have saved it</button></div>}
    {copied.startsWith('select-') && <p role="status" className="mt-3 text-xs text-ink-2">The value is selected. Use your keyboard or the browser menu to copy it.</p>}
    {error && <p role="alert" className="error-notice mt-5">{error}{!loaded && <button className="ml-2 underline" onClick={() => void load()}>Try again</button>}</p>}
    <div className="mt-8 border-t border-line pt-6"><h3 className="mb-3 text-sm font-medium">Active tokens</h3>{tokens.length ? <ul className="divide-y divide-line">{tokens.map(token => <li key={token.id} className="flex items-center gap-4 py-4"><div className="min-w-0 flex-1"><p className="truncate text-sm">{token.name}</p><p className="mt-1 text-xs text-ink-2">Created {new Date(token.createdAt).toLocaleDateString()}{token.lastUsedAt ? ` · Last used ${new Date(token.lastUsedAt).toLocaleDateString()}` : ' · Not used yet'}</p></div><button disabled={!!revoking} onClick={() => void revoke(token.id)} aria-label={`Revoke ${token.name}`} className="flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-xs text-ink-2 hover:bg-chip hover:text-ink disabled:opacity-50">{revoking === token.id ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}Revoke</button></li>)}</ul> : <p className="text-sm text-ink-2">{loaded ? 'No access tokens yet.' : 'Loading access tokens…'}</p>}</div>
  </section>;
}
