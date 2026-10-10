import assert from "node:assert/strict";
import { test } from "node:test";
import { compileGeneration, getModel, listModels, verifySnapshot, InferenceError } from "../../packages/inference/index.ts";

test("a fine-tune uses the same family graph and overrides weights and sampling data", () => {
  const first = compileGeneration({ modelId: "sdxl-base", prompt: "A ceramic cup", seed: 42 });
  const fineTune = compileGeneration({ modelId: "wai-illustrious-v17", prompt: "A ceramic cup", seed: 42 });
  assert.deepEqual(Object.fromEntries(Object.entries(first.graph).map(([id, node]) => [id, node.class_type])), Object.fromEntries(Object.entries(fineTune.graph).map(([id, node]) => [id, node.class_type])));
  assert.equal(fineTune.graph.checkpoint.inputs.ckpt_name, "waiIllustriousSDXL_v170.safetensors");
  assert.equal(fineTune.graph.clip.inputs.stop_at_clip_layer, -2);
  assert.equal(fineTune.graph.sample.inputs.sampler_name, "euler_ancestral");
  assert.notEqual(first.hash, fineTune.hash);
  assert.equal("runtimeId" in fineTune.model, false);
  assert.equal("resources" in fineTune.model, false);
});

test("resolved snapshots are deterministic, detached from manifests and detect mutation", () => {
  const model = getModel("sdxl-base");
  const a = compileGeneration({ modelId: model.id, prompt: "A cup", seed: 0 }, model);
  const b = compileGeneration({ seed: 0, prompt: "A cup", modelId: model.id }, model);
  assert.equal(a.hash, b.hash);
  model.artifacts[0].filename = "changed.safetensors";
  assert.equal(a.model.artifacts[0].filename, "sd_xl_base_1.0.safetensors");
  verifySnapshot(JSON.parse(JSON.stringify(a)));
  a.parameters.steps++;
  assert.throws(() => verifySnapshot(a), { code: "INVALID_SNAPSHOT" });
});

test("img2img encodes and scales its input instead of starting from empty latents", () => {
  const snapshot = compileGeneration({ modelId: "sdxl-base", operation: "image-to-image", prompt: "Make it winter", seed: 1, denoise: 0.4, images: [{ filename: "snow.png", subfolder: "grav/job", type: "input" }] });
  assert.equal(snapshot.graph.latent.class_type, "VAEEncode");
  assert.equal(snapshot.graph.input_image.inputs.image, "grav/job/snow.png");
  assert.equal(snapshot.graph.sample.inputs.denoise, 0.4);
  assert.equal(snapshot.graph.resize.inputs.crop, "center");
});

test("Klein chains both reference conditioning branches and uses its native schedule", () => {
  const snapshot = compileGeneration({ modelId: "flux-2-klein-4b", operation: "reference", prompt: "Combine the scene", seed: 2, images: [{ filename: "a.png", subfolder: "", type: "input" }, { filename: "b.png", subfolder: "", type: "input" }] });
  assert.deepEqual(snapshot.graph.reference_1_positive.inputs.conditioning, ["reference_0_positive", 0]);
  assert.deepEqual(snapshot.graph.reference_1_negative.inputs.conditioning, ["reference_0_negative", 0]);
  assert.deepEqual(snapshot.graph.guider.inputs.positive, ["reference_1_positive", 0]);
  assert.equal(snapshot.graph.schedule.class_type, "Flux2Scheduler");
  assert.equal(snapshot.parameters.steps, 4);
});

test("family validation rejects unsupported operations, silent controls and unsafe paths", () => {
  const base = { modelId: "sdxl-base", prompt: "A cup", seed: 1 };
  for (const patch of [{ width: 1025 }, { width: 2048, height: 2048 }, { steps: 0 }, { seed: -1 }, { cfg: Number.NaN }, { denoise: 0.5 }, { operation: "reference" }, { unknown: true }]) {
    assert.throws(() => compileGeneration({ ...base, ...patch } as never), InferenceError);
  }
  assert.throws(() => compileGeneration({ ...base, operation: "image-to-image" }), /input image/);
  assert.throws(() => compileGeneration({ modelId: "krea-2-turbo", operation: "reference", prompt: "Edit" }), /does not support/);
  assert.throws(() => compileGeneration({ modelId: "flux-2-klein-4b", prompt: "A cup", negativePrompt: "blur" }), /negative prompt/);
  assert.throws(() => compileGeneration({ ...base, operation: "image-to-image", images: [{ filename: "../private.png", subfolder: "", type: "input" }] }), /uploaded/);
  const model = getModel("sdxl-base"); model.artifacts[0].filename = "../private.safetensors";
  assert.throws(() => compileGeneration(base, model), /relative/);
  assert.throws(() => listModels([getModel("sdxl-base"), getModel("sdxl-base")]), /Duplicate/);
});

test("model license links must be safe HTTPS links and remain attached to snapshots", () => {
  const model = getModel("ideogram-4-fp8");
  assert.equal(compileGeneration({ modelId: model.id, prompt: "A poster", seed: 1 }, model).model.licenseUrl, "https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md");
  for (const url of ["javascript:alert(1)", "https://user:secret@huggingface.co/model", "not-a-url", "http://huggingface.co/model"]) {
    assert.throws(() => listModels([{ ...model, licenseUrl: url }]), /HTTPS license URL/);
  }
});
