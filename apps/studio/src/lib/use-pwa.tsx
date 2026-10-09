'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export interface PwaState {
  ready: boolean;
  supported: boolean;
  secureContext: boolean;
  unavailableReason: string;
  installed: boolean;
  canInstall: boolean;
  installing: boolean;
  updateAvailable: boolean;
  updating: boolean;
  error: string;
  install: () => Promise<void>;
  applyUpdate: () => void;
}
const initial = {
  ready: false, supported: false, secureContext: false, unavailableReason: '',
  installed: false, canInstall: false, installing: false, updateAvailable: false, updating: false, error: '',
};
const PwaContext = createContext<PwaState>({ ...initial, install: async () => {}, applyUpdate: () => {} });

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(initial);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const installEvent = useRef<InstallEvent | null>(null);
  const reloadRequested = useRef(false);
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let hadController = !!navigator.serviceWorker?.controller;
    let lastCheck = Date.now();
    let watchedWorker: ServiceWorker | null = null;
    let registered: ServiceWorkerRegistration | null = null;
    const display = window.matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: fullscreen), (display-mode: minimal-ui)');
    const isInstalled = () => display.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
    const displayChanged = () => setState(current => ({ ...current, installed: isInstalled() }));
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      installEvent.current = event as InstallEvent;
      setState(current => ({ ...current, canInstall: true }));
    };
    const installed = () => {
      installEvent.current = null;
      setState(current => ({ ...current, installed: true, canInstall: false, installing: false }));
    };
    const updateReady = () => setState(current => ({ ...current, updateAvailable: true }));
    const controllerChanged = () => {
      if (reloadRequested.current) { window.location.reload(); return; }
      // Another tab may accept the update. This tab keeps its work until Reload.
      if (hadController) updateReady();
      hadController = true;
    };
    const workerChanged = () => {
      if (watchedWorker?.state === 'installed' && navigator.serviceWorker.controller) updateReady();
    };
    const updateFound = () => {
      watchedWorker?.removeEventListener('statechange', workerChanged);
      watchedWorker = registered?.installing || null;
      watchedWorker?.addEventListener('statechange', workerChanged);
      workerChanged();
    };
    const checkUpdate = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck >= 60_000) {
        lastCheck = Date.now();
        void registration.current?.update().catch(() => {});
      }
    };
    const secureContext = window.isSecureContext;
    const supported = secureContext && 'serviceWorker' in navigator;
    setState(current => ({ ...current, ready: true, secureContext, supported, installed: isInstalled(),
      unavailableReason: !secureContext ? 'Open your studio over HTTPS to install it on this device. Localhost also works.'
        : !supported ? 'This browser does not support an installed studio. You can keep using it in this tab.' : '',
    }));
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installed);
    display.addEventListener('change', displayChanged);
    if (supported) {
      navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
      document.addEventListener('visibilitychange', checkUpdate);
      if (process.env.NODE_ENV === 'production') {
        void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(value => {
          if (disposed) return;
          registered = value; registration.current = value;
          if (value.waiting) updateReady();
          value.addEventListener('updatefound', updateFound);
          updateFound();
        }).catch(() => {
          if (!disposed) setState(current => ({ ...current, error: 'The app could not prepare offline access. Check your connection and reload to try again.' }));
        });
      } else {
        // Never let a production cache pin development or HMR code.
        void navigator.serviceWorker.getRegistrations().then(async values => {
          const url = new URL('/sw.js', window.location.origin).href;
          await Promise.all(values.filter(value => [value.active, value.waiting, value.installing].some(worker => worker?.scriptURL === url)).map(value => value.unregister()));
          if ('caches' in window) await Promise.all((await caches.keys()).filter(name => name.startsWith('gravity-studio-pwa-') || name.startsWith('gravity-pwa-')).map(name => caches.delete(name)));
        }).catch(() => {});
      }
    }
    return () => {
      disposed = true; alive.current = false;
      registration.current = null;
      if (updateTimer.current) clearTimeout(updateTimer.current);
      watchedWorker?.removeEventListener('statechange', workerChanged);
      registered?.removeEventListener('updatefound', updateFound);
      navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged);
      document.removeEventListener('visibilitychange', checkUpdate);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installed);
      display.removeEventListener('change', displayChanged);
    };
  }, []);

  const install = useCallback(async () => {
    const event = installEvent.current;
    if (!event) return;
    installEvent.current = null;
    setState(current => ({ ...current, canInstall: false, installing: true, error: '' }));
    try {
      // Called directly from a button: browsers require a user gesture here.
      await event.prompt();
      await event.userChoice;
    } catch {
      if (alive.current) setState(current => ({ ...current, error: 'The install prompt could not open. You can also install Gravity from your browser menu.' }));
    } finally {
      if (alive.current) setState(current => ({ ...current, installing: false }));
    }
  }, []);

  const applyUpdate = useCallback(() => {
    if (reloadRequested.current) return;
    const waiting = registration.current?.waiting;
    if (!waiting) { window.location.reload(); return; }
    reloadRequested.current = true;
    setState(current => ({ ...current, updating: true, error: '' }));
    try { waiting.postMessage({ type: 'gravity:activate-update' }); }
    catch {
      reloadRequested.current = false;
      setState(current => ({ ...current, updating: false, error: 'The update could not start. Try Reload app again.' }));
      return;
    }
    updateTimer.current = setTimeout(() => {
      reloadRequested.current = false;
      if (alive.current) setState(current => ({ ...current, updating: false, error: 'The update could not finish. Try Reload app again.' }));
    }, 10_000);
  }, []);

  return <PwaContext.Provider value={{ ...state, install, applyUpdate }}>{children}</PwaContext.Provider>;
}

export function usePwa() { return useContext(PwaContext); }
