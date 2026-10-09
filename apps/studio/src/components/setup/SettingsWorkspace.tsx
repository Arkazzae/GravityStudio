'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Cpu, ExternalLink, HardDrive, Layers2, LoaderCircle, RefreshCw, SlidersHorizontal, Wand2 } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { AdvancedSettings } from './AdvancedSettings';
import { IntegrationsSettings } from './IntegrationsSettings';
import { LanguageModels } from './LanguageModels';
import { TabbedWorkspace } from '@/components/studio/TabbedWorkspace';
import { api, bytes, errorMessage, type Hardware, type RuntimeSetupStatus, type Settings } from '@/lib/api';

const sections = [
  { id: 'gpus', label: 'GPUs', icon: Cpu },
  { id: 'generation', label: 'Generation', icon: SlidersHorizontal },
  { id: 'assistant', label: 'Assistant', icon: Wand2 },
  { id: 'connections', label: 'Connections', icon: HardDrive },
  { id: 'models', label: 'Model files', icon: Layers2 },
  { id: 'integrations', label: 'Integrations', icon: ExternalLink },
  { id: 'api', label: 'API access', icon: ExternalLink },
] as const;
export type SettingsSection = typeof sections[number]['id'];

export function SettingsWorkspace({ initialHardware, onSaved, onFinished, onboarding = false, initialSection = 'gpus' }: { initialHardware: Hardware | null; onSaved: () => void; onFinished: () => void; onboarding?: boolean; initialSection?: SettingsSection }) {
  const [hardware, setHardware] = useState(initialHardware);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSetupStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [advancedVisited, setAdvancedVisited] = useState(false);
  const [integrationsVisited, setIntegrationsVisited] = useState(initialSection === 'integrations');
  const [advancedRevision, setAdvancedRevision] = useState(0);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const load = useCallback(async () => {
    setError('');
    try {
      const [nextSettings, nextRuntime, nextHardware] = await Promise.all([api<Settings>('/settings'), api<RuntimeSetupStatus>('/runtime'), api<Hardware>('/hardware')]);
      setSettings(nextSettings); setRuntime(nextRuntime); setHardware(nextHardware);
      const assigned = nextSettings.workers.filter(worker => worker.enabled && worker.location === 'local').flatMap(worker => worker.deviceIds);
      setSelected(assigned.length ? assigned : nextHardware.gpus.filter(gpu => gpu.vendor === 'amd' || gpu.vendor === 'nvidia').map(gpu => gpu.id));
    } catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (initialHardware) setHardware(initialHardware); }, [initialHardware]);
  useEffect(() => {
    if (!runtime?.busy) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<RuntimeSetupStatus>('/runtime');
        if (cancelled) return;
        if (!next.busy && next.phase === 'ready') {
          const [nextSettings, nextHardware] = await Promise.all([api<Settings>('/settings'), api<Hardware>('/hardware')]);
          if (cancelled) return;
          setSettings(nextSettings); setHardware(nextHardware); setAdvancedRevision(value => value + 1); onSavedRef.current();
        }
        setRuntime(next); setError('');
        if (next.busy) timeout = setTimeout(() => void poll(), 1500);
      } catch (error) {
        if (cancelled) return;
        setError(errorMessage(error));
        timeout = setTimeout(() => void poll(), 3000);
      }
    }
    timeout = setTimeout(() => void poll(), 500);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [runtime?.busy]);

  const busy = starting || !!runtime?.busy;
  const assigned = settings?.workers.filter(worker => worker.enabled && worker.location === 'local').flatMap(worker => worker.deviceIds) || [];
  const changed = selected.length !== new Set(assigned).size || selected.some(id => !assigned.includes(id));
  const ready = runtime?.phase === 'ready' && !changed;
  const connected = ready || !!settings?.workers.some(worker => worker.enabled);

  async function refreshHardware() {
    setChecking(true); setError('');
    try { setHardware(await api<Hardware>('/hardware')); }
    catch (error) { setError(errorMessage(error)); }
    finally { setChecking(false); }
  }
  async function start() {
    if (advancedDirty) return;
    setStarting(true); setError('');
    try {
      const next = await api<RuntimeSetupStatus>('/runtime', { method: 'POST', body: JSON.stringify({ gpuIds: selected }) });
      setRuntime(next);
      if (!next.busy && next.phase === 'ready') { await load(); onSavedRef.current(); }
    } catch (error) { setError(errorMessage(error)); }
    finally { setStarting(false); }
  }

  function selectSection(next: SettingsSection) {
    if (next !== 'gpus' && next !== 'integrations' && next !== 'assistant') setAdvancedVisited(true);
    if (next === 'integrations') setIntegrationsVisited(true);
    setSection(next);
  }
  return <TabbedWorkspace id="settings" label="Settings sections" sections={sections} selected={section} onSelect={selectSection}>
    <div hidden={section !== 'gpus'} role="tabpanel" id="settings-panel-gpus" aria-labelledby="settings-tab-gpus">
    {error && <div className="error-notice mb-6" role="alert">{error}{!settings && <button onClick={() => void load()} className="ml-3 underline">Try again</button>}</div>}
    <section aria-labelledby="gpu-selection-title">
      <div className="mb-5 flex items-center justify-between gap-4"><h2 id="gpu-selection-title" className="text-[15px] font-medium">GPUs to use</h2><Chip disabled={checking || busy} icon={<RefreshCw className={checking ? 'animate-spin' : ''} />} onClick={() => void refreshHardware()}>{checking ? 'Checking…' : 'Refresh'}</Chip></div>
      <p className="mb-5 text-sm leading-relaxed text-ink-2">Select all GPUs you want to use. Studio distributes jobs across them, with one image at a time on each GPU. Different models can run in parallel when memory allows.</p>
      {loading ? <p role="status" className="py-5 text-sm text-ink-2">Detecting your hardware…</p> : hardware?.gpus.length ? <fieldset disabled={busy} className="divide-y divide-line border-y border-line"><legend className="sr-only">GPUs available for generation</legend>{hardware.gpus.map((gpu, index) => {
        const supported = gpu.vendor === 'amd' || gpu.vendor === 'nvidia';
        return <label key={gpu.id} className={`flex cursor-pointer items-start gap-4 py-5 ${!supported ? 'opacity-55' : ''}`}>
          <input type="checkbox" name="runtime-gpu" value={gpu.id} checked={selected.includes(gpu.id)} disabled={!supported} onChange={event => setSelected(current => event.target.checked ? [...current, gpu.id] : current.filter(id => id !== gpu.id))} className="mt-1 size-[18px] shrink-0 accent-volt" />
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">GPU {index + 1} · {gpu.name}</span><span className="mt-1.5 block text-xs leading-relaxed text-ink-2">{bytes(gpu.memory.totalBytes)} VRAM{gpu.pciAddress ? ` · PCI ${gpu.pciAddress}` : ''}{!supported ? ' · Automatic setup is not available' : ''}</span></span>
        </label>;
      })}</fieldset> : <p className="border-y border-line py-5 text-sm leading-relaxed text-ink-2">No GPUs were detected. Refresh after making your GPUs available, or connect an existing ComfyUI installation in Connections.</p>}
      {hardware && <p className="mt-4 text-xs leading-relaxed text-ink-2">{bytes(hardware.host.memory.totalBytes)} system memory · {hardware.host.logicalCpuCount} CPU threads</p>}
      <div className="mt-7 flex flex-wrap items-center gap-4">
        <button disabled={loading || busy || advancedDirty || !selected.length || ready} onClick={() => void start()} className="flex min-h-11 items-center justify-center gap-2 rounded-chip bg-volt px-5 py-3 text-sm font-semibold text-on-volt disabled:cursor-default disabled:opacity-55">{busy ? <LoaderCircle size={16} className="animate-spin" /> : ready ? <Check size={16} /> : null}{busy ? 'Setting up…' : ready ? 'Generation is ready' : runtime?.phase === 'failed' ? 'Try setup again' : assigned.length ? 'Apply GPU selection' : 'Set up generation'}</button>
        {!busy && !ready && !advancedDirty && <p className="max-w-[48ch] text-xs leading-relaxed text-ink-2">First setup downloads the runtime and can take several minutes.</p>}
      </div>
      {advancedDirty && changed && <p role="status" className="mt-4 text-sm leading-relaxed text-ink-2">Save or discard your edits in Generation, Connections or Model files before applying a new GPU selection.</p>}
      {runtime?.busy && <p role="status" className="mt-4 text-sm leading-relaxed text-ink-2">{runtime.message || 'Preparing generation…'} You can close this panel; setup will continue.</p>}
      {runtime?.phase === 'failed' && <p role="alert" className="error-notice mt-4">{runtime.error || runtime.message || 'Setup did not finish. Try again.'}</p>}
      {ready && <p role="status" className="mt-4 text-sm text-ink-2">{runtime.workerCount} GPU{runtime.workerCount === 1 ? '' : 's'} ready for generation. Download checkpoints from Models whenever you need them.</p>}
    </section>
    {onboarding && <div className="mt-9 flex flex-wrap items-center gap-4 border-t border-line pt-6"><button type="button" onClick={onFinished} className={`inline-flex min-h-11 items-center gap-2 rounded-chip px-5 text-sm font-medium ${connected ? 'bg-chip hover:bg-chip-hi' : 'text-ink-2 hover:text-ink'}`}>{connected ? 'Start creating' : 'I’ll set this up later'}<ArrowRight size={16} /></button></div>}
    </div>
    {integrationsVisited && <div hidden={section !== 'integrations'} role="tabpanel" id="settings-panel-integrations" aria-labelledby="settings-tab-integrations" tabIndex={0}><IntegrationsSettings active={section === 'integrations'} /></div>}
    {section === 'assistant' && <div role="tabpanel" id="settings-panel-assistant" aria-labelledby="settings-tab-assistant" tabIndex={0}><LanguageModels assistant onConfigure={() => selectSection('integrations')} /></div>}
    {advancedVisited && <fieldset disabled={busy} hidden={section === 'integrations' || section === 'assistant'} className="min-w-0">{busy && section !== 'gpus' && section !== 'integrations' && section !== 'assistant' && <p role="status" className="mb-5 text-sm text-ink-2">Applying GPU selection… Settings will be available when setup finishes.</p>}<AdvancedSettings section={section === 'integrations' || section === 'assistant' ? undefined : section} revision={advancedRevision} initialHardware={hardware} onDirtyChange={setAdvancedDirty} onChooseGpus={() => { selectSection('gpus'); document.getElementById('settings-tab-gpus')?.focus(); }} onSaved={() => { void load(); onSavedRef.current(); }} /></fieldset>}
  </TabbedWorkspace>;
}
