'use client';

import { useEffect, useRef, useState } from 'react';
import { Background, LoaderCircle } from '@/components/ui/icons';
import { Popover } from '@/components/ui/Popover';
import { api, errorMessage, type BackgroundRemovalStatus, type Job, type UpscaleSource } from '@/lib/api';
import type { UpscaleActions } from './UpscaleAction';

export function BackgroundRemovalAction({ source, actions, onReady }: { source: UpscaleSource; actions: UpscaleActions; onReady: () => void }) {
  const [status, setStatus] = useState<BackgroundRemovalStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reading = useRef<AbortController | null>(null), writing = useRef<AbortController | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const latest = useRef(actions); latest.current = actions;
  useEffect(() => () => { reading.current?.abort(); writing.current?.abort(); latest.current.onBusyChange(false); }, []);

  async function load() {
    reading.current?.abort(); const controller = new AbortController(); reading.current = controller;
    setLoading(true); setError('');
    try {
      const result = await api<BackgroundRemovalStatus>('/background-removal', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (!controller.signal.aborted) setStatus(result);
    } catch (failure) {
      if (!controller.signal.aborted) { setError(errorMessage(failure)); if ((failure as { status?: number }).status === 401) latest.current.onSessionExpired(); }
    } finally { if (reading.current === controller) { reading.current = null; if (!controller.signal.aborted) setLoading(false); } }
  }
  async function submit(close: () => void) {
    if (!status?.ready || loading || writing.current || actions.busy) return;
    const controller = new AbortController(); writing.current = controller;
    setBusy(true); setError(''); latest.current.onBusyChange(true);
    const body = JSON.stringify({ source });
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    try {
      const result = await api<{ job: Job }>('/background-removal', { method: 'POST', headers: { 'Idempotency-Key': attempt.current.key }, body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
      if (controller.signal.aborted) return;
      attempt.current = null; latest.current.onSubmitted(result.job); close(); onReady();
    } catch (failure) {
      if (!controller.signal.aborted) { setError(errorMessage(failure)); if ((failure as { status?: number }).status === 401) latest.current.onSessionExpired(); }
    } finally { if (writing.current === controller) { writing.current = null; latest.current.onBusyChange(false); if (!controller.signal.aborted) setBusy(false); } }
  }
  return <div data-photo-action>
    <Popover label="Remove background" width={320} side="top" trigger={({ open, triggerProps }) => <button {...triggerProps} type="button" disabled={busy || actions.busy} onClick={() => { if (!open) void load(); }} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-white/[0.06] text-[14px] font-medium text-ink transition-colors hover:bg-white/[0.11] disabled:opacity-50"><Background className="size-[18px]" />Remove background</button>}>
      {close => <div className="flex flex-col gap-3 p-1.5">
        <div><h2 className="text-[16px] font-semibold">Remove background</h2><p className="mt-1 text-[12px] leading-5 text-ink-2">Create a transparent copy with BiRefNet. The original image stays in your assets.</p></div>
        {loading ? <p role="status" className="text-[12px] text-ink-2">Checking background removal…</p> : status && !status.ready && <p role="status" className="text-[12px] leading-5 text-ink-2">{status.missingReasons.join(' ') || (actions.onManage ? 'Download BiRefNet in Models → Tools and connect a worker.' : 'Ask your administrator to enable background removal.')}</p>}
        {error && <p role="alert" className="error-notice text-xs">{error}{!status && <button type="button" onClick={() => void load()} className="ml-2 underline">Try again</button>}</p>}
        <button type="button" disabled={busy || actions.busy || loading || !status?.ready} onClick={() => void submit(close)} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-volt text-[14px] font-semibold text-on-volt hover:bg-volt-hi disabled:opacity-50">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Background className="size-4" />}{busy ? 'Queuing removal…' : 'Create transparent copy'}</button>
        {actions.onManage && <button type="button" disabled={busy} onClick={() => { close(); onReady(); actions.onManage?.(); }} className="min-h-9 text-left text-[12px] text-ink-2 underline underline-offset-4 hover:text-ink disabled:opacity-50">Manage image tools</button>}
      </div>}
    </Popover>
  </div>;
}
