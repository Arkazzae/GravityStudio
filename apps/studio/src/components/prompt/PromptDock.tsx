'use client';
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { GenerateButton } from '@/components/ui/GenerateButton';
import { FileDropOverlay } from '@/components/ui/FileDropOverlay';
import { ModelMenu } from './ModelMenu';
import { ReferencePicker } from './ReferencePicker';
import { ReferenceEditor } from './ReferenceEditor';
import { ImageReferenceInput } from './ImageReferenceInput';
import { ImageAspectRatioMenu } from './ImageAspectRatioMenu';
import { ImageQualityMenu } from './ImageQualityMenu';
import { BackgroundMenu } from './BackgroundMenu';
import { DockSettings } from './DockSettings';
import { PromptAssistant } from './PromptAssistant';
import { imageQualityProblem, imageSizeProblem } from '@/lib/image-settings';
import { imageBackground, imageBackgroundProblem } from '@/lib/image-background';
import { api, errorMessage, type GenerationTool, type InputImage, type StudioModel, type Job } from '@/lib/api';
import { draftCanvasSize, editingProblem, generationInput, generationOperation, loraProblem, referenceLimit, replaceDraftImages, selectedModelDraft, structuredPromptProblem, type Draft } from '@/lib/generation-draft';
import { imageFileProblem } from '@/lib/image-files';
import { appendReferences, referenceKey, type SavedReference } from '@/lib/reference-assets';
import { useFileIntake } from '@/lib/use-file-intake';

export type { Draft } from '@/lib/generation-draft';
export const initialDraft: Draft = { aspect: 'auto', background: 'auto', modelId: '', prompt: '', negativePrompt: '', width: 1024, height: 1024, steps: 30, cfg: 7, seed: '', denoise: .75, images: [] };
export const modelDraft = selectedModelDraft;

export function PromptDock({ browsing, onBrowse, onCloseAssets, models, draft, setDraft, onSubmitted, onHeight, connected, onSessionExpired, jobs, onOpenModels, favoriteError, sessionIdentity = '', modelToolsRevision = 0, onOpenTools, onOpenAssistantSettings, onBusyChange }: { browsing: boolean; onBrowse: () => void; onCloseAssets: () => void; jobs: Job[]; models: StudioModel[]; draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; onSubmitted: (job: Job) => void; onHeight: (height: number) => void; connected: boolean; onSessionExpired: () => void; onOpenModels?: () => void; onOpenTools?: () => void; favoriteError?: string; sessionIdentity?: string; modelToolsRevision?: number; onOpenAssistantSettings?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const dock = useRef<HTMLDivElement>(null);
  const referenceTrigger = useRef<HTMLButtonElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const lastAttempt = useRef<{ body: string; key: string } | null>(null);
  const pendingUpload = useRef<AbortController | null>(null);
  const uploadIdentity = `${sessionIdentity}\0${draft.modelId}`;
  const latestIdentity = useRef(uploadIdentity);
  latestIdentity.current = uploadIdentity;
  const [busy, setBusy] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy || assistantBusy || uploading || editorBusy); }, [busy, assistantBusy, uploading, editorBusy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const [assetsVisited, setAssetsVisited] = useState(false);
  useEffect(() => { if (browsing) setAssetsVisited(true); }, [browsing]);
  const [error, setError] = useState('');
  const [toolResult, setToolResult] = useState<{ identity: string; tools: GenerationTool[] } | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState('');
  const [toolsRevision, setToolsRevision] = useState(0);
  const toolsIdentity = `${uploadIdentity}\0${toolsRevision}\0${modelToolsRevision}`;
  const tools = toolResult?.identity === toolsIdentity ? toolResult.tools : null;
  const model = models.find(model => model.id === draft.modelId);
  const maxImages = referenceLimit(model, draft);
  const sourceCanvas = draftCanvasSize(model, draft);
  const sizeError = model ? imageSizeProblem(model, sourceCanvas?.width ?? draft.width, sourceCanvas?.height ?? draft.height) : null;
  const backgroundError = imageBackgroundProblem(model, imageBackground(draft.background));
  const qualityError = imageQualityProblem(model, draft.quality, imageBackground(draft.background));
  const optionError = editingProblem(model, draft) || structuredPromptProblem(model, draft) || loraProblem(model, draft.loras, tools);
  const canSubmit = connected && model?.ready && !!draft.prompt.trim() && draft.images.length <= maxImages && !sizeError && !backgroundError && !qualityError && !optionError && !busy && !assistantBusy && !uploading && !editorBusy;
  const update = (change: Partial<Draft>) => setDraft(current => ({ ...current, ...change }));
  const { dragging } = useFileIntake({ onFiles: files => { void upload(files); } });
  useEffect(() => () => { pendingUpload.current?.abort(); }, []);
  useEffect(() => {
    setToolResult(null); setToolsError('');
    if (!draft.modelId || !connected) { setToolsLoading(false); return; }
    const controller = new AbortController(); setToolsLoading(true);
    void api<{ tools: GenerationTool[] }>(`/generation-tools?modelId=${encodeURIComponent(draft.modelId)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(result => { if (!controller.signal.aborted) setToolResult({ identity: toolsIdentity, tools: result.tools }); })
      .catch(failure => { if (!controller.signal.aborted) { setToolsError(errorMessage(failure)); if ((failure as { status?: number }).status === 401) onSessionExpired(); } })
      .finally(() => { if (!controller.signal.aborted) setToolsLoading(false); });
    return () => controller.abort();
  }, [draft.modelId, connected, sessionIdentity, toolsRevision, modelToolsRevision, onSessionExpired]);
  useEffect(() => {
    pendingUpload.current?.abort();
    pendingUpload.current = null;
    setUploading(false);
  }, [uploadIdentity]);
  useEffect(() => { setEditorOpen(false); setEditorBusy(false); }, [uploadIdentity, draft.images[0]?.id]);
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
  async function upload(files: File[], signal?: AbortSignal) { return addReferences(files, signal); }
  async function addReferences(selection: Array<File | SavedReference>, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    const reject = (message: string) => { setError(message); return { ok: false, error: message }; };
    if (!selection.length || pendingUpload.current) return reject(pendingUpload.current ? 'Wait for the current upload to finish.' : 'Choose an image to add.');
    if (!connected) return reject('Wait for the studio server before adding images.');
    if (!maxImages) return reject('Choose a model that supports reference images to add these files.');
    const seen = new Set(draft.images.map(input => referenceKey({ type: 'input', input })));
    const sources = selection.filter(source => {
      if (source instanceof File) return true;
      const key = referenceKey(source);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (!sources.length) return { ok: true };
    if (sources.length + draft.images.length > maxImages) return reject(`This model accepts up to ${maxImages} reference image${maxImages === 1 ? '' : 's'}.`);
    const files = sources.filter((source): source is File => source instanceof File);
    const problem = imageFileProblem(files);
    if (problem) return reject(problem);
    const controller = new AbortController();
    pendingUpload.current = controller;
    const requestSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    setUploading(true); setError('');
    const added: InputImage[] = [];
    try {
      const saved = sources.some(source => !(source instanceof File) && source.type === 'input')
        ? (await api<{ inputs: InputImage[] }>('/inputs', { signal: AbortSignal.any([requestSignal, AbortSignal.timeout(45_000)]) })).inputs : [];
      for (const source of sources) {
        requestSignal.throwIfAborted();
        if (source instanceof File) {
          added.push(await api<InputImage>('/inputs', { method: 'POST', headers: { 'Content-Type': source.type, 'X-Filename': encodeURIComponent(source.name) }, body: source, signal: AbortSignal.any([requestSignal, AbortSignal.timeout(45_000)]) }));
        } else if (source.type === 'input') {
          const input = saved.find(input => input.id === source.input.id);
          if (!input) throw new Error('An image is no longer available. Choose another image.');
          added.push(input);
        } else {
          added.push(await api<InputImage>('/inputs/from-output', { method: 'POST', body: JSON.stringify({ jobId: source.jobId, outputId: source.outputId }), signal: AbortSignal.any([requestSignal, AbortSignal.timeout(45_000)]) }));
        }
      }
      requestSignal.throwIfAborted();
      if (latestIdentity.current !== uploadIdentity) return { ok: false };
      setDraft(current => {
        const images = appendReferences(current.images, added);
        return current.modelId === draft.modelId && images.length <= maxImages ? { ...current, images } : current;
      });
      return { ok: true };
    } catch (error) {
      if (requestSignal.aborted || latestIdentity.current !== uploadIdentity) return { ok: false };
      if ((error as { status?: number }).status === 401) onSessionExpired();
      return reject(errorMessage(error));
    } finally {
      if (pendingUpload.current === controller) { pendingUpload.current = null; setUploading(false); }
    }
  }
  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      const body = JSON.stringify(generationInput(model, draft));
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
        <div className={`flex items-start gap-3 pl-1 pt-0.5 ${draft.images.length > 1 ? "flex-col" : ""}`}>
          <ImageReferenceInput browseRef={referenceTrigger} images={draft.images} maxImages={maxImages} uploading={uploading || busy || editorBusy} onUpload={files => { void upload(files); }} onRemove={id => setDraft(current => replaceDraftImages(current, current.images.filter(image => image.id !== id)))} onClear={() => setDraft(current => replaceDraftImages(current, []))} onBrowse={onBrowse} onEdit={model && draft.images[0] ? () => setEditorOpen(true) : undefined} edited={!!draft.mask || !!draft.outpaint || !!draft.matchSource} />
          <label htmlFor="image-prompt" className="sr-only">{draft.images.length ? 'Edit instructions' : 'Image prompt'}</label><textarea ref={prompt} id="image-prompt" value={draft.prompt} maxLength={16000} onChange={event => update({ prompt: event.target.value, structuredPrompt: undefined })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} rows={1} placeholder={draft.images.length > 1 ? 'Describe how to use these references. Refer to them by number.' : draft.images.length ? 'Describe what you want to change in this image.' : 'Describe the shot you want.'} className="max-h-40 min-h-10 min-w-0 w-full resize-none bg-transparent py-2 text-[15px] leading-6 text-ink outline-none placeholder:text-ink-2" />
        </div>
        <div className="flex min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center"><div className="@container -mb-1.5 flex w-full min-w-0 items-center gap-1.5 overflow-x-scroll pb-1.5 [&>div:first-child]:min-w-[74px] [&>div:first-child>button]:max-w-[min(20rem,100%)] sm:w-auto sm:flex-1">
          <ModelMenu disabled={uploading} onManage={onOpenModels} models={models} value={draft.modelId} referenceCount={draft.images.length} selectedReferenceLimit={maxImages} onChange={id => { const next = models.find(model => model.id === id); if (next) setDraft(current => modelDraft(current, next, { previousModel: models.find(model => model.id === current.modelId), tools: current.modelId === draft.modelId ? tools : null })); }} />
          <ImageAspectRatioMenu model={model} draft={draft} onChange={update} />
          <ImageQualityMenu model={model} draft={draft} onChange={update} />
          <BackgroundMenu model={model} draft={draft} disabled={busy || uploading} onChange={update} />
        </div><div className="flex shrink-0 items-center gap-0.5 self-end sm:self-auto sm:border-l sm:border-white/[0.06] sm:pl-1.5">
          <PromptAssistant draft={draft} setDraft={setDraft} model={model} connected={connected} submitting={busy || uploading} sessionIdentity={sessionIdentity} onBusyChange={setAssistantBusy} onSessionExpired={onSessionExpired} onOpenSettings={onOpenAssistantSettings} />
          <DockSettings model={model} draft={draft} busy={busy || uploading || editorBusy} tools={tools} toolsLoading={toolsLoading} toolsError={toolsError} onReloadTools={() => setToolsRevision(value => value + 1)} onManageTools={onOpenTools} onEditSource={model && draft.images[0] ? () => setEditorOpen(true) : undefined} onChange={update} onReset={() => { if (model) setDraft({ ...modelDraft(draft, model), background: 'auto', mask: undefined, missingMaskId: undefined, outpaint: undefined, matchSource: false, editSourceId: undefined, loras: [], refiner: false, referenceStrength: undefined, structuredPrompt: undefined }); }} />
        </div></div>
        {error || sizeError || (connected && (backgroundError || qualityError || optionError)) ? <p role="alert" className="px-1 text-xs leading-relaxed text-[#ffc3aa]">{error || sizeError || backgroundError || qualityError || optionError}</p> : connected && !model?.ready ? <p className="px-1 text-xs text-ink-2">{onOpenModels ? 'Choose a model in Models. Manage your GPUs in Settings.' : 'No generation model is ready. Ask your administrator to enable one.'}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col justify-end sm:w-[188px]"><GenerateButton size="lg" busy={busy} disabled={!canSubmit} onClick={() => void submit()} className="h-16 shrink-0 sm:h-[92px]" /></div>
    </div>
    {dragging && <FileDropOverlay target="references" fullscreen available={maxImages > 0} title={maxImages ? 'Drop images to add references' : 'This model does not support reference images'} detail={uploading ? 'Wait for the current upload to finish.' : maxImages ? 'PNG, JPEG or WebP, up to 20 MiB each.' : 'Choose a model that accepts reference images.'} />}
    {(browsing || assetsVisited) && <ReferencePicker open={browsing} triggerRef={referenceTrigger} jobs={jobs} references={draft.images} max={Math.max(0, maxImages - draft.images.length)} onPick={upload} onPickSaved={addReferences} favoriteError={favoriteError} onClose={onCloseAssets} unavailableReason={maxImages < 1 ? 'Choose a model that supports reference images to use these assets.' : undefined} />}
    {model && draft.images[0] && <ReferenceEditor key={`${uploadIdentity}:${draft.images[0].id}:${draft.mask?.id || ''}:${draft.missingMaskId || ''}:${JSON.stringify(draft.outpaint)}:${!!draft.matchSource}`} open={editorOpen} model={model} image={draft.images[0]} missingMask={!!draft.mask && draft.missingMaskId === draft.mask.id} value={{ mask: draft.missingMaskId === draft.mask?.id ? undefined : draft.mask, outpaint: draft.outpaint, matchSource: draft.matchSource }} operation={generationOperation(model, draft)} onBusyChange={setEditorBusy} onSessionExpired={onSessionExpired} onClose={() => setEditorOpen(false)} onApply={value => setDraft(current => current.modelId === model.id && current.images[0]?.id === draft.images[0].id ? { ...current, mask: value.mask, missingMaskId: undefined, outpaint: value.outpaint, matchSource: !!value.matchSource, editSourceId: value.mask || value.outpaint || value.matchSource ? current.images[0].id : undefined } : current)} />}
  </div>;
}
