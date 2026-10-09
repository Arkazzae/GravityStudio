'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, ImageIcon, Repeat2, X } from '@/components/ui/icons';
import { FavoriteButton } from '@/components/ui/FavoriteButton';
import { api, type InputImage, type Job, type StudioModel } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ZoomableImage } from './ZoomableImage';

export interface ViewerEntry {
  id: string;
  job: Job & { modelName?: string; input?: { images?: string[] } };
  output: Job['outputs'][number];
}

const labels: Record<string, string> = {
  steps: 'Steps', cfg: 'Guidance', negativePrompt: 'Negative prompt', sampler: 'Sampler',
  scheduler: 'Scheduler', clipSkip: 'CLIP skip', denoise: 'Image strength',
};

export function OutputViewer({ items, openId, models, onClose, onSelect, onReuse, onFavorite, favoriteBusy, favoriteError }: {
  items: ViewerEntry[];
  openId: string;
  models: StudioModel[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onReuse: (job: Job) => void;
  onFavorite: (job: Job, output: Job['outputs'][number]) => void;
  favoriteBusy: ReadonlySet<string>;
  favoriteError?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reusing = useRef(false);
  const previousIndex = useRef(0);
  const [id, setId] = useState(openId);
  const selectedIndex = items.findIndex(entry => entry.id === id);
  const index = selectedIndex === -1 && items.length ? Math.min(previousIndex.current, items.length - 1) : selectedIndex;
  const item = items[index];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    element.focus({ preventScroll: true });
    return () => {
      if (element.open) element.close();
      if (reusing.current) document.getElementById('image-prompt')?.focus({ preventScroll: true });
      else if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else (document.querySelector<HTMLElement>('[aria-label="Image filter"] button[aria-pressed="true"]') || document.getElementById('image-prompt'))?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!item) { onClose(); return; }
    previousIndex.current = index;
    if (item.id !== id) { setId(item.id); onSelect(item.id); }
  }, [id, index, item, onClose, onSelect]);

  const step = useCallback((offset: number) => {
    if (items.length < 2 || index === -1) return;
    const nextId = items[(index + offset + items.length) % items.length].id;
    setId(nextId); onSelect(nextId);
  }, [index, items, onSelect]);

  if (!item) return null;
  const name = item.job.modelName || models.find(model => model.id === item.job.modelId)?.name || item.job.modelId;
  const created = new Date(item.job.createdAt);
  const width = item.output.width || item.job.parameters.width;
  const height = item.output.height || item.job.parameters.height;
  const size = width && height ? `${width} × ${height}` : '';
  const parameters = Object.entries(item.job.parameters).filter(([key, value]) => !['prompt', 'seed', 'width', 'height'].includes(key) && value !== undefined && value !== null && value !== '');
  const details: [string, string][] = [
    ['Model', name],
    ...(size ? [['Size', size] as [string, string]] : []),
    ...parameters.map(([key, value]) => [labels[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, first => first.toUpperCase()), String(value)] as [string, string]),
    ...(item.job.parameters.seed !== undefined ? [['Seed', String(item.job.parameters.seed)] as [string, string]] : []),
    ['Created', Number.isNaN(created.valueOf()) ? 'Saved on your server' : created.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })],
  ];

  return <dialog ref={dialog} id="output-viewer" aria-label={`${name} output`} tabIndex={-1}
    onCancel={event => { event.preventDefault(); onClose(); }}
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
          <OutputImage key={item.output.url} src={item.output.url} prompt={item.job.prompt} />
          {items.length > 1 && <><Step side="left" onClick={() => step(-1)} /><Step side="right" onClick={() => step(1)} /></>}
        </div>
      </div>
      <aside className="flex max-h-[52dvh] w-full shrink-0 flex-col overflow-hidden rounded-panel bg-panel lg:max-h-none lg:w-[380px]">
        <header className="flex items-center gap-2.5 px-4 pt-4">
          <span aria-hidden="true" className="size-8 shrink-0 rounded-full bg-[conic-gradient(from_120deg,#d3f94c,#3ad6a0,#7a5cff,#d3f94c)]" />
          <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{name}</span><span className="block truncate text-[12px] text-ink-3">{items.length > 1 ? `${index + 1} of ${items.length} in this view` : 'Saved on your server'}</span></span>
          <PanelAction label="Close preview" onClick={onClose}><X className="size-[18px]" strokeWidth={2} /></PanelAction>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2"><SectionLabel>Prompt</SectionLabel><CopyPrompt key={item.id} prompt={item.job.prompt} /></div>
            <div className="rounded-xl bg-panel-2 p-3">
              <InputReferences key={item.job.id} ids={item.job.input?.images} />
              <p className="text-[13px] leading-6 text-ink-2 [overflow-wrap:anywhere]">{item.job.prompt || 'This run was submitted without a prompt.'}</p>
            </div>
          </section>
          <details open className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden"><SectionLabel>Details</SectionLabel><ChevronDown className="ml-auto size-4 text-ink-3 transition-transform group-open:rotate-180" strokeWidth={2} /></summary>
            <dl className="mt-2 flex flex-col">{details.map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0"><dt className="shrink-0 text-[12.5px] text-ink-3">{label}</dt><dd title={value} className="truncate text-[12.5px] tabular-nums text-ink">{value}</dd></div>)}</dl>
          </details>
        </div>
        <footer className="flex flex-col gap-2 border-t border-line p-4">
          {favoriteError && <p role="alert" className="error-notice text-xs">{favoriteError}</p>}
          <button type="button" onClick={() => { reusing.current = true; onReuse(item.job); onClose(); }}
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-volt text-[14px] font-semibold text-on-volt shadow-key transition-[background-color,box-shadow,translate] duration-150 ease-[var(--ease-out-quint)] hover:bg-volt-hi active:translate-y-[2px] active:shadow-key-down focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-volt motion-reduce:transition-none motion-reduce:active:translate-y-0">
            <Repeat2 className="size-[18px]" strokeWidth={2} />Use these settings
          </button>
          <div className="flex gap-2">
            <a href={item.output.url} download aria-label="Download image" className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white/[0.06] text-[14px] font-medium text-ink transition-colors hover:bg-white/[0.11]"><Download className="size-[18px]" strokeWidth={1.8} />Download</a>
            <FavoriteButton favorite={!!item.output.favorite} busy={favoriteBusy.has(`${item.job.id}:${item.output.id}`)} onClick={() => onFavorite(item.job, item.output)} variant="viewer" />
            <a href={item.output.url} target="_blank" rel="noopener noreferrer" aria-label="Open the file in a new tab" title="Open the file in a new tab" className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-ink-2 transition-colors hover:bg-white/[0.11] hover:text-ink"><ExternalLink className="size-[18px]" strokeWidth={1.8} /></a>
          </div>
        </footer>
      </aside>
    </div>
  </dialog>;
}

function InputReferences({ ids = [] }: { ids?: string[] }) {
  const [images, setImages] = useState<InputImage[]>([]);
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const wanted = key.split(',');
    void api<{ inputs: InputImage[] }>('/inputs', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setImages(wanted.flatMap(id => result.inputs.filter(image => image.id === id)));
    }).catch(() => { /* The saved prompt and output stay available if input previews cannot be loaded. */ });
    return () => controller.abort();
  }, [key]);
  return images.length ? <div className="mb-2.5 flex flex-wrap gap-1.5">{images.map(image => <img key={image.id} src={image.url} alt={`Source image: ${image.name}`} className="size-14 rounded-lg object-cover" />)}</div> : null;
}

function OutputImage({ src, prompt }: { src: string; prompt: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <div role="alert" className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl bg-panel-2 p-6 text-center text-[12px] text-ink-2"><ImageIcon className="size-6" /><span>Preview could not be loaded.</span><button type="button" className="text-action mt-2" onClick={() => setFailed(false)}>Try again</button></div>
    : <ZoomableImage src={src} alt={prompt} onError={() => setFailed(true)} className="max-h-full max-w-full rounded-lg" />;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-3">{children}</h2>;
}

async function copyText(text: string, host: HTMLElement) {
  try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return; } } catch { /* HTTP deployments can use the selected-text fallback. */ }
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement('textarea');
  input.value = text; input.readOnly = true; input.tabIndex = -1;
  Object.assign(input.style, { position: 'fixed', left: '0', top: '0', opacity: '0', width: '1px', height: '1px' });
  host.append(input);
  try {
    input.focus({ preventScroll: true }); input.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally { input.remove(); previous?.focus({ preventScroll: true }); }
}

function CopyPrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);
  if (!prompt) return null;
  return <div className="ml-auto text-right"><button type="button" aria-label="Copy prompt" onClick={async event => {
    const host = event.currentTarget.closest('dialog');
    setError(false);
    try { if (!host) throw new Error('Preview closed'); await copyText(prompt, host); setCopied(true); }
    catch { setCopied(false); setError(true); }
  }} className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2 text-[12px] font-medium text-ink-2 transition-colors hover:bg-white/[0.11] hover:text-ink">
    {copied ? <Check className="size-3.5 text-volt" strokeWidth={2.4} /> : <Copy className="size-3.5" strokeWidth={1.8} />}{copied ? 'Copied' : 'Copy'}
  </button>{error && <p role="status" className="mt-2 max-w-60 text-[11px] leading-relaxed text-ink-2">Copy is unavailable. Select the prompt text and use your browser’s Copy command.</p>}</div>;
}

function Step({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return <button type="button" aria-label={side === 'left' ? 'Previous output' : 'Next output'} onClick={onClick}
    className={cn('absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/[0.08] text-ink backdrop-blur', 'transition-colors hover:bg-white/[0.16] focus-visible:outline-2 focus-visible:outline-volt', side === 'left' ? 'left-0 sm:left-2' : 'right-0 sm:right-2')}><Icon className="size-5" strokeWidth={2} /></button>;
}

function PanelAction({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink">{children}</button>;
}
