'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Cpu, ExternalLink, HardDrive, Layers2, LoaderCircle, MonitorIcon, RefreshCw, SlidersHorizontal, Wand2 } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { AdvancedSettings } from './AdvancedSettings';
import { IntegrationsSettings } from './IntegrationsSettings';
import { LanguageModels } from './LanguageModels';
import { AppSettings } from './AppSettings';
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
  { id: 'app', label: 'App', icon: MonitorIcon },
] as const;
export type SettingsSection = typeof sections[number]['id'];

export function SettingsWorkspace({ initialHardware, onSaved, onFinished, onboarding = false, section, onSectionChange, active = true, activeWork = false, embedded = false, onBusyChange }: { initialHardware: Hardware | null; onSaved: () => void; onFinished: () => void; onboarding?: boolean; section: SettingsSection; onSectionChange: (section: SettingsSection) => void; active?: boolean; activeWork?: boolean; embedded?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [hardware, setHardware] = useState(initialHardware);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runtime, setRuntime] = useState<RuntimeSetupStatus | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const errorSource = useRef<'read' | 'action' | null>(null);
  const [advancedVisited, setAdvancedVisited] = useState(false);
  const [integrationsVisited, setIntegrationsVisited] = useState(false);
  const [assistantVisited, setAssistantVisited] = useState(false);
  const [advancedRevision, setAdvancedRevision] = useState(0);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const pendingAdvancedRefresh = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const mounted = useRef(true);
  const selectionEdited = useRef(false);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const current = useRef({ settings, advancedDirty, active });
  current.current = { settings, advancedDirty, active };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; read.current?.abort(); write.current?.abort(); }; }, []);

  const load = useCallback(async (resetSelection = false) => {
    if (!mounted.current) return;
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      const [nextSettings, nextRuntime, nextHardware] = await Promise.all([api<Settings>('/settings', { signal }), api<RuntimeSetupStatus>('/runtime', { signal }), api<Hardware>('/hardware', { signal })]);
      if (controller.signal.aborted || !mounted.current) return;
      if (errorSource.current === 'read') { setError(''); errorSource.current = null; }
      if (current.current.settings && nextSettings.revision !== current.current.settings.revision) {
        if (current.current.advancedDirty || !current.current.active) pendingAdvancedRefresh.current = true;
        else { pendingAdvancedRefresh.current = false; setAdvancedRevision(value => value + 1); }
      }
      setSettings(nextSettings); setRuntime(nextRuntime); setHardware(nextHardware);
      const assigned = nextSettings.workers.filter(worker => worker.enabled && worker.location === 'local').flatMap(worker => worker.deviceIds);
      if (resetSelection || !selectionEdited.current) {
        setSelected(assigned.length ? assigned : nextHardware.gpus.filter(gpu => gpu.vendor === 'amd' || gpu.vendor === 'nvidia').map(gpu => gpu.id));
        selectionEdited.current = false;
      }
    } catch (error) { if (!controller.signal.aborted && mounted.current && errorSource.current !== 'action') { errorSource.current = 'read'; setError(errorMessage(error)); } }
    finally { if (read.current === controller) read.current = null; if (!controller.signal.aborted && mounted.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (active && !write.current) void load();
    return () => { read.current?.abort(); read.current = null; };
  }, [active, load]);
  useEffect(() => {
    if (active && !advancedDirty && pendingAdvancedRefresh.current) {
      pendingAdvancedRefresh.current = false;
      setAdvancedRevision(value => value + 1);
    }
  }, [active, advancedDirty]);
  useEffect(() => { if (initialHardware) setHardware(initialHardware); }, [initialHardware]);
  useEffect(() => {
    if (!active || !runtime?.busy || starting) return;
    let cancelled = false;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
        const next = await api<RuntimeSetupStatus>('/runtime', { signal });
        if (cancelled) return;
        if (!next.busy && next.phase === 'ready') {
          const [nextSettings, nextHardware] = await Promise.all([api<Settings>('/settings', { signal }), api<Hardware>('/hardware', { signal })]);
          if (cancelled) return;
          setSettings(nextSettings); setHardware(nextHardware);
          if (current.current.advancedDirty) pendingAdvancedRefresh.current = true;
          else { pendingAdvancedRefresh.current = false; setAdvancedRevision(value => value + 1); }
          onSavedRef.current();
        }
        setRuntime(next);
        if (errorSource.current === 'read') { setError(''); errorSource.current = null; }
        if (next.busy) timeout = setTimeout(() => void poll(), 1500);
      } catch (error) {
        if (cancelled) return;
        if (errorSource.current !== 'action') { errorSource.current = 'read'; setError(errorMessage(error)); }
        timeout = setTimeout(() => void poll(), 3000);
      }
    }
    timeout = setTimeout(() => void poll(), 500);
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [active, runtime?.busy, starting]);

  const busy = starting || !!runtime?.busy;
  useEffect(() => { onBusyChange?.(busy || advancedDirty); }, [busy, advancedDirty, onBusyChange]);
  const assigned = settings?.workers.filter(worker => worker.enabled && worker.location === 'local').flatMap(worker => worker.deviceIds) || [];
  const changed = selected.length !== new Set(assigned).size || selected.some(id => !assigned.includes(id));
  useEffect(() => { if (settings && !changed) selectionEdited.current = false; }, [settings, changed]);
  const ready = runtime?.phase === 'ready' && !changed;
  const connected = ready || !!settings?.workers.some(worker => worker.enabled);

  async function refreshHardware() {
    setChecking(true); setError(''); errorSource.current = 'action';
    try { const next = await api<Hardware>('/hardware', { signal: AbortSignal.timeout(15_000) }); if (mounted.current) { setHardware(next); errorSource.current = null; } }
    catch (error) { if (mounted.current) setError(errorMessage(error)); }
    finally { if (mounted.current) setChecking(false); }
  }
  async function start() {
    if (advancedDirty || write.current) return;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    setStarting(true); setError(''); errorSource.current = 'action';
    try {
      const next = await api<RuntimeSetupStatus>('/runtime', { method: 'POST', body: JSON.stringify({ gpuIds: selected }), signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      errorSource.current = null;
      setRuntime(next);
      selectionEdited.current = false;
      if (!next.busy && next.phase === 'ready') { await load(true); if (mounted.current) onSavedRef.current(); }
    } catch (error) { if (!controller.signal.aborted && mounted.current) setError(errorMessage(error)); }
    finally { if (write.current === controller) write.current = null; if (!controller.signal.aborted && mounted.current) setStarting(false); }
  }

  function advancedSaved(next: Settings) {
    if (!mounted.current) return;
    // The child already accepted this revision. A second reload would erase its
    // saved confirmation and could replace edits started just after the save.
    read.current?.abort(); read.current = null;
    pendingAdvancedRefresh.current = false;
    current.current = { ...current.current, settings: next, advancedDirty: false };
    setSettings(next); setAdvancedDirty(false); setLoading(false);
    if (!selectionEdited.current) {
      const assigned = next.workers.filter(worker => worker.enabled && worker.location === 'local').flatMap(worker => worker.deviceIds);
      setSelected(assigned.length ? assigned : hardware?.gpus.filter(gpu => gpu.vendor === 'amd' || gpu.vendor === 'nvidia').map(gpu => gpu.id) || []);
    }
    onSavedRef.current();
  }

  const advancedSection = section !== 'gpus' && section !== 'integrations' && section !== 'assistant' && section !== 'app';
  useEffect(() => {
    if (advancedSection) setAdvancedVisited(true);
    if (section === 'integrations') setIntegrationsVisited(true);
    if (section === 'assistant') setAssistantVisited(true);
  }, [section, advancedSection]);
  const selectSection = onSectionChange;
  const content = <>
    <div hidden={section !== 'gpus'} role="tabpanel" id="settings-panel-gpus" aria-labelledby="settings-tab-gpus">
    {error && <div className="error-notice mb-6" role="alert">{error}{!settings && <button onClick={() => void load()} className="ml-3 underline">Try again</button>}</div>}
    <section aria-labelledby="gpu-selection-title">
      <div className="mb-5 flex items-center justify-between gap-4"><h2 id="gpu-selection-title" className="text-[15px] font-medium">GPUs to use</h2><Chip disabled={checking || busy} icon={<RefreshCw className={checking ? 'animate-spin' : ''} />} onClick={() => void refreshHardware()}>{checking ? 'Checking…' : 'Refresh'}</Chip></div>
      <p className="mb-5 text-sm leading-relaxed text-ink-2">Select all GPUs you want to use. Studio distributes jobs across them, with one image at a time on each GPU. Different models can run in parallel when memory allows.</p>
      {loading ? <p role="status" className="py-5 text-sm text-ink-2">Detecting your hardware…</p> : hardware?.gpus.length ? <fieldset disabled={busy} className="divide-y divide-line border-y border-line"><legend className="sr-only">GPUs available for generation</legend>{hardware.gpus.map((gpu, index) => {
        const supported = gpu.vendor === 'amd' || gpu.vendor === 'nvidia';
        return <label key={gpu.id} className={`flex cursor-pointer items-start gap-4 py-5 ${!supported ? 'opacity-55' : ''}`}>
          <input type="checkbox" name="runtime-gpu" value={gpu.id} checked={selected.includes(gpu.id)} disabled={!supported} onChange={event => { selectionEdited.current = true; setSelected(current => event.target.checked ? [...current, gpu.id] : current.filter(id => id !== gpu.id)); }} className="mt-1 size-[18px] shrink-0 accent-volt" />
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
    {(integrationsVisited || section === 'integrations') && <div hidden={section !== 'integrations'} role="tabpanel" id="settings-panel-integrations" aria-labelledby="settings-tab-integrations" tabIndex={0}><IntegrationsSettings active={active && section === 'integrations'} /></div>}
    {(assistantVisited || section === 'assistant') && <div hidden={section !== 'assistant'} role="tabpanel" id="settings-panel-assistant" aria-labelledby="settings-tab-assistant" tabIndex={0}><LanguageModels active={active && section === 'assistant'} assistant onConfigure={() => selectSection('integrations')} /></div>}
    {section === 'app' && <div role="tabpanel" id="settings-panel-app" aria-labelledby="settings-tab-app" tabIndex={0}><AppSettings busy={activeWork || busy || advancedDirty} /></div>}
    {(advancedVisited || advancedSection) && <fieldset disabled={busy} hidden={section === 'integrations' || section === 'assistant' || section === 'app'} className="min-w-0">{busy && advancedSection && <p role="status" className="mb-5 text-sm text-ink-2">Applying GPU selection… Settings will be available when setup finishes.</p>}<AdvancedSettings section={section === 'integrations' || section === 'assistant' || section === 'app' ? undefined : section} revision={advancedRevision} initialHardware={hardware} onDirtyChange={setAdvancedDirty} onChooseGpus={() => { selectSection('gpus'); if (current.current.active) document.getElementById('settings-tab-gpus')?.focus(); }} onSaved={advancedSaved} /></fieldset>}
  </>;
  return embedded ? content : <TabbedWorkspace id="settings" label="Settings sections" sections={sections} selected={section} onSelect={selectSection}>{content}</TabbedWorkspace>;
}
