'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Boxes, HardDrive, LayoutGrid, LoaderCircle, LogOut, Rows3, Settings, UserRound } from '@/components/ui/icons';
import { Logo } from '@/components/layout/Logo';
import { Popover } from '@/components/ui/Popover';
import { IconChip } from '@/components/ui/Chip';
import { AuthPanel } from '@/components/setup/AuthPanel';
import { SettingsWorkspace, type SettingsSection } from '@/components/setup/SettingsWorkspace';
import { ModelLibrary } from '@/components/setup/ModelLibrary';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { PromptDock, initialDraft, modelDraft, type Draft } from '@/components/prompt/PromptDock';
import { api, errorMessage, type Bootstrap, type Catalog, type Job, type StudioState } from '@/lib/api';
import { favoriteKey, useFavorites } from '@/lib/use-favorites';
import { useJobNotifications } from '@/lib/completion-alerts';
import { usePwa } from '@/lib/use-pwa';
import { NotificationsPopover } from '@/components/system/NotificationsPopover';
import { Toasts } from '@/components/system/Toasts';
import { ServerActivity } from './ServerActivity';
import { StudioDialog } from './StudioDialog';

export function Studio({ settings: settingsPage = false, models: modelsPage = false }: { settings?: boolean; models?: boolean }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [state, setState] = useState<StudioState | null>(null);
  const [catalog, setCatalog] = useState<Catalog>({ models: [], families: [] });
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const stateRevision = useRef(0);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [dockHeight, setDockHeight] = useState(170);
  const [zoom, setZoom] = useState(.35);
  const [square, setSquare] = useState(false);
  const [filter, setFilter] = useState<'all' | 'queue' | 'favorites'>('all');
  const [onboarding, setOnboarding] = useState(false);
  const [panel, setPanel] = useState<'settings' | 'models' | null>(settingsPage ? 'settings' : modelsPage ? 'models' : null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('gpus');
  const modelsTrigger = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const closePanel = useCallback(() => {
    setPanel(null); setOnboarding(false); setSettingsSection('gpus');
    if (window.location.pathname === '/settings' || window.location.pathname === '/models') window.history.replaceState(window.history.state, '', '/image');
  }, []);
  const [signingOut, setSigningOut] = useState(false);
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [dockBusy, setDockBusy] = useState(false);
  const authenticated = !!bootstrap?.authenticated;
  const notifications = useJobNotifications(authenticated ? bootstrap?.user?.id || null : null, state?.jobs);
  const { updateAvailable } = usePwa();
  const { pushNotice } = notifications;
  useEffect(() => { if (authenticated && updateAvailable) pushNotice({ kind: 'info', title: 'An app update is ready', body: 'Open Settings → App to reload when you are ready.' }); }, [authenticated, updateAvailable, pushNotice]);
  const pending = state?.jobs.filter(job => ['queued', 'preparing', 'running'].includes(job.status)) || [];
  const hasPending = useRef(false); hasPending.current = pending.length > 0;
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
  const sessionExpired = useCallback(() => { stateRevision.current++; setBootstrap(current => current ? { ...current, authenticated: false } : null); setState(null); setConnected(false); }, []);
  const favorites = useFavorites(authenticated ? bootstrap?.user?.id || null : null, sessionExpired);
  const checkSession = useCallback(async () => {
    setError('');
    try { setBootstrap(await api<Bootstrap>('/bootstrap')); }
    catch (error) { setError(errorMessage(error)); }
  }, []);
  const refresh = useCallback(async () => {
    const revision = ++stateRevision.current;
    try { const next = await api<StudioState>('/state'); if (revision !== stateRevision.current) return; setState(next); setConnected(true); setError(''); }
    catch (error) { if (revision !== stateRevision.current) return; setConnected(false); setError(errorMessage(error)); if ((error as { status?: number }).status === 401) sessionExpired(); }
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
    const wake = () => {
      if (document.visibilityState === 'visible') { void refresh(); void refreshCatalog(); }
      else if (hasPending.current) void refresh();
    };
    const interval = setInterval(wake, 3000);
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', wake); };
  }, [authenticated, refresh, refreshCatalog]);
  const allJobs = useMemo(() => (state?.jobs || []).map(job => ({ ...job, outputs: job.outputs.map(output => ({ ...output, favorite: favorites.ready ? favorites.keys.has(favoriteKey(job.id, output.id)) : !!output.favorite })) })), [state?.jobs, favorites.ready, favorites.keys]);
  const assetJobs = useMemo(() => [...allJobs, ...favorites.jobs.filter(job => !allJobs.some(entry => entry.id === job.id))], [allJobs, favorites.jobs]);
  const jobs = filter === 'favorites' ? favorites.jobs : filter === 'queue' ? allJobs.filter(job => job.status !== 'succeeded' && job.status !== 'cancelled') : allJobs;
  const imageCount = jobs.reduce((total, job) => total + job.outputs.filter(output => output.mimeType.startsWith('image/')).length, 0);
  const showSettings = panel === 'settings';
  const showModels = panel === 'models';
  async function signOut() {
    setSigningOut(true);
    try { await api('/logout', { method: 'POST', body: '{}' }); setDraft(initialDraft); sessionExpired(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSigningOut(false); }
  }
  function reuse(job: Job) {
    setDraft(current => ({ ...current, modelId: job.modelId, prompt: job.prompt, aspect: 'custom', ...job.parameters, negativePrompt: job.parameters.negativePrompt || '', seed: String(job.parameters.seed), images: [] }));
    document.getElementById('image-prompt')?.focus();
  }
  async function deleteOutput(job: Job, output: Job['outputs'][number]) {
    try {
      await api<{ job: Job }>(`/jobs/${encodeURIComponent(job.id)}/outputs/${encodeURIComponent(output.id)}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) });
      stateRevision.current++;
      setState(current => current ? { ...current, jobs: current.jobs.map(entry => entry.id === job.id ? { ...entry, outputs: entry.outputs.filter(saved => saved.id !== output.id) } : entry) } : current);
      favorites.forgetOutput(job.id, output.id);
      void refresh();
    } catch (error) {
      if ((error as { status?: number }).status === 401) sessionExpired();
      throw error;
    }
  }
  if (!bootstrap) return <main className="flex min-h-dvh items-center justify-center px-5"><div className="max-w-md text-center"><Logo className="mx-auto mb-6 size-9 text-volt" />{error ? <><p role="alert" className="error-notice">{error}</p><button onClick={() => void checkSession()} className="mt-5 rounded-chip bg-chip px-5 py-3 text-sm">Try again</button></> : <p role="status" className="text-sm text-ink-2">Opening your studio…</p>}</div></main>;
  if (!authenticated) return <AuthPanel setup={!bootstrap.configured} onAuthenticated={() => { if (!bootstrap.configured) { setOnboarding(true); setPanel('settings'); } void checkSession(); }} />;
  return <div className="flex h-dvh flex-col overflow-hidden">
    <header className="titlebar sticky top-0 z-40 flex h-[52px] shrink-0 items-center gap-1 bg-void pl-4 pr-3">
      <Link href="/image" onClick={event => { event.preventDefault(); closePanel(); }} aria-label="Gravity Studio" className="mr-3 shrink-0 text-ink transition-colors hover:text-volt"><Logo className="size-6" /></Link>
      <nav aria-label="Studio" className="flex min-w-0 flex-1 items-center gap-1"><Link href="/image" onClick={event => { event.preventDefault(); closePanel(); }} aria-current="page" className="rounded-lg px-2 py-2 text-[14px] font-medium text-volt">Image</Link></nav>
      <ServerActivity state={state} connected={connected} onRefresh={() => void refresh()} onSettings={() => setPanel('settings')} />
      <NotificationsPopover connected={connected} {...notifications} />
      <IconChip ref={modelsTrigger} onClick={() => setPanel('models')} active={showModels} aria-label="Models" title="Models" aria-haspopup="dialog" aria-expanded={showModels} aria-controls={showModels ? "models-dialog" : undefined} className="rounded-lg [&_svg]:size-5"><HardDrive aria-hidden="true" /></IconChip>
      <IconChip ref={settingsTrigger} onClick={() => setPanel('settings')} active={showSettings} aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-expanded={showSettings} aria-controls={showSettings ? "settings-dialog" : undefined} className="rounded-lg [&_svg]:size-5"><Settings aria-hidden="true" /></IconChip>
      <Popover label="Account" side="bottom" align="end" width={220} trigger={({ open, triggerProps }) => <IconChip {...triggerProps} active={open} aria-label="Account"><UserRound /></IconChip>}>{() => <button disabled={signingOut} onClick={() => void signOut()} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-chip disabled:opacity-50">{signingOut ? <LoaderCircle className="size-4 animate-spin" /> : <LogOut size={16} />}{signingOut ? 'Signing out…' : 'Sign out'}</button>}</Popover>
    </header>
    {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-y border-[#e8997038] bg-[#67412c33] px-4 py-2 text-xs text-[#ffc3aa]"><span>{error}</span><button className="shrink-0 underline underline-offset-3" onClick={() => { void refresh(); void refreshCatalog(); }}>Try again</button></div>}
    <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5"><div className="flex rounded-[10px] bg-panel-2 p-1" role="group" aria-label="Image filter">{([{ id: 'all', label: 'All images' }, { id: 'queue', label: `Queue${pending.length ? ` ${pending.length}` : ''}` }, { id: 'favorites', label: 'Favorites' }] as const).map(view => <button key={view.id} onClick={() => setFilter(view.id)} aria-pressed={filter === view.id} className={`rounded-lg px-3 py-1.5 text-xs ${filter === view.id ? 'bg-chip text-ink' : 'text-ink-2 hover:text-ink'}`}>{view.label}</button>)}</div><div className="ml-auto flex items-center gap-3"><span className="hidden text-xs tabular-nums text-ink-2 sm:inline">{imageCount} image{imageCount === 1 ? '' : 's'}</span><label className="hidden items-center gap-2 md:flex"><span className="sr-only">Image tile size</span><input type="range" aria-label="Image tile size" min={0} max={1} step={.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} className="w-[90px]" /></label><div className="flex rounded-[10px] bg-panel-2 p-1"><button onClick={() => setSquare(false)} aria-pressed={!square} aria-label="Justified image layout" title="Justified layout" className={`grid size-7 place-items-center rounded-lg ${!square ? 'bg-chip text-ink' : 'text-ink-2'}`}><Rows3 size={15} /></button><button onClick={() => setSquare(true)} aria-pressed={square} aria-label="Square image layout" title="Square layout" className={`grid size-7 place-items-center rounded-lg ${square ? 'bg-chip text-ink' : 'text-ink-2'}`}><LayoutGrid size={15} /></button></div></div></div>
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingBottom: dockHeight }}>{favorites.error && <p role="alert" className="error-notice mx-4 my-3">{favorites.error}<button type="button" onClick={favorites.retry} className="ml-3 underline">Try again</button></p>}{filter === 'favorites' && !favorites.ready ? favorites.loading && <p role="status" className="px-6 py-12 text-center text-sm text-ink-2">Loading favorites…</p> : <GalleryGrid onDelete={deleteOutput} filter={filter} onFavorite={favorites.toggle} favoriteBusy={favorites.pending} favoriteError={favorites.error} jobs={jobs} models={catalog.models} zoom={zoom} square={square} onReuse={reuse} onChange={() => void refresh()} configured={catalog.models.some(model => model.ready)} hasWorkers={!!state?.workers.some(worker => worker.enabled)} onOpenModels={() => setPanel('models')} onOpenSettings={() => setPanel('settings')} />}</div>
        <PromptDock onBusyChange={setDockBusy} sessionIdentity={bootstrap.user?.id} onOpenAssistantSettings={() => { setSettingsSection('assistant'); setPanel('settings'); }} favoriteError={favorites.error} onOpenModels={() => setPanel('models')} jobs={assetJobs} models={catalog.models} draft={draft} setDraft={setDraft} connected={connected} onHeight={setDockHeight} onSessionExpired={sessionExpired} onSubmitted={job => { setState(current => current ? { ...current, jobs: [job, ...current.jobs.filter(entry => entry.id !== job.id)] } : current); void refresh(); }} />
    </main>
    {showSettings && <StudioDialog panel="settings" title={onboarding ? 'Set up your studio' : 'Settings'} description="Choose your GPUs and manage generation." icon={<Settings size={22} aria-hidden="true" />} onClose={closePanel} triggerRef={settingsTrigger}>
      <SettingsWorkspace activeWork={pending.length > 0 || dockBusy} initialSection={settingsSection} initialHardware={state?.hardware || null} onboarding={onboarding} onFinished={closePanel} onSaved={() => { void refreshCatalog(); void refresh(); }} />
    </StudioDialog>}
    {showModels && <StudioDialog panel="models" title="Models" description="Manage image and language models." icon={<Boxes size={22} aria-hidden="true" />} onClose={closePanel} triggerRef={modelsTrigger}>
      <ModelLibrary onConfigureText={() => { setSettingsSection('integrations'); setPanel('settings'); }} onChanged={() => { void refreshCatalog(); void refresh(); }} />
    </StudioDialog>}
    <Toasts items={notifications.notices} onDismiss={notifications.dismissNotice} bottom={dockHeight + 12} />
  </div>;
}
