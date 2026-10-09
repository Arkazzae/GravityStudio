import { Cpu, RefreshCw } from '@/components/ui/icons';
import { bytes, type Hardware } from '@/lib/api';
import { Chip } from '@/components/ui/Chip';

export function HardwarePanel({ hardware, onRefresh, refreshing }: { hardware: Hardware | null; onRefresh?: () => void; refreshing?: boolean }) {
  return <section aria-labelledby="hardware-title">
    <div className="mb-5 flex items-center justify-between gap-4"><h2 id="hardware-title" className="text-lg font-medium">Detected hardware</h2>{onRefresh && <Chip onClick={onRefresh} disabled={refreshing} icon={<RefreshCw className={refreshing ? 'animate-spin' : ''} />}>{refreshing ? 'Checking…' : 'Check again'}</Chip>}</div>
    {!hardware ? <p className="text-sm text-ink-2">Hardware information is not available yet.</p> : <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 text-sm sm:grid-cols-3">
        <div><dt className="mb-1.5 text-ink-2">System</dt><dd>{hardware.host.platform} · {hardware.host.architecture}</dd></div>
        <div><dt className="mb-1.5 text-ink-2">CPU threads</dt><dd className="tabular-nums">{hardware.host.logicalCpuCount}</dd></div>
        <div><dt className="mb-1.5 text-ink-2">Available memory</dt><dd className="tabular-nums">{bytes(hardware.host.memory.availableBytes)} / {bytes(hardware.host.memory.totalBytes)}</dd></div>
      </dl>
      <div className="mt-7 divide-y divide-line border-y border-line">
        {hardware.gpus.length ? hardware.gpus.map(gpu => <div key={gpu.id} className="flex items-start gap-4 py-5"><Cpu className="mt-1 size-5 shrink-0 text-ink-2" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{gpu.name}</p><p className="mt-1 text-xs text-ink-2">{gpu.vendor}{gpu.architecture ? ` · ${gpu.architecture}` : ''}{gpu.driverVersion ? ` · Driver ${gpu.driverVersion}` : ''}</p></div><span className="shrink-0 text-sm tabular-nums">{bytes(gpu.memory?.totalBytes)}</span></div>) : <p className="py-5 text-sm leading-relaxed text-ink-2">No GPU was detected on this server. You can still connect a ComfyUI worker running on another machine.</p>}
      </div>
      {hardware.host.container?.detected && <p className="mt-4 text-xs leading-relaxed text-ink-2">The studio is running in a container. This view shows the hardware visible to that container.</p>}
      {hardware.diagnostics?.map((item, index) => <p key={index} className="mt-2 text-xs leading-relaxed text-ink-2">{typeof item === 'string' ? item : item.message}</p>)}
    </>}
  </section>;
}
