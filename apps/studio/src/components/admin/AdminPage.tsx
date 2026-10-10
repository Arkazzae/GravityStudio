'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Logo } from '@/components/layout/Logo';
import { ArrowRight, Boxes, Clock3, Mail, Plus, Settings, Shield, Users } from '@/components/ui/icons';
import { AuthPanel } from '@/components/setup/AuthPanel';
import { SettingsWorkspace, type SettingsSection } from '@/components/setup/SettingsWorkspace';
import { ModelLibrary } from '@/components/setup/ModelLibrary';
import { StudioDialog } from '@/components/studio/StudioDialog';
import { TabbedWorkspace } from '@/components/studio/TabbedWorkspace';
import { api, errorMessage, type Bootstrap } from '@/lib/api';
import { AdminSession, button, copy, Feedback, Heading, Loading, useResource } from './shared';
import { UsersPanel } from './UsersPanel';
import { InvitationsPanel } from './InvitationsPanel';
import { WorkTimePanel } from './WorkTimePanel';
import { MailPanel } from './MailPanel';

const sections = [{ id: 'users', label: 'Users', icon: Users }, { id: 'invitations', label: 'Invitations', icon: Plus }, { id: 'work-time', label: 'Work time', icon: Clock3 }, { id: 'mail', label: 'Mail', icon: Mail }, { id: 'server', label: 'Server settings', icon: Settings }] as const;
type Section = typeof sections[number]['id'];
export function AdminPage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null), [error, setError] = useState('');
  const refresh = useCallback(async () => { try { setBootstrap(await api<Bootstrap>('/bootstrap')); setError(''); } catch (failure) { setError(errorMessage(failure)); } }, []);
  const expired = useCallback(() => setBootstrap(current => current ? { ...current, authenticated: false } : null), []);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!bootstrap) return <main className="grid min-h-dvh place-items-center p-6"><div><Loading>Opening administration…</Loading><Feedback error={error} />{error && <button className={button} onClick={() => void refresh()}>Try again</button>}</div></main>;
  if (!bootstrap.authenticated) return <AuthPanel setup={!bootstrap.configured} onAuthenticated={() => void refresh()} />;
  if (bootstrap.user?.role !== 'admin') return <main className="grid min-h-dvh place-items-center p-6"><div className="max-w-md"><Shield className="mb-4 size-8 text-ink-2" /><h1 className="text-2xl font-medium">Administrator access required</h1><p className={`mt-3 ${copy}`}>Your account can use the Studio. Only administrators can manage users and server settings.</p><Link href="/image" className={`${button} mt-6`}>Back to Studio<ArrowRight size={16} /></Link></div></main>;
  return <AdminSession.Provider value={expired}><AdminWorkspace key={bootstrap.user.id} user={bootstrap.user} onSelfChanged={() => void refresh()} /></AdminSession.Provider>;
}
function AdminWorkspace({ user, onSelfChanged }: { user: NonNullable<Bootstrap['user']>; onSelfChanged: () => void }) {
  const [section, setSection] = useState<Section>('users'), [panel, setPanel] = useState<'settings' | 'models' | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('gpus');
  const [visited, setVisited] = useState({ settings: false, models: false });
  const settingsTrigger = useRef<HTMLButtonElement>(null), modelsTrigger = useRef<HTMLButtonElement>(null);
  const activity = useResource<{ jobs: Array<{status:string}> }>('/state', 15_000);
  const activeWork = !!activity.data?.jobs.some(job => ['queued', 'preparing', 'running', 'interrupted'].includes(job.status));
  function open(next: 'settings' | 'models') { setVisited(current => ({ ...current, [next]: true })); setPanel(next); }
  return <div className="flex h-dvh flex-col overflow-hidden bg-void">
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-7"><Link href="/image" aria-label="Gravity Studio" className="text-volt"><Logo className="size-7" /></Link><span className="text-[17px] font-medium">Administration</span><span className="ml-auto hidden text-xs text-ink-2 sm:block">{user.username}</span><Link href="/image" className={button}>Back to Studio<ArrowRight size={16} /></Link></header>
    <main className="flex min-h-0 flex-1"><TabbedWorkspace id="admin" label="Administration sections" sections={sections} selected={section} onSelect={setSection}>
      <div id={`admin-panel-${section}`} role="tabpanel" aria-labelledby={`admin-tab-${section}`} tabIndex={0} className="mx-auto w-full max-w-[1240px]">
        {section === 'users' && <UsersPanel selfId={user.id} onSelfChanged={onSelfChanged} />}
        {section === 'invitations' && <InvitationsPanel />}
        {section === 'work-time' && <WorkTimePanel />}
        {section === 'mail' && <MailPanel />}
        {section === 'server' && <section><Heading title="Server settings">Manage shared hardware, model files, provider connections and generation policy.</Heading><div className="divide-y divide-line border-y border-line"><div className="flex flex-wrap items-center justify-between gap-4 py-6"><div><h2 className="text-base font-medium">Generation server</h2><p className={`mt-2 ${copy}`}>GPUs, runtime connections, generation limits and assistant configuration.</p></div><button ref={settingsTrigger} type="button" className={button} onClick={() => open('settings')}><Settings size={17} />Open server settings</button></div><div className="flex flex-wrap items-center justify-between gap-4 py-6"><div><h2 className="text-base font-medium">Models and tools</h2><p className={`mt-2 ${copy}`}>Download image models, upscalers and background removal tools.</p></div><button ref={modelsTrigger} type="button" className={button} onClick={() => open('models')}><Boxes size={17} />Manage models</button></div></div></section>}
      </div>
    </TabbedWorkspace></main>
    {visited.settings && <StudioDialog panel="settings" open={panel === 'settings'} title="Server settings" description="Shared configuration for everyone using this Studio." icon={<Settings size={22} />} onClose={() => setPanel(null)} triggerRef={settingsTrigger}><SettingsWorkspace active={panel === 'settings'} activeWork={activeWork} initialHardware={null} section={settingsSection} onSectionChange={setSettingsSection} onSaved={activity.reload} onFinished={() => setPanel(null)} /></StudioDialog>}
    {visited.models && <StudioDialog panel="models" open={panel === 'models'} title="Models" description="Manage shared image and language models." icon={<Boxes size={22} />} onClose={() => setPanel(null)} triggerRef={modelsTrigger}><ModelLibrary active={panel === 'models'} onChanged={activity.reload} onConfigureText={() => { setSettingsSection('integrations'); open('settings'); }} /></StudioDialog>}
  </div>;
}
