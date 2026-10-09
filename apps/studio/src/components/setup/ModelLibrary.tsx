'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Boxes, Check, Download, ExternalLink, HardDrive, LoaderCircle, Wand2 } from '@/components/ui/icons';
import { LanguageModels } from './LanguageModels';
import { TabbedWorkspace, type WorkspaceSection } from '@/components/studio/TabbedWorkspace';
import { api, errorMessage, type LibraryModel, type ModelDownload, type ModelLibraryState } from '@/lib/api';

const downloadBusy = (download?: ModelDownload | null) => !!download && !['succeeded', 'failed'].includes(download.status);
const size = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
type ModelsSection = 'library' | 'installed' | 'huggingface' | 'downloads' | 'language';

export function ModelLibrary({ onChanged, onConfigureText, active = true }: { onChanged: () => void; onConfigureText: () => void; active?: boolean }) {
  const [section, setSection] = useState<ModelsSection>('library');
  const [languageVisited, setLanguageVisited] = useState(false);
  const [library, setLibrary] = useState<ModelLibraryState | null>(null);
  const [error, setError] = useState('');
  const errorSource = useRef<'read' | 'action' | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const mounted = useRef(true);
  const visible = useRef(active); visible.current = active;
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
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
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; read.current?.abort(); write.current?.abort(); }; }, []);
  useEffect(() => {
    if (active && !submitting) void load();
    return () => { read.current?.abort(); read.current = null; };
  }, [active, submitting, load]);
  useEffect(() => { if (section === 'language') setLanguageVisited(true); }, [section]);
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

  async function download(body: { modelId: string } | { url: string; name: string; familyId: 'sdxl' }, id: string) {
    if (write.current) return;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    setSubmitting(id); setError(''); errorSource.current = 'action';
    try {
      const result = await api<ModelDownload>('/models/download', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      errorSource.current = null;
      setLibrary(current => current ? { ...current, download: result } : { models: [], download: result });
      if (id === 'huggingface') { setUrl(''); setName(''); }
      openSection('downloads');
    } catch (error) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(error)); }
    finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted && mounted.current) setSubmitting(null); }
  }
  async function activate(model: LibraryModel) {
    if (write.current) return;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    setSubmitting(model.id); setError(''); errorSource.current = 'action';
    try {
      const next = await api<ModelLibraryState>('/models/activate', { method: 'POST', body: JSON.stringify({ modelId: model.id }), signal: controller.signal });
      if (!controller.signal.aborted && mounted.current) { errorSource.current = null; setLibrary(next); onChangedRef.current(); }
    }
    catch (error) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(error)); }
    finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted && mounted.current) setSubmitting(null); }
  }
  const downloadState = library?.download;
  const progress = downloadState?.totalBytes ? Math.min(100, Math.round(downloadState.receivedBytes / downloadState.totalBytes * 100)) : null;
  const busy = downloading || !!submitting;

  const sections: readonly WorkspaceSection<ModelsSection>[] = [
    { id: 'library', label: 'Library', icon: Boxes },
    { id: 'installed', label: 'Installed', icon: HardDrive },
    { id: 'huggingface', label: 'Hugging Face', icon: ExternalLink },
    { id: 'downloads', label: 'Downloads', icon: downloading ? LoaderCircle : Download, busy: downloading },
    { id: 'language', label: 'Language', icon: Wand2 },
  ];
  const installed = library?.models.filter(model => model.installed) || [];
  const actionClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi disabled:cursor-default disabled:opacity-50';

  function modelList(models: LibraryModel[]) {
    return <div className="mt-3 divide-y divide-line">{models.map(model => <article key={model.id} data-model-id={model.id} className="flex flex-col gap-4 py-5 @xl:flex-row @xl:items-start @xl:gap-6">
      <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium">{model.name}</h3><p className="mt-1 break-words text-xs text-ink-2">{model.family}{model.license ? ` · ${model.license}` : ''}</p>
        {model.description && <p className="mt-2 max-w-[65ch] break-words text-sm leading-relaxed text-ink-2">{model.description}</p>}
        {!model.downloadable && !model.installed && <p className="mt-2 break-words text-xs leading-relaxed text-ink-2">{model.unavailableReason || 'This model is not available for automatic download.'}</p>}
      </div>
      <div className="shrink-0 @xl:pt-1">{model.enabled ? <span className="inline-flex min-h-11 items-center gap-2 text-sm text-volt"><Check size={16} />Ready to use</span>
        : <button disabled={busy || (!model.installed && !model.downloadable)} onClick={() => void (model.installed ? activate(model) : download({ modelId: model.id }, model.id))} className={actionClass}>
          {submitting === model.id || (downloading && downloadState?.modelId === model.id) ? <LoaderCircle size={15} className="animate-spin" /> : model.installed ? null : <Download size={15} />}
          {model.installed ? 'Use model' : downloading && downloadState?.modelId === model.id ? 'Downloading…' : 'Download'}
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
      {!library ? !error && <p role="status" className="mt-5 text-sm text-ink-2">Loading models…</p> : library.models.length ? modelList(library.models) : <div className="mt-6"><p className="mb-4 text-sm text-ink-2">No models in the library yet.</p><button type="button" className={actionClass} onClick={() => openSection('huggingface')}>Add from Hugging Face</button></div>}
    </div>
    <div hidden={section !== 'installed'} id="models-panel-installed" role="tabpanel" aria-labelledby="models-tab-installed" tabIndex={0}>
      <h2 className="text-lg font-medium">Installed models</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">Models with all required files downloaded. Activate a model to make it available in Image.</p>
      {!library ? !error && <p role="status" className="mt-5 text-sm text-ink-2">Loading installed models…</p> : installed.length ? modelList(installed) : <div className="mt-6"><p className="mb-4 text-sm text-ink-2">No models installed yet. Choose a model from the library to get started.</p><button type="button" className={actionClass} onClick={() => openSection('library')}>Browse library</button></div>}
    </div>
    <div hidden={section !== 'huggingface'} id="models-panel-huggingface" role="tabpanel" aria-labelledby="models-tab-huggingface" tabIndex={0}>
      <h2 id="huggingface-title" className="text-lg font-medium">Add from Hugging Face</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">Paste a public checkpoint file link. SDXL and Illustrious checkpoints are supported.</p>
      <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); void download({ url: url.trim(), name: name.trim(), familyId: 'sdxl' }, 'huggingface'); }}>
        <label className="field">Checkpoint URL<input type="url" name="checkpoint-url" required disabled={busy} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://huggingface.co/owner/model/blob/main/model.safetensors" /></label>
        <div className="grid items-end gap-4 @xl:grid-cols-[minmax(0,1fr)_auto]"><label className="field">Display name<input name="checkpoint-name" required maxLength={120} disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="My checkpoint" /></label><button disabled={busy || !url.trim() || !name.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-volt px-5 text-sm font-semibold text-on-volt disabled:opacity-50">{submitting === 'huggingface' ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}Download checkpoint</button></div>
      </form>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">Only public .safetensors files are supported here. For other families, use the Library tab.</p>
    </div>
    <div hidden={section !== 'downloads'} id="models-panel-downloads" role="tabpanel" aria-labelledby="models-tab-downloads" tabIndex={0}>
      <h2 className="text-lg font-medium">Downloads</h2><p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Your current or most recent model download.</p>
      {!library ? !error && <p role="status" className="text-sm text-ink-2">Loading download status…</p> : !downloadState ? <div><p className="mb-4 text-sm text-ink-2">No downloads yet.</p><button type="button" className={actionClass} onClick={() => openSection('library')}>Browse library</button></div> : <section aria-label="Model download" aria-live="polite">
        <div className="flex items-start gap-3">{downloading ? <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-ink-2" /> : downloadState.status === 'succeeded' ? <Check size={18} className="mt-0.5 shrink-0 text-volt" /> : null}<div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{downloadState.modelName}</p><p className={`mt-1 break-words text-xs leading-relaxed ${downloadState.status === 'failed' ? 'text-[#ffc3aa]' : 'text-ink-2'}`}>{downloadState.status === 'failed' ? downloadState.error || 'Download failed. You can try again from Library or Hugging Face.' : downloadState.stage}</p></div></div>
        {downloading && <><progress aria-label={`Downloading ${downloadState.modelName}`} value={progress ?? undefined} max={100} className="mt-4 h-1.5 w-full accent-volt" /><p className="mt-2 break-all text-xs tabular-nums text-ink-2">{downloadState.filename ? `${downloadState.filename} · ` : ''}{size(downloadState.receivedBytes)}{downloadState.totalBytes ? ` / ${size(downloadState.totalBytes)}` : ''} · File {Math.min(downloadState.completedFiles + 1, downloadState.totalFiles)} of {downloadState.totalFiles}</p><p className="mt-2 text-xs text-ink-2">You can close this panel while the download continues.</p></>}
        {!downloading && <button type="button" className={`${actionClass} mt-5`} onClick={() => openSection(downloadState.status === 'succeeded' ? 'installed' : 'library')}>{downloadState.status === 'succeeded' ? 'View installed models' : 'Browse library'}</button>}
      </section>}
    </div>
  </TabbedWorkspace>;
}
