'use client';
import { Cpu, Settings } from '@/components/ui/icons';
import { IconChip } from '@/components/ui/Chip';
import { Popover } from '@/components/ui/Popover';
import { bytes, type StudioState } from '@/lib/api';
import { ResolveJobButton } from './ResolveJobButton';
import styles from './ServerActivity.module.css';

export function ServerActivity({ state, connected, onRefresh, onSettings }: { state: StudioState | null; connected: boolean; onRefresh: () => void; onSettings: () => void }) {
  const pending = state?.jobs.filter(job => ['queued', 'preparing', 'running'].includes(job.status)) || [];
  const interrupted = state?.jobs.filter(job => job.status === 'interrupted') || [];
  const running = pending.filter(job => job.status !== 'queued');
  const enabledWorkers = state?.workers.filter(worker => worker.enabled) || [];
  const unavailableWorkers = enabledWorkers.filter(worker => worker.connected === false);
  const status = !connected ? 'offline' : interrupted.length || unavailableWorkers.length ? 'attention' : running.length ? 'running' : pending.length ? 'queued' : 'idle';
  const moving = connected && pending.length > 0;
  const summary = !connected ? 'Server disconnected' : pending.length ? `${running.length} generating · ${pending.length - running.length} queued` : interrupted.length ? `${interrupted.length} interrupted job${interrupted.length === 1 ? '' : 's'}` : unavailableWorkers.length ? 'Worker connection needs attention' : enabledWorkers.length ? 'Ready to generate' : 'No workers configured';
  const label = `Server activity: ${summary}${connected && pending.length && interrupted.length ? ` · ${interrupted.length} interrupted` : ''}`;

  return <Popover label="Server activity" title="Server" width={350} side="bottom" align="end" trigger={({ open, triggerProps }) => <IconChip {...triggerProps} active={open} data-server-activity data-state={status} aria-label={label} title={label} className="rounded-lg">
    <span aria-hidden="true" className={styles.meter} data-state={status} data-moving={moving}>
      <span /><span /><span /><span />
    </span>
    {pending.length > 0 && <span aria-hidden="true" className="absolute right-0.5 top-0 rounded bg-void px-0.5 text-[9px] leading-3 tabular-nums text-volt">{pending.length > 9 ? '9+' : pending.length}</span>}
  </IconChip>}>
    {close => <div className="px-2 pb-2 text-sm">
      <p className="mb-3 text-xs text-ink-2" role="status">{summary}</p>
      {!!pending.length && <div className="mb-3 max-h-48 overflow-y-auto">{pending.map(job => <div key={job.id} className="border-t border-line py-3">
        <p className="truncate text-xs">{job.prompt}</p>
        <div className="mt-1 flex justify-between gap-3 text-[11px] text-ink-2"><span>{job.stage || (job.status === 'queued' ? 'Waiting in queue' : job.status === 'preparing' ? 'Loading model' : 'Generating')}</span>{job.status === 'running' && job.progress != null && <span className="tabular-nums">{Math.round(job.progress * 100)}%</span>}</div>
        {job.status === 'running' && job.progress != null && <progress aria-label="Generation progress" max={1} value={job.progress} className="mt-2 block h-1 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-chip [&::-webkit-progress-value]:bg-volt [&::-moz-progress-bar]:bg-volt" />}
      </div>)}</div>}
      {interrupted.map(job => <div key={job.id} className="border-t border-line py-3"><p className="line-clamp-2 text-xs leading-relaxed">{job.prompt}</p><p className="mt-1 text-xs text-ink-2">Connection uncertain</p><ResolveJobButton job={job} onChange={onRefresh} /></div>)}
      {unavailableWorkers.map(worker => <p key={worker.id} className="border-t border-line py-3 text-xs text-[#ffc3aa]">{worker.name}: unavailable</p>)}
      {state?.hardware ? <>
        <div className="flex justify-between gap-3 border-t border-line py-3 text-xs"><span className="text-ink-2">Available RAM</span><span className="tabular-nums">{bytes(state.hardware.host.memory.availableBytes)} / {bytes(state.hardware.host.memory.totalBytes)}</span></div>
        {state.hardware.gpus.map(gpu => <div key={gpu.id} className="flex items-center gap-3 border-t border-line py-3"><Cpu className="size-4 shrink-0 text-ink-2" /><span className="min-w-0 flex-1 truncate text-xs">{gpu.name}</span><span className="text-xs tabular-nums text-ink-2">{bytes(gpu.memory?.totalBytes)}</span></div>)}
      </> : <p className="text-xs text-ink-2">Hardware information is unavailable.</p>}
      <button type="button" onClick={() => { close(); onSettings(); }} className="mt-3 inline-flex items-center gap-2 text-xs text-ink-2 hover:text-ink"><Settings size={14} />Settings</button>
    </div>}
  </Popover>;
}
