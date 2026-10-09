'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, Cpu, LayoutGrid, LoaderCircle, LogOut, Rows3, Settings2, UserRound } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { Popover } from '@/components/ui/Popover';
import { Chip, IconChip } from '@/components/ui/Chip';
import { AuthPanel } from '@/components/setup/AuthPanel';
import { SettingsWorkspace } from '@/components/setup/SettingsWorkspace';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { PromptDock, initialDraft, modelDraft, type Draft } from '@/components/prompt/PromptDock';
import { api, bytes, errorMessage, type Bootstrap, type Catalog, type Job, type StudioState } from '@/lib/api';
import { ResolveJobButton } from './ResolveJobButton';

export function Studio({ settings: settingsPage = false }: { settings?: boolean }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [state, setState] = useState<StudioState | null>(null);
  const [catalog, setCatalog] = useState<Catalog>({ models: [], families: [] });
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [dockHeight, setDockHeight] = useState(170);
  const [zoom, setZoom] = useState(.35);
  const [square, setSquare] = useState(false);
  const [queueOnly, setQueueOnly] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const authenticated = !!bootstrap?.authenticated;
  useEffect(() => {
    const userId = bootstrap?.authenticated ? bootstrap.user?.id : undefined;
    if (!userId) { setDraftOwner(null); return; }
    try {
      const value = JSON.parse(localStorage.getItem(`gravity:image-draft:${userId}`) || 'null');
      if (value && typeof value.modelId === 'string' && typeof value.prompt === 'string') {
        setDraft({ ...initialDraft, ...value, images: Array.isArray(value.images) ? value.images.filter((image: { id?: unknown; url?: unknown }) => typeof image.id === 'string' && typeof image.url === 'string' && image.url.startsWith('/api/inputs/')) : [] });
      }
    } catch { /* A blocked or full browser store does not prevent generation. */ }
    setDraftOwner(userId);
  }, [bootstrap?.authenticated, bootstrap?.user?.id]);
  useEffect(() => {
    if (!draftOwner || !bootstrap?.authenticated) return;
    try { localStorage.setItem(`gravity:image-draft:${draftOwner}`, JSON.stringify(draft)); } catch { /* Keep the current in-memory draft. */ }
  }, [draft, draftOwner, bootstrap?.authenticated]);
  const sessionExpired = useCallback(() => { setBootstrap(current => current ? { ...current, authenticated: false } : null); setState(null); setConnected(false); }, []);
  const checkSession = useCallback(async () => {
    setError('');
    try { setBootstrap(await api<Bootstrap>('/bootstrap')); }
    catch (error) { setError(errorMessage(error)); }
  }, []);
  const refresh = useCallback(async () => {
    try { const next = await api<StudioState>('/state'); setState(next); setConnected(true); setError(''); }
    catch (error) { setConnected(false); setError(errorMessage(error)); if ((error as { status?: number }).status === 401) sessionExpired(); }
  }, [sessionExpired]);
  const refreshCatalog = useCallback(async () => {
    try {
      const next = await api<Catalog>('/catalog'); setCatalog(next);
      setDraft(current => { if (current.modelId) return current; const first = next.models.find(model => model.ready); return first ? modelDraft(current, first) : current; });
    } catch (error) { setError(errorMessage(error)); }
  }, []);
  useEffect(() => { void checkSession(); }, [checkSession]);
  useEffect(() => {
    if (!authenticated) return;
    void refresh(); void refreshCatalog();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 3000);
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', wake); };
  }, [authenticated, refresh, refreshCatalog]);
  const pending = state?.jobs.filter(job => ['queued', 'preparing', 'running'].includes(job.status)) || [];
  const jobs = (queueOnly ? state?.jobs.filter(job => job.status !== 'succeeded' && job.status !== 'cancelled') : state?.jobs) || [];
  const imageCount = state?.jobs.reduce((total, job) => total + job.outputs.filter(output => output.mimeType.startsWith('image/')).length, 0) || 0;
  const showSettings = settingsPage || onboarding;
  async function signOut() {
    setSigningOut(true);
    try { await api('/logout', { method: 'POST', body: '{}' }); setDraft(initialDraft); sessionExpired(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSigningOut(false); }
  }
  function reuse(job: Job) {
    setDraft(current => ({ ...current, modelId: job.modelId, prompt: job.prompt, ...job.parameters, negativePrompt: job.parameters.negativePrompt || '', seed: String(job.parameters.seed), images: [] }));
    document.getElementById('image-prompt')?.focus();
  }
  if (!bootstrap) return <main className="flex min-h-dvh items-center justify-center px-5"><div className="max-w-md text-center"><Logo className="mx-auto mb-6 size-9 text-volt" />{error ? <><p role="alert" className="error-notice">{error}</p><button onClick={() => void checkSession()} className="mt-5 rounded-chip bg-chip px-5 py-3 text-sm">Try again</button></> : <p role="status" className="text-sm text-ink-2">Opening your studio…</p>}</div></main>;
  if (!authenticated) return <AuthPanel setup={!bootstrap.configured} onAuthenticated={() => { if (!bootstrap.configured) setOnboarding(true); void checkSession(); }} />;
  return <div className="flex h-dvh flex-col overflow-hidden">
    <header className="titlebar sticky top-0 z-40 flex h-[52px] shrink-0 items-center gap-1 bg-void pl-4 pr-3">
      <Link href="/image" onClick={() => setOnboarding(false)} aria-label="Gravity Studio" className="mr-3 shrink-0 text-ink transition-colors hover:text-volt"><Logo className="size-6" /></Link>
      <nav aria-label="Studio" className="flex min-w-0 flex-1 items-center gap-1"><Link href="/image" onClick={() => setOnboarding(false)} aria-current={!showSettings ? 'page' : undefined} className={`rounded-lg px-2 py-2 text-[14px] font-medium ${!showSettings ? 'text-volt' : 'text-ink-2 hover:text-ink'}`}>Image</Link><Link href="/settings" aria-current={showSettings ? 'page' : undefined} className={`rounded-lg px-2 py-2 text-[14px] font-medium ${showSettings ? 'text-volt' : 'text-ink-2 hover:text-ink'}`}><span className="hidden sm:inline">Hardware & setup</span><span className="sm:hidden">Setup</span></Link></nav>
      <Popover label="Server activity" title="Activity" width={350} side="bottom" align="end" trigger={({ open, triggerProps }) => <Chip {...triggerProps} active={open} icon={<Activity />} aria-label={`Activity: ${pending.length} active jobs`} className="bg-transparent! text-[12px]"><span className="hidden sm:inline">Activity</span>{pending.length ? <span className="ml-1 tabular-nums">{pending.length}</span> : null}</Chip>}>
        {() => <div className="px-2 pb-2 text-sm"><p className="mb-4 text-ink-2">{connected ? `${pending.length} job${pending.length === 1 ? '' : 's'} in progress` : 'Server disconnected'}</p>{pending.filter(job => job.status === 'interrupted').map(job => <div key={job.id} className="border-t border-line py-3"><p className="line-clamp-2 text-xs leading-relaxed">{job.prompt}</p><p className="mt-1 text-xs text-ink-2">Connection uncertain</p><ResolveJobButton job={job} onChange={() => void refresh()} /></div>)}{state?.hardware && <><div className="flex justify-between gap-3 border-t border-line py-3 text-xs"><span className="text-ink-2">Available RAM</span><span className="tabular-nums">{bytes(state.hardware.host.memory.availableBytes)} / {bytes(state.hardware.host.memory.totalBytes)}</span></div>{state.hardware.gpus.map(gpu => <div key={gpu.id} className="flex items-center gap-3 border-t border-line py-3"><Cpu className="size-4 shrink-0 text-ink-2" /><span className="min-w-0 flex-1 truncate text-xs">{gpu.name}</span><span className="text-xs tabular-nums text-ink-2">{bytes(gpu.memory?.totalBytes)}</span></div>)}</>}{!state?.hardware && <p className="text-xs text-ink-2">Hardware information is unavailable.</p>}<Link href="/settings" className="mt-3 inline-flex items-center gap-2 text-xs text-ink-2 hover:text-ink"><Settings2 size={14} />Manage hardware</Link></div>}
      </Popover>
      <Popover label="Account" side="bottom" align="end" width={220} trigger={({ open, triggerProps }) => <IconChip {...triggerProps} active={open} aria-label="Account"><UserRound /></IconChip>}>{() => <button disabled={signingOut} onClick={() => void signOut()} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-chip disabled:opacity-50">{signingOut ? <LoaderCircle className="size-4 animate-spin" /> : <LogOut size={16} />}{signingOut ? 'Signing out…' : 'Sign out'}</button>}</Popover>
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-y border-[#e8997038] bg-[#67412c33] px-4 py-2 text-xs text-[#ffc3aa]"><span>{error}</span><button className="shrink-0 underline underline-offset-3" onClick={() => { void refresh(); void refreshCatalog(); }}>Try again</button></div>}
    <main className="relative flex min-h-0 flex-1 flex-col">
      {showSettings ? <SettingsWorkspace initialHardware={state?.hardware || null} onboarding={onboarding} onFinished={() => setOnboarding(false)} onSaved={() => { void refreshCatalog(); void refresh(); }} /> : <>
        <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5"><div className="flex rounded-[10px] bg-panel-2 p-1" aria-label="Image filter"><button onClick={() => setQueueOnly(false)} aria-pressed={!queueOnly} className={`rounded-lg px-3 py-1.5 text-xs ${!queueOnly ? 'bg-chip text-ink' : 'text-ink-2 hover:text-ink'}`}>All images</button><button onClick={() => setQueueOnly(true)} aria-pressed={queueOnly} className={`rounded-lg px-3 py-1.5 text-xs ${queueOnly ? 'bg-chip text-ink' : 'text-ink-2 hover:text-ink'}`}>Queue{pending.length ? ` ${pending.length}` : ''}</button></div><div className="ml-auto flex items-center gap-3"><span className="hidden text-xs tabular-nums text-ink-2 sm:inline">{imageCount} image{imageCount === 1 ? '' : 's'}</span><label className="hidden items-center gap-2 md:flex"><span className="sr-only">Image tile size</span><input type="range" aria-label="Image tile size" min={0} max={1} step={.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} className="w-[90px]" /></label><div className="flex rounded-[10px] bg-panel-2 p-1"><button onClick={() => setSquare(false)} aria-pressed={!square} aria-label="Justified image layout" title="Justified layout" className={`grid size-7 place-items-center rounded-lg ${!square ? 'bg-chip text-ink' : 'text-ink-2'}`}><Rows3 size={15} /></button><button onClick={() => setSquare(true)} aria-pressed={square} aria-label="Square image layout" title="Square layout" className={`grid size-7 place-items-center rounded-lg ${square ? 'bg-chip text-ink' : 'text-ink-2'}`}><LayoutGrid size={15} /></button></div></div></div>
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingBottom: dockHeight }}><GalleryGrid jobs={jobs} models={catalog.models} zoom={zoom} square={square} onReuse={reuse} onChange={() => void refresh()} configured={catalog.models.some(model => model.ready)} /></div>
        <PromptDock jobs={state?.jobs || []} models={catalog.models} draft={draft} setDraft={setDraft} connected={connected} onHeight={setDockHeight} onSessionExpired={sessionExpired} onSubmitted={job => { setState(current => current ? { ...current, jobs: [job, ...current.jobs.filter(entry => entry.id !== job.id)] } : current); void refresh(); }} />
      </>}
    </main>
  </div>;
}
