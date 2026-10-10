'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Boxes, Clock3, Cpu, ExternalLink, HardDrive, KeyRound, Layers2, Mail, MonitorIcon, Plus, SlidersHorizontal, Users, Wand2 } from '@/components/ui/icons';
import { TabbedWorkspace } from '@/components/studio/TabbedWorkspace';
import { AdminSession } from '@/components/admin/shared';
import { UsersPanel } from '@/components/admin/UsersPanel';
import { InvitationsPanel } from '@/components/admin/InvitationsPanel';
import { WorkTimePanel, OwnWorkTime } from '@/components/admin/WorkTimePanel';
import { MailPanel } from '@/components/admin/MailPanel';
import { AppSettings } from './AppSettings';
import { ApiAccess } from './ApiAccess';
import { SettingsWorkspace, type SettingsSection } from './SettingsWorkspace';
import { ModelLibrary, type ModelsSection } from './ModelLibrary';
import { StorageSettings } from './StorageSettings';
import type { Bootstrap, Hardware } from '@/lib/api';

const personalSections = [
  { id: 'app', label: 'App', icon: MonitorIcon, group: 'Personal' },
  { id: 'work-time', label: 'Work time', icon: Clock3, group: 'Personal' },
  { id: 'api', label: 'API access', icon: KeyRound, group: 'Personal' },
] as const;
const adminSections = [
  { id: 'models', label: 'Models', icon: Boxes, group: 'Creation' },
  { id: 'generation', label: 'Generation', icon: SlidersHorizontal, group: 'Creation' },
  { id: 'assistant', label: 'Assistant', icon: Wand2, group: 'Creation' },
  { id: 'model-files', label: 'Model files', icon: Layers2, group: 'Creation' },
  { id: 'gpus', label: 'GPUs', icon: Cpu, group: 'Server' },
  { id: 'connections', label: 'Connections', icon: HardDrive, group: 'Server' },
  { id: 'integrations', label: 'Integrations', icon: ExternalLink, group: 'Server' },
  { id: 'storage', label: 'Storage', icon: HardDrive, group: 'Server' },
  { id: 'users', label: 'Users', icon: Users, group: 'Administration' },
  { id: 'invitations', label: 'Invitations', icon: Plus, group: 'Administration' },
  { id: 'work-time', label: 'Work time', icon: Clock3, group: 'Administration' },
  { id: 'mail', label: 'Mail', icon: Mail, group: 'Administration' },
] as const;
export type UnifiedSettingsSection = typeof personalSections[number]['id'] | typeof adminSections[number]['id'];
const serverSections = new Set<UnifiedSettingsSection>(['gpus', 'generation', 'assistant', 'connections', 'model-files', 'integrations']);

export function UnifiedSettings({ user, section, onSectionChange, initialHardware, onSaved, onFinished, onSessionExpired, onUserChanged, onboarding = false, active = true, activeWork = false, modelsRequest }: {
  user: NonNullable<Bootstrap['user']>;
  section: UnifiedSettingsSection;
  onSectionChange: (section: UnifiedSettingsSection) => void;
  initialHardware: Hardware | null;
  onSaved: () => void;
  onFinished: () => void;
  onSessionExpired: () => void;
  onUserChanged: () => void;
  onboarding?: boolean;
  active?: boolean;
  activeWork?: boolean;
  modelsRequest?: { section: ModelsSection; revision: number };
}) {
  const admin = user.role === 'admin';
  const sections = admin ? [...personalSections.filter(entry => entry.id !== 'work-time'), ...adminSections] : [...personalSections];
  const selected = sections.some(entry => entry.id === section) ? section : 'app';
  const isServer = admin && serverSections.has(selected);
  const [serverVisited, setServerVisited] = useState(isServer), [modelsVisited, setModelsVisited] = useState(admin && selected === 'models');
  const [serverBusy, setServerBusy] = useState(false);
  const [lastServerSection, setLastServerSection] = useState<SettingsSection>('gpus');
  useEffect(() => {
    if (isServer) { setServerVisited(true); setLastServerSection(selected === 'model-files' ? 'models' : selected as SettingsSection); }
    if (admin && selected === 'models') setModelsVisited(true);
  }, [selected, isServer, admin]);
  const serverSection = isServer ? selected === 'model-files' ? 'models' : selected as SettingsSection : lastServerSection;
  const panel = (id: UnifiedSettingsSection, children: ReactNode) => <div role="tabpanel" id={`settings-panel-${id}`} aria-labelledby={`settings-tab-${id}`} tabIndex={0}>{children}</div>;
  return <AdminSession.Provider value={onSessionExpired}><TabbedWorkspace id="settings" label="Settings sections" sections={sections} selected={selected} onSelect={onSectionChange}>
    {selected === 'app' && panel('app', <AppSettings busy={activeWork || serverBusy} />)}
    {selected === 'api' && panel('api', <ApiAccess active={active} />)}
    {selected === 'work-time' && panel('work-time', admin ? <WorkTimePanel /> : <OwnWorkTime active={active} />)}
    {admin && <>
      {selected === 'users' && panel('users', <UsersPanel selfId={user.id} onSelfChanged={onUserChanged} />)}
      {selected === 'invitations' && panel('invitations', <InvitationsPanel />)}
      {selected === 'mail' && panel('mail', <MailPanel />)}
      {selected === 'storage' && panel('storage', <StorageSettings active={active} />)}
      {(modelsVisited || selected === 'models') && <div hidden={selected !== 'models'} role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models" tabIndex={0}><ModelLibrary embedded active={active && selected === 'models'} requestedSection={modelsRequest} onChanged={onSaved} onConfigureText={() => onSectionChange('integrations')} /></div>}
      {(serverVisited || isServer) && <div hidden={!isServer}><SettingsWorkspace embedded onBusyChange={setServerBusy} active={active && isServer} activeWork={activeWork} section={serverSection} onSectionChange={next => onSectionChange(next === 'models' ? 'model-files' : next)} initialHardware={initialHardware} onSaved={onSaved} onFinished={onFinished} onboarding={onboarding} /></div>}
    </>}
  </TabbedWorkspace></AdminSession.Provider>;
}
