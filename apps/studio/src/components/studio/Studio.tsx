'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Boxes, HardDrive, LayoutGrid, Library, Rows3, Settings } from '@/components/ui/icons';
import { Logo } from '@/components/layout/Logo';
import { AccountButton } from '@/components/account/AccountButton';
import { imageBackground } from '@/lib/image-background';
import { IconChip } from '@/components/ui/Chip';
import { AuthPanel } from '@/components/setup/AuthPanel';
import { SettingsWorkspace, type SettingsSection } from '@/components/setup/SettingsWorkspace';
import { ModelLibrary, type ModelsSection } from '@/components/setup/ModelLibrary';
import { GalleryGrid } from '@/components/gallery/GalleryGrid';
import { AssetsBrowser } from '@/components/gallery/AssetsBrowser';
import { PromptDock, initialDraft, modelDraft, type Draft } from '@/components/prompt/PromptDock';
import { api, errorMessage, isConnectionError, type Bootstrap, type Catalog, type Job, type StudioState } from '@/lib/api';
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
  const [bootstrapError, setBootstrapError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [catalogError, setCatalogError] = useState<{ message: string; unavailable: boolean } | null>(null);
  const [connected, setConnected] = useState(false);
  const stateRevision = useRef(0);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [dockHeight, setDockHeight] = useState(170);
  const [zoom, setZoom] = useState(.35);
  const [square, setSquare] = useState(false);
  const [filter, setFilter] = useState<'all' | 'queue' | 'favorites'>('all');
  const [onboarding, setOnboarding] = useState(false);
  const [panel, setPanel] = useState<'settings' | 'models' | 'assets' | 'references' | null>(settingsPage ? 'settings' : modelsPage ? 'models' : null);
  const [visitedPanels, setVisitedPanels] = useState({ settings: settingsPage, models: modelsPage, assets: false });
  const openPanel = useCallback((next: 'settings' | 'models' | 'assets' | 'references') => {
    if (next !== 'references') setVisitedPanels(current => ({ ...current, [next]: true }));
    setPanel(next);
  }, []);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('gpus');
  const [modelsRequest, setModelsRequest] = useState<{ section: ModelsSection; revision: number }>();
  const assetsTrigger = useRef<HTMLButtonElement>(null);
  const modelsTrigger = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const closePanel = useCallback(() => {
    setPanel(null); setOnboarding(false);
    if (window.location.pathname === '/settings' || window.location.pathname === '/models') window.history.replaceState(window.history.state, '', '/image');
  }, []);
  const [signingOut, setSigningOut] = useState(false);
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [dockBusy, setDockBusy] = useState(false);
  const [assetsBusy, setAssetsBusy] = useState(false);
  const [upscaleBusy, setUpscaleBusy] = useState(false);
  const authenticated = !!bootstrap?.authenticated;
  const admin = authenticated && bootstrap?.user?.role === 'admin';
  const notifications = useJobNotifications(authenticated ? bootstrap?.user?.id || null : null, state?.jobs);
  const { updateAvailable } = usePwa();
  const { pushNotice } = notifications;
  useEffect(() => { if (authenticated && updateAvailable) pushNotice({ kind: 'info', title: 'An app update is ready', body: 'Open Account to reload when you are ready.' }); }, [authenticated, updateAvailable, pushNotice]);
  const pending = state?.jobs.filter(job => ['queued', 'preparing', 'running'].includes(job.status)) || [];
  const hasPending = useRef(false); hasPending.current = pending.length > 0;
  useEffect(() => {
    const userId = bootstrap?.authenticated ? bootstrap.user?.id : undefined;
    if (!userId) { setDraftOwner(null); return; }
    let restored = initialDraft;
    try {
      const value = JSON.parse(localStorage.getItem(`gravity:image-draft:${userId}`) || 'null');
      if (value && typeof value.modelId === 'string' && typeof value.prompt === 'string') {
        restored = { ...initialDraft, ...value, background: imageBackground(value.background), images: Array.isArray(value.images) ? value.images.filter((image: { id?: unknown; url?: unknown }) => typeof image.id === 'string' && typeof image.url === 'string' && image.url.startsWith('/api/inputs/')) : [] };
      }
    } catch { /* A blocked or full browser store does not prevent generation. */ }
    setDraft(restored);
    setDraftOwner(userId);
  }, [bootstrap?.authenticated, bootstrap?.user?.id]);
  useEffect(() => {
    if (!draftOwner || !bootstrap?.authenticated) return;
    try { localStorage.setItem(`gravity:image-draft:${draftOwner}`, JSON.stringify(draft)); } catch { /* Keep the current in-memory draft. */ }
  }, [draft, draftOwner, bootstrap?.authenticated]);
  const sessionExpired = useCallback(() => { setDraft(initialDraft); setDraftOwner(null); setPanel(null); setVisitedPanels({ settings: false, models: false, assets: false }); setSettingsSection('gpus'); setModelsRequest(undefined); setOnboarding(false); stateRevision.current++; setBootstrap(current => current ? { ...current, authenticated: false } : null); setState(null); setConnected(false); setConnectionError(''); setCatalogError(null); }, []);
  const favorites = useFavorites(authenticated ? bootstrap?.user?.id || null : null, sessionExpired);
  const checkSession = useCallback(async () => {
    setBootstrapError('');
    try { setBootstrap(await api<Bootstrap>('/bootstrap')); }
    catch (error) { setBootstrapError(errorMessage(error)); }
  }, []);
  const refresh = useCallback(async () => {
    const revision = ++stateRevision.current;
    try { const next = await api<StudioState>('/state'); if (revision !== stateRevision.current) return; setState(next); setConnected(true); setConnectionError(''); }
    catch (error) { if (revision !== stateRevision.current) return; setConnected(false); setConnectionError(errorMessage(error)); if ((error as { status?: number }).status === 401) sessionExpired(); }
  }, [sessionExpired]);
  const refreshCatalog = useCallback(async () => {
    try {
      const next = await api<Catalog>('/catalog'); setCatalog(next); setCatalogError(null);
      setDraft(current => { if (current.modelId) return current; const first = next.models.find(model => model.ready); return first ? modelDraft(current, first) : current; });
    } catch (error) {
      if ((error as { status?: number }).status === 401) { sessionExpired(); return; }
      setCatalogError({ message: errorMessage(error), unavailable: isConnectionError(error) });
    }
  }, [sessionExpired]);
  const refreshActivity = useCallback(async () => { await Promise.all([refresh(), refreshCatalog(), favorites.refresh()]); }, [refresh, refreshCatalog, favorites.refresh]);
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
  const showSettings = admin && panel === 'settings';
  const showModels = admin && panel === 'models';
  async function signOut() {
    setSigningOut(true);
    try { await api('/logout', { method: 'POST', body: '{}', signal: AbortSignal.timeout(30_000) }); setDraft(initialDraft); sessionExpired(); }
    finally { setSigningOut(false); }
  }
  function reuse(job: Job) {
    if (job.input?.operation === 'upscale') return;
    setDraft(current => ({ ...current, modelId: job.modelId, prompt: job.prompt, aspect: 'custom', quality: 'custom', ...job.parameters, background: imageBackground(job.parameters.background), negativePrompt: job.parameters.negativePrompt || '', seed: String(job.parameters.seed), images: [] }));
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
  const upscaleActions = {
    onSubmitted: (job: Job) => {
      stateRevision.current++;
      setState(current => current ? { ...current, jobs: [job, ...current.jobs.filter(entry => entry.id !== job.id)] } : current);
      setFilter('all'); closePanel(); void refresh();
      pushNotice({ kind: 'success', title: 'Upscale queued', body: `${job.modelName || job.modelId}${job.input?.operation === 'upscale' ? ` · ${job.input.scale}×` : ''}` });
    },
    onManage: admin ? () => { setModelsRequest(current => ({ section: 'tools', revision: (current?.revision || 0) + 1 })); openPanel('models'); } : undefined,
    onSessionExpired: sessionExpired,
    onBusyChange: setUpscaleBusy,
  };
  if (!bootstrap) return <main className="flex min-h-dvh items-center justify-center px-5"><div className="max-w-md text-center"><Logo className="mx-auto mb-6 size-9 text-volt" />{bootstrapError ? <><p role="alert" className="error-notice">{bootstrapError}</p><button onClick={() => void checkSession()} className="mt-5 rounded-chip bg-chip px-5 py-3 text-sm">Try again</button></> : <p role="status" className="text-sm text-ink-2">Opening your studio…</p>}</div></main>;
  if (!authenticated) return <AuthPanel setup={!bootstrap.configured} onAuthenticated={() => { if (!bootstrap.configured) { setOnboarding(true); openPanel('settings'); } void checkSession(); }} />;
  return <div key={bootstrap.user?.id} className="flex h-dvh flex-col overflow-hidden">
    <header className="titlebar sticky top-0 z-40 flex h-[52px] shrink-0 items-center gap-1 bg-void pl-4 pr-3 max-md:h-auto max-md:flex-wrap max-md:py-2">
      <Link href="/image" onClick={event => { event.preventDefault(); closePanel(); }} aria-label="Gravity Studio" className="mr-3 shrink-0 text-ink transition-colors hover:text-volt"><Logo className="size-6" /></Link>
      <nav aria-label="Studio" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto max-md:order-last max-md:basis-full max-md:py-2">
        {['Explore', 'Image', 'Edit', 'Video', 'Cinema Studio', 'Audio', 'Music', '3D'].map(category => <div key={category} className="flex shrink-0 items-center">
          {category === 'Image' && <span aria-hidden="true" className="mx-2 h-4 w-px bg-line-2" />}
          {category === 'Image'
            ? <Link href="/image" onClick={event => { event.preventDefault(); closePanel(); }} aria-current="page" className="flex items-center whitespace-nowrap rounded-lg px-2 py-1 text-[14px] font-medium leading-none text-volt">{category}</Link>
            : <button type="button" disabled className="flex cursor-default items-center whitespace-nowrap rounded-lg px-2 py-1 text-[14px] font-medium leading-none text-ink-3">{category}</button>}
        </div>)}
      </nav>
      <div className="ml-2 flex shrink-0 items-center gap-1 max-md:ml-auto max-sm:gap-0">
        <ServerActivity admin={admin} state={state} connected={connected} connectionError={connectionError || (catalogError?.unavailable ? catalogError.message : '') || favorites.connectionError} onRefresh={refreshActivity} />
        <NotificationsPopover connected={connected} {...notifications} />
        <IconChip ref={assetsTrigger} onClick={() => openPanel('assets')} active={panel === 'assets'} aria-label="Assets" title="Assets" aria-haspopup="dialog" aria-expanded={panel === 'assets'} aria-controls={panel === 'assets' ? "assets-browser-dialog" : undefined} className="rounded-lg [&_svg]:size-5"><Library aria-hidden="true" /></IconChip>
        {admin && <IconChip ref={modelsTrigger} onClick={() => openPanel('models')} active={showModels} aria-label="Models" title="Models" aria-haspopup="dialog" aria-expanded={showModels} aria-controls={showModels ? "models-dialog" : undefined} className="rounded-lg [&_svg]:size-5"><HardDrive aria-hidden="true" /></IconChip>}
        {admin && <IconChip ref={settingsTrigger} onClick={() => openPanel('settings')} active={showSettings} aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-expanded={showSettings} aria-controls={showSettings ? "settings-dialog" : undefined} className="rounded-lg [&_svg]:size-5"><Settings aria-hidden="true" /></IconChip>}
        {bootstrap.user && <AccountButton user={bootstrap.user} signingOut={signingOut} onSignOut={signOut} onSessionExpired={sessionExpired} appBusy={pending.length > 0 || dockBusy || assetsBusy || upscaleBusy} alertSettings={notifications} onNotice={(title, body) => pushNotice({ kind: 'success', title, body })} />}
      </div>
    </header>
    {catalogError && !catalogError.unavailable && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 border-y border-[#e8997038] bg-[#67412c33] px-4 py-2 text-xs text-[#ffc3aa]"><span>{catalogError.message}</span><button className="shrink-0 underline underline-offset-3" onClick={() => void refreshCatalog()}>Try again</button></div>}
    <main className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5"><div className="flex rounded-[10px] bg-panel-2 p-1" role="group" aria-label="Image filter">{([{ id: 'all', label: 'All images' }, { id: 'queue', label: `Queue${pending.length ? ` ${pending.length}` : ''}` }, { id: 'favorites', label: 'Favorites' }] as const).map(view => <button key={view.id} onClick={() => setFilter(view.id)} aria-pressed={filter === view.id} className={`rounded-lg px-3 py-1.5 text-xs ${filter === view.id ? 'bg-chip text-ink' : 'text-ink-2 hover:text-ink'}`}>{view.label}</button>)}</div><div className="ml-auto flex items-center gap-3"><span className="hidden text-xs tabular-nums text-ink-2 sm:inline">{imageCount} image{imageCount === 1 ? '' : 's'}</span><label className="hidden items-center gap-2 md:flex"><span className="sr-only">Image tile size</span><input type="range" aria-label="Image tile size" min={0} max={1} step={.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} className="w-[90px]" /></label><div className="flex rounded-[10px] bg-panel-2 p-1"><button onClick={() => setSquare(false)} aria-pressed={!square} aria-label="Justified image layout" title="Justified layout" className={`grid size-7 place-items-center rounded-lg ${!square ? 'bg-chip text-ink' : 'text-ink-2'}`}><Rows3 size={15} /></button><button onClick={() => setSquare(true)} aria-pressed={square} aria-label="Square image layout" title="Square layout" className={`grid size-7 place-items-center rounded-lg ${square ? 'bg-chip text-ink' : 'text-ink-2'}`}><LayoutGrid size={15} /></button></div></div></div>
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingBottom: dockHeight, scrollPaddingBottom: dockHeight }}>{favorites.error && <p role="alert" className="error-notice mx-4 my-3">{favorites.error}<button type="button" onClick={favorites.retry} className="ml-3 underline">Try again</button></p>}{filter === 'favorites' && !favorites.ready ? favorites.loading && <p role="status" className="px-6 py-12 text-center text-sm text-ink-2">Loading favorites…</p> : <GalleryGrid upscale={upscaleActions} onDelete={deleteOutput} filter={filter} onFavorite={favorites.toggle} favoriteBusy={favorites.pending} favoriteError={favorites.error} jobs={jobs} models={catalog.models} zoom={zoom} square={square} onReuse={reuse} onChange={() => void refresh()} configured={catalog.models.some(model => model.ready)} hasWorkers={!!state?.workers.some(worker => worker.enabled)} onOpenModels={admin ? () => openPanel('models') : undefined} onOpenSettings={admin ? () => openPanel('settings') : undefined} />}</div>
        <PromptDock browsing={panel === 'references'} onBrowse={() => openPanel('references')} onCloseAssets={closePanel} onBusyChange={setDockBusy} sessionIdentity={bootstrap.user?.id} onOpenAssistantSettings={admin ? () => { setSettingsSection('assistant'); openPanel('settings'); } : undefined} favoriteError={favorites.error} onOpenModels={admin ? () => openPanel('models') : undefined} jobs={assetJobs} models={catalog.models} draft={draft} setDraft={setDraft} connected={connected} onHeight={setDockHeight} onSessionExpired={sessionExpired} onSubmitted={job => { setState(current => current ? { ...current, jobs: [job, ...current.jobs.filter(entry => entry.id !== job.id)] } : current); void refresh(); }} />
    </main>
    {admin && visitedPanels.settings && <StudioDialog panel="settings" open={showSettings} title={onboarding ? 'Set up your studio' : 'Settings'} description="Choose your GPUs and manage generation." icon={<Settings size={22} aria-hidden="true" />} onClose={closePanel} triggerRef={settingsTrigger}>
      <SettingsWorkspace activeWork={pending.length > 0 || dockBusy || assetsBusy || upscaleBusy} active={showSettings} section={settingsSection} onSectionChange={setSettingsSection} initialHardware={state?.hardware || null} onboarding={onboarding} onFinished={closePanel} onSaved={() => { void refreshCatalog(); void refresh(); }} />
    </StudioDialog>}
    {admin && visitedPanels.models && <StudioDialog panel="models" open={showModels} title="Models" description="Manage image and language models." icon={<Boxes size={22} aria-hidden="true" />} onClose={closePanel} triggerRef={modelsTrigger}>
      <ModelLibrary requestedSection={modelsRequest} active={showModels} onConfigureText={() => { setSettingsSection('integrations'); openPanel('settings'); }} onChanged={() => { void refreshCatalog(); void refresh(); }} />
    </StudioDialog>}
    {visitedPanels.assets && <AssetsBrowser upscale={upscaleActions} open={panel === 'assets'} triggerRef={assetsTrigger} jobs={assetJobs} models={catalog.models} onClose={closePanel} onReuse={reuse} onFavorite={favorites.toggle} favoriteBusy={favorites.pending} favoriteError={favorites.error} onDeleteOutput={deleteOutput} onInputDeleted={id => setDraft(current => ({ ...current, images: current.images.filter(image => image.id !== id) }))} onSessionExpired={sessionExpired} onBusyChange={setAssetsBusy} />}
    <Toasts items={notifications.notices} onDismiss={notifications.dismissNotice} bottom={dockHeight + 12} />
  </div>;
}
