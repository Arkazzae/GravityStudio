'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Download, Heart, ImageIcon, LoaderCircle, Repeat2, TriangleAlert } from '@/components/ui/icons';
import { FavoriteButton } from '@/components/ui/FavoriteButton';
import { api, errorMessage, type Job, type StudioModel } from '@/lib/api';
import { ResolveJobButton } from '@/components/studio/ResolveJobButton';
import { OutputViewer, type ViewerEntry } from './OutputViewer';
import { DeleteImageButton } from './DeleteImageButton';

interface Entry { id: string; job: Job; output?: Job['outputs'][number]; aspect: number }
interface Row { height: number; cells: Array<{ entry: Entry; width: number }> }
function layout(items: Entry[], width: number, target: number, gap: number): Row[] {
  const rows: Row[] = []; let current: Entry[] = []; let ratios = 0;
  const clamp = (ratio: number) => Math.min(Math.max(ratio || 1, .55), 2.6);
  function flush(height: number, fill: boolean) {
    const available = width - gap * (current.length - 1); let used = 0;
    rows.push({ height, cells: current.map((entry, index) => { const cellWidth = fill && index === current.length - 1 ? available - used : Math.floor(clamp(entry.aspect) * height); used += cellWidth; return { entry, width: cellWidth }; }) }); current = []; ratios = 0;
  }
  for (const item of items) { current.push(item); ratios += clamp(item.aspect); const available = width - gap * (current.length - 1); if (ratios * target >= available) flush(available / ratios, true); }
  if (current.length) flush(Math.min(target, (width - gap * (current.length - 1)) / ratios), false);
  return rows;
}
const labels: Record<Job['status'], string> = { queued: 'Waiting in queue', preparing: 'Loading model', running: 'Generating', succeeded: 'Complete', failed: 'Generation failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };

export function GalleryGrid({ jobs, models, zoom, square, onReuse, onFavorite, onDelete, favoriteBusy, favoriteError, filter, onChange, configured, hasWorkers, onOpenModels, onOpenSettings }: { jobs: Job[]; models: StudioModel[]; zoom: number; square: boolean; onReuse: (job: Job) => void; onFavorite: (job: Job, output: Job['outputs'][number]) => void; onDelete: (job: Job, output: Job['outputs'][number]) => Promise<void>; favoriteBusy: ReadonlySet<string>; favoriteError?: string; filter: 'all' | 'queue' | 'favorites'; onChange: () => void; configured: boolean; hasWorkers: boolean; onOpenModels: () => void; onOpenSettings: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const imageBusy = useMemo(() => new Set([...favoriteBusy, ...deleting]), [favoriteBusy, deleting]);
  useEffect(() => { const element = container.current; if (!element) return; const measure = () => setWidth(element.getBoundingClientRect().width); measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect(); }, []);
  const entries = useMemo<Entry[]>(() => jobs.filter(job => job.status !== 'cancelled' && (job.status !== 'succeeded' || job.outputs.length > 0)).flatMap(job => job.outputs.length ? job.outputs.filter(output => output.mimeType.startsWith('image/')).map(output => ({ id: `${job.id}-${output.id}`, job, output, aspect: square ? 1 : (output.width || job.parameters.width || 1024) / (output.height || job.parameters.height || 1024) })) : [{ id: job.id, job, aspect: square ? 1 : (job.parameters.width || 1024) / (job.parameters.height || 1024) }]), [jobs, square]);
  const rows = useMemo(() => width ? layout(entries, width, 150 + zoom * 420, 4) : [], [entries, width, zoom]);
  const outputs = useMemo(() => entries.filter((entry): entry is Entry & ViewerEntry => !!entry.output), [entries]);
  const modelName = (job: Job) => models.find(model => model.id === job.modelId)?.name || job.modelId;
  const EmptyIcon = filter === 'favorites' ? Heart : filter === 'queue' ? Clock3 : ImageIcon;
  const emptyTitle = filter === 'favorites' ? 'No favorites yet.' : filter === 'queue' ? 'Your queue is clear.' : configured ? 'Your next image starts here.' : hasWorkers ? 'Choose your first model.' : 'Set up your studio.';
  const emptyDescription = filter === 'favorites' ? 'Save an image with the heart button to find it here.' : filter === 'queue' ? 'New generations and jobs that need attention will appear here.' : configured ? 'Describe the shot below. Your generated images and their settings will appear here.' : hasWorkers ? 'Download a checkpoint from Models to create your first image.' : 'Choose the GPUs to use. Your studio will handle the rest.';
  async function cancel(job: Job) {
    setCancelling(job.id); setError('');
    try { await api(`/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' }); onChange(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setCancelling(null); }
  }
  async function remove(job: Job, output: Job['outputs'][number]) {
    const key = `${job.id}:${output.id}`;
    setDeleting(current => new Set(current).add(key));
    try { await onDelete(job, output); }
    finally { setDeleting(current => { const next = new Set(current); next.delete(key); return next; }); }
  }
  return <div ref={container} className="flex min-h-full flex-col gap-1">
    {error && <p role="alert" className="error-notice mx-4 my-3">{error}</p>}
    {!entries.length && <div className="flex min-h-[320px] flex-1 flex-col items-center justify-center px-6 py-12 text-center"><EmptyIcon className="mb-5 size-8 text-ink-2" strokeWidth={1.3} /><h1 className="text-lg font-medium">{emptyTitle}</h1><p className="mt-2 max-w-[380px] text-sm leading-relaxed text-ink-2">{emptyDescription}</p>{filter === 'all' && !configured && <button type="button" onClick={hasWorkers ? onOpenModels : onOpenSettings} className="mt-6 rounded-chip bg-chip px-4 py-3 text-sm font-medium transition-colors hover:bg-chip-hi">{hasWorkers ? 'Browse models' : 'Set up generation'}</button>}</div>}
    {rows.map((row, index) => <div key={index} className="flex gap-1" style={{ height: row.height }}>{row.cells.map(({ entry, width }) => entry.output ? <figure key={entry.id} className="group relative shrink-0 overflow-hidden bg-panel" style={{ width }}>
      <img src={entry.output.url} alt={entry.job.prompt} loading="lazy" decoding="async" className="size-full object-cover" />
      <button aria-label={`Open ${modelName(entry.job)} output`} onClick={() => setViewing(entry.id)} className="absolute inset-0 cursor-zoom-in focus-visible:-outline-offset-2" />
      <div className="absolute right-2 top-2 flex flex-col gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"><FavoriteButton favorite={!!entry.output.favorite} busy={imageBusy.has(`${entry.job.id}:${entry.output.id}`)} onClick={() => onFavorite(entry.job, entry.output!)} /><button aria-label="Use these settings" title="Use these settings" onClick={() => onReuse(entry.job)} className="grid size-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/85"><Repeat2 size={16} /></button><a href={entry.output.url} download aria-label="Download image" title="Download image" className="grid size-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/85"><Download size={16} /></a>{['succeeded', 'failed', 'cancelled'].includes(entry.job.status) && <DeleteImageButton disabled={imageBusy.has(`${entry.job.id}:${entry.output.id}`)} onDelete={() => remove(entry.job, entry.output!)} />}</div>
      {entry.output.favorite && <Heart variant="Bold" className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-hot opacity-90 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 max-md:hidden" />}
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-3 pt-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><p className="line-clamp-2 text-xs leading-snug text-white/90">{entry.job.prompt}</p></figcaption>
    </figure> : <div key={entry.id} className="relative flex shrink-0 flex-col items-center justify-center gap-2 overflow-auto bg-panel-2 p-4 text-center" style={{ width }}>
      {['failed', 'interrupted'].includes(entry.job.status) ? <TriangleAlert size={22} className="text-[#ffc3aa]" /> : entry.job.status === 'queued' ? <Clock3 size={25} className="text-ink-2" /> : <LoaderCircle size={26} className="animate-spin text-ink-2" />}
      <p className="text-xs font-medium">{modelName(entry.job)}</p><p className="text-xs text-ink-2" role="status">{entry.job.stage || labels[entry.job.status]}{entry.job.progress != null && entry.job.status === 'running' ? ` · ${Math.round(entry.job.progress * 100)}%` : ''}</p>
      {entry.job.error && <p className="line-clamp-4 text-xs leading-relaxed text-[#ffc3aa]">{entry.job.error}</p>}
      <p className="line-clamp-2 text-[11px] leading-snug text-ink-2">{entry.job.prompt}</p>
      {entry.job.status === 'queued' ? <button disabled={cancelling === entry.job.id} onClick={() => void cancel(entry.job)} className="mt-1 text-xs text-ink-2 underline underline-offset-4 disabled:opacity-50">{cancelling === entry.job.id ? 'Cancelling…' : 'Cancel'}</button> : ['failed', 'interrupted'].includes(entry.job.status) ? <button onClick={() => onReuse(entry.job)} className="mt-1 text-xs text-ink-2 underline underline-offset-4">Use these settings</button> : null}
      {entry.job.status === 'interrupted' && <ResolveJobButton job={entry.job} onChange={onChange} />}
    </div>)}</div>)}
    {viewing && <OutputViewer items={outputs} openId={viewing} models={models} onClose={() => setViewing(null)} onSelect={setViewing} onReuse={onReuse} onFavorite={onFavorite} favoriteBusy={imageBusy} favoriteError={favoriteError} />}
  </div>;
}
