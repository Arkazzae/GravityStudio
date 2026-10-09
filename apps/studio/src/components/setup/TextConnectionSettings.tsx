'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Trash2 } from '@/components/ui/icons';
import { api, errorMessage } from '@/lib/api';
import type { TextSettings, TextModel } from '@/lib/text-api';

export function TextConnectionSettings({ active = true }: { active?: boolean }) {
  const [settings, setSettings] = useState<TextSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const editor = useRef({ settings, baseUrl, apiKey });
  editor.current = { settings, baseUrl, apiKey };
  const load = useCallback(async (preserveDraft = false) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    try {
      const next = await api<TextSettings>('/text/settings', { signal: controller.signal });
      if (!controller.signal.aborted) {
        const current = editor.current;
        const edited = current.settings && (current.baseUrl !== current.settings.connection.baseUrl || !!current.apiKey);
        const sameConnection = JSON.stringify(current.settings?.connection) === JSON.stringify(next.connection);
        if (preserveDraft && edited && !sameConnection) {
          setError('This connection changed in another window. Reload the connection before saving your edits.');
        } else {
          setSettings(next);
          if (!preserveDraft || !edited) { setBaseUrl(next.connection.baseUrl); setApiKey(''); }
        }
      }
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  }, []);
  useEffect(() => { if (active && !request.current) void load(true); }, [active, load]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  async function run(action: 'save' | 'remove' | 'check') {
    if (!settings || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'check') {
        const result = await api<{ models: TextModel[] }>('/text/models?provider=openai-compatible&refresh=true', { signal: controller.signal });
        if (!controller.signal.aborted) setMessage(`Connected · ${result.models.length} model${result.models.length === 1 ? '' : 's'} available. Choose one in Assistant or Models → Language.`);
      } else {
        const next = await api<TextSettings>('/text/connection', { method: 'PUT', signal: controller.signal, body: JSON.stringify({ revision: settings.revision, baseUrl: action === 'remove' ? settings.connection.baseUrl : baseUrl.trim(), ...(action === 'remove' ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }) });
        if (!controller.signal.aborted) { setSettings(next); setBaseUrl(next.connection.baseUrl); setApiKey(''); setMessage(action === 'remove' ? 'Key removed.' : 'Connection saved. Choose your model in Assistant or Models → Language.'); }
      }
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
  }
  const changed = !!settings && baseUrl.trim() !== settings.connection.baseUrl;
  const button = 'inline-flex min-h-11 items-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi disabled:opacity-50';
  return <form onSubmit={event => { event.preventDefault(); void run('save'); }} aria-labelledby="text-connection-title" className="border-b border-line py-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="text-connection-title" className="text-sm font-medium">OpenAI-compatible endpoint</h3>{settings && <span className="text-xs text-ink-2">{settings.connection.credential ? `Saved key · •••• ${settings.connection.credential.suffix}` : 'No key saved'}</span>}</div>
    <p className="mb-4 mt-2 text-xs leading-relaxed text-ink-2">Connect an existing llama.cpp server or another compatible text API. The Studio server must be able to reach this address.</p>
    <fieldset disabled={busy || !settings} className="space-y-4">
      <label className="field">API base URL<input type="url" aria-label="Text API base URL" placeholder="http://localhost:8080/v1" value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setMessage(''); }} maxLength={2048} autoComplete="off" spellCheck={false} /></label>
      <label className="field">API key <span className="font-normal text-ink-2">(optional)</span><input type="password" aria-label="Text endpoint API key" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={settings?.connection.credential ? 'Leave empty to keep the saved key' : 'Leave empty if your server needs no key'} autoComplete="off" spellCheck={false} minLength={8} maxLength={4096} /></label>
      {changed && settings?.connection.credential && <p className="text-xs leading-relaxed text-ink-2">Changing the address removes the saved key and model selection. Enter a replacement key if the new endpoint needs one.</p>}
      <div className="flex flex-wrap items-center gap-3"><button type="submit" className={button}>Save connection</button><button type="button" disabled={changed || !!apiKey.trim() || !settings?.connection.baseUrl} className={button} onClick={() => void run('check')}><Check size={15} />Check access</button>{settings?.connection.credential && <button type="button" disabled={changed || !!apiKey.trim()} aria-label="Remove text endpoint key" className={button} onClick={() => void run('remove')}><Trash2 size={15} />Remove key</button>}</div>
    </fieldset>
    {busy && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-ink-2"><LoaderCircle size={14} className="animate-spin" />Working…</p>}
    {message && <p role="status" className="mt-3 text-xs leading-relaxed text-ink-2">{message}</p>}
    {error && <p role="alert" className="error-notice mt-3">{error}<button type="button" className="ml-3 underline" disabled={busy} onClick={() => void load()}>Reload connection</button></p>}
  </form>;
}
