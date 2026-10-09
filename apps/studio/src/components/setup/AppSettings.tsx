'use client';

import { Download, LoaderCircle, RefreshCw } from '@/components/ui/icons';
import { usePwa } from '@/lib/use-pwa';

export function AppSettings({ busy = false }: { busy?: boolean }) {
  const pwa = usePwa();
  return <section aria-labelledby="app-settings-title">
    <h2 id="app-settings-title" className="text-lg font-medium">App on this device</h2>
    <p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-ink-2">Keep Gravity in its own window, with a shortcut on your desktop or home screen.</p>
    <div className="mt-6 border-y border-line py-5">
      {!pwa.ready ? <p role="status" className="text-sm text-ink-2">Checking this browser…</p>
        : !pwa.supported ? <p className="text-sm leading-relaxed text-ink-2">{pwa.unavailableReason}</p>
          : pwa.installed ? <p className="text-sm text-ink-2">Gravity Studio is installed on this device.</p>
            : pwa.canInstall || pwa.installing ? <button type="button" disabled={pwa.installing} onClick={() => void pwa.install()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-chip bg-volt px-5 py-3 text-sm font-semibold text-on-volt disabled:opacity-55">{pwa.installing ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Download size={17} />}{pwa.installing ? 'Opening install…' : 'Install Gravity Studio'}</button>
              : <p className="max-w-[58ch] text-sm leading-relaxed text-ink-2">Install Gravity from your browser menu. On iPhone or iPad, use Share → Add to Home Screen.</p>}
    </div>
    <div className="mt-6">
      <h3 className="text-sm font-medium">Updates</h3>
      <p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-ink-2">{pwa.updateAvailable ? 'An update is ready. Reload when you are ready to use it.' : 'Gravity checks for updates when you return to the app. Your workspace will stay open until you choose to reload.'}</p>
      {pwa.updateAvailable && <><button type="button" disabled={busy || pwa.updating} onClick={pwa.applyUpdate} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-chip bg-chip px-4 py-2 text-sm font-medium hover:bg-chip-hi disabled:opacity-55">{pwa.updating ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /> : <RefreshCw size={16} />}{pwa.updating ? 'Updating…' : 'Reload app'}</button>{busy && <p role="status" className="mt-2 text-xs leading-relaxed text-ink-2">Finish the current operation and save your settings before reloading.</p>}</>}
    </div>
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="text-sm font-medium">When you are away</h3>
      <p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-ink-2">Use the bell in the top bar to choose a sound or desktop notification when an image is ready. Keep Studio open in a tab or app window to receive them.</p>
      <p className="mt-3 max-w-[58ch] text-xs leading-relaxed text-ink-2">Generating and browsing images need a connection to your Studio server. If the connection drops, the offline screen helps you return when it is available.</p>
    </div>
    {pwa.error && <p role="alert" className="error-notice mt-5">{pwa.error}</p>}
  </section>;
}
