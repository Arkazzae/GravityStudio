'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, Trash2 } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { api, errorMessage, type IntegrationStatus, type IntegrationTestResult } from '@/lib/api';

export function IntegrationsSettings() {
  const [providers, setProviders] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await api<{ providers: IntegrationStatus[] }>('/integrations', { signal: controller.signal });
      if (request.current === controller && !controller.signal.aborted) setProviders(result.providers);
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (request.current === controller && !controller.signal.aborted) { request.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => { void load(); return () => { request.current?.abort(); request.current = null; }; }, [load]);

  return <section aria-labelledby="integrations-title">
    <h2 id="integrations-title" className="text-lg font-medium">Integrations</h2>
    <p className="mt-2 text-sm leading-relaxed text-ink-2">Manage provider keys for model downloads and external APIs. Keys are encrypted on the Studio server. Only their last four characters are shown after saving.</p>
    <p className="mb-6 mt-3 text-xs leading-relaxed text-ink-2">Access checks use the saved key and do not generate content. Provider keys are separate from the Studio tokens in API access.</p>
    {loading && <p role="status" className="py-5 text-sm text-ink-2">Loading integrations…</p>}
    {error && <div role="alert" className="error-notice">{error}<button type="button" onClick={() => void load()} className="ml-3 underline">Try again</button></div>}
    {!loading && !error && <div className="divide-y divide-line border-y border-line">{providers.map(provider => <ProviderSettings key={provider.id} initialStatus={provider} />)}</div>}
  </section>;
}

type ProviderAction = 'save' | 'remove' | 'test';

function ProviderSettings({ initialStatus }: { initialStatus: IntegrationStatus }) {
  const [provider, setProvider] = useState(initialStatus);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<ProviderAction | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  async function run(action: ProviderAction) {
    if (request.current || (action === 'save' && !apiKey.trim())) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(action); setError(''); setMessage('');
    const path = `/integrations/${provider.id}`;
    try {
      if (action === 'test') {
        const result = await api<IntegrationTestResult>(`${path}/test`, { method: 'POST', body: '{}', signal: controller.signal });
        if (request.current === controller && !controller.signal.aborted) setMessage(result.message);
      } else {
        const result = await api<IntegrationStatus>(path, { method: action === 'save' ? 'PUT' : 'DELETE', ...(action === 'save' ? { body: JSON.stringify({ apiKey: apiKey.trim() }) } : {}), signal: controller.signal });
        if (request.current === controller && !controller.signal.aborted) {
          setProvider(result); setApiKey(''); setMessage(action === 'save' ? 'Key saved. Check access to verify it.' : 'Key removed.');
        }
      }
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (request.current === controller && !controller.signal.aborted) { request.current = null; setBusy(null); }
    }
  }

  function save(event: FormEvent) { event.preventDefault(); void run('save'); }
  const prefix = `integration-${provider.id}`;
  return <form onSubmit={save} aria-labelledby={`${prefix}-title`} aria-busy={!!busy} className="py-6">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h3 id={`${prefix}-title`} className="text-sm font-medium">{provider.name}</h3>
      <p className={`text-xs ${provider.credential ? 'text-volt' : 'text-ink-2'}`}>{provider.credential ? <>Saved key · <span className="font-mono">•••• {provider.credential.suffix}</span></> : 'No key saved'}</p>
    </div>
    <p id={`${prefix}-help`} className="mb-4 mt-2 text-xs leading-relaxed text-ink-2">{provider.description}</p>
    <label className="field">{provider.credential ? 'Replace API key' : 'API key'}<input type="password" name={`${provider.id}-api-key`} aria-label={`${provider.name} API key`} aria-describedby={`${prefix}-help${error ? ` ${prefix}-error` : ''}`} aria-invalid={error ? true : undefined} value={apiKey} onChange={event => { setApiKey(event.target.value); setError(''); setMessage(''); }} disabled={!!busy} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={8} maxLength={4096} required placeholder={provider.credential ? 'Enter a new key to replace the saved key' : 'Paste your provider key'} /></label>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="submit" disabled={!!busy || !apiKey.trim()} className="flex min-h-11 items-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi disabled:opacity-50">{busy === 'save' && <LoaderCircle size={15} className="animate-spin" />}{busy === 'save' ? 'Saving…' : provider.credential ? 'Replace key' : 'Save key'}</button>
      {provider.credential && <>
        <Chip type="button" disabled={!!busy || !!apiKey.trim()} icon={busy === 'test' ? <LoaderCircle className="animate-spin" /> : <Check />} onClick={() => void run('test')}>{busy === 'test' ? 'Checking…' : 'Check access'}</Chip>
        <button type="button" disabled={!!busy} onClick={() => void run('remove')} aria-label={`Remove ${provider.name} key`} className="flex min-h-11 items-center gap-2 rounded-chip px-3 text-xs text-ink-2 hover:bg-chip hover:text-ink disabled:opacity-50">{busy === 'remove' ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}{busy === 'remove' ? 'Removing…' : 'Remove key'}</button>
      </>}
    </div>
    {message && <p role="status" className="mt-3 text-xs leading-relaxed text-ink-2">{message}</p>}
    {error && <p id={`${prefix}-error`} role="alert" className="error-notice mt-3">{error}</p>}
  </form>;
}
