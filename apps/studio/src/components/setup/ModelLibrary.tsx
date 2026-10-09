'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, LoaderCircle } from '@/components/ui/icons';
import { api, errorMessage, type LibraryModel, type ModelDownload, type ModelLibraryState } from '@/lib/api';

const downloadBusy = (download?: ModelDownload | null) => !!download && !['succeeded', 'failed'].includes(download.status);
const size = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.round(value / 1024 ** 2)} MB`;

export function ModelLibrary({ onChanged }: { onChanged: () => void }) {
  const [library, setLibrary] = useState<ModelLibraryState | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const load = useCallback(async () => {
    setError('');
    try { setLibrary(await api<ModelLibraryState>('/models/library')); }
    catch (error) { setError(errorMessage(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const downloading = downloadBusy(library?.download);
  useEffect(() => {
    if (!downloading) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<ModelLibraryState>('/models/library');
        if (cancelled) return;
        setLibrary(next); setError('');
        if (downloadBusy(next.download)) timeout = setTimeout(() => void poll(), 1500);
        else onChangedRef.current();
      } catch (error) {
        if (cancelled) return;
        setError(errorMessage(error)); timeout = setTimeout(() => void poll(), 3000);
      }
    }
    timeout = setTimeout(() => void poll(), 500);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [downloading]);

  async function download(body: { modelId: string } | { url: string; name: string; familyId: 'sdxl' }, id: string) {
    setSubmitting(id); setError('');
    try {
      const result = await api<ModelDownload>('/models/download', { method: 'POST', body: JSON.stringify(body) });
      setLibrary(current => current ? { ...current, download: result } : { models: [], download: result });
      if (id === 'huggingface') { setUrl(''); setName(''); }
    } catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(null); }
  }
  async function activate(model: LibraryModel) {
    setSubmitting(model.id); setError('');
    try { setLibrary(await api<ModelLibraryState>('/models/activate', { method: 'POST', body: JSON.stringify({ modelId: model.id }) })); onChangedRef.current(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSubmitting(null); }
  }
  const downloadState = library?.download;
  const progress = downloadState?.totalBytes ? Math.min(100, Math.round(downloadState.receivedBytes / downloadState.totalBytes * 100)) : null;
  const busy = downloading || !!submitting;

  return <div className="@container min-w-0 w-full">
    {error && <p className="error-notice mb-6" role="alert">{error}{!library && <button onClick={() => void load()} className="ml-3 underline">Try again</button>}</p>}
    {downloadState && <section className="mb-7 border-b border-line pb-5" aria-label="Model download" aria-live="polite">
      <div className="flex items-start gap-3">{downloading ? <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-ink-2" /> : downloadState.status === 'succeeded' ? <Check size={18} className="mt-0.5 shrink-0 text-volt" /> : null}<div className="min-w-0 flex-1"><p className="text-sm font-medium">{downloadState.modelName}</p><p className={`mt-1 text-xs leading-relaxed ${downloadState.status === 'failed' ? 'text-[#ffc3aa]' : 'text-ink-2'}`}>{downloadState.status === 'failed' ? downloadState.error || 'Download failed. You can try again.' : downloadState.stage}</p></div></div>
      {downloading && <><progress aria-label={`Downloading ${downloadState.modelName}`} value={progress ?? undefined} max={100} className="mt-4 h-1.5 w-full accent-volt" /><p className="mt-2 break-all text-xs tabular-nums text-ink-2">{downloadState.filename ? `${downloadState.filename} · ` : ''}{size(downloadState.receivedBytes)}{downloadState.totalBytes ? ` / ${size(downloadState.totalBytes)}` : ''} · File {Math.min(downloadState.completedFiles + 1, downloadState.totalFiles)} of {downloadState.totalFiles}</p><p className="mt-2 text-xs text-ink-2">You can close this panel while the download continues.</p></>}
    </section>}
    <section className="border-b border-line pb-7" aria-labelledby="huggingface-title"><h2 id="huggingface-title" className="text-lg font-medium">Add from Hugging Face</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">Paste a public checkpoint file link. SDXL and Illustrious checkpoints are supported.</p>
      <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); void download({ url: url.trim(), name: name.trim(), familyId: 'sdxl' }, 'huggingface'); }}>
        <label className="field">Checkpoint URL<input type="url" name="checkpoint-url" required disabled={busy} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://huggingface.co/owner/model/blob/main/model.safetensors" /></label>
        <div className="grid items-end gap-4 @xl:grid-cols-[minmax(0,1fr)_auto]"><label className="field">Display name<input name="checkpoint-name" required maxLength={120} disabled={busy} value={name} onChange={event => setName(event.target.value)} placeholder="My checkpoint" /></label><button disabled={busy || !url.trim() || !name.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-volt px-5 text-sm font-semibold text-on-volt disabled:opacity-50">{submitting === 'huggingface' ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}Download checkpoint</button></div>
      </form>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">Only public .safetensors files are supported here. For other families, use the models in the library below.</p>
    </section>
    <section className="mt-7" aria-labelledby="library-title"><h2 id="library-title" className="text-lg font-medium">Model library</h2>
      {!library ? <p role="status" className="mt-5 text-sm text-ink-2">Loading models…</p> : !library.models.length ? <p className="mt-5 text-sm text-ink-2">Add a checkpoint from Hugging Face above.</p> : <div className="mt-3 divide-y divide-line">{library.models.map(model => <article key={model.id} className="flex flex-col gap-4 py-5 @xl:flex-row @xl:items-start @xl:gap-6"><div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{model.name}</h3><p className="mt-1 text-xs text-ink-2">{model.family}{model.license ? ` · ${model.license}` : ''}</p>{model.description && <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-ink-2">{model.description}</p>}{!model.downloadable && !model.installed && <p className="mt-2 text-xs leading-relaxed text-ink-2">{model.unavailableReason || 'This model is not available for automatic download.'}</p>}</div><div className="shrink-0 @xl:pt-1">{model.enabled ? <span className="inline-flex min-h-11 items-center gap-2 text-sm text-volt"><Check size={16} />Ready to use</span> : <button disabled={busy || (!model.installed && !model.downloadable)} onClick={() => void (model.installed ? activate(model) : download({ modelId: model.id }, model.id))} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi disabled:cursor-default disabled:opacity-50">{submitting === model.id || (downloading && downloadState?.modelId === model.id) ? <LoaderCircle size={15} className="animate-spin" /> : model.installed ? null : <Download size={15} />}{model.installed ? 'Use model' : downloading && downloadState?.modelId === model.id ? 'Downloading…' : 'Download'}</button>}</div></article>)}</div>}
    </section>

  </div>;
}
