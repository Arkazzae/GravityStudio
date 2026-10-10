import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODELS, FAMILY_RECIPES, compileGeneration, createCheckpointManifest, effectiveModelOperations, effectiveModelQualityPresets, getModel, getModelPresets, modelManifestRevision, modelProbeRequest, validateModel, verifySnapshot } from "../../packages/inference/index.ts";
import type { CheckpointManifestInput, ModelArtifact, ModelManifest, Operation, SamplingDefaults } from "../../packages/inference/index.ts";

const replacement = (template: ModelManifest): ModelArtifact => ({
  role: template.familyId === "sdxl" ? "checkpoint" : "diffusion",
  folder: template.familyId === "sdxl" ? "checkpoints" : "diffusion_models",
  filename: "custom/weights.safetensors", source: "https://huggingface.co/author/model/resolve/pinned/weights.safetensors",
});
const input = (template: ModelManifest): CheckpointManifestInput => ({ id: `custom-${template.id}`, name: "Custom checkpoint", artifacts: [replacement(template)] });

test("preset choices are detached reviewed manifests with exact dependency roles", () => {
  const presets = getModelPresets();
  assert.deepEqual(presets.map(preset => preset.id), DEFAULT_MODELS.map(model => model.id));
  assert(!presets.some(preset => preset.familyId === "flux-2-klein-9b"), "A family recipe without reviewed baseline weights is not advertised as a preset");
  const ideogram = presets.find(preset => preset.id === "ideogram-4-fp8")!;
  assert.equal(ideogram.primaryRole, "diffusion");
  assert.deepEqual(ideogram.dependencyRoles, ["diffusion-unconditional", "text-encoder", "vae"]);
  ideogram.artifacts[0].filename = "changed.safetensors";
  ideogram.qualityPresets[0].sampling!.steps = 100;
  assert.notEqual(getModelPresets().find(preset => preset.id === ideogram.id)!.artifacts[0].filename, "changed.safetensors");
  assert.equal(FAMILY_RECIPES[ideogram.familyId].qualityPresets[0].sampling!.steps, 12);
});

test("every reviewed checkpoint preset materializes full weights and preserves unchanged dependencies", () => {
  for (const template of DEFAULT_MODELS) {
    const model = createCheckpointManifest(input(template), template);
    const primaryRole = replacement(template).role;
    assert.deepEqual(model.preset, { id: template.id, revision: template.revision });
    assert.deepEqual(model.artifacts.find(artifact => artifact.role === primaryRole), replacement(template));
    assert.equal(model.artifacts.find(artifact => artifact.role === primaryRole)!.sha256, undefined, "A replacement never inherits the old file's checksum");
    assert.deepEqual(model.artifacts.filter(artifact => artifact.role !== primaryRole), template.artifacts.filter(artifact => artifact.role !== primaryRole));
    const snapshot = compileGeneration(modelProbeRequest(model), model);
    verifySnapshot(snapshot);
    assert.deepEqual(snapshot.model.preset, model.preset);
    assert.equal(model.revision, modelManifestRevision(model));
    model.artifacts[0].filename = "changed.safetensors";
    assert.equal(snapshot.model.artifacts[0].filename, "custom/weights.safetensors");
    assert.notEqual(template.artifacts[0].filename, "changed.safetensors");
  }
});

test("encoders, VAE and the separate unconditional weight are complete role replacements", () => {
  const template = getModel("ideogram-4-fp8");
  const artifacts = template.artifacts.map(artifact => ({ role: artifact.role, folder: artifact.folder, filename: `custom/${artifact.role}.safetensors` }));
  const model = createCheckpointManifest({ ...input(template), artifacts }, template);
  assert.deepEqual(model.artifacts, artifacts, "Neither the old source nor the old SHA is retained");
  const graph = compileGeneration(modelProbeRequest(model), model).graph;
  assert.equal(graph.model.inputs.unet_name, "custom/diffusion.safetensors");
  assert.equal(graph.model_negative.inputs.unet_name, "custom/diffusion-unconditional.safetensors");
  assert.equal(graph.clip.inputs.clip_name, "custom/text-encoder.safetensors");
  assert.equal(graph.vae.inputs.vae_name, "custom/vae.safetensors");
});

test("materialized defaults do not drift with family or template tuning and do not claim the old weight license", () => {
  const template = getModel("sdxl-base");
  template.defaults = { sampler: "euler_ancestral" };
  const model = createCheckpointManifest(input(template), template);
  const frozen = { ...FAMILY_RECIPES.sdxl.defaults, ...template.defaults };
  assert.deepEqual(model.defaults, frozen, "All family defaults are part of the imported manifest");
  assert.equal(model.license, undefined);
  assert.equal(model.licenseUrl, undefined);
  assert.equal(model.description, "Checkpoint configured with the SDXL Base 1.0 preset.");
  template.defaults.sampler = "dpmpp_2m";
  const familyDefaults = FAMILY_RECIPES.sdxl.defaults as SamplingDefaults;
  const previous = { ...familyDefaults };
  try {
    Object.assign(familyDefaults, { steps: 99, cfg: 2, sampler: "heun", negativePrompt: "future defaults" });
    const snapshot = compileGeneration(modelProbeRequest(model), model);
    assert.equal(snapshot.parameters.steps, frozen.steps);
    assert.equal(snapshot.parameters.cfg, frozen.cfg);
    assert.equal(snapshot.parameters.sampler, frozen.sampler);
    assert.equal(snapshot.parameters.negativePrompt, frozen.negativePrompt);
    assert.deepEqual(model.defaults, frozen);
  } finally { Object.assign(familyDefaults, previous); }
  const ideogram = createCheckpointManifest(input(getModel("ideogram-4-fp8")), getModel("ideogram-4-fp8"));
  assert.equal(ideogram.licenseUrl, undefined, "A template license URL also cannot describe substituted weights");
});

test("preset overrides reject unsupported roles, duplicate roles, missing primary weights and broader operations", () => {
  const template = getModel("krea-2-turbo"), primary = replacement(template);
  for (const artifacts of [[], [primary, primary], [{ role: "vae", folder: "vae", filename: "vae.safetensors" }], [primary, { role: "checkpoint", folder: "checkpoints", filename: "bad.safetensors" }]]) {
    assert.throws(() => createCheckpointManifest({ ...input(template), artifacts: artifacts as ModelArtifact[] }, template));
  }
  assert.throws(() => createCheckpointManifest({ ...input(template), operations: ["image-to-image"] }, template), /narrow/);
  const textOnly = { ...template, operations: ["text-to-image"] as Operation[] };
  assert.throws(() => createCheckpointManifest({ ...input(textOnly), operations: ["reference"] }, textOnly), /narrow/);
  for (const defaults of [{ steps: 0 }, { cfg: 31 }, { width: 1025 }, { scheduler: "native" }, { clipSkip: 2 }, { unexpected: 1 }]) {
    assert.throws(() => createCheckpointManifest({ ...input(template), defaults } as CheckpointManifestInput, template));
  }
});

test("checkpoint sampling defaults survive all inherited output qualities and explicit requests still win", () => {
  const template = getModel("sdxl-base");
  const model = createCheckpointManifest({ ...input(template), defaults: { steps: 17, cfg: 4.5, sampler: "euler_ancestral", scheduler: "karras", clipSkip: 2 } }, template);
  for (const quality of ["fast", "standard", "high"] as const) {
    const snapshot = compileGeneration({ ...modelProbeRequest(model), quality }, model);
    assert.equal(snapshot.parameters.steps, 17);
    assert.equal(snapshot.parameters.cfg, 4.5);
    assert.equal(snapshot.parameters.sampler, "euler_ancestral");
    assert.equal(snapshot.parameters.scheduler, "karras");
    assert.equal(snapshot.parameters.clipSkip, 2);
  }
  assert.equal(compileGeneration({ ...modelProbeRequest(model), quality: "high", steps: 21 }, model).parameters.steps, 21);
  assert.equal(compileGeneration({ modelId: template.id, prompt: "A cup", seed: 0, quality: "high" }, template).parameters.steps, 40, "Legacy family quality tuning remains available");
  const direct = { ...template, defaults: { steps: 17 } };
  assert.equal(effectiveModelQualityPresets(direct).find(preset => preset.id === "high")!.sampling!.steps, 17);
});

test("checkpoint-specific quality profiles are validated, frozen and alter the execution hash", () => {
  const template = getModel("sdxl-base");
  template.qualityPresets = effectiveModelQualityPresets(template);
  template.qualityPresets.find(preset => preset.id === "high")!.sampling = { steps: 51 };
  const model = createCheckpointManifest(input(template), template);
  const first = compileGeneration({ ...modelProbeRequest(model), quality: "high" }, model);
  assert.equal(first.parameters.steps, 51);
  template.qualityPresets[2].sampling!.steps = 52;
  assert.equal(model.qualityPresets![2].sampling!.steps, 51);
  const changed = structuredClone(model); changed.qualityPresets![2].sampling!.steps = 52;
  assert.notEqual(compileGeneration({ ...modelProbeRequest(changed), quality: "high" }, changed).hash, first.hash);
  for (const qualityPresets of [[], [model.qualityPresets![0], model.qualityPresets![0], model.qualityPresets![2]], model.qualityPresets!.map(preset => ({ ...preset, pixels: 10 ** 12 })), model.qualityPresets!.map(preset => ({ ...preset, sampling: { steps: 0 } }))]) {
    assert.throws(() => validateModel({ ...model, qualityPresets }));
  }
});

test("invalid default aspects and quality schedulers are rejected before they can enter the catalog", () => {
  const ideogram = getModel("ideogram-4-fp8");
  for (const defaults of [{ width: 2048, height: 256 }, { width: 256, height: 2048 }]) {
    assert.throws(() => createCheckpointManifest({ ...input(ideogram), defaults }, ideogram), /aspect ratios/);
  }
  const boundary = createCheckpointManifest({ ...input(ideogram), defaults: { width: 1536, height: 256 } }, ideogram);
  for (const quality of [undefined, "fast", "standard", "high", "ultra"] as const) verifySnapshot(compileGeneration(modelProbeRequest(boundary, { quality }), boundary));
  const sdxl = getModel("sdxl-base");
  assert.throws(() => createCheckpointManifest({ ...input(sdxl), defaults: { width: 256, height: 1536 } }, sdxl), /quality preset's canvas grid/);
  for (const modelId of ["sdxl-base", "flux-2-klein-4b", "krea-2-turbo", "qwen-image-2.1", "ideogram-4-fp8"]) {
    const model = getModel(modelId);
    const native = model.familyId.startsWith("flux-2-klein") || model.familyId === "ideogram-4";
    model.qualityPresets = effectiveModelQualityPresets(model).map(preset => ({ ...preset, sampling: { ...preset.sampling, scheduler: native ? "normal" : "native" } }));
    assert.throws(() => validateModel(model), /recipe's scheduler/);
  }
});

test("operation probes and defaults respect text-only and image-only checkpoint variants", () => {
  const template = getModel("sdxl-base");
  const imageOnly = createCheckpointManifest({ ...input(template), operations: ["reference"] }, template);
  const probe = modelProbeRequest(imageOnly);
  assert.equal(modelProbeRequest(imageOnly, { modelId: "another-model" }).modelId, imageOnly.id);
  assert.equal(probe.operation, "reference");
  assert.equal(probe.images!.length, 1);
  assert.deepEqual(effectiveModelOperations(imageOnly), ["reference"]);
  assert.equal(compileGeneration(probe, imageOnly).recipe.operation, "reference");
  assert.throws(() => compileGeneration(modelProbeRequest(imageOnly, { operation: "text-to-image" }), imageOnly), /does not support/);
  assert.equal(modelProbeRequest(imageOnly, { images: [] }).images!.length, 0, "Explicit image lists are preserved for validation");
  const withImage = compileGeneration({ modelId: template.id, prompt: "Edit the cup", seed: 0, images: probe.images }, template);
  assert.equal(withImage.recipe.operation, "image-to-image");
  const textOnly = createCheckpointManifest({ ...input(template), operations: ["text-to-image"] }, template);
  assert.equal(modelProbeRequest(textOnly).images, undefined);
  assert.throws(() => compileGeneration({ ...modelProbeRequest(textOnly), images: probe.images }, textOnly), /does not accept/);
});

test("bundle identity covers every dependency digest and preset while ignoring artifact ordering", () => {
  const template = getModel("krea-2-turbo");
  const model = createCheckpointManifest(input(template), template);
  const reversed = { ...model, artifacts: [...model.artifacts].reverse() };
  assert.equal(modelManifestRevision(reversed), modelManifestRevision(model));
  const changed = structuredClone(model); changed.artifacts.find(artifact => artifact.role === "vae")!.sha256 = "a".repeat(64);
  assert.notEqual(modelManifestRevision(changed), model.revision);
  changed.preset!.revision = "next";
  assert.notEqual(modelManifestRevision(changed), modelManifestRevision({ ...changed, preset: model.preset }));
  const snapshot = compileGeneration(modelProbeRequest(model), model);
  changed.revision = modelManifestRevision(changed);
  assert.notEqual(compileGeneration(modelProbeRequest(changed), changed).hash, snapshot.hash);
  verifySnapshot(snapshot);
});
