'use client';

import { Check, InfoCircle, TriangleAlert, X } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

export interface ToastItem {
  id: string;
  kind: 'success' | 'info' | 'error';
  title: string;
  body?: string;
}

const ICON = { success: Check, info: InfoCircle, error: TriangleAlert };

/** The original Studio's compact notices, raised above the prompt dock. */
export function Toasts({ items, onDismiss, bottom = 20 }: { items: ToastItem[]; onDismiss: (id: string) => void; bottom?: number }) {
  if (!items.length) return null;

  return <div style={{ bottom: `max(${bottom}px, env(safe-area-inset-bottom))` }}
    className="pointer-events-none fixed right-5 z-[60] flex w-[340px] max-w-[calc(100vw-40px)] flex-col gap-2">
    {items.map(item => {
      const Icon = ICON[item.kind];
      return <div key={item.id} role={item.kind === 'error' ? 'alert' : 'status'} aria-atomic="true"
        className={cn('animate-toast-in pointer-events-auto flex shrink-0 items-start gap-3 rounded-2xl bg-raise px-4 py-3 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.9)] ring-1 motion-reduce:animate-none', item.kind === 'error' ? 'ring-volt/25' : 'ring-line')}>
        <Icon className={cn('mt-0.5 size-[17px] shrink-0', item.kind === 'info' ? 'text-ink-2' : 'text-volt')} strokeWidth={1.9} />
        <div className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
          <p className="font-medium text-ink">{item.title}</p>
          {item.body && <p className="mt-0.5 leading-relaxed text-ink-2">{item.body}</p>}
        </div>
        <button type="button" aria-label={`Dismiss ${item.title}`} onClick={() => onDismiss(item.id)}
          className="grid size-6 shrink-0 place-items-center rounded-full text-ink-2 transition-colors hover:bg-white/10 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-volt">
          <X className="size-3.5" strokeWidth={2} />
        </button>
      </div>;
    })}
  </div>;
}
