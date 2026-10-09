'use client';

import { ImageIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

export function FileDropOverlay({ title, detail, target, className }: {
  title: string;
  detail?: string;
  target: 'references' | 'assets';
  className?: string;
}) {
  return <div data-file-drop-target={target} role="status" className={cn('pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-volt bg-app/95 p-6 text-center shadow-dock', className)}>
    <div className="flex max-w-lg flex-col items-center gap-3">
      <ImageIcon className="size-8 text-volt" aria-hidden="true" />
      <p className="text-base font-medium text-ink">{title}</p>
      {detail && <p className="text-sm leading-relaxed text-ink-2">{detail}</p>}
    </div>
  </div>;
}
