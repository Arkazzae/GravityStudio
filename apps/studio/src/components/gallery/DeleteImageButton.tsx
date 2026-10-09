'use client';
import { useEffect, useState } from 'react';
import { Check, LoaderCircle, Trash2 } from '@/components/ui/icons';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

export function DeleteImageButton({ disabled, onDelete, onError, className }: { disabled: boolean; onDelete: () => Promise<void>; onError: (message: string) => void; className?: string }) {
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
      // Deleting a focused image can remove its button. Keep focus in the active modal.
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        const modal = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).find(element => element.matches(':focus-within'))
          || Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
        if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected && focused.getClientRects().length && (!modal || modal.contains(focused))) return;
        if (modal) (modal.querySelector<HTMLElement>('[data-dialog-dismiss]:not(:disabled)') || modal).focus({ preventScroll: true });
        else document.querySelector<HTMLButtonElement>('[aria-label="Image filter"] [aria-pressed="true"]')?.focus({ preventScroll: true });
      });
    } catch (error) { onError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <button type="button" data-delete-action disabled={disabled || busy} aria-label={busy ? 'Deleting image' : armed ? 'Confirm image deletion' : 'Delete image'} title={armed ? 'Click again to permanently delete' : 'Delete image'} aria-busy={busy}
    onClick={() => void remove()} onBlur={() => setArmed(false)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setArmed(false); } }}
    className={cn('grid size-8 place-items-center rounded-full bg-black/65 text-white transition-colors hover:bg-black/85 disabled:opacity-50', className, armed && 'bg-hot text-void hover:bg-hot hover:text-void hover:brightness-110')}>
    {busy ? <LoaderCircle size={16} className="animate-spin" /> : armed ? <Check size={18} /> : <Trash2 size={16} />}
  </button>;
}
