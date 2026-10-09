'use client';
import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { Chip } from '@/components/ui/Chip';
import { ApiAccess } from './ApiAccess';
import { api, errorMessage, type Catalog, type Hardware, type Settings, type WorkerProbe, type ModelConfiguration } from '@/lib/api';

const gib = 1024 ** 3;
const roleLabel = (role: string) => role.replace(/[_-]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

export function AdvancedSettings({ initialHardware, onSaved }: { initialHardware: Hardware | null; onSaved: () => void }) {
  const [hardware, setHardware] = useState(initialHardware);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [step, setStep] = useState(1);
  const [activeWorker, setActiveWorker] = useState(0);
  const [probe, setProbe] = useState<WorkerProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [selectedModel, setSelectedModel] = useState('');

  async function load() {
    setError('');
    try {
      const [nextSettings, nextCatalog] = await Promise.all([api<Settings>('/settings'), api<Catalog>('/catalog')]);
      setSettings(nextSettings.workers.length ? nextSettings : { ...nextSettings, workers: [{ id: 'comfyui', name: 'ComfyUI', baseUrl: 'http://127.0.0.1:8188', enabled: true, deviceIds: [], location: 'local', maxConcurrentJobs: 1 }] });
      setCatalog(nextCatalog); setSelectedModel(current => current || nextCatalog.models[0]?.id || '');
    } catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (initialHardware) setHardware(initialHardware); }, [initialHardware]);
  const worker = settings?.workers[activeWorker];
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
      if (next.enabled && !next.workerIds.length && worker) next.workerIds = [worker.id];
      return { ...current, modelConfigurations: [...current.modelConfigurations.filter(entry => entry.modelId !== selectedModel), next] };
    }); setSaved(false);
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
    try { const stored = await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }); setSettings(stored); setSaved(true); onSaved(); setCatalog(await api<Catalog>('/catalog')); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  return <div className="pt-5">
    <div className="mb-7 flex gap-2 overflow-x-auto border-b border-line pb-3" role="tablist" aria-label="Advanced settings sections">{['Connections', 'Model files', 'API access'].map((label, index) => <button key={label} role="tab" aria-selected={step === index + 1} aria-controls={`advanced-panel-${index + 1}`} id={`advanced-tab-${index + 1}`} onClick={() => setStep(index + 1)} className={`min-h-10 shrink-0 rounded-chip px-4 text-sm ${step === index + 1 ? 'bg-chip text-ink' : 'text-ink-2 hover:bg-panel-2'}`}>{label}</button>)}</div>
    {error && <div className="error-notice mb-6" role="alert">{error}{!settings && <button onClick={() => void load()} className="ml-3 underline">Try again</button>}</div>}
    <div id={`advanced-panel-${step}`} role="tabpanel" aria-labelledby={`advanced-tab-${step}`}>
    {step === 1 && (!settings ? <p className="text-sm text-ink-2">Loading worker settings…</p> : <section>
      <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-lg font-medium">ComfyUI worker</h2><Chip icon={<Plus />} onClick={() => { const index = settings.workers.length; setSettings({ ...settings, workers: [...settings.workers, { id: `comfyui-${Date.now().toString(36)}`, name: `ComfyUI ${index + 1}`, baseUrl: 'http://127.0.0.1:8188', enabled: true, deviceIds: [], location: 'local', maxConcurrentJobs: 1 }] }); setActiveWorker(index); setProbe(null); setSaved(false); }}>Add worker</Chip></div>
      {settings.workers.length > 1 && <label className="field mb-6">Worker<select value={activeWorker} onChange={event => { setActiveWorker(Number(event.target.value)); setProbe(null); }}>{settings.workers.map((entry, index) => <option key={entry.id} value={index}>{entry.name}</option>)}</select></label>}
      {worker && <><div className="grid gap-5"><label className="field">Name<input value={worker.name} maxLength={80} onChange={event => updateWorker({ name: event.target.value })} /></label><label className="field">ComfyUI address<input type="url" value={worker.baseUrl} onChange={event => updateWorker({ baseUrl: event.target.value })} placeholder="http://127.0.0.1:8188" /></label></div>
      <label className="field mt-5">Worker location<select value={worker.location} onChange={event => updateWorker({ location: event.target.value as "local" | "remote", deviceIds: [] })}><option value="local">On this server</option><option value="remote">On another machine</option></select></label>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">Use the address reachable from the studio server. For a worker on another machine, enter its LAN address.</p>
      <div className="mt-5 flex flex-wrap items-center gap-4"><Chip disabled={probing || !worker.baseUrl} icon={probing ? <LoaderCircle className="animate-spin" /> : undefined} onClick={() => void checkWorker()}>{probing ? 'Connecting…' : 'Test connection'}</Chip><label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={worker.enabled} onChange={event => updateWorker({ enabled: event.target.checked })} className="size-4 accent-volt" />Enabled</label>{settings.workers.length > 1 && <button aria-label="Remove selected worker" className="ml-auto text-ink-2 hover:text-ink" onClick={() => { setSettings({ ...settings, workers: settings.workers.filter((_, index) => index !== activeWorker) }); setActiveWorker(0); setProbe(null); setSaved(false); }}><Trash2 size={17} /></button>}</div>
      {probe && <p role="status" className={`mt-4 flex items-start gap-2 text-sm leading-relaxed ${probe.connected ? 'text-volt' : 'text-[#ffc3aa]'}`}>{probe.connected && <Check className="mt-0.5 size-4 shrink-0" />}{probe.connected ? `Connected to ComfyUI${probe.version ? ` ${probe.version}` : ''}. Installed files are available in Model files.` : probe.error || 'Could not connect. Check the address and that ComfyUI is running.'}</p>}
      {worker.location === "local" && hardware && hardware.gpus.length > 0 && <fieldset className="mt-8"><legend className="mb-3 text-sm font-medium">GPU used by this worker</legend><p className="mb-3 text-xs leading-relaxed text-ink-2">Select the GPU assigned to this ComfyUI process. Each image worker uses one GPU.</p><div className="space-y-3">{hardware.gpus.map((gpu, index) => <label key={gpu.id} className="flex items-center gap-3 text-sm text-ink-2"><input type="radio" name="worker-gpu" className="size-4 accent-volt" checked={worker.deviceIds.includes(gpu.id)} onChange={() => updateWorker({ deviceIds: [gpu.id] })} />GPU {index + 1} · {gpu.name}{gpu.pciAddress ? ` · ${gpu.pciAddress}` : ''}</label>)}</div></fieldset>}
      </>}
      <details className="mt-8 border-t border-line pt-5"><summary className="text-sm text-ink-2">Resource limits</summary><div className="mt-5 grid grid-cols-2 gap-4"><label className="field">Keep RAM free (GB)<input type="number" min={0} step={1} value={settings.policy.ramReserveBytes / gib} onChange={event => { setSettings({ ...settings, policy: { ...settings.policy, ramReserveBytes: Number(event.target.value) * gib } }); setSaved(false); }} /></label><label className="field">Keep VRAM free (GB)<input type="number" min={0} step={0.5} value={settings.policy.vramReserveBytes / gib} onChange={event => { setSettings({ ...settings, policy: { ...settings.policy, vramReserveBytes: Number(event.target.value) * gib } }); setSaved(false); }} /></label><label className="field col-span-2">Concurrent jobs<input type="number" min={1} max={16} value={settings.policy.maxConcurrentJobs} onChange={event => { setSettings({ ...settings, policy: { ...settings.policy, maxConcurrentJobs: Number(event.target.value) } }); setSaved(false); }} /></label></div></details>
    </section>)}
    {step === 2 && <section><h2 className="text-lg font-medium">Image models</h2><p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Choose a model and assign the files installed in ComfyUI. Models become available after their required files are configured.</p>
      <label className="field">Model<select value={selectedModel} onChange={event => setSelectedModel(event.target.value)}>{catalog?.models.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.family}</option>)}</select></label>
      {model && <><p className="my-4 text-sm text-ink-2">{model.description}</p><div className="space-y-4">{model.requiredArtifactRoles?.map(role => <label className="field" key={role}>{roleLabel(role)}<input list={`artifacts-${role}`} value={configuration?.artifacts[role] || ''} onChange={event => updateModel({ artifacts: { ...configuration?.artifacts, [role]: event.target.value } })} placeholder="Choose or enter the installed filename" /><datalist id={`artifacts-${role}`}>{probe?.artifacts?.[role]?.map(filename => <option key={filename} value={filename} />)}</datalist></label>)}</div><p className="mt-3 text-xs leading-relaxed text-ink-2">Use filenames relative to the matching ComfyUI model folder. Test the worker connection to see its installed files.</p><label className="field mt-6">Run on worker<select value={configuration?.workerIds[0] || worker?.id || ""} onChange={event => updateModel({ workerIds: [event.target.value] })}>{settings?.workers.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><details className="mt-5"><summary className="text-sm text-ink-2">Model memory budget</summary><p className="my-3 text-xs leading-relaxed text-ink-2">Memory reserved while this model runs. Start with a conservative estimate for your model and resolution.</p><div className="grid grid-cols-2 gap-3"><label className="field">RAM (GB)<input type="number" min={0} step={1} value={(configuration?.memory.ramBytes || 0) / gib} onChange={event => updateModel({ memory: { vramBytes: configuration?.memory.vramBytes || 0, ramBytes: Number(event.target.value) * gib, source: "estimate" } })} /></label><label className="field">VRAM (GB)<input type="number" min={0} step={1} value={(configuration?.memory.vramBytes || 0) / gib} onChange={event => updateModel({ memory: { ramBytes: configuration?.memory.ramBytes || 0, vramBytes: Number(event.target.value) * gib, source: "estimate" } })} /></label></div></details><label className="mt-6 flex items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-volt" checked={configuration?.enabled ?? false} onChange={event => updateModel({ enabled: event.target.checked })} />Make this model available in Image</label></>}
      {!!settings?.modelConfigurations.filter(entry => entry.enabled).length && <div className="mt-8 border-t border-line pt-5"><p className="mb-3 text-sm font-medium">Enabled models</p><ul className="space-y-2 text-sm text-ink-2">{settings.modelConfigurations.filter(entry => entry.enabled).map(entry => <li key={entry.modelId}>{catalog?.models.find(model => model.id === entry.modelId)?.name || entry.modelId}</li>)}</ul></div>}
    </section>}
    {step === 3 && <ApiAccess />}
    </div>
    {step !== 3 && <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-line pt-5"><button disabled={saving || !settings} onClick={() => void save()} className="flex min-h-11 items-center gap-2 rounded-chip bg-chip px-5 text-sm font-medium hover:bg-chip-hi disabled:opacity-50">{saving && <LoaderCircle size={16} className="animate-spin" />}{saving ? 'Saving…' : 'Save advanced settings'}</button>{saved && <span role="status" className="text-sm text-volt">Configuration saved.</span>}</div>}
  </div>;
}
