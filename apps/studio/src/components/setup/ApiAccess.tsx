'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, LoaderCircle, Trash2 } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { api, errorMessage } from '@/lib/api';
import type { ApiScope, ApiToken } from '../../../../../packages/contracts/access';
import styles from './ApiAccess.module.css';

interface AccessDiscovery {
  scopes: ApiScope[];
  endpoints: { mcp: string; openai: string; rest: string };
  models: { images: Array<{ id: string; name: string; ready: boolean }>; text: Array<{ id: string; name: string; ready: boolean }> };
}
const permissions: Array<{ id: ApiScope; name: string; description: string }> = [
  { id: 'models:read', name: 'Models', description: 'List models, capabilities and available tools.' },
  { id: 'jobs:read', name: 'Read jobs', description: 'Read your queue, progress and generation settings.' },
  { id: 'jobs:write', name: 'Run jobs', description: 'Generate, edit, upscale and remove backgrounds.' },
  { id: 'jobs:cancel', name: 'Cancel jobs', description: 'Cancel your queued jobs.' },
  { id: 'assets:read', name: 'Read images', description: 'View and download your inputs and outputs.' },
  { id: 'assets:write', name: 'Save images', description: 'Upload references and manage your favorites.' },
  { id: 'assets:delete', name: 'Delete images', description: 'Permanently delete your saved images.' },
  { id: 'text:generate', name: 'Language models', description: 'Send chat requests and refine image prompts.' },
  { id: 'system:read', name: 'Server status', description: 'Read runtime availability and resource status.' },
];
const profiles: Array<{ id: string; name: string; scopes: ApiScope[] }> = [
  { id: 'images', name: 'Create images', scopes: ['models:read', 'jobs:read', 'jobs:write', 'jobs:cancel', 'assets:read', 'assets:write'] },
  { id: 'read', name: 'Read library', scopes: ['models:read', 'jobs:read', 'assets:read'] },
  { id: 'chat', name: 'Use language models', scopes: ['models:read', 'text:generate'] },
  { id: 'studio', name: 'All Studio workflows', scopes: permissions.map(permission => permission.id) },
];
type Example = 'mcp' | 'images' | 'chat';
const exampleLabels: Record<Example, string> = { mcp: 'MCP client', images: 'Image API', chat: 'Chat API' };
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const date = (value: string) => new Date(value).toLocaleDateString();

function connectionExample(kind: Example, origin: string, discovery: AccessDiscovery | null, edit: boolean): string {
  const openai = `${origin}${discovery?.endpoints.openai ?? '/v1'}`;
  if (kind === 'mcp') return JSON.stringify({ mcpServers: { 'gravity-studio': { type: 'http', url: `${origin}${discovery?.endpoints.mcp ?? '/api/mcp'}`, headers: { Authorization: 'Bearer YOUR_TOKEN' } } } }, null, 2);
  const model = kind === 'images' ? discovery?.models.images.find(model => model.ready)?.id : discovery?.models.text.find(model => model.ready)?.id;
  if (kind === 'images' && edit) return `curl ${shellQuote(`${openai}/images/edits`)} \\\n  -H "Authorization: Bearer $GRAVITY_API_KEY" \\\n  -F ${shellQuote(`model=${model ?? 'IMAGE_MODEL_ID'}`)} \\\n  -F 'image=@reference.png' \\\n  -F 'prompt=Keep the composition and turn morning into twilight' \\\n  -F 'size=1024x1024'`;
  if (kind === 'images') return `curl ${shellQuote(`${openai}/images/generations`)} \\\n  -H "Authorization: Bearer $GRAVITY_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(JSON.stringify({ model: model ?? 'IMAGE_MODEL_ID', prompt: 'A ceramic cup in warm afternoon light', size: '1024x1024', response_format: 'b64_json' }, null, 2))}`;
  return `curl ${shellQuote(`${openai}/chat/completions`)} \\\n  -H "Authorization: Bearer $GRAVITY_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(JSON.stringify({ model: model ?? 'studio-assistant', messages: [{ role: 'user', content: 'Describe a cinematic portrait in one sentence.' }], stream: true }, null, 2))}`;
}

function CopyField({ label, value, copyLabel, secret = false }: { label: string; value: string; copyLabel: string; secret?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false), [fallback, setFallback] = useState(false);
  useEffect(() => { setCopied(false); setFallback(false); }, [value]);
  async function copy() {
    try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(value); setCopied(true); setFallback(false); }
    catch { input.current?.focus(); input.current?.select(); setFallback(true); }
  }
  return <div>
    <label className="field">{label}<div className={styles.copyRow}>
      <input ref={input} readOnly value={value} aria-label={secret ? 'New access token' : label} autoComplete="off" spellCheck={false} className="font-mono text-xs!" />
      <Chip aria-label={copyLabel} disabled={!value} onClick={() => void copy()} icon={copied ? <Check /> : <Copy />}>{copied ? 'Copied' : 'Copy'}</Chip>
    </div></label>
    {fallback && <p role="status" className="mt-2 text-xs leading-relaxed text-ink-2">The value is selected. Use your keyboard or the browser menu to copy it.</p>}
  </div>;
}

export function ApiAccess({ active = true }: { active?: boolean }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [discovery, setDiscovery] = useState<AccessDiscovery | null>(null);
  const [name, setName] = useState(''), [secret, setSecret] = useState('');
  const [profile, setProfile] = useState('images'), [scopes, setScopes] = useState<ApiScope[]>(profiles[0].scopes);
  const [days, setDays] = useState('90');
  const [busy, setBusy] = useState(false), [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState(''), [discoveryError, setDiscoveryError] = useState('');
  const [origin, setOrigin] = useState(''), [example, setExample] = useState<Example>('mcp');
  const [editExample, setEditExample] = useState(false);
  const [copiedExample, setCopiedExample] = useState(false), [exampleFallback, setExampleFallback] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const code = useRef<HTMLPreElement>(null), activeRef = useRef(active), visibilityRevision = useRef(0);
  const exampleText = connectionExample(example, origin, discovery, editExample);
  async function load() {
    try { setTokens((await api<{ tokens: ApiToken[] }>('/tokens')).tokens); setLoaded(true); }
    catch (error) { setError(errorMessage(error)); }
  }
  async function discover() {
    setDiscoveryError('');
    try { setDiscovery(await api<AccessDiscovery>('/access')); }
    catch (error) { setDiscoveryError(errorMessage(error)); }
  }
  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => { if (active) { void load(); void discover(); } }, [active]);
  useLayoutEffect(() => {
    activeRef.current = active;
    if (!active) { setSecret(''); setCopiedExample(false); setExampleFallback(false); }
    return () => { activeRef.current = false; visibilityRevision.current++; };
  }, [active]);
  useEffect(() => { setCopiedExample(false); setExampleFallback(false); }, [exampleText]);
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy || !scopes.length) return;
    setBusy(true); setError(''); setSecret('');
    const revision = visibilityRevision.current;
    try {
      const created = await api<ApiToken & { token: string }>('/tokens', { method: 'POST', body: JSON.stringify({ name: name.trim(), scopes, expiresInDays: days === 'never' ? null : Number(days) }) });
      if (activeRef.current && visibilityRevision.current === revision) setSecret(created.token);
      setName(''); await load();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setRevoking(id); setError('');
    try { await api(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setRevoking(null); }
  }
  async function copyExample() {
    try { if (!navigator.clipboard) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(exampleText); setCopiedExample(true); setExampleFallback(false); }
    catch {
      if (code.current) { const range = document.createRange(); range.selectNodeContents(code.current); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); code.current.focus(); }
      setExampleFallback(true);
    }
  }
  function chooseProfile(value: string) {
    setProfile(value); const selected = profiles.find(entry => entry.id === value); if (selected) setScopes([...selected.scopes]);
  }
  function toggleScope(scope: ApiScope) { setProfile('custom'); setScopes(previous => previous.includes(scope) ? previous.filter(value => value !== scope) : [...previous, scope]); }
  return <section className={styles.access}>
    <h2 className="text-lg font-medium">API & MCP access</h2>
    <p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Connect your tools to the same models, queue, and images you use in Studio.</p>
    <div className={styles.endpoints}>
      <CopyField label="MCP server address" value={origin ? `${origin}${discovery?.endpoints.mcp ?? '/api/mcp'}` : ''} copyLabel="Copy MCP address" />
      <CopyField label="OpenAI-compatible base URL" value={origin ? `${origin}${discovery?.endpoints.openai ?? '/v1'}` : ''} copyLabel="Copy OpenAI base URL" />
    </div>
    <p className="mt-3 text-xs leading-relaxed text-ink-2">Use your Studio token as the API key. MCP connects over HTTP. Your account permissions, private library and work-time allowance apply to every request.</p>
    <details className={styles.guide}>
      <summary>Connection examples</summary>
      <div className={styles.examples}>
        <div role="group" aria-label="Connection example" className={styles.exampleTabs}>{(Object.keys(exampleLabels) as Example[]).map(kind => <Chip key={kind} active={example === kind} aria-pressed={example === kind} onClick={() => setExample(kind)}>{exampleLabels[kind]}</Chip>)}</div>
        <p className="mt-3 text-xs leading-relaxed text-ink-2">{example === 'mcp' ? 'Add this HTTP server to your MCP client and replace YOUR_TOKEN. Available tools follow the permissions you choose below.' : example === 'images' ? 'Set GRAVITY_API_KEY to your token. Images use the Studio queue; allow a long timeout. For progress, upscaling and background removal, use MCP or the Studio API.' : 'Set GRAVITY_API_KEY to a token with Language models permission. Choose Chat Completions in your client. The assistant model follows the configuration selected by your administrator.'}</p>
        {example === 'images' && <div role="group" aria-label="Image request" className="mt-3 flex flex-wrap gap-2"><Chip active={!editExample} aria-pressed={!editExample} onClick={() => setEditExample(false)}>Generate image</Chip><Chip active={editExample} aria-pressed={editExample} onClick={() => setEditExample(true)}>Edit image</Chip></div>}
        {example === 'images' && editExample && <p className="mt-3 text-xs leading-relaxed text-ink-2">Choose a local image as <code>reference.png</code>. To edit a selected area, add <code>-F 'mask=@mask.png'</code>: fully transparent PNG pixels are regenerated; opaque pixels are protected.</p>}
        {example !== 'mcp' && <p className="mt-2 text-xs leading-relaxed text-ink-2">{example === 'images' && !discovery?.models.images.some(model => model.ready) ? 'No image model is ready yet. Install and enable a model, then use its ID from ' : 'Discover available model IDs with '}<code>GET {discovery?.endpoints.openai ?? '/v1'}/models</code>.</p>}
        <div className={styles.codeHeader}><span className="text-xs text-ink-2">{example === 'mcp' ? 'MCP client configuration' : 'cURL'}</span><Chip aria-label="Copy connection example" onClick={() => void copyExample()} icon={copiedExample ? <Check /> : <Copy />}>{copiedExample ? 'Copied' : 'Copy'}</Chip></div>
        <pre ref={code} tabIndex={0} aria-label={exampleLabels[example]} className={styles.code}><code>{exampleText}</code></pre>
        {exampleFallback && <p role="status" className="mt-2 text-xs text-ink-2">The example is selected. Use your keyboard or the browser menu to copy it.</p>}
        <p className="mt-3 text-xs leading-relaxed text-ink-2">The Studio API at <code>{discovery?.endpoints.rest ?? '/api'}</code> also exposes jobs, assets, favorites and image tools.</p>
      </div>
    </details>
    {discoveryError && <p role="alert" className="error-notice mt-4">{discoveryError}<button type="button" className="ml-2 underline" onClick={() => void discover()}>Retry model discovery</button></p>}
    <form onSubmit={create} className="mt-7 border-t border-line pt-6">
      <h3 className="mb-2 text-sm font-medium">Create an access token</h3>
      <p className="mb-4 text-xs leading-relaxed text-ink-2">Give each connected tool its own token. Choose what it can do with your account; server administration stays in Settings.</p>
      <label className="field">Token name<input value={name} onChange={event => setName(event.target.value)} placeholder="My MCP client" maxLength={80} required autoComplete="off" /></label>
      <div className={styles.tokenOptions}>
        <label className="field">Permissions<select aria-label="Token permissions" value={profile} onChange={event => chooseProfile(event.target.value)}>{profiles.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}{profile === 'custom' && <option value="custom">Custom permissions</option>}</select></label>
        <label className="field">Expires in<select aria-label="Token expiration" value={days} onChange={event => setDays(event.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">No expiration</option></select></label>
      </div>
      <details className={styles.scopeDetails}>
        <summary>Review permissions <span className="text-ink-2">({scopes.length})</span></summary>
        <fieldset className={styles.permissions}><legend className="sr-only">Individual token permissions</legend>{permissions.map(permission => <label key={permission.id} className={styles.permission}><input type="checkbox" checked={scopes.includes(permission.id)} onChange={() => toggleScope(permission.id)} /><span><span className="block text-sm text-ink">{permission.name}</span><span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{permission.description}</span></span></label>)}</fieldset>
      </details>
      <button disabled={busy || !loaded || !name.trim() || !scopes.length} className={styles.create}>{busy && <LoaderCircle size={15} className="animate-spin" />}{busy ? 'Creating…' : 'Create token'}</button>
    </form>
    {secret && <div className="mt-5 rounded-panel bg-panel-2 p-4" role="status"><CopyField label="Your new token" value={secret} copyLabel="Copy access token" secret /><p className="mt-3 text-xs leading-relaxed text-ink-2">Copy this token now. It will not be shown after you leave this page.</p><button type="button" onClick={() => setSecret('')} className="mt-3 min-h-8 text-xs text-ink-2 underline underline-offset-3">I have saved it</button></div>}
    {error && <p role="alert" className="error-notice mt-5">{error}{!loaded && <button type="button" className="ml-2 underline" onClick={() => { setError(''); void load(); }}>Try again</button>}</p>}
    <div className="mt-7 border-t border-line pt-6"><h3 className="mb-3 text-sm font-medium">Your access tokens</h3>{tokens.length ? <ul className="divide-y divide-line">{tokens.map(token => {
      const expired = !!token.expiresAt && Date.parse(token.expiresAt) <= Date.now();
      return <li key={token.id} className={styles.token}>
        <div className="min-w-0 flex-1"><p className="break-words text-sm">{token.name}{expired && <span className="ml-2 text-xs text-ink-2">Expired</span>}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-2">Created {date(token.createdAt)} · {token.expiresAt ? `${expired ? 'Expired' : 'Expires'} ${date(token.expiresAt)}` : 'No expiration'}<br />{token.lastUsedAt ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'Not used yet'}</p>
          <details className={styles.savedScopes}><summary>{token.scopes.length} permissions</summary><p className="mt-2 break-words text-xs leading-relaxed text-ink-2">{token.scopes.map(scope => permissions.find(permission => permission.id === scope)?.name ?? scope).join(' · ')}</p></details>
        </div>
        <button disabled={!!revoking} onClick={() => void revoke(token.id)} aria-label={`Revoke ${token.name}`} className={styles.revoke}>{revoking === token.id ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}Revoke</button>
      </li>;
    })}</ul> : <p className="text-sm text-ink-2">{loaded ? 'No access tokens yet.' : 'Loading access tokens…'}</p>}</div>
  </section>;
}
