'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, type Job } from './api';

export const favoriteKey = (jobId: string, outputId: string) => `${jobId}:${outputId}`;
type Failure = { job: Job; output: Job['outputs'][number]; message: string };

export function useFavorites(ownerId: string | null, onSessionExpired: () => void) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const owner = useRef(ownerId);
  owner.current = ownerId;
  const version = useRef(0);
  const reading = useRef<AbortController | null>(null);
  const writes = useRef(new Map<string, AbortController>());

  const refresh = useCallback(async () => {
    if (!ownerId || writes.current.size || (reading.current && !reading.current.signal.aborted)) return;
    const controller = new AbortController();
    reading.current = controller;
    const revision = ++version.current;
    try {
      const result = await api<{ jobs: Job[] }>('/favorites', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (owner.current !== ownerId || controller.signal.aborted || revision !== version.current) return;
      setJobs(result.jobs); setReady(true); setLoadError('');
    } catch (error) {
      if (owner.current !== ownerId || controller.signal.aborted || revision !== version.current) return;
      setLoadError(errorMessage(error));
      if ((error as { status?: number }).status === 401) onSessionExpired();
    } finally { if (reading.current === controller) reading.current = null; }
  }, [ownerId, onSessionExpired]);

  useEffect(() => {
    setJobs([]); setReady(false); setLoadError(''); setFailure(null); setPending(new Set());
    if (!ownerId) return;
    void refresh();
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    const interval = setInterval(wake, 3000);
    document.addEventListener('visibilitychange', wake);
    return () => {
      version.current++;
      reading.current?.abort();
      for (const controller of writes.current.values()) controller.abort();
      writes.current.clear();
      clearInterval(interval); document.removeEventListener('visibilitychange', wake);
    };
  }, [ownerId, refresh]);

  const toggle = useCallback(async (job: Job, output: Job['outputs'][number]) => {
    const key = favoriteKey(job.id, output.id);
    if (!ownerId || writes.current.has(key)) return;
    const controller = new AbortController();
    writes.current.set(key, controller); version.current++; reading.current?.abort();
    setPending(new Set(writes.current.keys()));
    setFailure(current => current && favoriteKey(current.job.id, current.output.id) === key ? null : current);
    try {
      const result = await api<{ job: Job }>(`/jobs/${encodeURIComponent(job.id)}/outputs/${encodeURIComponent(output.id)}/favorite`, {
        method: 'PUT', body: JSON.stringify({ favorite: !output.favorite }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (owner.current !== ownerId || controller.signal.aborted) return;
      const saved = result.job.outputs.find(entry => entry.id === output.id);
      if (!saved) throw new Error('The image could not be updated. Try again.');
      // Only this output belongs to this response. Another heart may have saved concurrently.
      setJobs(current => {
        const previous = current.find(entry => entry.id === job.id);
        const outputs = (previous?.outputs || []).filter(entry => entry.id !== output.id);
        if (saved.favorite) outputs.push(saved);
        const next = current.filter(entry => entry.id !== job.id);
        if (outputs.length) next.push({ ...result.job, outputs: result.job.outputs.filter(entry => outputs.some(saved => saved.id === entry.id)).map(entry => outputs.find(saved => saved.id === entry.id)!) });
        return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    } catch (error) {
      if (owner.current !== ownerId || controller.signal.aborted) return;
      setFailure({ job, output, message: errorMessage(error) });
      if ((error as { status?: number }).status === 401) onSessionExpired();
    } finally {
      if (writes.current.get(key) === controller) writes.current.delete(key);
      if (owner.current === ownerId && !controller.signal.aborted) {
        setPending(new Set(writes.current.keys()));
        if (!writes.current.size) void refresh();
      }
    }
  }, [ownerId, onSessionExpired, refresh]);

  const forgetOutput = useCallback((jobId: string, outputId: string) => {
    version.current++; reading.current?.abort();
    setJobs(current => current.map(job => job.id === jobId ? { ...job, outputs: job.outputs.filter(output => output.id !== outputId) } : job).filter(job => job.outputs.length));
    setFailure(current => current?.job.id === jobId && current.output.id === outputId ? null : current);
    void refresh();
  }, [refresh]);

  const keys = useMemo(() => new Set(jobs.flatMap(job => job.outputs.map(output => favoriteKey(job.id, output.id)))), [jobs]);
  return { jobs, ready, loading: !ready && !loadError, keys, pending, toggle, forgetOutput,
    error: failure?.message || loadError,
    retry: () => { if (failure) void toggle(failure.job, failure.output); else void refresh(); },
  };
}
