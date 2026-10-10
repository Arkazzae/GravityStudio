import { sourceCanvasSize } from '../../../../packages/contracts/image-size.ts';
import { LEGACY_MAX_LORAS, MAX_LORAS } from '../../../../packages/contracts/lora-stack.ts';
import { compileIdeogramPrompt, parseIdeogramPrompt } from '../../../../packages/inference/ideogram-prompt.ts';
import type { GenerationInput, GenerationTool, InputImage, Job, StudioModel, ImageBackground, LoraChoice, OutpaintPadding } from './api.ts';
import { imageQualityForSize, imageQualitySampling, type ImageAspectRatio, type ImageQuality } from './image-settings.ts';

export interface Draft { aspect?: ImageAspectRatio | 'custom'; quality?: ImageQuality | 'custom'; background?: ImageBackground; modelId: string; prompt: string; structuredPrompt?: string; negativePrompt: string; width: number; height: number; steps: number; cfg: number; sampler?: string; scheduler?: string; seed: string; denoise: number; images: InputImage[]; imageMode?: 'image-to-image' | 'reference'; editSourceId?: string; mask?: InputImage; missingMaskId?: string; outpaint?: OutpaintPadding; matchSource?: boolean; refiner?: boolean; referenceStrength?: number; loras?: LoraChoice[] }

export interface ModelDraftContext { previousModel?: StudioModel; tools?: GenerationTool[] | null }

/** Checkpoint changes preserve an adapter stack whose architecture is still compatible. */
export function selectedModelDraft(draft: Draft, model: StudioModel, context: ModelDraftContext = {}): Draft {
  const quality = imageQualityForSize(model, model.defaults.width, model.defaults.height, 'auto');
  const editing = model.capabilities?.editing;
  const mask = editing?.inpaint.available ? draft.mask : undefined;
  const outpaint = editing?.outpaint.available ? draft.outpaint : undefined;
  const matchSource = editing?.matchSource.available && !!draft.matchSource;
  const sameFamily = !!model.familyId && context.previousModel?.familyId === model.familyId;
  const loras = (draft.loras || []).filter(choice => sameFamily || context.tools?.some(tool => tool.id === choice.id && tool.kind === 'lora' && !!model.familyId && tool.familyIds.includes(model.familyId))).map(choice => ({ ...choice }));
  return {
    ...draft, modelId: model.id, aspect: 'auto', sampler: undefined, scheduler: undefined,
    imageMode: undefined, ...model.defaults, ...imageQualitySampling(model, quality), quality,
    negativePrompt: model.defaults.negativePrompt || '', seed: '', denoise: .75,
    structuredPrompt: ideogramModel(model) ? draft.structuredPrompt : undefined,
    mask, missingMaskId: mask ? draft.missingMaskId : undefined, outpaint, matchSource, editSourceId: mask || outpaint || matchSource ? draft.editSourceId : undefined,
    loras, refiner: false, referenceStrength: undefined,
  };
}

export const ideogramModel = (model: Pick<StudioModel, 'id' | 'familyId'> | undefined) => model?.familyId === 'ideogram-4' || !!model?.id.startsWith('ideogram-4');

export function readablePrompt(prompt: string, modelId: string): string {
  if (!modelId.startsWith('ideogram-4')) return prompt;
  try {
    const caption = parseIdeogramPrompt(prompt);
    return caption?.high_level_description || caption?.compositional_deconstruction.elements.map(element => element.desc).filter(Boolean).join(' ') || caption?.compositional_deconstruction.background || prompt;
  } catch { return prompt; }
}

export function promptFields(prompt: string, model: Pick<StudioModel, 'id' | 'familyId'>): Pick<Draft, 'prompt' | 'structuredPrompt'> {
  if (!ideogramModel(model)) return { prompt, structuredPrompt: undefined };
  const caption = parseIdeogramPrompt(prompt);
  return caption ? { prompt: readablePrompt(JSON.stringify(caption), 'ideogram-4'), structuredPrompt: JSON.stringify(caption) } : { prompt, structuredPrompt: undefined };
}

export function structuredPromptProblem(model: StudioModel | undefined, draft: Pick<Draft, 'structuredPrompt'>): string | null {
  if (!ideogramModel(model) || draft.structuredPrompt === undefined) return null;
  try { return parseIdeogramPrompt(draft.structuredPrompt) ? null : 'Use a valid Ideogram JSON caption, or turn off the structured prompt.'; }
  catch (error) { return error instanceof Error ? error.message : 'Check the structured prompt.'; }
}

export function initialStructuredPrompt(prompt: string): string { return JSON.stringify(JSON.parse(compileIdeogramPrompt(prompt || 'Describe the scene.')), null, 2); }

export function generationOperation(model: StudioModel | undefined, draft: Pick<Draft, 'images' | 'mask' | 'outpaint' | 'imageMode'>): GenerationInput['operation'] {
  if (!draft.images.length) return 'text-to-image';
  if (draft.mask || draft.outpaint) return model?.operations?.includes('image-to-image') ? 'image-to-image' : 'reference';
  if (draft.imageMode && model?.operations?.includes(draft.imageMode)) return draft.imageMode;
  return model?.operations?.includes('image-to-image') ? 'image-to-image' : 'reference';
}

/** Editing redraws one source. Multi-image conditioning is enabled explicitly for families offering both modes. */
export function referenceLimit(model: StudioModel | undefined, draft?: Pick<Draft, 'imageMode' | 'mask' | 'outpaint'>): number {
  const maximum = model?.capabilities?.maxImages ?? model?.limits?.maxImages ?? 0;
  if (model?.operations && !model.operations.some(operation => operation === 'image-to-image' || operation === 'reference')) return 0;
  if (model?.capabilities?.imageInput === false) return 0;
  if (draft?.imageMode === 'reference' && model?.operations && !model.operations.includes('reference')) return 0;
  if (draft?.imageMode === 'reference' && model?.capabilities?.editing?.reference.available === false) return 0;
  if (model?.operations?.includes('image-to-image') && (draft?.imageMode !== 'reference' || draft.mask || draft.outpaint)) return Math.min(1, maximum);
  return maximum;
}

export function replaceDraftImages(draft: Draft, images: InputImage[]): Draft {
  const keepEdit = !!images[0] && draft.editSourceId === images[0].id;
  return { ...draft, images, ...(!keepEdit ? { mask: undefined, missingMaskId: undefined, outpaint: undefined, matchSource: false, editSourceId: undefined } : {}) };
}

/** Deleting a saved mask must never silently turn a protected edit into a whole-image redraw. */
export function deletedDraftInput(draft: Draft, id: string): Draft {
  const next = replaceDraftImages(draft, draft.images.filter(image => image.id !== id));
  return next.mask?.id === id ? { ...next, missingMaskId: id } : next;
}

export function draftCanvasSize(model: StudioModel | undefined, draft: Draft) {
  if (ideogramModel(model) && generationOperation(model, draft) === 'reference') return { width: 1024, height: 1024 };
  if (!model || !draft.images[0] || !(draft.mask || draft.outpaint || draft.matchSource)) return null;
  return sourceCanvasSize(model, draft.images[0], draft.outpaint);
}

export function editingProblem(model: StudioModel | undefined, draft: Draft): string | null {
  const editing = model?.capabilities?.editing;
  const source = draft.images[0];
  if (!source && (model?.capabilities?.requiresImage || model?.operations && !model.operations.includes('text-to-image'))) return 'This model requires a source image. Add an image before generating.';
  if (source && model?.operations && !model.operations.some(operation => operation === 'image-to-image' || operation === 'reference')) return 'This model generates from text only. Remove its source images or choose an image-capable model.';
  if (draft.mask && draft.missingMaskId === draft.mask.id) return 'The selected mask was deleted. Open the reference and paint a new mask, or choose Clear edits.';
  if (draft.mask || draft.outpaint || draft.matchSource) {
    if (!source || draft.editSourceId !== source.id) return 'Choose the original source image again or clear its edits.';
    if (draft.mask && draft.outpaint) return 'Choose a mask or extended canvas, not both.';
    if (draft.mask && (draft.mask.width !== source.width || draft.mask.height !== source.height)) return 'The mask must have the same dimensions as its source image. Open the source and paint a new mask.';
    for (const [enabled, capability, label] of [[draft.mask, editing?.inpaint, 'Masked editing'], [draft.outpaint, editing?.outpaint, 'Canvas extension'], [draft.matchSource, editing?.matchSource, 'Source canvas matching']] as const) {
      if (enabled && !capability?.available) return capability?.reason || `${label} is unavailable for this model.`;
    }
    if (!draftCanvasSize(model, draft)) return 'The source and padding do not fit this model’s canvas limits. Reduce the extension.';
  }
  const operation = generationOperation(model, draft);
  if (operation === 'image-to-image' && draft.images.length > 1) return 'Use one source for image editing, or choose Reference mode in Advanced.';
  if (operation === 'reference' && editing?.reference && !editing.reference.available) return editing.reference.reason || 'Reference images are unavailable on the assigned workers.';
  if (operation === 'reference' && ideogramModel(model) && (draft.mask || draft.outpaint || draft.matchSource)) return 'Ideogram reference mode uses a 1024 × 1024 canvas. Clear edits or choose Image to image in Advanced.';
  if (draft.refiner && !editing?.refiner.available) return editing?.refiner.reason || 'The refiner is unavailable for this model.';
  return null;
}

export function loraLimit(model: StudioModel | undefined): number {
  const advertised = model?.capabilities?.loras?.max;
  if (advertised === undefined) return LEGACY_MAX_LORAS;
  return Number.isSafeInteger(advertised) && advertised >= 0 ? Math.min(advertised, MAX_LORAS) : 0;
}

export function moveLoraChoice(choices: LoraChoice[], from: number, direction: -1 | 1): LoraChoice[] {
  const to = from + direction;
  if (!Number.isInteger(from) || from < 0 || from >= choices.length || to < 0 || to >= choices.length) return choices;
  const next = [...choices];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function loraProblem(model: StudioModel | undefined, choices: Draft['loras'], tools: GenerationTool[] | null): string | null {
  if (!choices?.length) return null;
  const maximum = loraLimit(model);
  if (!maximum) return 'This model does not support LoRAs. Remove the selected LoRAs in Advanced or choose another model.';
  if (choices.length > maximum) return `This model accepts up to ${maximum} LoRA${maximum === 1 ? '' : 's'}. Remove some in Advanced to generate.`;
  if (new Set(choices.map(choice => choice.id)).size !== choices.length) return 'Choose different LoRAs. Each adapter can be selected only once.';
  if (!tools) return 'Checking selected LoRAs…';
  for (const choice of choices) {
    const tool = tools.find(tool => tool.id === choice.id && tool.kind === 'lora');
    if (!tool || !model?.familyId || !tool.familyIds.includes(model.familyId)) return 'A selected LoRA is incompatible with this model. Remove it in Advanced or switch models.';
    if (!tool.ready) return tool.missingReasons.join(' ') || `${tool.name} is not ready on the assigned workers.`;
    if (!Number.isFinite(choice.strength) || choice.strength < 0 || choice.strength > 2) return 'LoRA strength must be between 0 and 2.';
  }
  return null;
}

export function generationInput(model: StudioModel | undefined, draft: Draft): GenerationInput {
  const operation = generationOperation(model, draft);
  const canvas = draftCanvasSize(model, draft);
  return {
    modelId: draft.modelId, operation, prompt: ideogramModel(model) && draft.structuredPrompt || draft.prompt,
    negativePrompt: draft.negativePrompt, background: draft.background || 'auto',
    ...(draft.quality && draft.quality !== 'custom' ? { quality: draft.quality } : {}),
    width: canvas?.width ?? draft.width, height: canvas?.height ?? draft.height, steps: draft.steps, cfg: draft.cfg,
    ...(draft.sampler ? { sampler: draft.sampler } : {}), ...(draft.scheduler ? { scheduler: draft.scheduler } : {}),
    ...(draft.seed.trim() ? { seed: Number(draft.seed) } : {}),
    ...(draft.images.length ? { images: draft.images.map(image => image.id) } : {}),
    ...(operation === 'image-to-image' ? { denoise: draft.denoise } : {}),
    ...(draft.mask ? { maskId: draft.mask.id } : {}), ...(draft.outpaint ? { outpaint: draft.outpaint } : {}),
    ...(draft.matchSource ? { matchSource: true } : {}), ...(draft.refiner ? { refiner: true } : {}),
    ...(draft.loras?.length ? { loras: draft.loras } : {}),
    ...(operation === 'reference' && ['sdxl', 'krea-2'].includes(model?.familyId || '') && draft.referenceStrength !== undefined ? { referenceStrength: draft.referenceStrength } : {}),
  };
}

export function savedInputImage(value: unknown): value is InputImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as InputImage;
  return typeof image.id === 'string' && /^[a-zA-Z0-9-]+$/.test(image.id) && image.url === `/api/inputs/${image.id}` && typeof image.name === 'string' && Number.isInteger(image.width) && image.width > 0 && Number.isInteger(image.height) && image.height > 0;
}

/** Restore only the serializable edit fields; URLs must remain private Studio input URLs. */
export function savedDraftEdits(value: Record<string, unknown>): Partial<Draft> {
  const padding = value.outpaint as Draft['outpaint'];
  return {
    structuredPrompt: typeof value.structuredPrompt === 'string' ? value.structuredPrompt.slice(0, 16_000) : undefined,
    sampler: typeof value.sampler === 'string' ? value.sampler : undefined,
    scheduler: typeof value.scheduler === 'string' ? value.scheduler : undefined,
    imageMode: value.imageMode === 'image-to-image' || value.imageMode === 'reference' ? value.imageMode : undefined,
    editSourceId: typeof value.editSourceId === 'string' ? value.editSourceId : undefined,
    mask: savedInputImage(value.mask) ? value.mask : undefined,
    missingMaskId: typeof value.missingMaskId === 'string' ? value.missingMaskId : undefined,
    outpaint: padding && ['left', 'right', 'top', 'bottom'].every(side => Number.isInteger(padding[side as keyof typeof padding])) ? { left: padding.left, right: padding.right, top: padding.top, bottom: padding.bottom } : undefined,
    matchSource: value.matchSource === true, refiner: value.refiner === true,
    referenceStrength: typeof value.referenceStrength === 'number' ? value.referenceStrength : undefined,
    loras: Array.isArray(value.loras) ? value.loras.filter((choice): choice is NonNullable<Draft['loras']>[number] => !!choice && typeof choice === 'object' && typeof choice.id === 'string' && typeof choice.strength === 'number').map(choice => ({ id: choice.id, strength: choice.strength })) : [],
  };
}

/** Resolve the saved sources before replacing the current draft, so a missing image cannot silently become text-to-image. */
export function reusedDraft(current: Draft, job: Job, inputs: InputImage[]): Draft {
  if (job.input?.operation === 'upscale' || job.input?.operation === 'remove-background') throw new Error('This image tool has no generation settings to reuse.');
  const input = job.input;
  const find = (id: string) => {
    const image = inputs.find(image => image.id === id);
    if (!image) throw new Error('A source image or mask from this run is no longer available. Your current draft was kept.');
    return image;
  };
  const images = (input?.images || []).map(find);
  const mask = input?.maskId ? find(input.maskId) : undefined;
  return {
    ...current, ...job.parameters, ...promptFields(job.prompt, { id: job.modelId }), modelId: job.modelId,
    aspect: 'custom', quality: job.parameters.quality || input?.quality || 'custom', background: job.parameters.background || input?.background || 'auto',
    negativePrompt: job.parameters.negativePrompt || '', seed: job.parameters.seed === undefined ? '' : String(job.parameters.seed),
    sampler: job.parameters.sampler || input?.sampler, scheduler: job.parameters.scheduler || input?.scheduler,
    denoise: input?.denoise ?? .75, images, mask, missingMaskId: undefined,
    imageMode: input?.operation === 'image-to-image' || input?.operation === 'reference' ? input.operation : undefined,
    outpaint: input?.outpaint, matchSource: input?.matchSource === true,
    editSourceId: mask || input?.outpaint || input?.matchSource ? images[0]?.id : undefined,
    refiner: input?.refiner === true, referenceStrength: input?.referenceStrength, loras: input?.loras?.map(choice => ({ ...choice })) || [],
  };
}
