'use client';

import { useEffect, useRef } from 'react';
import { CircleHelp } from '@/components/ui/icons';
import { useAnchoredPopover } from '@/lib/useAnchoredPopover';
import { cn } from '@/lib/utils';
import styles from './Dropdown.module.css';

/** A top-layer hint stays readable inside scrolling parameter panels. */
export function HelpTooltip({ label, children, className }: { label: string; children: string; className?: string }) {
  const { triggerProps, popoverProps } = useAnchoredPopover({ align: 'end', side: 'top', width: 240 });
  const { popoverTarget: _target, ...buttonProps } = triggerProps;
  const pointerInside = useRef(false);
  const pressedWhileOpen = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelHide() { if (timer.current) clearTimeout(timer.current); timer.current = null; }
  function show() {
    cancelHide();
    const tooltip = popoverProps.ref.current;
    if (tooltip && !tooltip.matches(':popover-open')) tooltip.showPopover();
  }
  function hide() { cancelHide(); popoverProps.ref.current?.hidePopover(); }
  function leave() {
    pointerInside.current = false;
    cancelHide();
    timer.current = setTimeout(() => {
      if (!pointerInside.current && document.activeElement !== triggerProps.ref.current) hide();
    }, 120);
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return <span className={cn('inline-flex', className)}>
    <button {...buttonProps} type="button" aria-label={`Help: ${label}`} aria-describedby={popoverProps.id}
      className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-volt focus-visible:-outline-offset-2"
      onPointerEnter={event => { if (event.pointerType !== 'touch') { pointerInside.current = true; show(); } }}
      onPointerLeave={event => { if (event.pointerType !== 'touch') leave(); }}
      onPointerDown={() => { pressedWhileOpen.current = !!popoverProps.ref.current?.matches(':popover-open'); }}
      onFocus={show} onBlur={leave}
      onClick={event => {
        const wasOpen = event.detail === 0 ? popoverProps.ref.current?.matches(':popover-open') : pressedWhileOpen.current;
        if (wasOpen) hide(); else show();
      }}>
      <CircleHelp className="size-[13px]" aria-hidden="true" />
    </button>
    <div {...popoverProps} role="tooltip" className={styles.menu}
      onPointerEnter={() => { pointerInside.current = true; cancelHide(); }} onPointerLeave={leave}
      onToggle={event => {
        popoverProps.onToggle(event);
        if (event.target === event.currentTarget && event.newState === 'closed') { pointerInside.current = false; cancelHide(); }
      }}>
      <div className="px-2 py-1 text-left text-xs leading-5 font-normal normal-case tracking-normal text-ink-2">{children}</div>
    </div>
  </span>;
}
