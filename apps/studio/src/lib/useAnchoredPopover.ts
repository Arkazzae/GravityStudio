"use client";

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ToggleEvent } from "react";

/** Native top-layer dismissal and focus handling, with placement shared by all menus. */
export function useAnchoredPopover({
  align = "end",
  side = "bottom",
  width = 392,
}: {
  align?: "start" | "end";
  side?: "top" | "bottom" | "left" | "right";
  width?: number | string;
} = {}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!open || !trigger || !popover) return;

    function place() {
      if (!trigger || !popover || !popover.matches(":popover-open")) return;
      const viewport = window.visualViewport;
      const margin = 12;
      const gap = 8;
      const leftEdge = (viewport?.offsetLeft ?? 0) + margin;
      const topEdge = (viewport?.offsetTop ?? 0) + margin;
      const rightEdge = leftEdge + (viewport?.width ?? document.documentElement.clientWidth) - margin * 2;
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - margin * 2;
      const anchor = trigger.getBoundingClientRect();

      popover.style.width = typeof width === "number" ? `${width}px`
        : width.endsWith("%") ? `${anchor.width * parseFloat(width) / 100}px` : width;
      popover.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`;

      if (side === "left" || side === "right") {
        // Detail panels beside a picker can use the full viewport height.
        popover.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
        const before = anchor.left - gap - leftEdge;
        const after = rightEdge - anchor.right - gap;
        const preferredSpace = side === "right" ? after : before;
        const otherSpace = side === "right" ? before : after;
        const placedSide = popover.offsetWidth > preferredSpace && otherSpace > preferredSpace ? side === "right" ? "left" : "right" : side;
        const left = placedSide === "right" ? anchor.right + gap : anchor.left - gap - popover.offsetWidth;
        popover.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - popover.offsetWidth))}px`;
        popover.style.top = `${Math.max(topEdge, Math.min(anchor.top, bottomEdge - popover.offsetHeight))}px`;
        popover.dataset.side = placedSide;
        return;
      }

      const above = Math.max(0, anchor.top - gap - topEdge);
      const below = Math.max(0, bottomEdge - anchor.bottom - gap);
      const height = popover.scrollHeight + popover.offsetHeight - popover.clientHeight;
      const preferredSpace = side === "bottom" ? below : above;
      const otherSpace = side === "bottom" ? above : below;
      const placedSide = height > preferredSpace && otherSpace > preferredSpace
        ? side === "bottom" ? "top" : "bottom" : side;
      popover.style.maxHeight = `${placedSide === "bottom" ? below : above}px`;
      const left = align === "start" ? anchor.left : anchor.right - popover.offsetWidth;
      const top = placedSide === "bottom" ? anchor.bottom + gap : anchor.top - gap - popover.offsetHeight;
      popover.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - popover.offsetWidth))}px`;
      popover.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - popover.offsetHeight))}px`;
      popover.dataset.side = placedSide;
    }

    place();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(trigger);
    observer.observe(popover);
    // Content can grow while a height-constrained popover keeps the same outer size.
    for (const child of popover.children) observer.observe(child);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, align, side, width]);

  function close() {
    popoverRef.current?.hidePopover();
    triggerRef.current?.focus({ preventScroll: true });
  }

  return {
    open,
    close,
    triggerProps: {
      ref: triggerRef,
      id: `${id}-trigger`,
      popoverTarget: id,
      "aria-controls": id,
      "aria-expanded": open,
    },
    popoverProps: {
      ref: popoverRef,
      id,
      popover: "auto" as const,
      onToggle: (event: ToggleEvent<HTMLDivElement>) => {
        // A sampler menu can live inside Advanced. Its toggle must not hide
        // the parent panel when an option is selected.
        if (event.target === event.currentTarget) setOpen(event.newState === "open");
      },
      style: {
        position: "fixed", inset: "auto", margin: 0, width,
        // The native toggle event arrives after opening. Keep that first frame hidden
        // until the layout effect has measured the panel at its final width.
        visibility: open ? "visible" : "hidden",
      } satisfies CSSProperties,
    },
  };
}
