'use client';
import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, Trash2 } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { ApiAccess } from './ApiAccess';
import { api, errorMessage, type Catalog, type Hardware, type Settings, type WorkerProbe, type ModelConfiguration } from '@/lib/api';

const gib = 1024 ** 3;
const roleLabel = (role: string) => role.replace(/[_-]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

export type AdvancedSettingsSection = 'generation' | 'connections' | 'models' | 'api';

export function AdvancedSettings({ initialHardware, onSaved, onChooseGpus, onDirtyChange, section, revision = 0 }: { initialHardware: Hardware | null; onSaved: (settings: Settings) => void; onChooseGpus: () => void; onDirtyChange: (dirty: boolean) => void; section?: AdvancedSettingsSection | 'gpus'; revision?: number }) {
  const [hardware, setHardware] = useState(initialHardware);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [managedWorkerIds, setManagedWorkerIds] = useState<string[]>([]);
  const [savedSettings, setSavedSettings] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [visited, setVisited] = useState(() => ({ generation: section === 'generation', connections: section === 'connections', models: section === 'models', api: section === 'api' }));
  const [activeWorker, setActiveWorker] = useState(0);
  const [probe, setProbe] = useState<WorkerProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [selectedModel, setSelectedModel] = useState('');

  function acceptSettings(next: Settings) {
    setManagedWorkerIds(next.workers.filter(worker => next.managedWorkers?.some(binding => binding.id === worker.id || binding.baseUrl === worker.baseUrl)).map(worker => worker.id));
    setSettings(next);
    setSavedSettings(JSON.stringify(next));
  }

  async function load(signal?: AbortSignal) {
    setError('');
    try {
      const [nextSettings, nextCatalog] = await Promise.all([api<Settings>('/settings', { signal }), api<Catalog>('/catalog', { signal })]);
      if (signal?.aborted) return;
      acceptSettings(nextSettings);
      setActiveWorker(current => Math.min(current, Math.max(0, nextSettings.workers.length - 1)));
      setCatalog(nextCatalog); setSelectedModel(current => nextCatalog.models.some(model => model.id === current) ? current : nextCatalog.models[0]?.id || '');
      setProbe(null); setSaved(false);
    } catch (error) { if (!signal?.aborted) setError(errorMessage(error)); }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [revision]);
  useEffect(() => { if (initialHardware) setHardware(initialHardware); }, [initialHardware]);
  const dirty = !!settings && JSON.stringify(settings) !== savedSettings;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!section || section === 'gpus') return;
    setVisited(current => current[section] ? current : { ...current, [section]: true });
  }, [section]);
  const worker = settings?.workers[activeWorker];
  const managedWorker = worker && managedWorkerIds.includes(worker.id) ? settings?.managedWorkers?.find(entry => entry.id === worker.id || entry.baseUrl === worker.baseUrl) : undefined;
  const managedGpuIndex = hardware?.gpus.findIndex(gpu => gpu.id === managedWorker?.deviceId) ?? -1;
  const managedGpu = hardware?.gpus[managedGpuIndex];
  const model = catalog?.models.find(entry => entry.id === selectedModel);
  const configuration = settings?.modelConfigurations.find(entry => entry.modelId === selectedModel);
  function updateWorker(change: Partial<NonNullable<typeof worker>>) {
    setSettings(current => current ? { ...current, workers: current.workers.map((entry, index) => index === activeWorker ? { ...entry, ...change } : entry) } : current);
    setSaved(false); if (change.baseUrl !== undefined) setProbe(null);
  }
  function updateModel(change: Partial<ModelConfiguration>) {
    setSettings(current => {
      if (!current) return current;
      const previous = current.modelConfigurations.find(entry => entry.modelId === selectedModel);
      const next: ModelConfiguration = { modelId: selectedModel, enabled: false, artifacts: {}, workerIds: worker ? [worker.id] : [], memory: { ramBytes: 0, vramBytes: 0, source: 'estimate' }, ...previous, ...change };
      if (change.enabled && !next.workerIds.length) next.workerIds = current.workers.filter(entry => entry.enabled).map(entry => entry.id);
      return { ...current, modelConfigurations: [...current.modelConfigurations.filter(entry => entry.modelId !== selectedModel), next] };
    }); setSaved(false);
  }
  function updatePolicy(change: Partial<Settings['policy']>) {
    setSettings(current => current ? { ...current, policy: { ...current.policy, ...change } } : current);
    setSaved(false);
  }
  async function checkWorker() {
    if (!worker) return;
    setProbing(true); setError(''); setProbe(null);
    try { const result = await api<WorkerProbe>('/workers/probe', { method: 'POST', body: JSON.stringify({ baseUrl: worker.baseUrl }) }); setProbe(result); }
    catch (error) { setError(errorMessage(error)); }
    finally { setProbing(false); }
  }
  async function save() {
    if (!settings) return;
    setSaving(true); setError(''); setSaved(false);
    try { const stored = await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }); acceptSettings(stored); setSaved(true); onSaved(stored); setCatalog(await api<Catalog>('/catalog')); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  return <div hidden={!section || section === 'gpus'} className="min-w-0">
    {error && section !== 'api' && <div className="error-notice mb-6" role="alert">{error}{!settings && <button onClick={() => void load()} className="ml-3 underline">Try again</button>}</div>}
    {(visited.generation || section === 'generation') && <div hidden={section !== 'generation'} id="settings-panel-generation" role="tabpanel" aria-labelledby="settings-tab-generation" tabIndex={0}>
      <h2 className="text-lg font-medium">Generation</h2>
      <p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Models load when you generate an image. Studio prefers an available GPU that last used the same model files and queues jobs when memory is tight.</p>
      {!settings ? <p className="text-sm text-ink-2">Loading generation settings…</p> : <>
        <label className="field">Concurrent jobs<input name="maxConcurrentJobs" type="number" min={1} max={64} value={settings.policy.maxConcurrentJobs} onChange={event => updatePolicy({ maxConcurrentJobs: Number(event.target.value) })} aria-describedby="concurrent-jobs-help" /></label>
        <p id="concurrent-jobs-help" className="mb-6 mt-3 text-xs leading-relaxed text-ink-2">Maximum across all GPUs. Each worker runs one job at a time; available RAM and VRAM can reduce this limit.</p>
        <label className="field">Keep models ready<select name="idleUnloadSeconds" value={settings.policy.idleUnloadSeconds} onChange={event => updatePolicy({ idleUnloadSeconds: Number(event.target.value) })} aria-describedby="model-retention-help">
          <option value={0}>No idle timeout</option><option value={120}>For 2 minutes</option><option value={300}>For 5 minutes</option><option value={600}>For 10 minutes</option>
          {![0, 120, 300, 600].includes(settings.policy.idleUnloadSeconds) && <option value={settings.policy.idleUnloadSeconds}>For {settings.policy.idleUnloadSeconds} seconds</option>}
        </select></label>
        <p id="model-retention-help" className="mt-3 text-xs leading-relaxed text-ink-2">Keep recently used models in memory between jobs. An idle timeout frees memory after this delay. Models may be unloaded sooner when another job needs space.</p>
        <fieldset className="mt-8 border-t border-line pt-5"><legend className="text-sm font-medium">Memory to keep free</legend><p className="mb-4 text-xs leading-relaxed text-ink-2">These reserves apply to every job. System RAM is shared across local GPUs.</p><div className="grid grid-cols-2 gap-4">
          <label className="field">RAM (GB)<input name="ramReserveGiB" type="number" min={0} step={1} value={settings.policy.ramReserveBytes / gib} onChange={event => updatePolicy({ ramReserveBytes: Number(event.target.value) * gib })} /></label>
          <label className="field">VRAM per GPU (GB)<input name="vramReserveGiB" type="number" min={0} step={0.5} value={settings.policy.vramReserveBytes / gib} onChange={event => updatePolicy({ vramReserveBytes: Number(event.target.value) * gib })} /></label>
        </div></fieldset>
      </>}
    </div>}
    {(visited.connections || section === 'connections') && <div hidden={section !== 'connections'} id="settings-panel-connections" role="tabpanel" aria-labelledby="settings-tab-connections" tabIndex={0}>
    {!settings ? <p className="text-sm text-ink-2">Loading worker settings…</p> : <section>
      <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-lg font-medium">ComfyUI worker</h2><Chip icon={<Plus />} onClick={() => { const index = settings.workers.length; setSettings({ ...settings, workers: [...settings.workers, { id: `comfyui-${Date.now().toString(36)}`, name: `ComfyUI ${index + 1}`, baseUrl: '', enabled: true, deviceIds: [], location: 'local', maxConcurrentJobs: 1 }] }); setActiveWorker(index); setProbe(null); setSaved(false); }}>Add worker</Chip></div>
      {settings.workers.length > 1 && <label className="field mb-6">Worker<select value={activeWorker} onChange={event => { setActiveWorker(Number(event.target.value)); setProbe(null); }}>{settings.workers.map((entry, index) => <option key={entry.id} value={index}>{entry.name}</option>)}</select></label>}
      {worker && <><div className="grid gap-5"><label className="field">Name<input value={worker.name} maxLength={80} onChange={event => updateWorker({ name: event.target.value })} /></label><label className="field">ComfyUI address<input type="url" readOnly={!!managedWorker} value={worker.baseUrl} onChange={event => updateWorker({ baseUrl: event.target.value })} placeholder="http://127.0.0.1:8188" /></label></div>
      <label className="field mt-5">Worker location<select disabled={!!managedWorker} value={worker.location} onChange={event => updateWorker({ location: event.target.value as "local" | "remote", deviceIds: [] })}><option value="local">On this server</option><option value="remote">On another machine</option></select></label>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">{managedWorker ? 'Studio manages this connection. Change the active GPUs in the GPUs tab.' : 'Use the address reachable from the studio server. For a worker on another machine, enter its LAN address.'}</p>
      <div className="mt-5 flex flex-wrap items-center gap-4"><Chip disabled={probing || !worker.baseUrl} icon={probing ? <LoaderCircle className="animate-spin" /> : undefined} onClick={() => void checkWorker()}>{probing ? 'Connecting…' : 'Test connection'}</Chip>{!managedWorker && <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={worker.enabled} onChange={event => updateWorker({ enabled: event.target.checked })} className="size-4 accent-volt" />Enabled</label>}{!managedWorker && settings.workers.length > 1 && <button aria-label="Remove selected worker" className="ml-auto text-ink-2 hover:text-ink" onClick={() => { setSettings({ ...settings, workers: settings.workers.filter((_, index) => index !== activeWorker) }); setActiveWorker(0); setProbe(null); setSaved(false); }}><Trash2 size={17} /></button>}</div>
      {probe && <p role="status" className={`mt-4 flex items-start gap-2 text-sm leading-relaxed ${probe.connected ? 'text-volt' : 'text-[#ffc3aa]'}`}>{probe.connected && <Check className="mt-0.5 size-4 shrink-0" />}{probe.connected ? `Connected to ComfyUI${probe.version ? ` ${probe.version}` : ''}. Installed files are available in Model files.` : probe.error || 'Could not connect. Check the address and that ComfyUI is running.'}</p>}
      {managedWorker && <div className="mt-8 border-t border-line pt-5"><h3 className="text-sm font-medium">Assigned GPU</h3><p className="mt-3 text-sm text-ink-2">{managedGpu ? `GPU ${managedGpuIndex + 1} · ${managedGpu.name}${managedGpu.pciAddress ? ` · ${managedGpu.pciAddress}` : ''}` : 'GPU not currently detected'}</p><p className="mb-4 mt-2 text-xs leading-relaxed text-ink-2">{worker.enabled ? 'This GPU is available for generation.' : 'This GPU is disabled for generation.'} Studio starts one ComfyUI process for each selected GPU.</p><Chip onClick={onChooseGpus}>Choose GPUs</Chip></div>}
      {!managedWorker && worker.location === "local" && hardware && hardware.gpus.length > 0 && <fieldset className="mt-8"><legend className="mb-3 text-sm font-medium">GPU used by this worker</legend><p className="mb-3 text-xs leading-relaxed text-ink-2">Identify the GPU this ComfyUI process already uses. This does not move the process to another GPU. Each worker uses one GPU.</p><div className="space-y-3">{hardware.gpus.map((gpu, index) => <label key={gpu.id} className="flex items-center gap-3 text-sm text-ink-2"><input type="radio" name="worker-gpu" className="size-4 accent-volt" checked={worker.deviceIds.includes(gpu.id)} onChange={() => updateWorker({ deviceIds: [gpu.id] })} />GPU {index + 1} · {gpu.name}{gpu.pciAddress ? ` · ${gpu.pciAddress}` : ''}</label>)}</div></fieldset>}
      </>}

    </section>}
    </div>}
    {(visited.models || section === 'models') && <div hidden={section !== 'models'} id="settings-panel-models" role="tabpanel" aria-labelledby="settings-tab-models" tabIndex={0}>
    <section><h2 className="text-lg font-medium">Image models</h2><p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Choose a model and assign the files installed in ComfyUI. Models become available after their required files are configured.</p>
      <label className="field">Model<select value={selectedModel} onChange={event => setSelectedModel(event.target.value)}>{catalog?.models.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.family}</option>)}</select></label>
      {model && <><p className="my-4 text-sm text-ink-2">{model.description}</p><div className="space-y-4">{model.requiredArtifactRoles?.map(role => <label className="field" key={role}>{roleLabel(role)}<input list={`artifacts-${role}`} value={configuration?.artifacts[role] || ''} onChange={event => updateModel({ artifacts: { ...configuration?.artifacts, [role]: event.target.value } })} placeholder="Choose or enter the installed filename" /><datalist id={`artifacts-${role}`}>{probe?.artifacts?.[role]?.map(filename => <option key={filename} value={filename} />)}</datalist></label>)}</div><p className="mt-3 text-xs leading-relaxed text-ink-2">Use filenames relative to the matching ComfyUI model folder. Test the worker connection to see its installed files.</p><fieldset className="mt-6"><legend className="mb-3 text-sm font-medium">Workers for this model</legend><p className="mb-3 text-xs leading-relaxed text-ink-2">Select every worker that has these files. Studio chooses an available worker for each image.</p><label className="mb-3 flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name="model-auto-workers" className="size-4 shrink-0 accent-volt" checked={configuration?.workerSelection !== 'manual'} onChange={event => {
        const selectedManaged = settings?.workers.filter(entry => entry.enabled && managedWorkerIds.includes(entry.id)).map(entry => entry.id) || [];
        const external = configuration?.workerIds.filter(id => !managedWorkerIds.includes(id)) || [];
        updateModel(event.target.checked ? { workerSelection: 'automatic', workerIds: [...new Set([...selectedManaged, ...external])] } : { workerSelection: 'manual' });
      }} /><span>Use all Studio GPUs automatically</span></label><div className="space-y-1">{settings?.workers.map(entry => <label key={entry.id} className="flex min-h-11 items-center gap-3 text-sm text-ink-2"><input type="checkbox" name="model-worker" value={entry.id} className="size-4 shrink-0 accent-volt" checked={configuration?.workerIds.includes(entry.id) ?? false} onChange={event => updateModel({ workerSelection: 'manual', workerIds: event.target.checked ? [...(configuration?.workerIds || []), entry.id] : (configuration?.workerIds || []).filter(id => id !== entry.id) })} /><span>{entry.name}{!entry.enabled ? ' · Disabled' : ''}</span></label>)}</div></fieldset><details className="mt-5"><summary className="text-sm text-ink-2">Model memory budget</summary><p className="my-3 text-xs leading-relaxed text-ink-2">Memory reserved while this model runs. Start with a conservative estimate for your model and resolution.</p><div className="grid grid-cols-2 gap-3"><label className="field">RAM (GB)<input type="number" min={0} step={1} value={(configuration?.memory.ramBytes || 0) / gib} onChange={event => updateModel({ memory: { vramBytes: configuration?.memory.vramBytes || 0, ramBytes: Number(event.target.value) * gib, source: "estimate" } })} /></label><label className="field">VRAM (GB)<input type="number" min={0} step={1} value={(configuration?.memory.vramBytes || 0) / gib} onChange={event => updateModel({ memory: { ramBytes: configuration?.memory.ramBytes || 0, vramBytes: Number(event.target.value) * gib, source: "estimate" } })} /></label></div></details><label className="mt-6 flex items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-volt" checked={configuration?.enabled ?? false} onChange={event => updateModel({ enabled: event.target.checked })} />Make this model available in Image</label></>}
      {!!settings?.modelConfigurations.filter(entry => entry.enabled).length && <div className="mt-8 border-t border-line pt-5"><p className="mb-3 text-sm font-medium">Enabled models</p><ul className="space-y-2 text-sm text-ink-2">{settings.modelConfigurations.filter(entry => entry.enabled).map(entry => <li key={entry.modelId}>{catalog?.models.find(model => model.id === entry.modelId)?.name || entry.modelId}</li>)}</ul></div>}
    </section>
    </div>}
    {(visited.api || section === 'api') && <div hidden={section !== 'api'} id="settings-panel-api" role="tabpanel" aria-labelledby="settings-tab-api" tabIndex={0}><ApiAccess /></div>}
    {(section === 'generation' || section === 'connections' || section === 'models') && <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-line pt-5"><button disabled={saving || !settings} onClick={() => void save()} className="flex min-h-11 items-center gap-2 rounded-chip bg-chip px-5 text-sm font-medium hover:bg-chip-hi disabled:opacity-50">{saving && <LoaderCircle size={16} className="animate-spin" />}{saving ? 'Saving…' : 'Save settings'}</button>{dirty && <button type="button" disabled={saving} onClick={() => { if (savedSettings) { const previous = JSON.parse(savedSettings) as Settings; acceptSettings(previous); setActiveWorker(current => Math.min(current, Math.max(0, previous.workers.length - 1))); setProbe(null); setError(''); setSaved(false); } }} className="min-h-11 px-2 text-sm text-ink-2 hover:text-ink disabled:opacity-50">Discard changes</button>}{saved && <span role="status" className="text-sm text-volt">Configuration saved.</span>}</div>}
  </div>;
}
