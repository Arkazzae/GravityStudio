'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Download, ImageIcon, LoaderCircle, Repeat2, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { api, errorMessage, type Job, type StudioModel } from '@/lib/api';
import { ResolveJobButton } from '@/components/studio/ResolveJobButton';

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

export function GalleryGrid({ jobs, models, zoom, square, onReuse, onChange, configured }: { jobs: Job[]; models: StudioModel[]; zoom: number; square: boolean; onReuse: (job: Job) => void; onChange: () => void; configured: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState<Entry | null>(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  useEffect(() => { const element = container.current; if (!element) return; const measure = () => setWidth(element.getBoundingClientRect().width); measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect(); }, []);
  const entries = useMemo(() => jobs.filter(job => job.status !== 'cancelled').flatMap(job => job.outputs.length ? job.outputs.filter(output => output.mimeType.startsWith('image/')).map(output => ({ id: `${job.id}-${output.id}`, job, output, aspect: square ? 1 : (output.width || job.parameters.width || 1024) / (output.height || job.parameters.height || 1024) })) : [{ id: job.id, job, aspect: square ? 1 : (job.parameters.width || 1024) / (job.parameters.height || 1024) }]), [jobs, square]);
  const rows = useMemo(() => width ? layout(entries, width, 150 + zoom * 420, 4) : [], [entries, width, zoom]);
  const modelName = (job: Job) => models.find(model => model.id === job.modelId)?.name || job.modelId;
  async function cancel(job: Job) {
    setCancelling(job.id); setError('');
    try { await api(`/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' }); onChange(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setCancelling(null); }
  }
  return <div ref={container} className="flex min-h-full flex-col gap-1">
    {error && <p role="alert" className="error-notice mx-4 my-3">{error}</p>}
    {!entries.length && <div className="flex min-h-[320px] flex-1 flex-col items-center justify-center px-6 py-12 text-center"><ImageIcon className="mb-5 size-8 text-ink-2" strokeWidth={1.3} /><h1 className="text-lg font-medium">{configured ? 'Your next image starts here.' : 'Your studio is ready to connect.'}</h1><p className="mt-2 max-w-[380px] text-sm leading-relaxed text-ink-2">{configured ? 'Describe the shot below. Your generated images and their settings will appear here.' : 'Connect ComfyUI and choose an image model to create your first image.'}</p>{!configured && <Link href="/settings" className="mt-6 rounded-chip bg-chip px-4 py-3 text-sm font-medium transition-colors hover:bg-chip-hi">Set up generation</Link>}</div>}
    {rows.map((row, index) => <div key={index} className="flex gap-1" style={{ height: row.height }}>{row.cells.map(({ entry, width }) => entry.output ? <figure key={entry.id} className="group relative shrink-0 overflow-hidden bg-panel" style={{ width }}>
      <img src={entry.output.url} alt={entry.job.prompt} loading="lazy" decoding="async" className="size-full object-cover" />
      <button aria-label={`Open ${modelName(entry.job)} output`} onClick={() => setViewing(entry)} className="absolute inset-0 cursor-zoom-in focus-visible:-outline-offset-2" />
      <div className="absolute right-2 top-2 flex flex-col gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"><button aria-label="Use these settings" title="Use these settings" onClick={() => onReuse(entry.job)} className="grid size-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/85"><Repeat2 size={16} /></button><a href={entry.output.url} download aria-label="Download image" title="Download image" className="grid size-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/85"><Download size={16} /></a></div>
      <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-3 pt-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><p className="line-clamp-2 text-xs leading-snug text-white/90">{entry.job.prompt}</p></figcaption>
    </figure> : <div key={entry.id} className="relative flex shrink-0 flex-col items-center justify-center gap-2 overflow-auto bg-panel-2 p-4 text-center" style={{ width }}>
      {['failed', 'interrupted'].includes(entry.job.status) ? <TriangleAlert size={22} className="text-[#ffc3aa]" /> : entry.job.status === 'queued' ? <Clock3 size={25} className="text-ink-2" /> : <LoaderCircle size={26} className="animate-spin text-ink-2" />}
      <p className="text-xs font-medium">{modelName(entry.job)}</p><p className="text-xs text-ink-2" role="status">{entry.job.stage || labels[entry.job.status]}{entry.job.progress != null && entry.job.status === 'running' ? ` · ${Math.round(entry.job.progress * 100)}%` : ''}</p>
      {entry.job.error && <p className="line-clamp-4 text-xs leading-relaxed text-[#ffc3aa]">{entry.job.error}</p>}
      <p className="line-clamp-2 text-[11px] leading-snug text-ink-2">{entry.job.prompt}</p>
      {entry.job.status === 'queued' ? <button disabled={cancelling === entry.job.id} onClick={() => void cancel(entry.job)} className="mt-1 text-xs text-ink-2 underline underline-offset-4 disabled:opacity-50">{cancelling === entry.job.id ? 'Cancelling…' : 'Cancel'}</button> : ['failed', 'interrupted'].includes(entry.job.status) ? <button onClick={() => onReuse(entry.job)} className="mt-1 text-xs text-ink-2 underline underline-offset-4">Use these settings</button> : null}
      {entry.job.status === 'interrupted' && <ResolveJobButton job={entry.job} onChange={onChange} />}
    </div>)}</div>)}
    {viewing?.output && <OutputViewer entry={viewing} name={modelName(viewing.job)} onClose={() => setViewing(null)} onReuse={() => { onReuse(viewing.job); setViewing(null); }} />}
  </div>;
}

function OutputViewer({ entry, name, onClose, onReuse }: { entry: Entry; name: string; onClose: () => void; onReuse: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} className="fixed inset-0 m-auto h-[min(90dvh,1000px)] w-[min(94vw,1440px)] max-w-none overflow-hidden rounded-panel bg-panel p-0 text-ink shadow-dock">
    <div className="flex h-full flex-col"><div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3"><p className="truncate text-sm font-medium">{name}</p><div className="flex items-center gap-3"><a href={entry.output?.url} download className="grid size-9 place-items-center rounded-lg hover:bg-chip" aria-label="Download image"><Download size={17} /></a><button autoFocus onClick={onClose} className="grid size-9 place-items-center rounded-lg hover:bg-chip" aria-label="Close image"><X size={19} /></button></div></div><div className="min-h-0 flex-1 bg-void"><img src={entry.output?.url} alt={entry.job.prompt} className="size-full object-contain" /></div><div className="flex max-h-[25dvh] shrink-0 flex-wrap items-center gap-4 overflow-auto border-t border-line px-5 py-4"><div className="min-w-0 flex-1"><p className="text-sm leading-relaxed">{entry.job.prompt}</p><p className="mt-2 text-xs tabular-nums text-ink-2">{entry.job.parameters.width} × {entry.job.parameters.height} · {entry.job.parameters.steps} steps · Seed {entry.job.parameters.seed}</p></div><button onClick={onReuse} className="flex items-center gap-2 rounded-chip bg-chip px-3 py-2.5 text-xs hover:bg-chip-hi"><Repeat2 size={15} />Use settings</button></div></div>
  </dialog>;
}
