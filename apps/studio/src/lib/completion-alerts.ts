'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NotificationFeed, type ActivityEvent, type ActivityJob } from './notification-feed';

export type DesktopPermission = NotificationPermission | 'unsupported' | 'insecure';
export interface CompletionAlerts { sound: boolean; desktop: boolean; permission: DesktopPermission }
interface Notice { id: string; kind: 'success' | 'info' | 'error'; title: string; body?: string }
const KEY = 'gravity:completion-alerts';
const CLAIM_PREFIX = 'gravity:completion:';
const CLAIM_MS = 10 * 60_000;
const SERVER: CompletionAlerts = { sound: false, desktop: false, permission: 'default' };
const listeners = new Set<() => void>();
let memory: string | null = null, snapshotKey = '';
let memoryPreferred = false;
let snapshot = SERVER;
const changed = () => listeners.forEach(listener => listener());

function permission(): DesktopPermission {
  if (!window.isSecureContext) return 'insecure';
  return 'Notification' in window ? Notification.permission : 'unsupported';
}
function read(): CompletionAlerts {
  let stored = memory;
  if (!memoryPreferred) try { stored = localStorage.getItem(KEY); } catch { /* The in-memory choice still works in this tab. */ }
  const currentPermission = permission(), key = `${currentPermission}|${stored}`;
  if (snapshotKey !== key) {
    let value: Record<string, unknown> = {};
    try { const parsed: unknown = stored ? JSON.parse(stored) : {}; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>; } catch { /* Damaged settings default to off. */ }
    snapshotKey = key;
    snapshot = { sound: value.sound === true, desktop: value.desktop === true, permission: currentPermission };
  }
  return snapshot;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) { memory = event.newValue; memoryPreferred = false; listener(); }
  };
  window.addEventListener('storage', storage); window.addEventListener('focus', listener);
  document.addEventListener('visibilitychange', listener);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); window.removeEventListener('focus', listener); document.removeEventListener('visibilitychange', listener); };
}
export const useCompletionAlerts = () => useSyncExternalStore(subscribe, read, () => SERVER);
export function setCompletionAlerts(patch: Partial<Pick<CompletionAlerts, 'sound' | 'desktop'>>) {
  const { sound, desktop } = { ...read(), ...patch };
  memory = JSON.stringify({ sound, desktop });
  memoryPreferred = true;
  try { localStorage.setItem(KEY, memory); memoryPreferred = false; } catch { /* Keep the choice in memory. */ }
  changed();
}

let audio: AudioContext | null = null;
/** The two-note sound from the original Studio, synthesized without downloads. */
export async function playPing() {
  try {
    audio ??= new AudioContext();
    if (audio.state !== 'running') await Promise.race([audio.resume(), new Promise(resolve => setTimeout(resolve, 300))]);
    if (audio.state !== 'running') return;
    const start = audio.currentTime + .02;
    for (const [offset, frequency] of [[0, 880], [.14, 1318.5]]) {
      const tone = audio.createOscillator(), gain = audio.createGain();
      tone.type = 'sine'; tone.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(.18, start + offset + .015);
      gain.gain.exponentialRampToValueAtTime(.0001, start + offset + .45);
      tone.connect(gain).connect(audio.destination); tone.start(start + offset); tone.stop(start + offset + .5);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
    }
  } catch { /* Browser autoplay or unavailable audio must not interrupt generation. */ }
}

const claims = new Map<string, number>();
function markClaim(key: string): { won: boolean; persisted: boolean } {
  const now = Date.now();
  for (const [id, at] of claims) if (now - at > CLAIM_MS) claims.delete(id);
  if (claims.has(key)) return { won: false, persisted: false };
  claims.set(key, now);
  try {
    // These short-lived entries contain job identifiers, never prompts or outputs.
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const candidate = localStorage.key(index);
      if (candidate?.startsWith(CLAIM_PREFIX) && now - Number(localStorage.getItem(candidate)) > CLAIM_MS) localStorage.removeItem(candidate);
    }
    const previous = Number(localStorage.getItem(key));
    if (previous && now - previous < CLAIM_MS) return { won: false, persisted: true };
    localStorage.setItem(key, String(now));
    return { won: true, persisted: true };
  } catch { return { won: true, persisted: false }; }
}
function claim(owner: string, id: string): Promise<boolean> {
  const key = `${CLAIM_PREFIX}${owner}:${id}`;
  if (!navigator.locks) return Promise.resolve(markClaim(key).won);
  return new Promise(resolve => {
    navigator.locks.request(key, { ifAvailable: true }, lock => {
      if (!lock) { resolve(false); return; }
      const result = markClaim(key); resolve(result.won);
      // Without storage, keep the lock as the cross-tab claim for its lifetime.
      if (result.won && !result.persisted) return new Promise<void>(release => setTimeout(release, CLAIM_MS));
    }).catch(() => resolve(markClaim(key).won));
  });
}
async function announce(owner: string, jobs: ActivityJob[], current: () => boolean) {
  if (!jobs.length || !current()) return;
  const options = read();
  if (!options.sound && (!options.desktop || options.permission !== 'granted')) return;
  const won = await Promise.all(jobs.map(async job => await claim(owner, job.id) ? job : null));
  const finished = won.filter((job): job is ActivityJob => job !== null);
  if (!current() || !finished.length) return;
  const { sound, desktop, permission: allowed } = read();
  if (sound) void playPing();
  if (!desktop || allowed !== 'granted' || (!document.hidden && document.hasFocus())) return;
  const title = finished.length === 1 ? 'Your image is ready' : `${finished.length} images are ready`;
  const body = [...new Set(finished.map(job => job.modelName || job.modelId))].join(', ').slice(0, 140);
  const tag = `gravity:${owner}:${finished[0].id}`;
  const notificationOptions = { body, icon: '/pwa/icon-192.png', tag, data: { url: '/image' } };
  try {
    // Mobile browsers require the service-worker API; never wait forever for ready.
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
    if (!current() || !read().desktop || permission() !== 'granted' || (!document.hidden && document.hasFocus())) return;
    if (registration?.active) { await registration.showNotification(title, notificationOptions); return; }
  } catch { /* Desktop browsers can still use the direct notification API. */ }
  if (!current() || !read().desktop || permission() !== 'granted' || (!document.hidden && document.hasFocus())) return;
  try {
    const notification = new Notification(title, notificationOptions);
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch { /* Unsupported native alerts do not affect the activity list or sound. */ }
}

export function useJobNotifications(owner: string | null, jobs: ActivityJob[] | undefined) {
  const alerts = useCompletionAlerts();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [desktopPending, setDesktopPending] = useState(false);
  const [permissionError, setPermissionError] = useState('');
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeSequence = useRef(0);
  const noticeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const identity = useRef({ owner, epoch: 0, alive: false });
  if (identity.current.owner !== owner) { identity.current.owner = owner; identity.current.epoch++; }
  const dismissNotice = useCallback((id: string) => {
    clearTimeout(noticeTimers.current.get(id)); noticeTimers.current.delete(id);
    setNotices(items => items.filter(item => item.id !== id));
  }, []);
  const pushNotice = useCallback((notice: Omit<Notice, 'id'>) => {
    if (!identity.current.alive || !identity.current.owner) return;
    const id = `notice-${++noticeSequence.current}`;
    setNotices(items => [...items.slice(-2), { ...notice, id }]);
    noticeTimers.current.set(id, setTimeout(() => dismissNotice(id), 8000));
  }, [dismissNotice]);
  const feed = useRef<{ owner: string | null; value: NotificationFeed }>({ owner, value: new NotificationFeed() });
  useEffect(() => {
    identity.current.alive = true; identity.current.epoch++;
    setDesktopPending(false); setPermissionError(''); setNotices([]);
    return () => {
      identity.current.alive = false; identity.current.epoch++;
      for (const timer of noticeTimers.current.values()) clearTimeout(timer);
      noticeTimers.current.clear();
    };
  }, [owner]);
  useEffect(() => {
    if (feed.current.owner !== owner || !owner) { feed.current = { owner, value: new NotificationFeed() }; setEvents([]); }
    if (!owner || !jobs) return;
    const next = feed.current.value.update(jobs);
    setEvents(next.events);
    if (next.completed.length) pushNotice({ kind: 'success', title: next.completed.length === 1 ? 'Your image is ready' : `${next.completed.length} images are ready`, body: [...new Set(next.completed.map(job => job.modelName || job.modelId))].join(', ') });
    const epoch = identity.current.epoch;
    void announce(owner, next.completed, () => identity.current.alive && identity.current.owner === owner && identity.current.epoch === epoch).catch(() => {});
  }, [owner, jobs, pushNotice]);
  function onSoundChange(next: boolean) { setCompletionAlerts({ sound: next }); if (next) void playPing(); }
  async function onDesktopChange(next: boolean) {
    setPermissionError('');
    if (!next) { setCompletionAlerts({ desktop: false }); return; }
    if (desktopPending || !owner) return;
    const current = permission();
    if (current === 'granted') { setCompletionAlerts({ desktop: true }); return; }
    if (current !== 'default') return;
    const epoch = identity.current.epoch;
    const valid = () => identity.current.alive && identity.current.owner === owner && identity.current.epoch === epoch;
    setDesktopPending(true);
    try {
      const allowed = await Notification.requestPermission();
      if (valid()) setCompletionAlerts({ desktop: allowed === 'granted' });
    } catch { if (valid()) setPermissionError('Could not request notification permission. Try again from your browser’s site settings.'); }
    finally { if (valid()) setDesktopPending(false); changed(); }
  }
  return { events, alerts, desktopPending, permissionError, onSoundChange, onDesktopChange, notices, pushNotice, dismissNotice };
}
