"use client";

import { useLayoutEffect } from "react";
import { Check } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { useAnchoredPopover } from "@/lib/useAnchoredPopover";
import styles from "./Dropdown.module.css";

export function Dropdown({
  trigger,
  children,
  align = "start",
  side = "top",
  className,
  width = 260,
}: {
  trigger: (props: {
    open: boolean;
    triggerProps: ReturnType<typeof useAnchoredPopover>["triggerProps"] & { "aria-haspopup": "menu" };
  }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "start" | "end";
  side?: "top" | "bottom";
  className?: string;
  width?: number | string;
}) {
  const { open, close, triggerProps, popoverProps } = useAnchoredPopover({ align, side, width });
  const { ref } = popoverProps;

  useLayoutEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, ref]);

  return (
    <div className="relative">
      {trigger({ open, triggerProps: { ...triggerProps, "aria-haspopup": "menu" } })}
      <div {...popoverProps} role="menu" aria-labelledby={triggerProps.id}
        className={cn(styles.menu, className)}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
          if (!items.length) return;
          event.preventDefault();
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next].focus();
        }}>
        {children(close)}
      </div>
    </div>
  );
}

export function MenuItem({
  children,
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-2 [overflow-wrap:anywhere]",
        "transition-colors hover:bg-white/[0.05] hover:text-ink focus-visible:bg-white/[0.05] focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-volt focus-visible:-outline-offset-2",
        active && "bg-white/[0.05] text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/*
 * The dock's menus all read like the model menu: a quiet uppercase heading, then
 * rows of a bare mark, a name and an optional note. The chosen row is lit and
 * its mark turns volt.
 */

/** Names a menu, or a section of one. Quiet, because it repeats down a list. */
export function MenuLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3", className)}>{children}</div>;
}

/** A gap between sections, headed or not, so one never reads as the tail of the one above. */
export function MenuSection({ label, heading = true, children }: { label: string; heading?: boolean; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="pt-1.5 first:pt-0">
      {heading ? <MenuLabel>{label}</MenuLabel> : null}
      {children}
    </div>
  );
}

/** Explains an empty menu or an unavailable option, under the rows. */
export function MenuNote({ children, className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("px-2 py-1.5 text-[11.5px] leading-relaxed text-ink-3", className)} {...props}>{children}</p>;
}

/** Holds a row's icon, or a check for a selected plain value. */
export function MenuTile({ active, children, className }: { active?: boolean; children?: React.ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center transition-colors",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.8]",
        active ? "text-volt" : "text-ink-3 group-hover:text-ink-2 group-focus-visible:text-ink-2",
        className,
      )}
    >
      {children ?? (active ? <Check /> : null)}
    </span>
  );
}

/** One choice in a menu, laid out as the model list lays out a model. */
export function MenuOption({
  icon,
  label,
  note,
  noteClassName,
  badge,
  active,
  disabled,
  className,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon?: React.ReactNode;
  label: React.ReactNode;
  note?: React.ReactNode;
  noteClassName?: string;
  badge?: React.ReactNode;
  active?: boolean;
}) {
  return (
    <MenuItem
      active={active}
      aria-current={active || undefined}
      disabled={disabled}
      className={cn("group", note ? "items-start" : "items-center", disabled && "cursor-not-allowed opacity-45 hover:bg-transparent", className)}
      {...props}
    >
      <MenuTile active={active} className={note ? "mt-px" : undefined}>{icon}</MenuTile>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] text-ink">{label}</span>
          {badge}
        </span>
        {note ? <span className={cn("mt-px block text-[11.5px] leading-snug text-ink-3", noteClassName)}>{note}</span> : null}
      </span>
    </MenuItem>
  );
}
