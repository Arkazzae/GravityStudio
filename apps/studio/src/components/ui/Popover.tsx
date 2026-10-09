"use client";

import { useLayoutEffect } from "react";
import { cn } from "@/lib/utils";
import { useAnchoredPopover } from "@/lib/useAnchoredPopover";
import styles from "./Dropdown.module.css";

/**
 * A plain anchored panel. `Dropdown` is a menu — it owns roving focus between
 * `menuitem`s — so anything with fields inside (a slider, a seed input) needs
 * this instead. It wears the same panel, and `title` gives it the same heading.
 */
export function Popover({
  trigger,
  children,
  label,
  title,
  flush,
  align = "start",
  side = "top",
  className,
  width = 260,
  initialFocus,
}: {
  trigger: (props: {
    open: boolean;
    triggerProps: ReturnType<typeof useAnchoredPopover>["triggerProps"] & { "aria-haspopup": "dialog" };
  }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  label: string;
  /** A visible heading, set like a menu's. */
  title?: string;
  /** Content brings its own row padding, as a menu's rows do. */
  flush?: boolean;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  width?: number | string;
  /** Focus a field or choice after the anchored panel becomes visible. */
  initialFocus?: string;
}) {
  const { open, close, triggerProps, popoverProps } = useAnchoredPopover({ align, side, width });
  const { ref } = popoverProps;
  useLayoutEffect(() => {
    if (open && initialFocus) ref.current?.querySelector<HTMLElement>(initialFocus)?.focus({ preventScroll: true });
  }, [open, initialFocus, ref]);

  return (
    <div className="relative">
      {trigger({ open, triggerProps: { ...triggerProps, "aria-haspopup": "dialog" } })}
      <div {...popoverProps} role="dialog" aria-label={label} className={cn(styles.menu, className)}>
        {title ? <div className="px-3 py-2 text-[13px] font-medium">{title}</div> : null}
        {flush ? children(close) : <div className={title ? "px-2 pb-2 pt-0.5" : "p-2"}>{children(close)}</div>}
      </div>
    </div>
  );
}
