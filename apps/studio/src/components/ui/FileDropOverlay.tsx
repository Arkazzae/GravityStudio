'use client';

import { createPortal } from 'react-dom';
import { ImagePlus } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

export function FileDropOverlay({ title, detail, target, fullscreen = false, available = true }: {
  title: string;
  detail?: string;
  target: 'references' | 'assets';
  fullscreen?: boolean;
  available?: boolean;
}) {
  const overlay = <div data-file-drop-target={target} role="status" className={cn('pointer-events-none inset-0 z-[70] grid place-items-center bg-black/60 p-4', fullscreen ? 'fixed' : 'absolute')}>
    <div className={cn('max-w-full rounded-3xl border-2 border-dashed bg-void/80 px-6 py-8 text-center backdrop-blur-sm sm:px-12 sm:py-10', available ? 'border-volt/70' : 'border-white/25')}>
      <ImagePlus className={cn('mx-auto size-8', available ? 'text-volt' : 'text-ink-3')} strokeWidth={1.6} aria-hidden="true" />
      <p className="mt-3 text-[15px] font-medium text-ink">{title}</p>
      {detail && <p className="max-w-sm text-[13px] text-ink-3">{detail}</p>}
    </div>
  </div>;
  return fullscreen ? typeof document === 'undefined' ? null : createPortal(overlay, document.body) : overlay;
}
