'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Boxes, Check, Download, ExternalLink, HardDrive, LoaderCircle, SlidersHorizontal, Wand2 } from '@/components/ui/icons';
import { LanguageModels } from './LanguageModels';
import { ProviderSettings } from './IntegrationsSettings';
import { TabbedWorkspace, type WorkspaceSection } from '@/components/studio/TabbedWorkspace';
import { api, errorMessage, type IntegrationStatus, type LibraryModel, type ModelAccessResult, type ModelDownload, type ModelLibraryState } from '@/lib/api';

const downloadBusy = (download?: ModelDownload | null) => !!download && !['succeeded', 'failed'].includes(download.status);
const size = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
export type ModelsSection = 'library' | 'installed' | 'tools' | 'huggingface' | 'downloads' | 'language';

export function ModelLibrary({ onChanged, onConfigureText, active = true, requestedSection }: { onChanged: () => void; onConfigureText: () => void; active?: boolean; requestedSection?: { section: ModelsSection; revision: number } }) {
  const [section, setSection] = useState<ModelsSection>('library');
  const [languageVisited, setLanguageVisited] = useState(false);
  const [library, setLibrary] = useState<ModelLibraryState | null>(null);
  const [error, setError] = useState('');
  const errorSource = useRef<'read' | 'action' | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [action, setAction] = useState<'check' | 'download-check' | 'download' | 'activate' | null>(null);
  const [access, setAccess] = useState<Record<string, ModelAccessResult>>({});
  const [huggingFace, setHuggingFace] = useState<IntegrationStatus | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(false);
  const [credentialError, setCredentialError] = useState('');
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [returnToModel, setReturnToModel] = useState<{ section: ModelsSection; name: string } | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const mounted = useRef(true);
  const visible = useRef(active); visible.current = active;
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const credentialRead = useRef<AbortController | null>(null);
  const credentialAction = useRef(false);
  const credentialRevision = useRef<string | undefined>(undefined);
  const libraryRef = useRef(library); libraryRef.current = library;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const load = useCallback(async () => {
    if (!mounted.current || read.current || write.current) return;
    const controller = new AbortController(); read.current = controller;
    try {
      const next = await api<ModelLibraryState>('/models/library', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!controller.signal.aborted && mounted.current) {
        if (downloadBusy(libraryRef.current?.download) && !downloadBusy(next.download)) onChangedRef.current();
        setLibrary(next);
        if (errorSource.current === 'read') { setError(''); errorSource.current = null; }
      }
    }
    catch (error) { if (!controller.signal.aborted && mounted.current && errorSource.current !== 'action') { errorSource.current = 'read'; setError(errorMessage(error)); } }
    finally { if (read.current === controller) read.current = null; }
  }, []);
  const loadCredential = useCallback(async () => {
    if (!mounted.current || credentialAction.current) return;
    credentialRead.current?.abort();
    const controller = new AbortController(); credentialRead.current = controller;
    setCredentialLoading(true); setCredentialError('');
    try {
      const result = await api<{ providers: IntegrationStatus[] }>('/integrations', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (controller.signal.aborted || !mounted.current || credentialRead.current !== controller) return;
      const provider = result.providers.find(provider => provider.id === 'huggingface');
      if (!provider) throw new Error('Hugging Face token settings are unavailable. Try again.');
      const revision = provider.credential ? `${provider.credential.updatedAt}:${provider.credential.suffix}` : '';
      if (credentialRevision.current !== undefined && credentialRevision.current !== revision) setAccess({});
      credentialRevision.current = revision;
      setHuggingFace(provider);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setCredentialError(errorMessage(error));
    } finally {
      if (credentialRead.current === controller) { credentialRead.current = null; if (mounted.current) setCredentialLoading(false); }
    }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; read.current?.abort(); write.current?.abort(); credentialRead.current?.abort(); }; }, []);
  useEffect(() => {
    if (active) void loadCredential();
    return () => { credentialRead.current?.abort(); credentialRead.current = null; };
  }, [active, loadCredential]);
  useEffect(() => {
    if (active && !submitting) void load();
    return () => { read.current?.abort(); read.current = null; };
  }, [active, submitting, load]);
  useEffect(() => { if (section === 'language') setLanguageVisited(true); }, [section]);
  useEffect(() => { if (requestedSection) setSection(requestedSection.section); }, [requestedSection]);
  const downloading = downloadBusy(library?.download);
  useEffect(() => {
    if (!active || !downloading || submitting) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      await load();
      if (!cancelled) timeout = setTimeout(() => void poll(), 1500);
    }
    timeout = setTimeout(() => void poll(), 500);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [active, downloading, submitting, load]);

  function openSection(next: ModelsSection) {
    if (!mounted.current) return;
    setSection(next);
    if (visible.current) document.getElementById(`models-tab-${next}`)?.focus({ preventScroll: true });
  }

  function configureToken(name: string) {
    setReturnToModel({ section, name });
    openSection('huggingface');
    void loadCredential();
  }
  function credentialChanged(provider: IntegrationStatus) {
    credentialRevision.current = provider.credential ? `${provider.credential.updatedAt}:${provider.credential.suffix}` : '';
    setHuggingFace(provider); setAccess({});
  }
  function credentialActionChanged(running: boolean) {
    credentialAction.current = running; setCredentialBusy(running);
    credentialRead.current?.abort(); credentialRead.current = null; setCredentialLoading(false);
    if (!running && visible.current) void loadCredential();
  }
  async function readAccess(body: { modelId: string } | { url: string }, id: string, controller: AbortController) {
    const result = await api<ModelAccessResult>('/models/access', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
    if (!controller.signal.aborted && mounted.current) setAccess(current => ({ ...current, [id]: result }));
    return result;
  }
  async function checkAccess(body: { modelId: string } | { url: string }, id: string) {
    if (write.current || credentialAction.current) return;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    setSubmitting(id); setAction('check'); setError(''); errorSource.current = 'action';
    try {
      await readAccess(body, id, controller);
      if (!controller.signal.aborted && mounted.current) errorSource.current = null;
    } catch (error) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(error)); }
    finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted && mounted.current) { setSubmitting(null); setAction(null); } }
  }

  async function download(body: { modelId: string } | { url: string; name: string; familyId: 'sdxl' }, id: string) {
    if (write.current || credentialAction.current) return;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    setSubmitting(id); setAction('download-check'); setError(''); errorSource.current = 'action';
    try {
      const checked = await readAccess('modelId' in body ? { modelId: body.modelId } : { url: body.url }, id, controller);
      if (controller.signal.aborted || !mounted.current) return;
      if (!checked.available) { errorSource.current = null; return; }
      setAction('download');
      const result = await api<ModelDownload>('/models/download', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      errorSource.current = null;
      setLibrary(current => current ? { ...current, download: result } : { models: [], download: result });
      if ('url' in body) { setUrl(''); setName(''); }
      openSection('downloads');
    } catch (error) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(error)); }
    finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted && mounted.current) { setSubmitting(null); setAction(null); } }
  }
  async function activate(model: LibraryModel) {
    if (write.current || credentialAction.current) return;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    setSubmitting(model.id); setAction('activate'); setError(''); errorSource.current = 'action';
    try {
      const next = await api<ModelLibraryState>('/models/activate', { method: 'POST', body: JSON.stringify({ modelId: model.id }), signal: controller.signal });
      if (!controller.signal.aborted && mounted.current) { errorSource.current = null; setLibrary(next); onChangedRef.current(); }
    }
    catch (error) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(error)); }
    finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted && mounted.current) { setSubmitting(null); setAction(null); } }
  }
  const downloadState = library?.download;
  const progress = downloadState?.totalBytes ? Math.min(100, Math.round(downloadState.receivedBytes / downloadState.totalBytes * 100)) : null;
  const busy = downloading || !!submitting || credentialBusy;
  const importAccessId = `huggingface:${url.trim()}`;

  const sections: readonly WorkspaceSection<ModelsSection>[] = [
    { id: 'library', label: 'Library', icon: Boxes },
    { id: 'installed', label: 'Installed', icon: HardDrive },
    { id: 'tools', label: 'Tools', icon: SlidersHorizontal },
    { id: 'huggingface', label: 'Hugging Face', icon: ExternalLink },
    { id: 'downloads', label: 'Downloads', icon: downloading ? LoaderCircle : Download, busy: downloading },
    { id: 'language', label: 'Language', icon: Wand2 },
  ];
  const installed = library?.models.filter(model => model.installed) || [];
  const imageModels = library?.models.filter(model => model.kind !== 'utility') || [];
  const tools = library?.models.filter(model => model.kind === 'utility') || [];
  const actionClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi disabled:cursor-default disabled:opacity-50';

  function modelList(models: LibraryModel[]) {
    return <div className="mt-3 divide-y divide-line">{models.map(model => <article key={model.id} data-model-id={model.id} className="flex flex-col gap-4 py-5 @xl:flex-row @xl:items-start @xl:gap-6">
      <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium">{model.name}</h3><p className="mt-1 break-words text-xs text-ink-2">{model.family}{model.license ? ` · ${model.license}` : ''}</p>
        {model.description && <p className="mt-2 max-w-[65ch] break-words text-sm leading-relaxed text-ink-2">{model.description}</p>}
        {(model.repositories?.length > 0 || model.licenseUrl) && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-2">
          {model.repositories?.map(repository => <a key={repository.id} href={repository.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1.5 underline underline-offset-3 hover:text-ink"><ExternalLink size={13} className="shrink-0" /><span className="break-all">{repository.id}</span></a>)}
          {model.licenseUrl && <a href={model.licenseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 underline underline-offset-3 hover:text-ink"><ExternalLink size={13} />License</a>}
        </div>}
        {!model.downloadable && !model.installed && <p className="mt-2 break-words text-xs leading-relaxed text-ink-2">{model.unavailableReason || 'This model is not available for automatic download.'}</p>}
        {access[model.id] && <AccessReport result={access[model.id]} onConfigureToken={() => configureToken(model.name)} />}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 @xl:flex-col @xl:items-stretch @xl:pt-1">{model.enabled || model.kind === 'utility' && model.installed ? <span className="inline-flex min-h-11 items-center gap-2 text-sm text-volt"><Check size={16} />{model.kind === 'utility' ? 'Downloaded' : 'Ready to use'}</span>
        : <button disabled={busy || (!model.installed && !model.downloadable)} onClick={() => void (model.installed ? activate(model) : download({ modelId: model.id }, model.id))} className={actionClass}>
          {submitting === model.id && action !== 'check' || (downloading && downloadState?.modelId === model.id) ? <LoaderCircle size={15} className="animate-spin" /> : model.installed ? null : <Download size={15} />}
          {submitting === model.id && action === 'download-check' ? 'Checking access…' : model.installed ? 'Use model' : downloading && downloadState?.modelId === model.id ? 'Downloading…' : 'Download'}
        </button>}
        {!!model.repositories?.length && <button type="button" disabled={busy} onClick={() => void checkAccess({ modelId: model.id }, model.id)} className={actionClass}>
          {submitting === model.id && action === 'check' ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}{submitting === model.id && action === 'check' ? 'Checking…' : 'Check access'}
        </button>}
      </div>
    </article>)}</div>;
  }

  return <TabbedWorkspace id="models" label="Model sections" sections={sections} selected={section} onSelect={setSection}>
    {(languageVisited || section === 'language') && <div hidden={section !== 'language'} id="models-panel-language" role="tabpanel" aria-labelledby="models-tab-language" tabIndex={0}><LanguageModels active={active && section === 'language'} onConfigure={onConfigureText} /></div>}
    {error && <p className="error-notice mb-6 break-words" role="alert">{error}{!library && <button onClick={() => void load()} className="ml-3 underline">Try again</button>}</p>}
    {downloading && section !== 'downloads' && <div className="mb-6 flex items-center gap-3 border-b border-line pb-5">
      <LoaderCircle size={16} className="shrink-0 animate-spin text-ink-2" /><p title={`Downloading ${downloadState?.modelName}`} className="min-w-0 flex-1 line-clamp-2 break-words text-xs leading-relaxed text-ink-2">Downloading {downloadState?.modelName}</p>
      <button type="button" className={`${actionClass} shrink-0`} onClick={() => openSection('downloads')}>View download</button>
    </div>}
    <div hidden={section !== 'library'} id="models-panel-library" role="tabpanel" aria-labelledby="models-tab-library" tabIndex={0}>
      <h2 className="text-lg font-medium">Model library</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">Download a supported model and its required files. Add your own SDXL checkpoint in Hugging Face.</p>
      {!library ? !error && <p role="status" className="mt-5 text-sm text-ink-2">Loading models…</p> : imageModels.length ? modelList(imageModels) : <div className="mt-6"><p className="mb-4 text-sm text-ink-2">No models in the library yet.</p><button type="button" className={actionClass} onClick={() => openSection('huggingface')}>Add from Hugging Face</button></div>}
    </div>
    <div hidden={section !== 'tools'} id="models-panel-tools" role="tabpanel" aria-labelledby="models-tab-tools" tabIndex={0}>
      <h2 className="text-lg font-medium">Image tools</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">Download an upscaler, then open any image and choose Upscale. Background removal is used by the Transparent setting.</p>
      {!library ? !error && <p role="status" className="mt-5 text-sm text-ink-2">Loading tools…</p> : tools.length ? modelList(tools) : <p className="mt-6 text-sm text-ink-2">No image tools are available yet.</p>}
    </div>
    <div hidden={section !== 'installed'} id="models-panel-installed" role="tabpanel" aria-labelledby="models-tab-installed" tabIndex={0}>
      <h2 className="text-lg font-medium">Installed models</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">Models and tools with all required files downloaded. Activate a generation model to make it available in Image.</p>
      {!library ? !error && <p role="status" className="mt-5 text-sm text-ink-2">Loading installed models…</p> : installed.length ? modelList(installed) : <div className="mt-6"><p className="mb-4 text-sm text-ink-2">No models installed yet. Choose a model from the library to get started.</p><button type="button" className={actionClass} onClick={() => openSection('library')}>Browse library</button></div>}
    </div>
    <div hidden={section !== 'huggingface'} id="models-panel-huggingface" role="tabpanel" aria-labelledby="models-tab-huggingface" tabIndex={0}>
      <h2 className="text-lg font-medium">Hugging Face</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">Use a read token for private or gated model files. Accept the license or request access on each model’s Hugging Face page using the same account.</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-2">Your token is encrypted on the Studio server. <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer" className="underline underline-offset-3 hover:text-ink">Manage Hugging Face tokens<ExternalLink size={12} className="ml-1 inline" /></a></p>
      {returnToModel && <button type="button" className={`${actionClass} mt-4 max-w-full break-words text-left`} onClick={() => { openSection(returnToModel.section); setReturnToModel(null); }}>Back to {returnToModel.name}</button>}
      {credentialLoading && !huggingFace && <p role="status" className="mt-5 text-sm text-ink-2">Loading token settings…</p>}
      {credentialError && <p role="alert" className="error-notice mt-4">{credentialError}<button type="button" className="ml-3 underline" onClick={() => void loadCredential()}>Try again</button></p>}
      {huggingFace && <fieldset className="min-w-0" disabled={!!submitting || downloading}><ProviderSettings initialStatus={huggingFace} onActionChange={credentialActionChanged} onCredentialChange={credentialChanged} idPrefix="models-integration" showAccessCheck={false} /></fieldset>}
      <div className="border-t border-line pt-6">
      <h3 id="huggingface-title" className="text-lg font-medium">Add from Hugging Face</h3><p className="mt-2 text-sm leading-relaxed text-ink-2">Paste a checkpoint file link. SDXL and Illustrious checkpoints are supported.</p>
      <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); void download({ url: url.trim(), name: name.trim(), familyId: 'sdxl' }, importAccessId); }}>
        <label className="field">Checkpoint URL<input type="url" name="checkpoint-url" required disabled={busy} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://huggingface.co/owner/model/blob/main/model.safetensors" /></label>
        <label className="field">Display name<input name="checkpoint-name" required maxLength={120} disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="My checkpoint" /></label>
        <div className="flex flex-wrap gap-3"><button disabled={busy || !url.trim() || !name.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-volt px-5 text-sm font-semibold text-on-volt disabled:opacity-50">{submitting === importAccessId && action !== 'check' ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}{submitting === importAccessId && action === 'download-check' ? 'Checking access…' : 'Download checkpoint'}</button>
          <button type="button" disabled={busy || !url.trim()} className={actionClass} onClick={() => void checkAccess({ url: url.trim() }, importAccessId)}>{submitting === importAccessId && action === 'check' ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}{submitting === importAccessId && action === 'check' ? 'Checking…' : 'Check access'}</button>
        </div>
      </form>
      {access[importAccessId] && <AccessReport result={access[importAccessId]} />}
      <p className="mt-3 text-xs leading-relaxed text-ink-2">Use a .safetensors file you can access. For other model families, use the Library tab.</p>
      </div>
    </div>
    <div hidden={section !== 'downloads'} id="models-panel-downloads" role="tabpanel" aria-labelledby="models-tab-downloads" tabIndex={0}>
      <h2 className="text-lg font-medium">Downloads</h2><p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Your current or most recent model download.</p>
      {!library ? !error && <p role="status" className="text-sm text-ink-2">Loading download status…</p> : !downloadState ? <div><p className="mb-4 text-sm text-ink-2">No downloads yet.</p><button type="button" className={actionClass} onClick={() => openSection('library')}>Browse library</button></div> : <section aria-label="Model download" aria-live="polite">
        <div className="flex items-start gap-3">{downloading ? <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-ink-2" /> : downloadState.status === 'succeeded' ? <Check size={18} className="mt-0.5 shrink-0 text-volt" /> : null}<div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{downloadState.modelName}</p><p className={`mt-1 break-words text-xs leading-relaxed ${downloadState.status === 'failed' ? 'text-[#ffc3aa]' : 'text-ink-2'}`}>{downloadState.status === 'failed' ? downloadState.error || 'Download failed. You can try again from Library or Hugging Face.' : downloadState.stage}</p></div></div>
        {downloadState.status === 'failed' && downloadState.access && <AccessReport result={{ available: false, repositories: [{ ...downloadState.access.repository, status: downloadState.access.status, message: downloadState.access.message }] }} onConfigureToken={() => configureToken(downloadState.modelName)} />}
        {downloading && <><progress aria-label={`Downloading ${downloadState.modelName}`} value={progress ?? undefined} max={100} className="mt-4 h-1.5 w-full accent-volt" /><p className="mt-2 break-all text-xs tabular-nums text-ink-2">{downloadState.filename ? `${downloadState.filename} · ` : ''}{size(downloadState.receivedBytes)}{downloadState.totalBytes ? ` / ${size(downloadState.totalBytes)}` : ''} · File {Math.min(downloadState.completedFiles + 1, downloadState.totalFiles)} of {downloadState.totalFiles}</p><p className="mt-2 text-xs text-ink-2">You can close this panel while the download continues.</p></>}
        {!downloading && <button type="button" className={`${actionClass} mt-5`} onClick={() => openSection(downloadState.status === 'succeeded' ? 'installed' : 'library')}>{downloadState.status === 'succeeded' ? 'View installed models' : 'Browse library'}</button>}
      </section>}
    </div>
  </TabbedWorkspace>;
}

function AccessReport({ result, onConfigureToken }: { result: Pick<ModelAccessResult, 'available' | 'repositories'>; onConfigureToken?: () => void }) {
  if (result.available) return <p role="status" className="mt-3 text-xs leading-relaxed text-volt">Access confirmed. The required files are available to download.</p>;
  const blocked = result.repositories.filter(repository => repository.status !== 'available');
  const needsToken = blocked.some(repository => ['gated', 'unauthorized', 'forbidden'].includes(repository.status));
  return <div className="mt-3 space-y-3 text-xs leading-relaxed" role="alert">
    {blocked.map(repository => <div key={repository.id} className="min-w-0">
      <p className="break-words text-[#ffc3aa]">{repository.message}</p>
      <a href={repository.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1.5 text-ink-2 underline underline-offset-3 hover:text-ink"><ExternalLink size={13} className="shrink-0" /><span className="break-all">{repository.status === 'gated' ? 'Review terms and request access' : 'Open repository'} · {repository.id}</span></a>
    </div>)}
    {needsToken && onConfigureToken && <button type="button" onClick={onConfigureToken} className="min-h-11 text-ink-2 underline underline-offset-3 hover:text-ink">Set up Hugging Face token</button>}
  </div>;
}
