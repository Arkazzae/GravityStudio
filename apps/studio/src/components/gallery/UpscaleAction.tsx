'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, LoaderCircle } from '@/components/ui/icons';
import { Popover } from '@/components/ui/Popover';
import { api, errorMessage, type Job, type UpscaleInput, type UpscalerCard, type UpscaleSource } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface UpscaleActions {
  onSubmitted: (job: Job) => void;
  onManage: () => void;
  onSessionExpired: () => void;
  onBusyChange: (busy: boolean) => void;
}

export function UpscaleAction({ source, width, height, actions, onReady }: {
  source: UpscaleSource;
  width?: number;
  height?: number;
  actions: UpscaleActions;
  onReady: () => void;
}) {
  const [models, setModels] = useState<UpscalerCard[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [scale, setScale] = useState<2 | 4>(2);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const latestActions = useRef(actions); latestActions.current = actions;
  useEffect(() => () => { reading.current?.abort(); writing.current?.abort(); latestActions.current.onBusyChange(false); }, []);
  const installed = models?.filter(model => model.installed) || [];
  const selected = installed.find(model => model.id === modelId) || installed.find(model => model.ready) || installed[0];
  const factor = selected?.scales.includes(scale) ? scale : selected?.scales[0] || scale;
  const tooLarge = !!selected && !!width && !!height && Math.max(width, height) * factor > selected.maxOutputDimension;

  async function load() {
    reading.current?.abort();
    const controller = new AbortController(); reading.current = controller;
    setLoading(true); setError('');
    try {
      const result = await api<{ models: UpscalerCard[] }>('/upscalers', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!controller.signal.aborted) setModels(result.models);
    } catch (failure) {
      if (!controller.signal.aborted) { setError(errorMessage(failure)); if ((failure as { status?: number }).status === 401) latestActions.current.onSessionExpired(); }
    } finally { if (reading.current === controller) { reading.current = null; if (!controller.signal.aborted) setLoading(false); } }
  }
  async function submit(close: () => void) {
    if (!selected?.ready || tooLarge || loading || writing.current) return;
    const controller = new AbortController(); writing.current = controller;
    setBusy(true); setError(''); latestActions.current.onBusyChange(true);
    const input: UpscaleInput = { operation: 'upscale', modelId: selected.id, source, scale: factor };
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') };
    try {
      const result = await api<{ job: Job }>('/upscale', { method: 'POST', headers: { 'Idempotency-Key': attempt.current.key }, body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
      if (controller.signal.aborted) return;
      attempt.current = null; latestActions.current.onSubmitted(result.job); close(); onReady();
    } catch (failure) {
      if (!controller.signal.aborted) { setError(errorMessage(failure)); if ((failure as { status?: number }).status === 401) latestActions.current.onSessionExpired(); }
    } finally {
      if (writing.current === controller) { writing.current = null; latestActions.current.onBusyChange(false); if (!controller.signal.aborted) setBusy(false); }
    }
  }
  return <div data-photo-action>
    <Popover label="Upscale image" width={340} side="top" initialFocus="select, [data-upscale-manage]" trigger={({ open, triggerProps }) =>
      <button {...triggerProps} type="button" aria-label="Upscale image" disabled={busy} onClick={() => { if (!open) void load(); }} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-white/[0.06] text-[14px] font-medium text-ink transition-colors hover:bg-white/[0.11] disabled:opacity-50"><ArrowUp className="size-[18px] rotate-45" />Upscale</button>}>
      {close => <div className="flex flex-col gap-4 p-1.5">
        <div><h2 className="text-[16px] font-semibold">Upscale image</h2><p className="mt-1 text-[12px] leading-5 text-ink-2">A larger image, saved as a new result. Your original stays unchanged.</p></div>
        {loading && <p role="status" className="text-[12px] text-ink-2">Checking upscale models…</p>}
        {selected ? <>
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-2">Upscale model<span className="relative">
            <select aria-label="Upscale model" disabled={busy || loading} value={selected.id} onChange={event => { setModelId(event.target.value); setError(''); }} className="h-12 w-full appearance-none rounded-xl border border-line bg-panel-2 px-3 pr-9 text-[14px] font-medium text-ink focus:outline-volt">
              {installed.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select><ChevronDown className="pointer-events-none absolute right-3 top-4 size-4" /></span>
            <span className="leading-5">{selected.description}</span>
          </label>
          <div role="group" aria-label="Upscale size" className="flex gap-1 rounded-xl bg-panel-2 p-1">{selected.scales.map(value => <button key={value} type="button" aria-pressed={factor === value} disabled={busy || loading || (!!width && !!height && Math.max(width, height) * value > selected.maxOutputDimension)} onClick={() => { setScale(value); setError(''); }} className={cn('h-10 flex-1 rounded-lg text-[14px] font-medium disabled:opacity-35', factor === value ? 'bg-white/10 text-ink' : 'text-ink-2 hover:text-ink')}>{value}×</button>)}</div>
          <p className="text-[12px] tabular-nums text-ink-2">{width && height ? `${width} × ${height} → ${width * factor} × ${height * factor}` : `Maximum output: ${selected.maxOutputDimension} px`}</p>
          {tooLarge && <p className="text-[12px] leading-5 text-ink-2">Choose a smaller scale or image. Maximum output: {selected.maxOutputDimension} px.</p>}
          {!selected.ready && <p className="text-[12px] leading-5 text-ink-2">{selected.missingReasons.join(' ') || 'Connect a ready worker to use this upscaler.'}</p>}
          <button type="button" disabled={busy || loading || tooLarge || !selected.ready} onClick={() => void submit(close)} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-volt text-[14px] font-semibold text-on-volt hover:bg-volt-hi disabled:opacity-50">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4 rotate-45" />}{busy ? 'Queuing upscale…' : `Upscale ${factor}×`}</button>
        </> : !loading && !error && <p className="text-[13px] leading-6 text-ink-2">Download an upscaler in Models to enlarge your images.</p>}
        {error && <p role="alert" className="error-notice text-xs">{error}{!models && <button type="button" onClick={() => void load()} className="ml-2 underline">Try again</button>}</p>}
        <button data-upscale-manage type="button" disabled={busy} onClick={() => { close(); onReady(); actions.onManage(); }} className="min-h-9 text-left text-[12px] text-ink-2 underline underline-offset-4 hover:text-ink disabled:opacity-50">{installed.length ? 'Manage upscalers' : 'Download upscaler'}</button>
      </div>}
    </Popover>
  </div>;
}
