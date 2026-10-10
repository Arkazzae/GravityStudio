import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deletedDraftInput, draftCanvasSize, editingProblem, generationInput, loraProblem, promptFields,
  referenceLimit, replaceDraftImages, reusedDraft, savedDraftEdits, savedInputImage, selectedModelDraft, structuredPromptProblem,
  type Draft,
} from '../../apps/studio/src/lib/generation-draft.ts';
import { FAMILY_RECIPES } from '../../packages/inference/catalog.ts';
import { compileIdeogramPrompt } from '../../packages/inference/ideogram-prompt.ts';
import type { GenerationInput, GenerationTool, InputImage, Job, StudioModel } from '../../apps/studio/src/lib/api.ts';

const source: InputImage = { id: 'source-id', name: 'source.png', url: '/api/inputs/source-id', width: 1024, height: 768 };
const mask: InputImage = { ...source, id: 'mask-id', name: 'mask.png', url: '/api/inputs/mask-id' };
const second: InputImage = { ...source, id: 'other-id', url: '/api/inputs/other-id' };
const draft: Draft = { modelId: 'sdxl-base', prompt: 'A paper boat', negativePrompt: '', width: 1024, height: 1024, steps: 40, cfg: 7, seed: '', denoise: .75, images: [] };
const available = { available: true };
function model(familyId: keyof typeof FAMILY_RECIPES): StudioModel {
  const family = FAMILY_RECIPES[familyId];
  return { ...family, operations: [...family.operations], qualityPresets: [...(family.qualityPresets || [])], id: `${familyId}-base`, familyId, family: family.name, installed: true, ready: true,
    capabilities: { maxImages: family.maxReferences, editing: { inpaint: available, outpaint: available, matchSource: available, reference: available, refiner: available } } };
}
const sdxl = model('sdxl'), qwen = model('qwen-image-2.1'), ideogram = model('ideogram-4');

function job(input: GenerationInput, parameters: Partial<Job['parameters']> = {}): Job {
  return { id: 'job-id', modelId: input.modelId, status: 'succeeded', prompt: input.prompt, outputs: [], input, progress: 1, error: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', parameters: { width: 1024, height: 768, steps: 40, cfg: 7, seed: 42, ...parameters } };
}

test('source-bound edits survive adding a secondary reference and clear when the source is removed', () => {
  const edited: Draft = { ...draft, images: [source], mask, matchSource: true, editSourceId: source.id };
  assert.equal(replaceDraftImages(edited, [source, second]).mask?.id, mask.id);
  for (const images of [[second], []]) {
    const changed = replaceDraftImages(edited, images);
    assert.equal(changed.mask, undefined);
    assert.equal(changed.matchSource, false);
    assert.equal(changed.editSourceId, undefined);
  }
  assert.match(editingProblem(sdxl, { ...edited, images: [second] })!, /original source/);
});

test('deleting a draft mask retains protected-edit intent and blocks generation across reload until explicitly replaced or cleared', () => {
  const edited: Draft = { ...draft, images: [source], mask, matchSource: true, editSourceId: source.id };
  const deleted = deletedDraftInput(edited, mask.id);
  assert.equal(deleted.mask?.id, mask.id);
  assert.equal(deleted.missingMaskId, mask.id);
  assert.equal(generationInput(sdxl, deleted).maskId, mask.id, 'A protected edit must never silently omit its missing mask');
  assert.match(editingProblem(sdxl, deleted)!, /mask was deleted/);
  const restored = { ...deleted, ...savedDraftEdits(JSON.parse(JSON.stringify(deleted))) };
  assert.match(editingProblem(sdxl, restored)!, /mask was deleted/);
  assert.equal(editingProblem(sdxl, { ...restored, mask: { ...mask, id: 'replacement-mask' }, missingMaskId: undefined }), null);
  const cleared = replaceDraftImages(restored, []);
  assert.equal(cleared.mask, undefined);
  assert.equal(cleared.missingMaskId, undefined);
  assert.equal(editingProblem(sdxl, cleared), null);
  assert.equal(deletedDraftInput(edited, second.id).missingMaskId, undefined, 'Deleting another input leaves this mask available');
});

test('masked and extended generations serialize the owned source separately and keep its canvas at Ultra', () => {
  const edited: Draft = { ...draft, quality: 'ultra', images: [source], mask, editSourceId: source.id, matchSource: true };
  const request = generationInput(sdxl, edited);
  assert.equal(request.operation, 'image-to-image');
  assert.deepEqual(request.images, [source.id]);
  assert.equal(request.maskId, mask.id);
  assert.equal(request.width, 1024);
  assert.equal(request.height, 768);
  assert.equal(request.quality, 'ultra');
  assert.equal('sourceSize' in request, false);
  const extended = { ...edited, mask: undefined, outpaint: { left: 128, right: 128, top: 0, bottom: 0 } };
  assert.deepEqual(generationInput(sdxl, extended).outpaint, extended.outpaint);
  assert.equal(generationInput(sdxl, extended).width, 1280);
  assert.match(editingProblem(sdxl, { ...edited, outpaint: extended.outpaint })!, /not both/);
});

test('ten Qwen references remain references without accidental denoise or input flattening', () => {
  const images = Array.from({ length: 10 }, (_, index) => ({ ...source, id: `source-${index}`, url: `/api/inputs/source-${index}` }));
  const request = generationInput(qwen, { ...draft, modelId: qwen.id, images });
  assert.equal(request.operation, 'reference');
  assert.deepEqual(request.images, images.map(image => image.id));
  assert.equal('denoise' in request, false);
});

test('SDXL accepts one edit source until reference mode is selected, while Qwen retains ten reference slots', () => {
  assert.equal(referenceLimit(sdxl, draft), 1);
  assert.equal(referenceLimit(sdxl, { ...draft, imageMode: 'reference' }), 4);
  assert.equal(referenceLimit(sdxl, { ...draft, imageMode: 'reference', mask }), 1);
  assert.equal(referenceLimit(qwen, draft), 10);
  assert.equal(referenceLimit({ ...qwen, capabilities: { ...qwen.capabilities, imageInput: false } }, draft), 0);
});

test('checkpoint variants require a source only when advertised and reject images for text-only models', () => {
  const editOnly: StudioModel = { ...sdxl, operations: ['image-to-image'], capabilities: { ...sdxl.capabilities, requiresImage: true, maxImages: 1 } };
  assert.match(editingProblem(editOnly, draft)!, /requires a source image/);
  assert.equal(editingProblem(editOnly, { ...draft, images: [source] }), null);
  assert.equal(referenceLimit(editOnly, draft), 1);
  assert.equal(referenceLimit(editOnly, { ...draft, imageMode: 'reference' }), 0);
  const legacyEditOnly: StudioModel = { ...sdxl, operations: ['reference'] };
  assert.match(editingProblem(legacyEditOnly, draft)!, /requires a source image/);
  const textOnly: StudioModel = { ...sdxl, operations: ['text-to-image'] };
  assert.equal(referenceLimit(textOnly, draft), 0);
  assert.equal(editingProblem(textOnly, draft), null);
  assert.match(editingProblem(textOnly, { ...draft, images: [source] })!, /text only/);
});

test('Ideogram experimental reference locks the canvas but retains explicit sampling and prevents source edits', () => {
  const value: Draft = { ...draft, modelId: ideogram.id, images: [source], imageMode: 'reference', width: 2048, height: 2048, quality: 'high', steps: 48 };
  assert.deepEqual(draftCanvasSize(ideogram, value), { width: 1024, height: 1024 });
  const request = generationInput(ideogram, value);
  assert.equal(request.width, 1024);
  assert.equal(request.height, 1024);
  assert.equal(request.steps, 48);
  assert.equal(request.quality, 'high');
  assert.match(editingProblem(ideogram, { ...value, matchSource: true, editSourceId: source.id })!, /reference mode/);
  assert.equal(generationInput(ideogram, { ...value, imageMode: 'image-to-image' }).width, 2048);
});

test('native captions stay separate from readable prompts and blank or invalid enabled captions cannot submit', () => {
  const caption = compileIdeogramPrompt('A yellow boat with the text "SUMMER".');
  const fields = promptFields(caption, ideogram);
  assert.equal(fields.prompt, 'A yellow boat with the text "SUMMER".');
  assert.ok(fields.structuredPrompt);
  assert.deepEqual(JSON.parse(generationInput(ideogram, { ...draft, ...fields }).prompt), JSON.parse(caption));
  assert.equal(structuredPromptProblem(ideogram, fields), null);
  assert.ok(structuredPromptProblem(ideogram, { structuredPrompt: '' }));
  assert.ok(structuredPromptProblem(ideogram, { structuredPrompt: '{' }));
  assert.equal(structuredPromptProblem(sdxl, { structuredPrompt: '{' }), null);
});

test('changing model removes model-specific adapters and unsupported edits while choosing native sampling defaults', () => {
  const current: Draft = { ...draft, background: 'transparent', images: [source], mask, matchSource: true, editSourceId: source.id,
    structuredPrompt: compileIdeogramPrompt('A paper boat'), loras: [{ id: 'old-lora', strength: .8 }], refiner: true, referenceStrength: .7, sampler: 'heun', scheduler: 'karras' };
  const changed = selectedModelDraft(current, { ...sdxl, capabilities: { editing: { inpaint: { available: false }, outpaint: available, matchSource: { available: false }, reference: available, refiner: available } } });
  assert.equal(changed.mask, undefined);
  assert.equal(changed.editSourceId, undefined);
  assert.equal(changed.structuredPrompt, undefined);
  assert.deepEqual(changed.loras, []);
  assert.equal(changed.refiner, false);
  assert.equal(changed.referenceStrength, undefined);
  assert.equal(changed.sampler, FAMILY_RECIPES.sdxl.defaults.sampler);
  assert.equal(changed.steps, 40);
  assert.equal(changed.prompt, current.prompt);
  assert.equal(changed.background, 'transparent', 'The intended output background is shared across models and must not silently change.');
  assert.deepEqual(changed.images, current.images);
});

test('draft persistence preserves intentional advanced sampling and rejects foreign or mismatched image URLs', () => {
  const fields = savedDraftEdits({ sampler: 'euler', scheduler: 'karras', imageMode: 'reference', editSourceId: source.id, mask,
    outpaint: { left: 128, right: 0, top: 0, bottom: 0 }, matchSource: true, refiner: true, referenceStrength: .4, loras: [{ id: 'my-lora', strength: .65 }] });
  assert.equal(fields.sampler, 'euler');
  assert.equal(fields.scheduler, 'karras');
  assert.deepEqual(fields.mask, mask);
  assert.equal(fields.referenceStrength, .4);
  assert.deepEqual(fields.loras, [{ id: 'my-lora', strength: .65 }]);
  assert.ok(savedInputImage(source));
  for (const url of ['https://example.com/image.png', '/api/inputs/../account', '/api/inputs/different-id']) assert.equal(savedInputImage({ ...source, url }), false);
});

test('reusing a masked run resolves all original assets and cannot silently become a new text-to-image job', () => {
  const original = job({ modelId: sdxl.id, operation: 'image-to-image', prompt: 'A ceramic boat', images: [source.id], maskId: mask.id, matchSource: true, denoise: .4, refiner: true, loras: [{ id: 'detail', strength: .7 }], quality: 'ultra' }, { sampler: 'euler', scheduler: 'karras' });
  const reused = reusedDraft(draft, original, [source, mask]);
  assert.deepEqual(reused.images, [source]);
  assert.equal(reused.mask?.id, mask.id);
  assert.equal(reused.editSourceId, source.id);
  assert.equal(reused.denoise, .4);
  assert.equal(reused.quality, 'ultra');
  assert.equal(reused.seed, '42');
  assert.equal(reused.sampler, 'euler');
  assert.equal(reused.refiner, true);
  assert.deepEqual(reused.loras, [{ id: 'detail', strength: .7 }]);
  assert.throws(() => reusedDraft(draft, original, [source]), /no longer available/);
  assert.throws(() => reusedDraft(draft, original, [mask]), /no longer available/);
  assert.deepEqual(draft.images, []);
});

test('reuse clears a previous edit when the selected job is plain text-to-image', () => {
  const reused = reusedDraft({ ...draft, mask, images: [source], matchSource: true, editSourceId: source.id, outpaint: { left: 128, right: 0, top: 0, bottom: 0 }, refiner: true, loras: [{ id: 'detail', strength: 1 }] }, job({ modelId: sdxl.id, operation: 'text-to-image', prompt: 'A boat' }), []);
  assert.deepEqual(reused.images, []);
  assert.equal(reused.mask, undefined);
  assert.equal(reused.outpaint, undefined);
  assert.equal(reused.editSourceId, undefined);
  assert.equal(reused.matchSource, false);
  assert.equal(reused.refiner, false);
  assert.deepEqual(reused.loras, []);
});

test('LoRA readiness is scoped to the selected family and chosen worker state', () => {
  const choice = [{ id: 'detail', strength: 1 }];
  const tool: GenerationTool = { id: 'detail', name: 'Detail', kind: 'lora', familyIds: ['sdxl'], ready: true, installed: true, missingReasons: [], artifacts: [] };
  assert.equal(loraProblem(sdxl, choice, [tool]), null);
  assert.match(loraProblem(qwen, choice, [tool])!, /incompatible/);
  assert.match(loraProblem(sdxl, choice, [{ ...tool, ready: false, missingReasons: ['Not on the assigned worker.'] }])!, /assigned worker/);
  assert.match(loraProblem(sdxl, [{ ...choice[0], strength: NaN }], [tool])!, /between 0 and 2/);
  assert.ok(loraProblem(sdxl, [...choice, ...choice], [tool]));
});
