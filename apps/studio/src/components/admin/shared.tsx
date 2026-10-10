'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessage } from '@/lib/api';
import { LoaderCircle, RefreshCw } from '@/components/ui/icons';

export const AdminSession = createContext<() => void>(() => {});
export const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-chip px-4 py-2 text-sm font-medium hover:bg-chip-hi disabled:cursor-default disabled:opacity-50';
export const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-volt px-5 py-2 text-sm font-semibold text-on-volt hover:bg-volt-hi disabled:cursor-default disabled:opacity-50';
export const danger = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-chip border border-[#e8997040] px-4 py-2 text-sm text-[#ffc3aa] hover:bg-[#67412c33] disabled:opacity-50';
export const copy = 'text-sm leading-relaxed text-ink-2';
export const date = (value: string | number | null) => value === null ? '—' : new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function duration(ms: number) { const minutes = Math.floor(Math.abs(ms) / 60_000); return `${ms < 0 ? '−' : ''}${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`; }
export const requestKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

export function useResource<T>(path: string | null, pollMs = 0) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const expired = useContext(AdminSession);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError(''); setData(null);
    async function load() {
      try {
        const result = await api<T>(path!, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
        if (!controller.signal.aborted) { setData(result); setError(''); }
      } catch (failure) {
        if (!controller.signal.aborted) { setError(errorMessage(failure)); if ((failure as { status?: number }).status === 401) expired(); }
      } finally {
        if (!controller.signal.aborted) { setLoading(false); if (pollMs) timer = setTimeout(() => void load(), pollMs); }
      }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [path, revision, pollMs, expired]);
  return { data, error, loading, reload, setData };
}

export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const expired = useContext(AdminSession);
  useEffect(() => () => controller.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const pending = new AbortController(); controller.current = pending;
    setBusy(true); setError(''); setNotice('');
    try { await action(AbortSignal.any([pending.signal, AbortSignal.timeout(60_000)])); }
    catch (failure) { if (!pending.signal.aborted) { setError(errorMessage(failure)); if ((failure as { status?: number }).status === 401) expired(); } }
    finally { if (controller.current === pending) { controller.current = null; if (!pending.signal.aborted) setBusy(false); } }
  }
  return { busy, error, notice, run, setNotice, setError };
}

export function Feedback({ error, notice }: { error?: string; notice?: string }) { return <>{error && <p role="alert" className="error-notice my-4">{error}</p>}{notice && <p role="status" className="my-4 text-sm leading-relaxed text-volt">{notice}</p>}</>; }
export function Heading({ title, children, onRefresh, loading }: { title: string; children: ReactNode; onRefresh?: () => void; loading?: boolean }) { return <header className="mb-7 flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h1 className="text-[26px] font-medium leading-tight tracking-[-.025em]">{title}</h1><p className={`mt-2 max-w-[65ch] ${copy}`}>{children}</p></div>{onRefresh && <button type="button" disabled={loading} onClick={onRefresh} className={button}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} />Refresh</button>}</header>; }
export function Loading({ children = 'Loading…' }: { children?: ReactNode }) { return <p role="status" className="flex items-center gap-2 py-4 text-sm text-ink-2"><LoaderCircle size={16} className="animate-spin" />{children}</p>; }
