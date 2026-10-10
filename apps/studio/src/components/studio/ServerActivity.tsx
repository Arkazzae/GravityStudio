'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Cpu, LoaderCircle, RefreshCw, X } from '@/components/ui/icons';
import { IconChip } from '@/components/ui/Chip';
import { api, bytes, errorMessage, type Hardware, type Job, type StudioState } from '@/lib/api';
import type { LocalTextStatus } from '@/lib/text-api';
import { useAnchoredPopover } from '@/lib/useAnchoredPopover';
import { ResolveJobButton } from './ResolveJobButton';
import styles from './ServerActivity.module.css';

const gib = 1024 ** 3;
const number = (value: number) => (value / gib).toLocaleString('en-US', { maximumFractionDigits: 1 });
const known = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value >= 0;
const residentPhases = new Set(['loaded', 'loading', 'running', 'stopping', 'failed']);
type ActivityWorker = StudioState['workers'][number];

export function ServerActivity({ state, connected, connectionError = '', onRefresh }: { state: StudioState | null; connected: boolean; connectionError?: string; onRefresh: () => void | Promise<void> }) {
  const { open, close, triggerProps, popoverProps } = useAnchoredPopover({ width: 368, side: 'bottom', align: 'end' });
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [requested, setRequested] = useState<string[]>([]);
  const [localText, setLocalText] = useState<LocalTextStatus | null>(null);
  const [textError, setTextError] = useState('');
  const [pollRevision, setPollRevision] = useState(0);
  const refreshingRef = useRef(false);
  const action = useRef<AbortController | null>(null);
  const textRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; action.current?.abort(); }; }, []);
  useEffect(() => { if (!open) setRequested([]); }, [open]);
  useEffect(() => {
    setRequested(previous => previous.filter(id => state?.workers.find(worker => worker.id === id)?.status !== 'busy'));
  }, [state?.workers]);
  useEffect(() => {
    if (!open || !connected) { setLocalText(null); setTextError(''); return; }
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    setLocalText(null); setTextError('');
    async function poll() {
      const controller = new AbortController();
      textRequest.current = controller;
      try {
        const result = await api<LocalTextStatus>('/text/local', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (active && !controller.signal.aborted) { setLocalText(result); setTextError(''); }
      } catch (error) {
        if (active && !controller.signal.aborted) { setLocalText(null); setTextError(`Local assistant status unavailable. ${errorMessage(error)}`); }
      } finally {
        if (textRequest.current === controller) textRequest.current = null;
        if (active) timer = setTimeout(() => void poll(), 3_000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); textRequest.current?.abort(); textRequest.current = null; };
  }, [open, connected, pollRevision]);

  const pending = connected ? (state?.jobs.filter(job => ['queued', 'preparing', 'running'].includes(job.status)) || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  const interrupted = connected ? state?.jobs.filter(job => job.status === 'interrupted') || [] : [];
  const running = pending.filter(job => job.status !== 'queued');
  const queuedIds = pending.filter(job => job.status === 'queued').map(job => job.id);
  const enabledWorkers = connected ? state?.workers.filter(worker => worker.enabled) || [] : [];
  const unavailableWorkers = enabledWorkers.filter(worker => worker.connected === false);
  const hasResidentText = !!localText?.gpuId && residentPhases.has(localText.phase) && !textError;
  const textActive = open && hasResidentText && (localText?.phase === 'loading' || localText?.phase === 'running');
  const status = !connected ? 'offline' : connectionError || interrupted.length || unavailableWorkers.length ? 'attention' : running.length || textActive ? 'running' : pending.length ? 'queued' : 'idle';
  const moving = connected && (pending.length > 0 || !!textActive);
  const summary = !connected ? 'Server disconnected' : connectionError ? 'Server connection needs attention' : pending.length ? `${running.length} generating · ${pending.length - running.length} queued` : textActive ? 'Assistant working' : interrupted.length ? `${interrupted.length} interrupted job${interrupted.length === 1 ? '' : 's'}` : unavailableWorkers.length ? 'Worker connection needs attention' : enabledWorkers.length ? 'Ready to generate' : 'No workers configured';
  const label = `Server activity: ${summary}${connected && pending.length && interrupted.length ? ` · ${interrupted.length} interrupted` : ''}`;
  const gpus = connected ? state?.hardware?.gpus || [] : [];
  const workersOn = (id: string) => enabledWorkers.filter(worker => worker.location === 'local' && worker.deviceIds.includes(id));
  const otherWorkers = enabledWorkers.filter(worker => worker.location !== 'local' || !worker.deviceIds.some(id => gpus.some(gpu => gpu.id === id)));

  async function refresh() {
    if (refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true); setActionError('');
    if (open && connected) setPollRevision(value => value + 1);
    try { await onRefresh(); }
    catch (error) { if (mounted.current) setActionError(errorMessage(error)); }
    finally { refreshingRef.current = false; if (mounted.current) setRefreshing(false); }
  }
  async function runAction(key: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller; setActing(key); setActionError('');
    try {
      await operation(AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      if (mounted.current) await onRefresh();
    } catch (error) { if (mounted.current && !controller.signal.aborted) setActionError(errorMessage(error)); }
    finally { action.current = null; if (mounted.current) setActing(null); }
  }
  const cancel = (id: string) => runAction(`cancel:${id}`, async signal => {
    await api(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}', signal });
  });
  const release = (id: string) => runAction(`worker:${id}`, async signal => {
    await api(`/workers/${encodeURIComponent(id)}/unload`, { method: 'POST', body: '{}', signal });
    if (mounted.current) setRequested(previous => [...previous, id]);
  });
  const unloadText = () => runAction('text', async signal => {
    textRequest.current?.abort();
    const result = await api<LocalTextStatus>('/text/local/unload', { method: 'POST', body: '{}', signal });
    if (mounted.current) { setLocalText(result); setTextError(''); setPollRevision(value => value + 1); }
  });
  const workerRow = (worker: ActivityWorker) => <WorkerRow key={worker.id} worker={worker} jobs={[...running, ...interrupted].filter(job => job.workerId === worker.id)} acting={acting} requested={requested.includes(worker.id)} onRelease={release} />;
  const textRow = hasResidentText && localText ? <div className={styles.runtime}>
    <div className={styles.runtimeHeading}>
      <span className={styles.runtimeName}>{localText.model.name}</span>
      <span className={styles.runtimeState} data-busy={localText.busy}>{localText.phase === 'loaded' ? 'Loaded' : localText.phase === 'failed' ? 'Needs attention' : localText.phase}</span>
      <button type="button" disabled={localText.busy || acting !== null} onClick={() => void unloadText()} aria-label={`Unload ${localText.model.name}`} title={localText.busy ? 'The assistant can unload after its current request finishes.' : 'Unload the model and clear its context cache. The next response will load it again.'} className={styles.release}>{acting === 'text' ? 'Unloading…' : 'Unload'}</button>
    </div>
    {(localText.busy || localText.error) && <p className={localText.error ? styles.warning : styles.detail}>{localText.error || localText.message}</p>}
  </div> : null;

  return <>
    <IconChip {...triggerProps} active={open} data-server-activity data-state={status} aria-label={label} title={label} aria-haspopup="dialog" className="rounded-lg">
      <span aria-hidden="true" className={styles.meter} data-state={status} data-moving={moving}><span /><span /><span /><span /></span>
      {pending.length > 0 && <span aria-hidden="true" className="absolute right-0.5 top-0 rounded bg-void px-0.5 text-[9px] leading-3 tabular-nums text-volt">{pending.length > 9 ? '9+' : pending.length}</span>}
    </IconChip>
    <div {...popoverProps} role="dialog" aria-label="Server activity" className={styles.popover}>
      <div className={styles.header}>
        <h2>{summary}</h2>
        <button type="button" aria-label="Refresh activity" title="Refresh activity" disabled={refreshing} onClick={() => void refresh()} className={styles.icon}><RefreshCw className={refreshing ? styles.spin : undefined} /></button>
        <button type="button" aria-label="Close activity" title="Close activity" onClick={close} className={styles.icon}><X /></button>
      </div>
      <div className={styles.content}>
        {connectionError && <p role="status" className={styles.warning}>{connectionError}</p>}
        {connected ? <>
          {!!pending.length && <section aria-label="Your generations" className={styles.generations}>
            <h3>Your generations<span>{pending.length}</span></h3>
            <ol className={styles.jobs}>{pending.map(job => <JobRow key={job.id} job={job} position={queuedIds.indexOf(job.id) + 1} acting={acting} onCancel={cancel} />)}</ol>
          </section>}
          {interrupted.map(job => <div key={job.id} className={styles.interrupted}>
            <p className="line-clamp-2 text-xs leading-relaxed">{job.prompt}</p><p className="mt-1 text-xs text-ink-2">Connection uncertain</p>
            <ResolveJobButton job={job} onChange={() => { void refresh(); }} />
          </div>)}
          {gpus.map((gpu, index) => <GpuCard key={gpu.id} gpu={gpu} index={index} busy={workersOn(gpu.id).some(worker => worker.status === 'busy') || !!(hasResidentText && localText?.gpuId === gpu.id && localText.busy)}>
            {workersOn(gpu.id).map(workerRow)}
            {hasResidentText && localText?.gpuId === gpu.id && textRow}
            {!workersOn(gpu.id).length && (!hasResidentText || localText?.gpuId !== gpu.id) && <p className={styles.detail}>No Studio worker assigned</p>}
          </GpuCard>)}
          {!gpus.length && <p className={styles.detail}>No GPU telemetry available yet.</p>}
          {!!otherWorkers.length && <section className={styles.device} aria-label="Other workers"><h3 className={styles.sectionTitle}>Other workers</h3>{otherWorkers.map(workerRow)}</section>}
          {hasResidentText && localText && !gpus.some(gpu => gpu.id === localText.gpuId) && <section className={styles.device} aria-label="Local assistant"><h3 className={styles.sectionTitle}>Local assistant</h3>{textRow}</section>}
          {state?.hardware ? <section className={styles.device} aria-label="System memory">
            <div className={styles.deviceHeading}><h3>System RAM</h3><span className={styles.memoryValue}>{known(state.hardware.host.memory.availableBytes) ? bytes(state.hardware.host.memory.availableBytes) : 'Unavailable'} <small>available</small></span></div>
            <MemoryMeter label="System RAM used" total={state.hardware.host.memory.totalBytes} used={known(state.hardware.host.memory.availableBytes) && known(state.hardware.host.memory.totalBytes) ? Math.max(0, state.hardware.host.memory.totalBytes - state.hardware.host.memory.availableBytes) : null} />
            <p className={styles.detail}>{known(state.hardware.host.memory.totalBytes) ? `${bytes(state.hardware.host.memory.totalBytes)} total` : 'Total RAM unavailable'}</p>
          </section> : <p className={styles.detail}>Hardware information is unavailable.</p>}
          {textError && <p role="status" className={styles.warning}>{textError}</p>}
        </> : <>
          <p className={styles.detail}>{state ? 'Your server stopped answering. Queued and saved jobs stay on the server.' : 'Connect to the Studio server to see its GPUs and loaded models.'}</p>
          <button type="button" disabled={refreshing} onClick={() => void refresh()} className={styles.retry}>{refreshing ? 'Connecting…' : 'Try again'}</button>
        </>}
        {actionError && <p role="alert" className={styles.warning}>{actionError}</p>}
      </div>
    </div>
  </>;
}

function JobRow({ job, position, acting, onCancel }: { job: Job; position: number; acting: string | null; onCancel: (id: string) => void }) {
  const progress = known(job.progress) ? Math.min(1, job.progress) : null;
  const detail = job.stage || (job.status === 'queued' ? 'Waiting in queue' : job.status === 'preparing' ? 'Loading model' : 'Generating');
  return <li className={styles.job}>
    <div className={styles.jobHeading}>
      <span aria-hidden="true" className={styles.position}>{job.status === 'queued' ? position : <LoaderCircle className={styles.spin} />}</span>
      <span className={styles.jobCopy}>
        <span className={styles.prompt} title={job.prompt}>{job.prompt}</span>
        <span className={styles.jobModel}>{job.modelName || job.modelId}{job.status === 'queued' && <> · <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></>}</span>
        <span role="status" className={styles.jobDetail}>{detail}</span>
      </span>
      {job.status === 'running' && progress != null && <span className={styles.progressValue}>{Math.round(progress * 100)}%</span>}
      {job.status === 'queued' && <button type="button" aria-label={`Cancel queued job: ${job.prompt}`} title="Cancel queued job" disabled={acting !== null} onClick={() => onCancel(job.id)} className={styles.icon}>{acting === `cancel:${job.id}` ? <LoaderCircle className={styles.spin} /> : <X />}</button>}
    </div>
    {job.status === 'running' && progress != null && <progress aria-label="Generation progress" max={1} value={progress} className={styles.jobProgress} />}
  </li>;
}

function WorkerRow({ worker, jobs, acting, requested, onRelease }: { worker: ActivityWorker; jobs: Job[]; acting: string | null; requested: boolean; onRelease: (id: string) => void }) {
  const busy = jobs.some(job => ['preparing', 'running'].includes(job.status));
  const uncertain = jobs.some(job => job.status === 'interrupted');
  return <div className={styles.runtime}>
    <div className={styles.runtimeHeading}>
      <span className={styles.runtimeName} title={jobs.length ? jobs.map(job => job.modelName || job.modelId).join(', ') : worker.name}>{jobs.length ? jobs.map(job => job.modelName || job.modelId).join(', ') : worker.name}</span>
      <span className={styles.runtimeState} data-busy={busy}>{worker.connected === false ? 'Unavailable' : uncertain ? 'Needs attention' : busy || worker.status === 'busy' ? 'Working' : 'Idle'}</span>
      {requested ? <span role="status" className={styles.requested}>Release requested</span> : <button type="button" disabled={!worker.canRelease || acting !== null} onClick={() => onRelease(worker.id)} aria-label={`Release cache for ${worker.name}`} title={worker.canRelease ? 'Ask this image worker to release cached model weights. Memory usage updates when the worker releases them.' : 'Cache can be released when this worker is connected and has no active or uncertain generations.'} className={styles.release}>{acting === `worker:${worker.id}` ? 'Releasing…' : 'Release cache'}</button>}
    </div>
    {jobs.map(job => <p key={job.id} className={styles.detail}>{job.stage || (job.status === 'preparing' ? 'Loading model' : job.status === 'interrupted' ? 'Connection uncertain' : 'Generating')}</p>)}
    {worker.connected === false && <p className={styles.warning}>{worker.error || 'Worker connection is unavailable.'}</p>}
    {worker.location === 'remote' && <p className={styles.detail}>Remote worker</p>}
  </div>;
}

function GpuCard({ gpu, index, busy, children }: { gpu: Hardware['gpus'][number]; index: number; busy: boolean; children: ReactNode }) {
  const name = `GPU ${index + 1} · ${gpu.name}`;
  const total = gpu.memory?.totalBytes, used = gpu.memory?.usedBytes;
  return <section className={styles.device} aria-label={name}>
    <div className={styles.deviceHeading}>
      <h3 title={name}><Cpu size={13} /><span>GPU {index + 1}</span><span className={styles.gpuName}>{gpu.name}</span></h3>
      <span className={styles.memoryValue}>{known(used) ? number(used) : '—'} <small>/ {known(total) && total > 0 ? `${number(total)} GB` : 'Unknown'}</small></span>
    </div>
    {gpu.pciAddress && <p className={styles.address}>{gpu.pciAddress}</p>}
    <MemoryMeter label={`${name} memory`} total={total} used={used} busy={busy} />
    {children}
  </section>;
}

function MemoryMeter({ label, total, used, busy = false }: { label: string; total: number | null | undefined; used: number | null | undefined; busy?: boolean }) {
  if (!known(total) || total <= 0 || !known(used)) return <p className={styles.detail}>Memory usage unavailable</p>;
  const measured = Math.min(total, used), percent = measured / total * 100;
  return <div className={styles.memoryMeter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total / gib} aria-valuenow={measured / gib} aria-valuetext={`${number(measured)} of ${number(total)} GB used`}>
    <span data-busy={busy} style={{ width: `${percent}%` }} />
  </div>;
}
