'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw } from '@/components/ui/icons';
import { api, errorMessage } from '@/lib/api';
import { textProviderName, type TextModel, type TextProviderId, type TextSettings } from '@/lib/text-api';
import { LocalTextRuntime } from './LocalTextRuntime';

export function LanguageModels({ assistant = false, onConfigure, active = true }: { assistant?: boolean; onConfigure: () => void; active?: boolean }) {
  const titleId = useId();
  const [settings, setSettings] = useState<TextSettings | null>(null);
  const [provider, setProvider] = useState<TextProviderId>('local');
  const [models, setModels] = useState<TextModel[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorSource = useRef<'read' | 'action' | null>(null);
  const [message, setMessage] = useState('');
  const [localVisited, setLocalVisited] = useState(false);
  const [localModel, setLocalModel] = useState<TextModel | null>(null);
  const request = useRef<AbortController | null>(null);
  const operation = useRef<'read' | 'action' | null>(null);
  const edited = useRef(false);
  const providerRef = useRef(provider); providerRef.current = provider;
  const load = useCallback(async (resetDraft = false) => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; operation.current = 'read';
    setBusy(true);
    if (resetDraft) { setError(''); errorSource.current = null; }
    try {
      const next = await api<TextSettings>('/text/settings', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!controller.signal.aborted) {
        if (errorSource.current === 'read') { setError(''); errorSource.current = null; }
        setSettings(next);
        if (resetDraft || !edited.current) {
          const nextProvider = next.assistant?.provider || 'local';
          if (providerRef.current !== nextProvider) setModels(null);
          setProvider(nextProvider); setModelId(next.assistant?.modelId || ''); edited.current = false;
        }
      }
    } catch (error) { if (!controller.signal.aborted && errorSource.current !== 'action') { errorSource.current = 'read'; setError(errorMessage(error)); } }
    finally { if (request.current === controller) { request.current = null; operation.current = null; setBusy(false); } }
  }, []);
  useEffect(() => {
    if (active) void load();
    return () => {
      if (operation.current === 'read') { request.current?.abort(); request.current = null; operation.current = null; setBusy(false); }
    };
  }, [active, load]);
  useEffect(() => () => { request.current?.abort(); request.current = null; operation.current = null; }, []);
  useEffect(() => { if (provider === 'local' && settings) setLocalVisited(true); }, [provider, settings]);
  const localModelChanged = useCallback((model: TextModel | null) => { setLocalModel(model); }, []);
  const availableModels = provider === 'local' ? localModel ? [localModel] : [] : models;
  const selectedModelId = provider === 'local' ? localModel?.id || '' : modelId;

  async function discover() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; operation.current = 'action';
    setBusy(true); setError(''); setMessage(''); errorSource.current = 'action';
    try {
      const result = await api<{ models: TextModel[] }>(`/text/models?provider=${provider}&refresh=true`, { signal: controller.signal });
      if (!controller.signal.aborted) { errorSource.current = null; setModels(result.models); setModelId(current => result.models.some(model => model.id === current) ? current : ''); }
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { if (request.current === controller) { request.current = null; operation.current = null; setBusy(false); } }
  }
  async function save(disable = false) {
    if (!settings || request.current) return;
    const controller = new AbortController(); request.current = controller; operation.current = 'action';
    setBusy(true); setError(''); setMessage(''); errorSource.current = 'action';
    try {
      const next = await api<TextSettings>('/text/assistant', { method: 'PUT', signal: controller.signal, body: JSON.stringify({ revision: settings.revision, provider: disable ? null : provider, modelId: disable ? null : selectedModelId }) });
      if (!controller.signal.aborted) { errorSource.current = null; setSettings(next); edited.current = disable; setMessage(disable ? 'Prompt assistant disabled.' : 'Assistant model saved. Open the assistant in the prompt dock to refine a prompt.'); }
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { if (request.current === controller) { request.current = null; operation.current = null; setBusy(false); } }
  }
  const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi disabled:opacity-50';
  return <section aria-labelledby={titleId}>
    <h2 id={titleId} className="text-lg font-medium">{assistant ? 'Prompt assistant' : 'Language models'}</h2>
    <p className="mt-2 text-sm leading-relaxed text-ink-2">Choose a model for refining prompts and rewriting them with your instructions. Refine runs only when you request it.</p>
    <div className="my-6 border-y border-line py-5"><p className="text-xs text-ink-2">Current assistant</p><p className="mt-2 break-words text-sm">{settings ? settings.assistant ? `${textProviderName(settings.assistant.provider)} · ${settings.assistant.modelId}` : 'Not configured' : 'Loading…'}</p></div>
    <fieldset disabled={busy || !settings} className="space-y-5">
      <label className="field">Provider<select aria-label="Language model provider" value={provider} onChange={event => { edited.current = true; setProvider(event.target.value as TextProviderId); setModels(null); setModelId(''); setError(''); errorSource.current = null; setMessage(''); }}><option value="local">Local Studio</option><option value="gemini">Gemini</option><option value="openai-compatible">OpenAI-compatible endpoint</option></select></label>
      {(localVisited || provider === 'local' && !!settings) && <div hidden={provider !== 'local'}><LocalTextRuntime active={active && provider === 'local'} onModelChange={localModelChanged} disabled={busy || !settings} /></div>}
      {provider !== 'local' && <>
        <div className="flex flex-wrap items-center gap-3"><button type="button" onClick={() => void discover()} className={button}><RefreshCw size={15} />{models ? 'Refresh models' : 'Load models'}</button><button type="button" onClick={onConfigure} className="min-h-11 px-2 text-sm text-ink-2 underline underline-offset-4 hover:text-ink">Manage connections</button></div>
        {models && (models.length ? <label className="field">Model<select aria-label="Assistant model" value={modelId} onChange={event => { edited.current = true; setModelId(event.target.value); setMessage(''); }}><option value="">Choose a model</option>{models.map(model => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}</select></label> : <p className="text-sm text-ink-2">No text models available from this connection.</p>)}
      </>}
      <div className="flex flex-wrap items-center gap-3">{(provider !== 'local' || !!availableModels?.length) && <button type="button" disabled={!availableModels?.some(model => model.id === selectedModelId)} onClick={() => void save()} className={`${button} !bg-volt !text-on-volt`}><Check size={15} />Use for assistant</button>}{settings?.assistant && <button type="button" onClick={() => void save(true)} className={button}>Disable assistant</button>}</div>
    </fieldset>
    <p className="mt-5 text-xs leading-relaxed text-ink-2">{provider === 'local' ? 'Your prompt and instructions stay on this Studio server. Reference images are not sent to the language model.' : 'Your prompt and instructions are sent to the selected provider. Reference images stay in Studio. Existing endpoints manage their own model loading and GPU usage.'}</p>
    {busy && <p role="status" className="mt-4 flex items-center gap-2 text-xs text-ink-2"><LoaderCircle size={14} className="animate-spin" />Loading…</p>}
    {message && <p role="status" className="mt-4 text-sm leading-relaxed text-ink-2">{message}</p>}
    {error && <p role="alert" className="error-notice mt-4">{error}<button type="button" disabled={busy} onClick={() => void load(true)} className="ml-3 underline">Reload settings</button></p>}
  </section>;
}
