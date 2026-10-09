'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, ExternalLink, LoaderCircle, RefreshCw } from '@/components/ui/icons';
import { api, bytes, errorMessage } from '@/lib/api';
import type { LocalTextStatus, TextModel } from '@/lib/text-api';

const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-chip px-4 text-sm font-medium hover:bg-chip-hi disabled:cursor-default disabled:opacity-50';
const sameIds = (left: string[], right: string[]) => left.length === right.length && left.every(id => right.includes(id));

export function LocalTextRuntime({ onModelChange, disabled = false, active = true }: { onModelChange: (model: TextModel | null) => void; disabled?: boolean; active?: boolean }) {
  const [status, setStatus] = useState<LocalTextStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const edited = useRef(false);
  const editRevision = useRef<number | null>(null);
  const modelCallback = useRef(onModelChange);
  modelCallback.current = onModelChange;
  const lastModel = useRef<string | null>(null);

  const accept = useCallback((next: LocalTextStatus, resetDraft = false) => {
    setStatus(next);
    if (resetDraft || !edited.current) {
      setAutomatic(next.gpuIds.length === 0);
      setSelected(next.gpuIds.length ? next.gpuIds : next.gpus.filter(gpu => gpu.supported).map(gpu => gpu.id));
      edited.current = false; editRevision.current = null;
    }
    const available = next.ready ? JSON.stringify([next.model.id, next.model.name, next.model.contextTokens]) : null;
    if (available !== lastModel.current) {
      lastModel.current = available;
      modelCallback.current(next.ready ? { id: next.model.id, name: next.model.name, inputTokenLimit: next.model.contextTokens } : null);
    }
  }, []);

  const refresh = useCallback(async (resetDraft = false, silent = false) => {
    if (write.current || read.current) return;
    const controller = new AbortController(); read.current = controller;
    try {
      const next = await api<LocalTextStatus>('/text/local', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!controller.signal.aborted && mounted.current) { accept(next, resetDraft); if (!silent) setError(''); }
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) setError(current => silent && current ? current : errorMessage(failure));
    } finally {
      if (read.current === controller) read.current = null;
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; read.current?.abort(); write.current?.abort(); read.current = null; write.current = null; };
  }, []);
  useEffect(() => {
    if (active) void refresh(false, true);
    return () => { read.current?.abort(); read.current = null; };
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !status || !status.busy && !status.ready || mutating) return;
    let polling = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(false, true); if (polling) timer = setTimeout(() => void poll(), status.busy ? 1500 : 5000); };
    timer = setTimeout(() => void poll(), status.busy ? 1500 : 5000);
    return () => { polling = false; clearTimeout(timer); read.current?.abort(); read.current = null; };
  }, [active, status?.busy, status?.ready, mutating, refresh]);

  const selectedIds = automatic ? [] : selected;
  const dirty = !!status && !sameIds(selectedIds, status.gpuIds);
  const usableGpu = !!status?.gpus.some(gpu => gpu.supported && (automatic || selected.includes(gpu.id)));
  const busy = disabled || loading || mutating || !!status?.busy;
  useEffect(() => { if (status && !dirty) { edited.current = false; editRevision.current = null; } }, [dirty, status]);

  function edit() {
    if (!edited.current) editRevision.current = status?.revision ?? null;
    edited.current = true;
    setNotice(''); setError('');
  }

  async function run(action: 'prepare' | 'save' | 'unload') {
    if (!status || busy || write.current || action !== 'unload' && !usableGpu) return;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    setMutating(true); setError(''); setNotice('');
    try {
      if (dirty && action !== 'unload') {
        const next = await api<LocalTextStatus>('/text/local', { method: 'PUT', signal: controller.signal, body: JSON.stringify({ revision: editRevision.current ?? status.revision, gpuIds: selectedIds }) });
        if (controller.signal.aborted || !mounted.current) return;
        accept(next, true);
      }
      if (action === 'prepare' || action === 'unload') {
        const next = await api<LocalTextStatus>(action === 'unload' ? '/text/local/unload' : '/text/local', { method: 'POST', signal: controller.signal, body: JSON.stringify(action === 'unload' ? {} : { modelId: status.model.id }) });
        if (controller.signal.aborted || !mounted.current) return;
        accept(next, action === 'prepare');
      } else setNotice('GPU selection saved. It will be used for the next request.');
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) setError(errorMessage(failure));
    } finally {
      if (write.current === controller) write.current = null;
      if (!controller.signal.aborted && mounted.current) setMutating(false);
    }
  }

  if (!status) return <div className="py-3">{loading ? <p role="status" className="flex items-center gap-2 text-sm text-ink-2"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />Checking local language models…</p>
    : <p role="alert" className="error-notice">{error || 'Local model information is unavailable.'}<button type="button" className="ml-3 underline" onClick={() => { setLoading(true); void refresh(); }}>Try again</button></p>}</div>;

  const progress = status.download?.totalBytes ? Math.min(100, Math.max(0, status.download.receivedBytes / status.download.totalBytes * 100)) : undefined;
  const currentGpu = status.gpus.find(gpu => gpu.id === status.gpuId);
  return <section aria-label="Local language model" className="space-y-6">
    <article className="border-y border-line py-5">
      <h3 className="break-words text-sm font-medium">{status.model.name}</h3>
      <p className="mt-2 break-words text-xs leading-relaxed text-ink-2">{status.model.quantization} · {bytes(status.model.sizeBytes)} · {status.model.contextTokens.toLocaleString('en-US')} token context</p>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">Loads when needed and stays in memory while space allows. Idle models unload when another task needs the memory.</p>
      <a href={status.model.source} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs text-ink-2 underline underline-offset-4 hover:text-ink">{status.model.license} · View model<ExternalLink size={13} /></a>
      {status.ready && !status.busy && status.phase !== 'failed' && <p className="mt-4 flex items-center gap-2 text-sm text-volt"><Check size={16} />{status.phase === 'loaded' ? `Loaded${currentGpu ? ` on GPU ${status.gpus.indexOf(currentGpu) + 1}` : ' in GPU memory'}` : 'Ready to use'}</p>}
      {status.busy && <p role="status" className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-ink-2"><LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" /><span>{status.message || 'Preparing the local model…'}{currentGpu ? ` · ${currentGpu.name}` : ''}</span></p>}
      {status.download && <div className="mt-4"><progress aria-label={`Downloading ${status.model.name}`} max={100} value={progress} className="h-1.5 w-full accent-volt" /><p className="mt-2 text-xs tabular-nums text-ink-2">{bytes(status.download.receivedBytes)} / {bytes(status.download.totalBytes)}</p></div>}
      {status.busy && ['downloading', 'preparing'].includes(status.phase) && <p className="mt-3 text-xs leading-relaxed text-ink-2">You can close this panel. Setup will continue on the server.</p>}
      {!status.ready && <button type="button" disabled={busy || !usableGpu} onClick={() => void run('prepare')} className={`${button} mt-5 !bg-volt !text-on-volt`}>{mutating || status.busy ? <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" /> : <Download size={15} />}{mutating || status.busy ? 'Preparing model…' : status.phase === 'failed' ? 'Retry setup' : status.installed ? 'Prepare model' : 'Download model'}</button>}
      {(status.phase === 'loaded' || status.phase === 'failed' && !!status.gpuId) && <button type="button" disabled={busy} onClick={() => void run('unload')} className={`${button} mt-4`}>{status.phase === 'failed' ? 'Retry unload' : 'Unload from GPU'}</button>}
    </article>

    <fieldset disabled={busy} className="min-w-0">
      <legend className="mb-4 text-sm font-medium">GPUs for the local assistant</legend>
      <label className="flex cursor-pointer items-start gap-3"><input type="checkbox" aria-label="Use Studio GPUs automatically" checked={automatic} onChange={event => { edit(); setAutomatic(event.target.checked); }} className="mt-0.5 size-[18px] shrink-0 accent-volt" /><span className="min-w-0 text-sm leading-relaxed">Use Studio GPUs automatically<span className="mt-1 block text-xs leading-relaxed text-ink-2">Chooses one of the GPUs enabled for image generation. Before image setup, all compatible GPUs are available.</span></span></label>
      {!automatic && <div className="mt-4 divide-y divide-line border-y border-line">{status.gpus.length ? status.gpus.map((gpu, index) => <label key={gpu.id} className={`flex cursor-pointer items-start gap-3 py-4 ${!gpu.supported ? 'opacity-60' : ''}`}>
        <input type="checkbox" name="local-text-gpu" value={gpu.id} checked={selected.includes(gpu.id)} disabled={!gpu.supported && !selected.includes(gpu.id)} onChange={event => { edit(); setSelected(current => event.target.checked ? [...current, gpu.id] : current.filter(id => id !== gpu.id)); }} className="mt-1 size-[18px] shrink-0 accent-volt" />
        <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">GPU {index + 1} · {gpu.name}</span><span className="mt-1 block break-words text-xs leading-relaxed text-ink-2">{bytes(gpu.memoryBytes)} VRAM{gpu.pciAddress ? ` · PCI ${gpu.pciAddress}` : ''}{gpu.reason ? ` · ${gpu.reason}` : ''}</span></span>
      </label>) : <p className="py-4 text-sm leading-relaxed text-ink-2">No GPUs were detected on this server.</p>}</div>}
      {!automatic && !!status.gpus.length && <p className="mt-3 text-xs leading-relaxed text-ink-2">Studio chooses one selected GPU when it loads the model.</p>}
      {!usableGpu && <p className="mt-4 text-xs leading-relaxed text-ink-2">{automatic ? 'No compatible GPU is available for this model.' : 'Select at least one compatible GPU.'}</p>}
      {dirty && status.ready && <button type="button" disabled={!usableGpu} onClick={() => void run('save')} className={`${button} mt-4`}>Apply GPU selection</button>}
      {dirty && !status.ready && <p className="mt-3 text-xs leading-relaxed text-ink-2">Your GPU selection will be saved when setup starts.</p>}
    </fieldset>
    {notice && <p role="status" className="text-xs leading-relaxed text-ink-2">{notice}</p>}
    {error || status.error ? <p role="alert" className="error-notice">{error || status.error}<button type="button" disabled={busy} className="ml-3 underline" onClick={() => void refresh(true)}>Reload local settings</button></p> : null}
    {!status.busy && <button type="button" disabled={busy} className="inline-flex min-h-10 items-center gap-2 text-xs text-ink-2 hover:text-ink disabled:opacity-50" onClick={() => void refresh()}><RefreshCw size={14} />Refresh local status</button>}
  </section>;
}
