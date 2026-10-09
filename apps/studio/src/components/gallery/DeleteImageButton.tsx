'use client';
import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Trash2 } from '@/components/ui/icons';
import { errorMessage } from '@/lib/api';

export function DeleteImageButton({ disabled, onDelete, onError }: { disabled: boolean; onDelete: () => Promise<void>; onError: (message: string) => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);
  async function remove() {
    if (busy || disabled) return;
    if (!armed) { setArmed(true); return; }
    setArmed(false); setBusy(true); onError('');
    try {
      await onDelete();
      // The deleted tile may have held focus. Keep keyboard navigation in the gallery.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) document.querySelector<HTMLButtonElement>('[aria-label="Image filter"] [aria-pressed="true"]')?.focus({ preventScroll: true });
      });
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <button type="button" data-delete-action disabled={disabled || busy} aria-label={busy ? 'Deleting image' : armed ? 'Confirm image deletion' : 'Delete image'} title={armed ? 'Click again to permanently delete' : 'Delete image'} aria-busy={busy}
    onClick={() => void remove()} onBlur={() => setArmed(false)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setArmed(false); } }}
    className={`grid size-8 place-items-center rounded-full transition-colors disabled:opacity-50 ${armed ? 'bg-hot text-void hover:brightness-110' : 'bg-black/65 text-white hover:bg-black/85'}`}>
    {busy ? <LoaderCircle size={16} className="animate-spin" /> : armed ? <Check size={18} /> : <Trash2 size={16} />}
  </button>;
}
