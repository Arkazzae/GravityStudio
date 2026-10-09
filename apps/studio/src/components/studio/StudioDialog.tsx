'use client';
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import styles from './StudioDialog.module.css';

export function StudioDialog({ panel, title, description, icon, onClose, triggerRef, children }: {
  panel: 'models' | 'settings';
  title: string;
  description: string;
  icon: ReactNode;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const pressedOutside = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      const target = previousFocus?.isConnected && previousFocus.getClientRects().length ? previousFocus : triggerRef.current;
      target?.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  function outside(clientX: number, clientY: number) {
    const rect = dialog.current?.getBoundingClientRect();
    return !!rect && (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom);
  }

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
    className={`${styles.dialog} ${panel === 'settings' ? styles.settings : styles.models}`}
    onKeyDown={keepFocus}
    onClose={event => { if (!event.currentTarget.open) onClose(); }}
    onPointerDown={event => { pressedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onClick={event => { if (pressedOutside.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose(); pressedOutside.current = false; }}>
    <header className={styles.header}>
      <div className="min-w-0"><h1 id={`${panel}-title`}>{icon}{title}</h1><p id={`${panel}-description`}>{description}</p></div>
      <button ref={closeButton} type="button" className={styles.close} aria-label={`Close ${panel}`} title={`Close ${panel}`} onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>{children}</div>
  </dialog>;
}
