import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_LORAS, LEGACY_MAX_LORAS, validateLoraChoices } from "../../packages/contracts/lora-stack.ts";
import { FAMILY_RECIPES, compileGeneration, createCheckpointManifest, effectiveModelLoraLimit, getModel, getModelPresets, verifySnapshot, validateModel } from "../../packages/inference/index.ts";
import type { GenerationExtensionManifest, GenerationRequest, LoraChoice, ModelManifest } from "../../packages/inference/index.ts";

function stack(model: ModelManifest, count: number) {
  const extensions: GenerationExtensionManifest[] = Array.from({ length: count }, (_, index) => ({
    id: `adapter-${index}`, revision: "pinned-1", name: `Adapter ${index}`, description: "Pinned test adapter", kind: "lora", category: "image", familyIds: [model.familyId],
    artifacts: [{ role: "lora", folder: "loras", filename: `stack/adapter-${index}.safetensors`, sha256: index.toString(16).padStart(64, "0") }],
    memory: { ramBytes: 1024, vramBytes: 512 },
  }));
  const loras: LoraChoice[] = extensions.map((extension, index) => ({ id: extension.id, strength: (index % 5) / 2 }));
  return { extensions, loras, request: { modelId: model.id, prompt: "A ceramic cup", seed: 42, loras } satisfies GenerationRequest };
}

test("browser-safe stack validation shares a bounded policy without mutating choices", () => {
  assert.equal(MAX_LORAS, 32); assert.equal(LEGACY_MAX_LORAS, 4);
  const choices = stack(getModel("sdxl-base"), MAX_LORAS).loras;
  const original = structuredClone(choices);
  assert(validateLoraChoices(choices));
  assert.deepEqual(choices, original);
  assert(!validateLoraChoices(choices, LEGACY_MAX_LORAS));
  assert(validateLoraChoices([], 0));
  for (const value of [undefined, null, {}, [choices[0], choices[0]], [{ id: "../file", strength: 1 }], [{ id: "adapter", strength: NaN }], [{ id: "adapter", strength: Infinity }], [{ id: "adapter", strength: -1 }], [{ id: "adapter", strength: 3 }], [{ id: "adapter", strength: 1, filename: "other" }]]) assert(!validateLoraChoices(value));
  for (const limit of [-1, .5, MAX_LORAS + 1, Infinity]) assert(!validateLoraChoices([], limit));
});

test("SDXL chains more than four adapters through both model and CLIP without changing the VAE", () => {
  const model = getModel("sdxl-base"), { request, loras, extensions } = stack(model, 7);
  const snapshot = compileGeneration(request, model, undefined, extensions);
  for (let index = 0; index < loras.length; index++) {
    const node = snapshot.graph[`lora_${index}`];
    assert.equal(node.class_type, "LoraLoader");
    assert.deepEqual(node.inputs.model, index === 0 ? ["checkpoint", 0] : [`lora_${index - 1}`, 0]);
    assert.deepEqual(node.inputs.clip, index === 0 ? ["checkpoint", 1] : [`lora_${index - 1}`, 1]);
    assert.equal(node.inputs.lora_name, extensions[index].artifacts[0].filename);
    assert.equal(node.inputs.strength_model, loras[index].strength);
    assert.equal(node.inputs.strength_clip, loras[index].strength);
  }
  assert.deepEqual(snapshot.graph.sample.inputs.model, ["lora_6", 0]);
  assert.deepEqual(snapshot.graph.clip.inputs.clip, ["lora_6", 1]);
  assert.deepEqual(snapshot.graph.decode.inputs.vae, ["checkpoint", 2]);
  assert.deepEqual(snapshot.parameters.loras, loras);
  assert.deepEqual(snapshot.extensions!.map(extension => extension.id), loras.map(choice => choice.id));
  verifySnapshot(snapshot);
});

test("all reviewed single-model diffusion recipes preserve ordered model-only adapter chains", () => {
  for (const modelId of ["flux-2-klein-4b", "krea-2-turbo", "qwen-image-2.1"]) {
    const model = getModel(modelId), { request, loras, extensions } = stack(model, 6);
    const snapshot = compileGeneration(request, model, undefined, [...extensions].reverse());
    for (let index = 0; index < loras.length; index++) {
      const node = snapshot.graph[`lora_${index}`];
      assert.equal(node.class_type, "LoraLoaderModelOnly");
      assert.deepEqual(node.inputs.model, index === 0 ? ["model", 0] : [`lora_${index - 1}`, 0]);
      assert.equal(node.inputs.lora_name, extensions[index].artifacts[0].filename);
      assert.equal(node.inputs.strength_model, loras[index].strength);
      assert.equal(node.inputs.clip, undefined);
    }
    assert.equal(snapshot.graph.clip.class_type, "CLIPLoader");
    assert.deepEqual(snapshot.graph.decode.inputs.vae, ["vae", 0]);
    verifySnapshot(snapshot);
  }
});

test("the 32-adapter workflow boundary is enforced separately from physical memory admission", () => {
  for (const modelId of ["sdxl-base", "krea-2-turbo"]) {
    const model = getModel(modelId), accepted = stack(model, MAX_LORAS), rejected = stack(model, MAX_LORAS + 1);
    const snapshot = compileGeneration(accepted.request, model, undefined, accepted.extensions);
    assert(snapshot.graph.lora_31);
    assert.equal(snapshot.graph.lora_32, undefined);
    assert.equal(snapshot.extensions!.length, MAX_LORAS);
    assert.throws(() => compileGeneration(rejected.request, model, undefined, rejected.extensions), /up to 32/);
  }
});

test("checkpoint limits can narrow a family policy and are frozen by preset imports", () => {
  const template = getModel("sdxl-base");
  for (const maxLoras of [0, 1, 8, MAX_LORAS]) {
    const limited = { ...template, maxLoras };
    validateModel(limited);
    assert.equal(effectiveModelLoraLimit(limited), maxLoras);
    const imported = createCheckpointManifest({ id: `limited-${maxLoras}`, name: "Limited checkpoint", artifacts: [{ role: "checkpoint", folder: "checkpoints", filename: "custom.safetensors" }] }, limited);
    assert.equal(imported.maxLoras, maxLoras);
    const accepted = stack(imported, maxLoras);
    compileGeneration(accepted.request, imported, undefined, accepted.extensions);
    if (maxLoras < MAX_LORAS) {
      const rejected = stack(imported, maxLoras + 1);
      assert.throws(() => compileGeneration(rejected.request, imported, undefined, rejected.extensions), new RegExp(`up to ${maxLoras}`));
    }
  }
  assert.equal(effectiveModelLoraLimit(template), MAX_LORAS);
  for (const maxLoras of [-1, .5, MAX_LORAS + 1, Infinity, "4"]) assert.throws(() => validateModel({ ...template, maxLoras } as ModelManifest), /LoRA limit/);
  assert(getModelPresets().every(preset => preset.maxLoras === (preset.familyId === "ideogram-4" ? 0 : MAX_LORAS)));
  assert(Object.values(FAMILY_RECIPES).every(family => family.maxLoras === (family.id === "ideogram-4" ? 0 : MAX_LORAS)));
});

test("Ideogram remains unsupported and duplicate or incompatible adapters cannot be hidden in a larger stack", () => {
  const ideogram = getModel("ideogram-4-fp8");
  assert.equal(effectiveModelLoraLimit(ideogram), 0);
  assert.throws(() => validateModel({ ...ideogram, maxLoras: 1 }), /LoRA limit/);
  assert.throws(() => compileGeneration({ modelId: ideogram.id, prompt: "A cup", loras: [{ id: "adapter-0", strength: 1 }] }, ideogram), /up to 0/);
  const model = getModel("sdxl-base"), { request, loras, extensions } = stack(model, 8);
  assert.throws(() => compileGeneration({ ...request, loras: [...loras, loras[0]] }, model, undefined, extensions), /distinct/);
  const incompatible = structuredClone(extensions); incompatible[7].familyIds = ["krea-2"];
  assert.throws(() => compileGeneration(request, model, undefined, incompatible), /does not support/);
});

test("stack ordering, strengths and pinned files remain reproducible after source mutation", () => {
  for (const modelId of ["sdxl-base", "krea-2-turbo"]) {
    const model = getModel(modelId), { request, extensions } = stack(model, 8);
    const snapshot = compileGeneration(request, model, undefined, extensions);
    assert.equal(compileGeneration(request, snapshot.model, undefined, snapshot.extensions).hash, snapshot.hash);
    const reordered = { ...request, loras: [...request.loras].reverse() };
    assert.notEqual(compileGeneration(reordered, model, undefined, snapshot.extensions).hash, snapshot.hash);
    assert.equal(compileGeneration(reordered, model, undefined, snapshot.extensions).graph.lora_0.inputs.lora_name, "stack/adapter-7.safetensors");
    const strength = { ...request, loras: request.loras.map((choice, index) => ({ ...choice, strength: index === 0 ? .25 : choice.strength })) };
    assert.notEqual(compileGeneration(strength, model, undefined, snapshot.extensions).hash, snapshot.hash);
    extensions[0].artifacts[0].filename = "replaced.safetensors";
    request.loras[0].strength = 2;
    assert.equal(snapshot.graph.lora_0.inputs.lora_name, "stack/adapter-0.safetensors");
    assert.equal(snapshot.parameters.loras![0].strength, 0);
    const replay = { ...request, loras: structuredClone(snapshot.parameters.loras!) };
    assert.equal(compileGeneration(replay, snapshot.model, undefined, snapshot.extensions).hash, snapshot.hash);
    verifySnapshot(snapshot);
  }
});
