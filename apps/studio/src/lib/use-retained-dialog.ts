'use client';

import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type RefObject, type SyntheticEvent } from 'react';

/** Keep a modal's draft in React while releasing its native top-layer slot. */
export function useRetainedDialog({ dialog, open, onClose, initialFocus, triggerRef, dismissible = true }: {
  dialog: RefObject<HTMLDialogElement | null>;
  open: boolean;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  dismissible?: boolean;
}) {
  const latest = useRef({ open, onClose, dismissible });
  latest.current = { open, onClose, dismissible };
  const shown = useRef(false);
  const pressedOutside = useRef(false);
  const lastFocus = useRef<HTMLElement | null>(null);
  const scroll = useRef<Array<{ element: HTMLElement; section: string | null; top: number; left: number }>>([]);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rememberedFocus = lastFocus.current;
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== element && !event.target.closest('[data-dialog-dismiss]')) lastFocus.current = event.target;
    };
    element.addEventListener('focusin', rememberFocus);
    shown.current = true;
    if (!element.open) element.showModal();
    const target = rememberedFocus?.isConnected && rememberedFocus.getClientRects().length && !rememberedFocus.matches(':disabled, [role="tab"][aria-selected="false"]')
      ? rememberedFocus : initialFocus?.current;
    target?.focus({ preventScroll: true });
    for (const position of scroll.current) {
      if (position.element.isConnected && position.element.getAttribute('data-dialog-scroll') === position.section) { position.element.scrollTop = position.top; position.element.scrollLeft = position.left; }
    }
    return () => {
      scroll.current = Array.from(element.querySelectorAll<HTMLElement>('[data-dialog-scroll]')).map(scroller => ({ element: scroller, section: scroller.getAttribute('data-dialog-scroll'), top: scroller.scrollTop, left: scroller.scrollLeft }));
      element.removeEventListener('focusin', rememberFocus);
      shown.current = false; pressedOutside.current = false;
      if (element.open) element.close();
      const target = previousFocus?.isConnected && previousFocus.getClientRects().length && !previousFocus.matches(':disabled') ? previousFocus : triggerRef?.current;
      // Switching panels must never focus a control behind the new modal.
      const modals = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'));
      const otherModal = modals.find(modal => modal.contains(document.activeElement)) || modals.at(-1);
      if (!otherModal || target && otherModal.contains(target)) target?.focus({ preventScroll: true });
      else if (!otherModal.contains(document.activeElement)) {
        (otherModal.querySelector<HTMLElement>('[data-dialog-dismiss]:not(:disabled)') || otherModal).focus({ preventScroll: true });
      }
    };
  }, [dialog, open, initialFocus, triggerRef]);

  function outside(x: number, y: number) {
    const rect = dialog.current?.getBoundingClientRect();
    return !!rect && (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom);
  }
  function dismiss() { if (latest.current.open && latest.current.dismissible) latest.current.onClose(); }
  return {
    onCancel(event: SyntheticEvent<HTMLDialogElement>) { event.preventDefault(); dismiss(); },
    onClose(event: SyntheticEvent<HTMLDialogElement>) { if (shown.current && !event.currentTarget.open) dismiss(); },
    onPointerDown(event: PointerEvent<HTMLDialogElement>) { pressedOutside.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); },
    onClick(event: MouseEvent<HTMLDialogElement>) {
      if (pressedOutside.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) dismiss();
      pressedOutside.current = false;
    },
  };
}
