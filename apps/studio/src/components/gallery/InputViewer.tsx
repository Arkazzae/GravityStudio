'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, ImageIcon, X } from '@/components/ui/icons';
import { type InputImage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useRetainedDialog } from '@/lib/use-retained-dialog';
import { DeleteImageButton } from './DeleteImageButton';
import { ZoomableImage } from './ZoomableImage';

export function InputViewer({ items, open, openId, onSelect, onClose, onDelete }: {
  items: InputImage[];
  open: boolean;
  openId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onDelete: (input: InputImage) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousIndex = useRef(0);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const selectedIndex = items.findIndex(input => input.id === openId);
  const index = selectedIndex === -1 && open && items.length ? Math.min(previousIndex.current, items.length - 1) : selectedIndex;
  const item = items[index];
  const dialogHandlers = useRetainedDialog({ dialog, open: open && !!item, onClose, initialFocus: dialog });

  useEffect(() => {
    if (!open) return;
    if (!item) { onClose(); return; }
    previousIndex.current = index;
    if (item.id !== openId) onSelect(item.id);
  }, [open, openId, index, item, onClose, onSelect]);

  const step = useCallback((offset: number) => {
    if (!open || items.length < 2 || index === -1) return;
    onSelect(items[(index + offset + items.length) % items.length].id);
  }, [open, index, items, onSelect]);

  async function remove(input: InputImage) {
    setDeleting(current => new Set(current).add(input.id));
    try { await onDelete(input); }
    finally { setDeleting(current => { const next = new Set(current); next.delete(input.id); return next; }); }
  }

  if (!item) return null;
  const details = [['Filename', item.name], ['Size', `${item.width} × ${item.height}`], ['Type', 'Imported image']];

  return <dialog ref={dialog} id="assets-input-viewer" aria-label={`${item.name} preview`} tabIndex={-1}
    {...dialogHandlers}
    onKeyDown={event => {
      if ((event.target as HTMLElement).closest('[data-photo-action]')) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1);
    }}
    className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-void p-0 text-ink backdrop:bg-black/80">
    <div className="flex h-full flex-col gap-3 p-3 lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-1 sm:px-12" style={{ containerType: 'size' }}
          onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
          <InputImagePreview key={item.url} item={item} />
          {items.length > 1 && <><Step side="left" onClick={() => step(-1)} /><Step side="right" onClick={() => step(1)} /></>}
        </div>
      </div>
      <aside className="flex max-h-[52dvh] w-full shrink-0 flex-col overflow-hidden rounded-panel bg-panel lg:max-h-none lg:w-[380px]">
        <header className="flex items-center gap-2.5 px-4 pt-4">
          <ImageIcon className="size-8 shrink-0 text-ink" strokeWidth={1.5} />
          <span className="min-w-0 flex-1"><span title={item.name} className="block truncate text-[14px] font-medium">{item.name}</span><span className="block truncate text-[12px] text-ink-2">Imported image{items.length > 1 ? ` · ${index + 1} of ${items.length} in this view` : ''}</span></span>
          <button type="button" data-dialog-dismiss aria-label="Close preview" title="Close preview" onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink"><X className="size-[18px]" strokeWidth={2} /></button>
        </header>
        <div data-dialog-scroll className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <details open className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden"><h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">Details</h2><ChevronDown className="ml-auto size-4 text-ink-2 transition-transform group-open:rotate-180" strokeWidth={2} /></summary>
            <dl className="mt-2 flex flex-col">{details.map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0"><dt className="shrink-0 text-[12.5px] text-ink-2">{label}</dt><dd title={value} className="truncate text-[12.5px] tabular-nums text-ink">{value}</dd></div>)}</dl>
          </details>
        </div>
        <footer className="flex flex-col gap-2 border-t border-line p-4">
          {deleteError?.id === item.id && deleteError.message && <p role="alert" className="error-notice text-xs">{deleteError.message}</p>}
          <div className="flex gap-2">
            <a href={item.url} download={`${item.name.replace(/\.(png|jpe?g|webp)$/i, '')}.png`} aria-label="Download image" className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white/[0.06] text-[14px] font-medium text-ink transition-colors hover:bg-white/[0.11]"><Download className="size-[18px]" strokeWidth={1.8} />Download</a>
            <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label="Open the file in a new tab" title="Open the file in a new tab" className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-ink-2 transition-colors hover:bg-white/[0.11] hover:text-ink"><ExternalLink className="size-[18px]" strokeWidth={1.8} /></a>
            <DeleteImageButton key={item.id} disabled={deleting.has(item.id)} onDelete={() => remove(item)} onError={message => setDeleteError({ id: item.id, message })} className="size-11 shrink-0 rounded-xl bg-white/[0.06] text-ink-2 hover:bg-white/[0.11] hover:text-ink" />
          </div>
        </footer>
      </aside>
    </div>
  </dialog>;
}

function InputImagePreview({ item }: { item: InputImage }) {
  const [failed, setFailed] = useState(false);
  return failed ? <div role="alert" className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl bg-panel-2 p-6 text-center text-[12px] text-ink-2"><ImageIcon className="size-6" /><span>Preview could not be loaded.</span><button type="button" className="text-action mt-2" onClick={() => setFailed(false)}>Try again</button></div>
    : <ZoomableImage src={item.url} alt={item.name} onError={() => setFailed(true)} className="max-h-full max-w-full rounded-lg" />;
}

function Step({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return <button type="button" aria-label={side === 'left' ? 'Previous image' : 'Next image'} onClick={onClick}
    className={cn('absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/[0.08] text-ink backdrop-blur', 'transition-colors hover:bg-white/[0.16] focus-visible:outline-2 focus-visible:outline-volt', side === 'left' ? 'left-0 sm:left-2' : 'right-0 sm:right-2')}><Icon className="size-5" strokeWidth={2} /></button>;
}
