'use client';

import { Bell, X } from '@/components/ui/icons';
import { IconChip } from '@/components/ui/Chip';
import { Switch } from '@/components/ui/Switch';
import { useAnchoredPopover } from '@/lib/useAnchoredPopover';
import styles from './NotificationsPopover.module.css';

export interface NotificationEvent {
  id: string;
  message: string;
  at: string;
}

export interface CompletionAlertSettingsProps {
  alerts: {
    sound: boolean;
    desktop: boolean;
    permission: NotificationPermission | 'unsupported' | 'insecure';
  };
  onSoundChange: (next: boolean) => void;
  onDesktopChange: (next: boolean) => void | Promise<void>;
  desktopPending?: boolean;
  permissionError?: string;
}

/** Recent activity and the ways this browser calls the user back to a result. */
export function NotificationsPopover({
  events,
  connected,
  ...alertSettings
}: CompletionAlertSettingsProps & { events: NotificationEvent[]; connected: boolean }) {
  const { open, close, triggerProps, popoverProps } = useAnchoredPopover({ align: 'end', side: 'bottom', width: 392 });

  return <>
    <IconChip {...triggerProps} active={open} aria-label="Notifications" title="Notifications" aria-haspopup="dialog" className="rounded-lg">
      <Bell className="size-[18px]" />
    </IconChip>
    <div {...popoverProps} role="dialog" aria-label="Notifications" className={styles.popover}>
      <div className={styles.header}>
        <h2>Notifications</h2>
        <button type="button" className={styles.close} aria-label="Close notifications" onClick={close}><X /></button>
      </div>
      <CompletionAlertSettings {...alertSettings} />
      {!connected ? <p className={styles.empty} role="status">Reconnect to load recent activity.</p>
        : events.length ? <ol className={styles.events} aria-label="Recent activity">
          {events.map(event => <li key={event.id}>
            <p>{event.message}</p>
            <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
          </li>)}
        </ol>
          : <p className={styles.empty}>No activity yet. Job updates will appear here.</p>}
    </div>
  </>;
}

export function CompletionAlertSettings({ alerts, onSoundChange, onDesktopChange, desktopPending = false, permissionError }: CompletionAlertSettingsProps) {
  const { sound, desktop, permission } = alerts;
  const unavailable = permission === 'denied' || permission === 'unsupported' || permission === 'insecure';

  return <section aria-label="When a generation is ready" className={styles.alerts}>
    <h3>When a generation is ready</h3>
    <div className={styles.setting}>
      <span className={styles.copy}><span>Play a sound</span><span>A short chime from this browser</span></span>
      <Switch checked={sound} onChange={onSoundChange} label="Play a sound when a generation is ready" />
    </div>
    <div className={styles.setting}>
      <span className={styles.copy}><span>Desktop notification</span><span>{desktopPending ? 'Waiting for browser permission…' : 'While the studio is in the background'}</span></span>
      <Switch checked={desktop && permission === 'granted'} onChange={next => { void onDesktopChange(next); }} disabled={unavailable || desktopPending} label="Show a desktop notification when a generation is ready" />
    </div>
    {permissionError ? <p role="alert" className={styles.warning}>{permissionError}</p>
      : permission === 'denied' ? <p role="status" className={styles.warning}>Notifications are blocked for this site. Allow them in your browser’s site settings.</p>
        : permission === 'insecure' ? <p role="status" className={styles.help}>Open Studio over HTTPS to enable desktop notifications on this device.</p>
          : permission === 'unsupported' ? <p role="status" className={styles.help}>This browser cannot show desktop notifications.</p> : null}
  </section>;
}
