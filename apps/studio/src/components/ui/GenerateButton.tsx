"use client";

import type { ComponentProps } from "react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type GenerateButtonProps = Omit<ComponentProps<"button">, "children"> & {
  busy?: boolean;
  /** Server-derived detail under the label, such as a measured estimate. */
  hint?: string;
  /** "lg" is the dock's own: the widest, loudest thing on the bar. */
  size?: "md" | "lg";
  /** What this particular submit does, when it is not plain generation. */
  label?: string;
  busyLabel?: string;
};

/**
 * The house primary, shaped after the sign-in submit: a flat volt face on a
 * hard edge, with the word standing on its own. The press travels down into
 * the edge rather than scaling the face, so the button reads as a key.
 */
export function GenerateButton({ busy = false, hint, size = "md", label = "Generate", busyLabel = "Submitting…", className, disabled, ...props }: GenerateButtonProps) {
  const large = size === "lg";
  const live = !busy && !disabled;
  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={disabled}
      title="Submit to your generation queue · ⌘↵"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-0.5 px-4 font-semibold",
        large ? "min-h-16 rounded-[17px] text-[18px] tracking-[-0.01em]" : "min-h-13 rounded-[13px] text-[15px]",
        "transition-[background-color,box-shadow,translate] duration-150 ease-[var(--ease-out-quint)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt",
        "motion-reduce:transition-none",
        // A submit in flight keeps the volt, the way the sign-in submit does, so
        // the bar still shows where the action went. A blocked one goes quiet
        // and lies flat — nothing to press.
        busy && "cursor-wait bg-volt-busy text-on-volt shadow-key",
        disabled && !busy && "cursor-not-allowed bg-white/[0.07] text-ink-2",
        live && "bg-volt text-on-volt shadow-key hover:bg-volt-hi active:translate-y-[2px] active:shadow-key-down motion-reduce:active:translate-y-0",
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-2.5">
        {busy ? <LoaderCircle className={cn("animate-spin", large ? "size-[18px]" : "size-4")} strokeWidth={2.2} /> : null}
        {busy ? busyLabel : label}
      </span>
      {hint && !busy ? (
        <span className={cn("font-medium tabular-nums opacity-70", large ? "text-[12.5px]" : "text-[11.5px]")}>{hint}</span>
      ) : null}
    </button>
  );
}
