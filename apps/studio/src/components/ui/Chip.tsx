"use client";

import { ChevronDown, ChevronRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * 36px tall, 12px radius — the one control shape the dock and its menus share.
 * A chip carries the current setting; the name of the setting lives in the
 * panel it opens, so a dock row reads as values rather than as a form.
 */
export function Chip({
  children,
  icon,
  chevron,
  active,
  className,
  ...props
}: React.ComponentPropsWithRef<"button"> & {
  icon?: React.ReactNode;
  /** The reference keeps a chevron on the model chip alone — a value chip is
   *  read as a value, not as a form field. */
  chevron?: "down" | "right";
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-chip bg-white/[0.045] px-2.5 text-[13px] font-medium text-ink",
        "transition-colors duration-150",
        "hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-volt/40",
        "disabled:text-ink-3 disabled:hover:bg-white/[0.045]",
        active && "bg-white/[0.1]",
        className,
      )}
      {...props}
    >
      {icon ? <span className="grid size-[18px] shrink-0 place-items-center text-ink-2 [&_svg]:size-4 [&_svg]:stroke-[1.8]">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">{children}</span>
      {chevron === "down" ? <ChevronDown className="-mr-0.5 ml-auto size-3.5 shrink-0 text-ink-3" strokeWidth={2} /> : null}
      {chevron === "right" ? <ChevronRight className="-mr-0.5 ml-auto size-3.5 shrink-0 text-ink-3" strokeWidth={2} /> : null}
    </button>
  );
}

/** A chip reduced to its mark, for actions that sit at the end of a row. */
export function IconChip({
  children,
  active,
  className,
  ...props
}: React.ComponentPropsWithRef<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-chip text-ink-2 transition-colors duration-150",
        "hover:bg-white/[0.08] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-volt/40",
        "disabled:text-ink-3 disabled:opacity-50 disabled:hover:bg-transparent",
        "[&_svg]:size-4 [&_svg]:stroke-[1.8]",
        active && "bg-white/[0.1] text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
