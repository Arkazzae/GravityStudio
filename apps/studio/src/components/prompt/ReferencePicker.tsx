'use client';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from '@/components/ui/icons';
import { errorMessage, type Job } from '@/lib/api';
import styles from '@/components/studio/StudioDialog.module.css';

export function ReferencePicker({ jobs, onPick, onClose }: { jobs: Job[]; onPick: (files: File[]) => Promise<boolean>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const images = jobs.flatMap(job => job.outputs.filter(output => output.mimeType.startsWith('image/')).map(output => ({ ...output, prompt: job.prompt })));
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  async function choose(image: typeof images[number]) {
    setBusy(image.id); setError('');
    try {
      const response = await fetch(image.url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('This image could not be loaded. Try again.');
      const blob = await response.blob();
      const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png';
      if (await onPick([new File([blob], `reference-${image.id}.${extension}`, { type: image.mimeType })])) onClose();
      else setError('The reference could not be added. Close this picker to check the upload message.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  return <dialog ref={dialog} id="reference-picker-dialog" aria-labelledby="reference-picker-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} className={`pointer-events-auto ${styles.dialog} ${styles.centered}`}>
    <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-4"><div><h2 id="reference-picker-title" className="text-base font-medium">Choose a reference image</h2><p className="mt-1 text-xs text-ink-2">Use a saved output as the starting point for your next image.</p></div><button autoFocus aria-label="Close reference picker" onClick={onClose} className="ml-3 grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-chip hover:text-ink"><X size={18} /></button></div>
    {error && <p role="alert" className="error-notice m-4 shrink-0">{error}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{images.length ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">{images.map(image => <button key={image.id} disabled={!!busy} onClick={() => void choose(image)} aria-label={`Use reference: ${image.prompt.slice(0, 80)}`} className="group relative aspect-square overflow-hidden rounded-lg bg-panel-2 disabled:opacity-70"><img src={image.url} alt={image.prompt} loading="lazy" className="size-full object-cover transition-opacity group-hover:opacity-75" />{busy === image.id && <span className="absolute inset-0 grid place-items-center bg-black/40"><LoaderCircle className="size-6 animate-spin" /></span>}</button>)}</div> : <p className="px-4 py-12 text-center text-sm text-ink-2">Your generated images will appear here. You can upload a reference from your device using the image button.</p>}</div>
  </dialog>;
}
