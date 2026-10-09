'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Expand, ImagePlus, Library, LoaderCircle, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { Chip, IconChip } from '@/components/ui/Chip';
import { GenerateButton } from '@/components/ui/GenerateButton';
import { Popover } from '@/components/ui/Popover';
import { ModelMenu } from './ModelMenu';
import { ReferencePicker } from './ReferencePicker';
import { api, errorMessage, type InputImage, type StudioModel, type Job } from '@/lib/api';

export interface Draft { modelId: string; prompt: string; negativePrompt: string; width: number; height: number; steps: number; cfg: number; seed: string; denoise: number; images: InputImage[] }
export const initialDraft: Draft = { modelId: '', prompt: '', negativePrompt: '', width: 1024, height: 1024, steps: 30, cfg: 7, seed: '', denoise: .75, images: [] };
export function modelDraft(draft: Draft, model: StudioModel): Draft { return { ...draft, modelId: model.id, ...model.defaults, negativePrompt: model.defaults.negativePrompt || '', seed: '', denoise: .75 }; }
const ratios = [{ label: '1:1', width: 1024, height: 1024 }, { label: '4:3', width: 1152, height: 864 }, { label: '3:4', width: 864, height: 1152 }, { label: '16:9', width: 1344, height: 768 }, { label: '9:16', width: 768, height: 1344 }];

export function PromptDock({ models, draft, setDraft, onSubmitted, onHeight, connected, onSessionExpired, jobs }: { jobs: Job[]; models: StudioModel[]; draft: Draft; setDraft: (draft: Draft) => void; onSubmitted: (job: Job) => void; onHeight: (height: number) => void; connected: boolean; onSessionExpired: () => void }) {
  const dock = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastAttempt = useRef<{ body: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState('');
  const model = models.find(model => model.id === draft.modelId);
  const maxImages = model?.capabilities?.maxImages ?? model?.limits?.maxImages ?? 0;
  const operation = draft.images.length ? model?.operations?.includes('reference') ? 'reference' : 'image-to-image' : 'text-to-image';
  const canSubmit = connected && model?.ready && !!draft.prompt.trim() && draft.images.length <= maxImages && !busy && !uploading;
  const update = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  useLayoutEffect(() => { if (!prompt.current) return; prompt.current.style.height = '0px'; prompt.current.style.height = `${Math.min(160, Math.max(40, prompt.current.scrollHeight))}px`; }, [draft.prompt]);
  useEffect(() => {
    const element = prompt.current;
    if (!element) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      element.style.height = '0px';
      element.style.height = `${Math.min(160, Math.max(40, element.scrollHeight))}px`;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!dock.current) return; const observer = new ResizeObserver(([entry]) => onHeight(entry.contentRect.height + 48)); observer.observe(dock.current); return () => observer.disconnect(); }, [onHeight]);
  async function upload(files: File[]) {
    if (!files.length || uploading) return false;
    if (files.length + draft.images.length > maxImages) { setError(`This model accepts up to ${maxImages} reference image${maxImages === 1 ? '' : 's'}.`); return false; }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { setError('Choose PNG, JPEG, or WebP images.'); return false; }
    setUploading(true); setError('');
    const added: InputImage[] = [];
    try {
      for (const file of files) added.push(await api<InputImage>('/inputs', { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file }));
    } catch (error) { setError(errorMessage(error)); }
    finally { if (added.length) update({ images: [...draft.images, ...added] }); setUploading(false); }
    return added.length === files.length;
  }
  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      const body = JSON.stringify({ modelId: draft.modelId, operation, prompt: draft.prompt, negativePrompt: draft.negativePrompt, width: draft.width, height: draft.height, steps: draft.steps, cfg: draft.cfg, ...(draft.seed.trim() ? { seed: Number(draft.seed) } : {}), ...(draft.images.length ? { images: draft.images.map(image => image.id) } : {}), ...(operation === 'image-to-image' ? { denoise: draft.denoise } : {}) });
      if (lastAttempt.current?.body !== body) lastAttempt.current = { body, key: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') };
      const result = await api<Job | { job: Job }>('/jobs', { method: 'POST', headers: { 'Idempotency-Key': lastAttempt.current.key }, body });
      lastAttempt.current = null;
      onSubmitted('job' in result ? result.job : result);
    } catch (error) { setError(errorMessage(error)); if ((error as { status?: number }).status === 401) onSessionExpired(); }
    finally { setBusy(false); }
  }
  const ratio = ratios.find(entry => entry.width === draft.width && entry.height === draft.height);
  return <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4">
    <div ref={dock} className="animate-dock-in pointer-events-auto flex max-h-[70dvh] w-full max-w-[1120px] flex-col gap-3 overflow-y-auto rounded-dock border border-white/[0.07] bg-raise p-3 shadow-dock transition-colors focus-within:border-white/[0.14] sm:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-start gap-3 pl-1 pt-0.5" onDragOver={event => { if (maxImages) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (maxImages) void upload(Array.from(event.dataTransfer.files)); }}>
          {(maxImages > 0 || draft.images.length > 0) && <div className="flex max-w-[180px] shrink-0 flex-wrap gap-2 pt-1">
            <input ref={fileInput} className="sr-only" type="file" aria-label="Upload reference images" accept="image/png,image/jpeg,image/webp" multiple={maxImages > 1} onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} />
            {draft.images.map((image, index) => <div key={image.id} className="relative size-10"><img src={image.url} alt={`Reference ${index + 1}: ${image.name}`} className="size-full rounded-chip object-cover" /><button type="button" aria-label={`Remove reference ${index + 1}`} onClick={() => update({ images: draft.images.filter(entry => entry.id !== image.id) })} className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-raise ring-1 ring-line-2"><X size={12} /></button></div>)}
            {draft.images.length < maxImages && <button type="button" aria-label="Add reference image" title="Add reference image" disabled={uploading} onClick={() => fileInput.current?.click()} className="grid size-10 place-items-center rounded-chip bg-white/[0.03] text-ink-2 ring-1 ring-line-2 transition-colors hover:bg-white/[0.09] hover:text-ink disabled:opacity-50">{uploading ? <LoaderCircle size={17} className="animate-spin" /> : <ImagePlus size={19} />}</button>}
            {draft.images.length < maxImages && <button type="button" aria-label="Browse saved images" title="Browse saved images" disabled={uploading} onClick={() => setBrowsing(true)} className="grid size-10 place-items-center rounded-chip bg-white/[0.03] text-ink-2 ring-1 ring-line-2 transition-colors hover:bg-white/[0.09] hover:text-ink disabled:opacity-50"><Library size={18} /></button>}
          </div>}
          <label htmlFor="image-prompt" className="sr-only">Image prompt</label><textarea ref={prompt} id="image-prompt" value={draft.prompt} maxLength={16000} onChange={event => update({ prompt: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} onPaste={event => { if (maxImages && event.clipboardData.files.length) { event.preventDefault(); void upload(Array.from(event.clipboardData.files)); } }} rows={1} placeholder={draft.images.length ? 'Describe what you want to change in this image.' : 'Describe the shot you want.'} className="max-h-40 min-h-10 min-w-0 w-full resize-none bg-transparent py-2 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-2" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5"><div className="-mb-1.5 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1.5">
          <ModelMenu models={models} value={draft.modelId} referenceCount={draft.images.length} onChange={id => { const next = models.find(model => model.id === id); if (next) setDraft(modelDraft(draft, next)); }} />
          <Popover label="Image size" title="Aspect ratio" width={280} trigger={({ open, triggerProps }) => <Chip {...triggerProps} disabled={!model} active={open} icon={<Expand />} aria-label={`Aspect ratio: ${ratio?.label || `${draft.width} × ${draft.height}`}`}>{ratio?.label || `${draft.width} × ${draft.height}`}</Chip>}>{close => <><div className="grid grid-cols-3 gap-2">{ratios.map(entry => <button key={entry.label} onClick={() => { update({ width: entry.width, height: entry.height }); close(); }} aria-pressed={ratio?.label === entry.label} className={`flex h-16 flex-col items-center justify-center gap-2 rounded-lg text-xs ${ratio?.label === entry.label ? 'bg-chip-hi text-volt' : 'bg-panel-2 hover:bg-chip'}`}><span className="block rounded-xs border border-current" style={{ width: 18 * Math.min(entry.width / entry.height, 1.5), height: 18 }} />{entry.label}</button>)}</div><p className="mt-3 text-xs text-ink-2">{draft.width} × {draft.height} pixels</p></>}</Popover>
          <Chip disabled={!model} title="Sampling steps" onClick={() => document.getElementById('advanced-trigger')?.click()}>{draft.steps} steps</Chip>
        </div><div className="flex shrink-0 items-center gap-0.5 border-l border-white/[0.06] pl-1.5">
          <Popover label="Advanced settings" title="Advanced" width={320} align="end" trigger={({ open, triggerProps }) => <IconChip {...triggerProps} id="advanced-trigger" active={open} disabled={!model} aria-label="Advanced settings" title="Advanced settings"><SlidersHorizontal /></IconChip>}>{() => <div className="max-h-[min(60dvh,480px)] space-y-4 overflow-auto p-1">
            <div className="grid grid-cols-2 gap-3"><label className="field">Width<input type="number" min={model?.limits?.width?.min ?? 256} max={model?.limits?.width?.max ?? 2048} step={model?.limits?.width?.step ?? 16} value={draft.width} onChange={event => update({ width: Number(event.target.value) })} /></label><label className="field">Height<input type="number" min={model?.limits?.height?.min ?? 256} max={model?.limits?.height?.max ?? 2048} step={model?.limits?.height?.step ?? 16} value={draft.height} onChange={event => update({ height: Number(event.target.value) })} /></label><label className="field">Steps<input type="number" min={model?.limits?.steps?.min ?? 1} max={model?.limits?.steps?.max ?? 100} value={draft.steps} onChange={event => update({ steps: Number(event.target.value) })} /></label><label className="field">Guidance<input type="number" min={0} max={30} step={.1} value={draft.cfg} onChange={event => update({ cfg: Number(event.target.value) })} /></label></div>
            <label className="field">Seed<input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} placeholder="Random each time" value={draft.seed} onChange={event => update({ seed: event.target.value })} /><span className="text-xs">Leave blank for a new seed.</span></label>
            {operation === 'image-to-image' && <label className="field">Image strength<input type="number" min={.05} max={1} step={.05} value={draft.denoise} onChange={event => update({ denoise: Number(event.target.value) })} /><span className="text-xs">Lower values preserve more of the original image.</span></label>}
            {model?.capabilities?.negativePrompt !== false && <label className="field">Negative prompt<textarea rows={3} maxLength={16000} placeholder="What should stay out of the image?" value={draft.negativePrompt} onChange={event => update({ negativePrompt: event.target.value })} /></label>}
          </div>}</Popover>
          <IconChip aria-label="Reset settings to defaults" title="Reset settings to defaults" disabled={!model || busy} onClick={() => { if (model) setDraft(modelDraft(draft, model)); }}><RotateCcw /></IconChip>
        </div></div>
        {error ? <p role="alert" className="px-1 text-xs leading-relaxed text-[#ffc3aa]">{error}</p> : !connected ? <p role="status" className="px-1 text-xs text-ink-2">Waiting for the studio server. Your prompt is kept here.</p> : !model?.ready ? <p className="px-1 text-xs text-ink-2">Choose a model in Models. Manage your GPUs in Settings.</p> : null}
      </div>
      <div className="flex shrink-0 flex-col justify-end sm:w-[188px]"><GenerateButton size="lg" busy={busy} disabled={!canSubmit} onClick={() => void submit()} className="max-h-28 sm:grow" /></div>
    </div>
    {browsing && <ReferencePicker jobs={jobs} onPick={upload} onClose={() => setBrowsing(false)} />}
  </div>;
}
