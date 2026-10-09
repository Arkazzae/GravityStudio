'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { Chip } from '@/components/ui/Chip';
import { HardwarePanel } from './HardwarePanel';
import { ApiAccess } from './ApiAccess';
import { api, errorMessage, type Catalog, type Hardware, type Settings, type WorkerProbe, type ModelConfiguration } from '@/lib/api';

const gib = 1024 ** 3;
const roleLabel = (role: string) => role.replace(/[_-]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

export function SettingsWorkspace({ initialHardware, onSaved, onFinished, onboarding = false }: { initialHardware: Hardware | null; onSaved: () => void; onFinished: () => void; onboarding?: boolean }) {
  const [hardware, setHardware] = useState(initialHardware);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [step, setStep] = useState(onboarding ? 0 : 1);
  const [activeWorker, setActiveWorker] = useState(0);
  const [probe, setProbe] = useState<WorkerProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [checking, setChecking] = useState(false);
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
  async function refreshHardware() {
    setChecking(true); setError('');
    try { setHardware(await api<Hardware>('/hardware')); }
    catch (error) { setError(errorMessage(error)); }
    finally { setChecking(false); }
  }
  async function save() {
    if (!settings) return;
    setSaving(true); setError(''); setSaved(false);
    try { const stored = await api<Settings>('/settings', { method: 'PUT', body: JSON.stringify(settings) }); setSettings(stored); setSaved(true); onSaved(); setCatalog(await api<Catalog>('/catalog')); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  return <div className="min-h-0 flex-1 overflow-auto"><div className="mx-auto w-full max-w-[900px] px-5 py-8 sm:px-10 sm:py-12">
    <Link href="/image" className="mb-7 inline-flex items-center gap-2 text-sm text-ink-2 hover:text-ink"><ArrowLeft size={15} />Back to images</Link>
    <h1 className="text-[28px] font-medium tracking-[-.025em]">{onboarding ? 'Connect your studio.' : 'Hardware & setup'}</h1>
    <p className="mt-3 max-w-[65ch] text-sm leading-relaxed text-ink-2">{onboarding ? 'Check your hardware, connect ComfyUI, and choose the models you want to use.' : 'Manage your generation worker and the models available in your studio.'}</p>
    <div className="my-8 flex gap-2 overflow-x-auto border-b border-line pb-3" role="tablist" aria-label="Setup sections">{(onboarding ? ['Hardware', 'Worker', 'Models'] : ['Hardware', 'Worker', 'Models', 'API access']).map((label, index) => <button key={label} role="tab" aria-selected={step === index} aria-controls={`setup-panel-${index}`} id={`setup-tab-${index}`} onClick={() => setStep(index)} className={`flex min-h-10 shrink-0 items-center gap-2 rounded-chip px-4 text-sm transition-colors ${step === index ? 'bg-chip text-ink' : 'text-ink-2 hover:bg-panel-2'}`}>{onboarding && <span className="text-xs tabular-nums text-ink-2">{index + 1}</span>}{label}</button>)}</div>
    {error && <div className="error-notice mb-6" role="alert">{error}{!settings && <button onClick={() => void load()} className="ml-3 underline">Try again</button>}</div>}
    <div id={`setup-panel-${step}`} role="tabpanel" aria-labelledby={`setup-tab-${step}`}>
    {step === 0 && <HardwarePanel hardware={hardware} onRefresh={() => void refreshHardware()} refreshing={checking} />}
    {step === 1 && (!settings ? <p className="text-sm text-ink-2">Loading worker settings…</p> : <section>
      <details open={onboarding} className="mb-7 border-b border-line pb-6"><summary className="text-sm font-medium">Start managed ComfyUI</summary><p className="mb-3 mt-3 text-xs leading-relaxed text-ink-2">On the computer with your GPUs, run these commands from the project folder. The first previews the configuration; the second starts the workers.</p><pre className="overflow-x-auto rounded-chip bg-panel-2 p-4 text-xs leading-7 text-ink"><code>pnpm runtime plan --engine docker{'\n'}pnpm runtime up --engine docker</code></pre><p className="mt-3 text-xs leading-relaxed text-ink-2">Use <code>--engine podman</code> for Podman. Each GPU gets one worker, sharing <code>storage/models</code>. Worker addresses start at <code>http://127.0.0.1:8188</code>, then port 8189 for the next GPU.</p><p className="mt-3 text-xs leading-relaxed text-ink-2">Already running ComfyUI? Enter its address below.</p></details>
      <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-lg font-medium">ComfyUI worker</h2><Chip icon={<Plus />} onClick={() => { const index = settings.workers.length; setSettings({ ...settings, workers: [...settings.workers, { id: `comfyui-${Date.now().toString(36)}`, name: `ComfyUI ${index + 1}`, baseUrl: 'http://127.0.0.1:8188', enabled: true, deviceIds: [], location: 'local', maxConcurrentJobs: 1 }] }); setActiveWorker(index); setProbe(null); setSaved(false); }}>Add worker</Chip></div>
      {settings.workers.length > 1 && <label className="field mb-6">Worker<select value={activeWorker} onChange={event => { setActiveWorker(Number(event.target.value)); setProbe(null); }}>{settings.workers.map((entry, index) => <option key={entry.id} value={index}>{entry.name}</option>)}</select></label>}
      {worker && <><div className="grid gap-5 sm:grid-cols-2"><label className="field">Name<input value={worker.name} maxLength={80} onChange={event => updateWorker({ name: event.target.value })} /></label><label className="field">ComfyUI address<input type="url" value={worker.baseUrl} onChange={event => updateWorker({ baseUrl: event.target.value })} placeholder="http://127.0.0.1:8188" /></label></div>
      <label className="field mt-5">Worker location<select value={worker.location} onChange={event => updateWorker({ location: event.target.value as "local" | "remote", deviceIds: [] })}><option value="local">On this server</option><option value="remote">On another machine</option></select></label>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">Use the address reachable from the studio server. For a worker on another machine, enter its LAN address.</p>
      <div className="mt-5 flex flex-wrap items-center gap-4"><Chip disabled={probing || !worker.baseUrl} icon={probing ? <LoaderCircle className="animate-spin" /> : undefined} onClick={() => void checkWorker()}>{probing ? 'Connecting…' : 'Test connection'}</Chip><label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={worker.enabled} onChange={event => updateWorker({ enabled: event.target.checked })} className="size-4 accent-volt" />Enabled</label>{settings.workers.length > 1 && <button aria-label="Remove selected worker" className="ml-auto text-ink-2 hover:text-ink" onClick={() => { setSettings({ ...settings, workers: settings.workers.filter((_, index) => index !== activeWorker) }); setActiveWorker(0); setProbe(null); setSaved(false); }}><Trash2 size={17} /></button>}</div>
      {probe && <p role="status" className={`mt-4 flex items-start gap-2 text-sm leading-relaxed ${probe.connected ? 'text-volt' : 'text-[#ffc3aa]'}`}>{probe.connected && <Check className="mt-0.5 size-4 shrink-0" />}{probe.connected ? `Connected to ComfyUI${probe.version ? ` ${probe.version}` : ''}. Model files are ready to choose in Models.` : probe.error || 'Could not connect. Check the address and that ComfyUI is running.'}</p>}
      {worker.location === "local" && hardware && hardware.gpus.length > 0 && <fieldset className="mt-8"><legend className="mb-3 text-sm font-medium">GPU used by this worker</legend><p className="mb-3 text-xs leading-relaxed text-ink-2">Select the GPU assigned to this ComfyUI process. Each image worker uses one GPU.</p><div className="space-y-3">{hardware.gpus.map(gpu => <label key={gpu.id} className="flex items-center gap-3 text-sm text-ink-2"><input type="radio" name="worker-gpu" className="size-4 accent-volt" checked={worker.deviceIds.includes(gpu.id)} onChange={() => updateWorker({ deviceIds: [gpu.id] })} />{gpu.name}</label>)}</div></fieldset>}
      </>}
      <details className="mt-8 border-t border-line pt-5"><summary className="text-sm text-ink-2">Resource limits</summary><div className="mt-5 grid gap-4 sm:grid-cols-3"><label className="field">Keep RAM free (GB)<input type="number" min={0} step={1} value={settings.policy.ramReserveBytes / gib} onChange={event => { setSettings({ ...settings, policy: { ...settings.policy, ramReserveBytes: Number(event.target.value) * gib } }); setSaved(false); }} /></label><label className="field">Keep VRAM free (GB)<input type="number" min={0} step={0.5} value={settings.policy.vramReserveBytes / gib} onChange={event => { setSettings({ ...settings, policy: { ...settings.policy, vramReserveBytes: Number(event.target.value) * gib } }); setSaved(false); }} /></label><label className="field">Concurrent jobs<input type="number" min={1} max={16} value={settings.policy.maxConcurrentJobs} onChange={event => { setSettings({ ...settings, policy: { ...settings.policy, maxConcurrentJobs: Number(event.target.value) } }); setSaved(false); }} /></label></div></details>
    </section>)}
    {step === 2 && <section><h2 className="text-lg font-medium">Image models</h2><p className="mb-6 mt-2 text-sm leading-relaxed text-ink-2">Choose a model and assign the files installed in ComfyUI. Models become available after their required files are configured.</p>
      <label className="field">Model<select value={selectedModel} onChange={event => setSelectedModel(event.target.value)}>{catalog?.models.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.family}</option>)}</select></label>
      {model && <><p className="my-4 text-sm text-ink-2">{model.description}</p><div className="space-y-4">{model.requiredArtifactRoles?.map(role => <label className="field" key={role}>{roleLabel(role)}<input list={`artifacts-${role}`} value={configuration?.artifacts[role] || ''} onChange={event => updateModel({ artifacts: { ...configuration?.artifacts, [role]: event.target.value } })} placeholder="Choose or enter the installed filename" /><datalist id={`artifacts-${role}`}>{probe?.artifacts?.[role]?.map(filename => <option key={filename} value={filename} />)}</datalist></label>)}</div><p className="mt-3 text-xs leading-relaxed text-ink-2">Use filenames relative to the matching ComfyUI model folder. Test the worker connection to see its installed files.</p><label className="field mt-6">Run on worker<select value={configuration?.workerIds[0] || worker?.id || ""} onChange={event => updateModel({ workerIds: [event.target.value] })}>{settings?.workers.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label><details className="mt-5"><summary className="text-sm text-ink-2">Model memory budget</summary><p className="my-3 text-xs leading-relaxed text-ink-2">Memory reserved while this model runs. Start with a conservative estimate for your model and resolution.</p><div className="grid grid-cols-2 gap-3"><label className="field">RAM (GB)<input type="number" min={0} step={1} value={(configuration?.memory.ramBytes || 0) / gib} onChange={event => updateModel({ memory: { vramBytes: configuration?.memory.vramBytes || 0, ramBytes: Number(event.target.value) * gib, source: "estimate" } })} /></label><label className="field">VRAM (GB)<input type="number" min={0} step={1} value={(configuration?.memory.vramBytes || 0) / gib} onChange={event => updateModel({ memory: { ramBytes: configuration?.memory.ramBytes || 0, vramBytes: Number(event.target.value) * gib, source: "estimate" } })} /></label></div></details><label className="mt-6 flex items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-volt" checked={configuration?.enabled ?? false} onChange={event => updateModel({ enabled: event.target.checked })} />Make this model available in Image</label></>}
      {!!settings?.modelConfigurations.filter(entry => entry.enabled).length && <div className="mt-8 border-t border-line pt-5"><p className="mb-3 text-sm font-medium">Enabled models</p><ul className="space-y-2 text-sm text-ink-2">{settings.modelConfigurations.filter(entry => entry.enabled).map(entry => <li key={entry.modelId}>{catalog?.models.find(model => model.id === entry.modelId)?.name || entry.modelId}</li>)}</ul></div>}
    </section>}
    {step === 3 && <ApiAccess />}
    </div>
    {step !== 3 && <div className="mt-9 flex flex-wrap items-center gap-4 border-t border-line pt-6">
      {onboarding && step < 2 ? <button onClick={() => setStep(step + 1)} className="ml-auto flex min-h-11 items-center gap-2 rounded-chip bg-volt px-5 text-sm font-semibold text-on-volt">{step === 0 ? 'Connect worker' : 'Choose models'}<ArrowRight size={16} /></button> : <><button disabled={saving || !settings} onClick={() => void save()} className="flex min-h-11 items-center gap-2 rounded-chip bg-volt px-5 text-sm font-semibold text-on-volt disabled:opacity-50">{saving && <LoaderCircle size={16} className="animate-spin" />}{saving ? 'Saving…' : 'Save configuration'}</button>{saved && <span role="status" className="text-sm text-volt">Configuration saved.</span>}{saved && <Link className="ml-auto flex items-center gap-2 text-sm hover:text-volt" href="/image" onClick={onFinished}>Start creating<ArrowRight size={16} /></Link>}</>}
    </div>}
  </div></div>;
}
