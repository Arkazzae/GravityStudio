"use client";

import type { CSSProperties } from "react";
import type { Brand } from "@/lib/model-brand";
import { cn } from "@/lib/utils";

/**
 * The lab a model comes from, as its own mark in a single colour.
 *
 * A mark is a mask filled with `currentColor`, so it takes the colour of the text
 * around it — quiet grey down a list, volt on the chosen model — instead of the
 * plate its designer drew it on. In a menu it sits on the row's `MenuTile`;
 * inline it sits like any other icon and `className` sizes it.
 */
export function BrandMark({ brand, className }: { brand: Brand; className?: string }) {
  return brand.src ? (
    <span
      aria-hidden
      className={cn("block size-4 shrink-0 bg-current", className)}
      style={{ maskImage: `url("${brand.src}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center" } satisfies CSSProperties}
    />
  ) : (
    <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center text-[12px] font-semibold leading-none", className)}>
      {brand.initial}
    </span>
  );
}
