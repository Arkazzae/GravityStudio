'use client';
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { GenerateButton } from '@/components/ui/GenerateButton';
import { ModelMenu } from './ModelMenu';
import { ReferencePicker } from './ReferencePicker';
import { ImageReferenceInput } from './ImageReferenceInput';
import { ImageAspectRatioMenu } from './ImageAspectRatioMenu';
import { DockSettings } from './DockSettings';
import { imageSizeProblem, type ImageAspectRatio } from '@/lib/image-settings';
import { api, errorMessage, type InputImage, type StudioModel, type Job } from '@/lib/api';

export interface Draft { aspect?: ImageAspectRatio | 'custom'; modelId: string; prompt: string; negativePrompt: string; width: number; height: number; steps: number; cfg: number; seed: string; denoise: number; images: InputImage[] }
export const initialDraft: Draft = { aspect: 'auto', modelId: '', prompt: '', negativePrompt: '', width: 1024, height: 1024, steps: 30, cfg: 7, seed: '', denoise: .75, images: [] };
export function modelDraft(draft: Draft, model: StudioModel): Draft { return { ...draft, modelId: model.id, aspect: 'auto', ...model.defaults, negativePrompt: model.defaults.negativePrompt || '', seed: '', denoise: .75 }; }

export function PromptDock({ models, draft, setDraft, onSubmitted, onHeight, connected, onSessionExpired, jobs, onOpenModels }: { jobs: Job[]; models: StudioModel[]; draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; onSubmitted: (job: Job) => void; onHeight: (height: number) => void; connected: boolean; onSessionExpired: () => void; onOpenModels: () => void }) {
  const dock = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const lastAttempt = useRef<{ body: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState('');
  const model = models.find(model => model.id === draft.modelId);
  const maxImages = model?.capabilities?.maxImages ?? model?.limits?.maxImages ?? 0;
  const operation = draft.images.length ? model?.operations?.includes('reference') ? 'reference' : 'image-to-image' : 'text-to-image';
  const sizeError = model ? imageSizeProblem(model, draft.width, draft.height) : null;
  const canSubmit = connected && model?.ready && !!draft.prompt.trim() && draft.images.length <= maxImages && !sizeError && !busy && !uploading;
  const update = (change: Partial<Draft>) => setDraft(current => ({ ...current, ...change }));
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
  useEffect(() => { if (!dock.current) return; const observer = new ResizeObserver(([entry]) => onHeight(entry.contentRect.height + 24)); observer.observe(dock.current); return () => observer.disconnect(); }, [onHeight]);
  async function upload(files: File[]) {
    if (!files.length || uploading) return false;
    if (files.length + draft.images.length > maxImages) { setError(`This model accepts up to ${maxImages} reference image${maxImages === 1 ? '' : 's'}.`); return false; }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { setError('Choose PNG, JPEG, or WebP images.'); return false; }
    setUploading(true); setError('');
    const added: InputImage[] = [];
    try {
      for (const file of files) added.push(await api<InputImage>('/inputs', { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file }));
    } catch (error) { setError(errorMessage(error)); }
    finally { if (added.length) setDraft(current => ({ ...current, images: [...current.images, ...added] })); setUploading(false); }
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
  return <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4">
    <div ref={dock} data-workspace-scroll="dock" className="animate-dock-in pointer-events-auto flex max-h-[70dvh] w-full max-w-[1120px] flex-col gap-3 overflow-y-auto rounded-dock border border-white/[0.07] bg-raise p-3 shadow-dock transition-colors duration-200 focus-within:border-white/[0.14] sm:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className={`flex items-start gap-3 pl-1 pt-0.5 ${draft.images.length > 1 ? "flex-col" : ""}`} onDragOver={event => { if (maxImages) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (maxImages) void upload(Array.from(event.dataTransfer.files)); }}>
          <ImageReferenceInput images={draft.images} maxImages={maxImages} uploading={uploading} onUpload={files => { void upload(files); }} onRemove={id => update({ images: draft.images.filter(image => image.id !== id) })} onClear={() => update({ images: [] })} onBrowse={() => setBrowsing(true)} />
          <label htmlFor="image-prompt" className="sr-only">{draft.images.length ? 'Edit instructions' : 'Image prompt'}</label><textarea ref={prompt} id="image-prompt" value={draft.prompt} maxLength={16000} onChange={event => update({ prompt: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} onPaste={event => { if (maxImages && event.clipboardData.files.length) { event.preventDefault(); void upload(Array.from(event.clipboardData.files)); } }} rows={1} placeholder={draft.images.length > 1 ? 'Describe how to use these references. Refer to them by number.' : draft.images.length ? 'Describe what you want to change in this image.' : 'Describe the shot you want.'} className="max-h-40 min-h-10 min-w-0 w-full resize-none bg-transparent py-2 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-2" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5"><div className="@container -mb-1.5 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-1.5">
          <ModelMenu disabled={uploading} onManage={onOpenModels} models={models} value={draft.modelId} referenceCount={draft.images.length} onChange={id => { const next = models.find(model => model.id === id); if (next) setDraft(modelDraft(draft, next)); }} />
          <ImageAspectRatioMenu model={model} draft={draft} onChange={update} />
        </div><div className="flex shrink-0 items-center gap-0.5 border-l border-white/[0.06] pl-1.5">
          <DockSettings model={model} draft={draft} busy={busy} onChange={update} onReset={() => { if (model) setDraft(modelDraft(draft, model)); }} />
        </div></div>
        {error || sizeError ? <p role="alert" className="px-1 text-xs leading-relaxed text-[#ffc3aa]">{error || sizeError}</p> : !connected ? <p role="status" className="px-1 text-xs text-ink-2">Waiting for the studio server. Your prompt is kept here.</p> : !model?.ready ? <p className="px-1 text-xs text-ink-2">Choose a model in Models. Manage your GPUs in Settings.</p> : null}
      </div>
      <div className="flex shrink-0 flex-col justify-end sm:w-[188px]"><GenerateButton size="lg" busy={busy} disabled={!canSubmit} onClick={() => void submit()} className="h-16 shrink-0 sm:h-[92px]" /></div>
    </div>
    {browsing && <ReferencePicker jobs={jobs} onPick={upload} onClose={() => setBrowsing(false)} />}
  </div>;
}
