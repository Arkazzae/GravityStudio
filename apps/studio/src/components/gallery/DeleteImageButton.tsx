'use client';
import { useState } from 'react';
import { Popover } from '@/components/ui/Popover';
import { LoaderCircle, Trash2 } from '@/components/ui/icons';
import { errorMessage } from '@/lib/api';

export function DeleteImageButton({ disabled, onDelete }: { disabled: boolean; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove(close: () => void) {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try {
      await onDelete();
      close();
      // The deleted tile may have held focus. Keep keyboard navigation in the gallery.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) document.querySelector<HTMLButtonElement>('[aria-label="Image filter"] [aria-pressed="true"]')?.focus({ preventScroll: true });
      });
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <Popover label="Delete image" title="Delete this image?" width={280} side="bottom" align="end" initialFocus="[data-delete-cancel]"
    trigger={({ triggerProps }) => <button {...triggerProps} type="button" data-delete-action disabled={disabled || busy} aria-label="Delete image" title="Delete image" aria-busy={busy} onClick={() => setError('')} className="grid size-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/85 disabled:opacity-50">{busy ? <LoaderCircle size={16} className="animate-spin" /> : <Trash2 size={16} />}</button>}>
    {close => <div className="px-1 pb-1">
      <p className="text-xs leading-relaxed text-ink-2">This permanently deletes the image and removes it from favorites.</p>
      {error && <p role="alert" className="error-notice mt-3 text-xs">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" data-delete-cancel disabled={busy} onClick={close} className="min-h-10 rounded-lg px-3 text-xs font-medium hover:bg-chip disabled:opacity-50">Cancel</button>
        <button type="button" disabled={busy || disabled} aria-busy={busy} onClick={() => void remove(close)} className="min-h-10 rounded-lg bg-hot px-3 text-xs font-medium text-void hover:brightness-110 disabled:opacity-50">{busy ? 'Deleting…' : 'Delete image'}</button>
      </div>
    </div>}
  </Popover>;
}
