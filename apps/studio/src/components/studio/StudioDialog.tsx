'use client';
import { useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { X } from '@/components/ui/icons';
import { useRetainedDialog } from '@/lib/use-retained-dialog';
import styles from './StudioDialog.module.css';

export function StudioDialog({ panel, open, title, description, icon, onClose, triggerRef, children }: {
  panel: 'models' | 'settings';
  open: boolean;
  title: string;
  description: string;
  icon: ReactNode;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const events = useRetainedDialog({ dialog, open, onClose, initialFocus: closeButton, triggerRef });

  function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]'))
      .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <dialog ref={dialog} id={`${panel}-dialog`} aria-labelledby={`${panel}-title`} aria-describedby={`${panel}-description`}
    className={`${styles.dialog} ${styles.centered}`}
    onKeyDown={keepFocus} {...events}>
    <header className={styles.header}>
      <div className="min-w-0"><h1 id={`${panel}-title`}>{icon}{title}</h1><p id={`${panel}-description`}>{description}</p></div>
      <button ref={closeButton} data-dialog-dismiss type="button" className={styles.close} aria-label={`Close ${panel}`} title={`Close ${panel}`} onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>{children}</div>
  </dialog>;
}
