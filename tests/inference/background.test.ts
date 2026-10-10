import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { BIREFNET_ARTIFACT, canonicalJson, checkCapabilities, ComfyClient, compileGeneration, FAMILY_RECIPES, listModels, verifySnapshot } from "../../packages/inference/index.ts";
import type { ComfyDiscovery, ExecutionSnapshot, GenerationRequest } from "../../packages/inference/index.ts";
import backgroundNodes from "./fixtures/background-object-info.json" with { type: "json" };
import { completed, fakeComfy, sdxlObjectInfo } from "./fake-comfy.ts";

const request = { modelId: "sdxl-base", prompt: "A ceramic cup", seed: 42 };
const qwen = { ...request, modelId: "qwen-image-2.1" };

function discovery(): ComfyDiscovery {
  return {
    objectInfo: { ...structuredClone(sdxlObjectInfo), ...structuredClone(backgroundNodes) },
    models: { checkpoints: ["sd_xl_base_1.0.safetensors"], background_removal: [BIREFNET_ARTIFACT.filename] },
    modelSources: {},
  };
}

test("Auto retains normal generation and background modes are explicit validated snapshot parameters", () => {
  for (const model of listModels()) {
    const input = { ...request, modelId: model.id };
    const auto = compileGeneration(input);
    assert.equal(auto.parameters.background, "auto");
    assert.equal(auto.hash, compileGeneration({ ...input, background: "auto" }).hash);
    assert.equal("auxiliaryArtifacts" in auto, false);
    assert.equal(Object.keys(auto.graph).some(id => id.startsWith("background_")), false);
    assert.equal(auto.parameters.prompt, request.prompt);
    verifySnapshot(auto);
    for (const mode of ["opaque", "transparent"] as const) {
      const changed = compileGeneration({ ...input, background: mode });
      assert.notEqual(changed.hash, auto.hash);
      assert.equal(changed.parameters.background, mode);
    }
  }
  for (const background of ["white", "", false, 0, {}, [], null]) {
    assert.throws(() => compileGeneration({ ...request, background } as GenerationRequest), { code: "INVALID_INPUT" });
  }
});

test("transparent Qwen conditions native RGBA without BiRefNet and preserves the user prompt", () => {
  const prompt = 'Keep <image1> and the exact words "Ceramic & Co."';
  for (const images of [[], [{ filename: "cup.png", subfolder: "grav/job", type: "input" as const }]]) {
    const input = { ...qwen, prompt, background: "transparent" as const, operation: images.length ? "reference" as const : "text-to-image" as const, images };
    const snapshot = compileGeneration(input);
    assert.equal(snapshot.parameters.prompt, prompt);
    assert.equal(snapshot.graph.conditioning.inputs.prompt, `This is an RGBA image with transparency. ${prompt} The image has alpha channel and the background is transparent.`);
    assert.equal("auxiliaryArtifacts" in snapshot, false);
    assert.equal(Object.values(snapshot.graph).some(node => node.class_type === "RemoveBackground"), false);
    assert.deepEqual(snapshot.graph.output.inputs.images, [images.length ? "output_resize" : "decode", 0]);
    assert.equal(compileGeneration(input, snapshot.model).hash, snapshot.hash, "Recompilation does not wrap the prompt twice");
    verifySnapshot(snapshot);
  }
  assert.deepEqual(Object.values(FAMILY_RECIPES).filter(family => family.nativeTransparency).map(family => family.id), ["qwen-image-2.1"]);
});

test("opaque Qwen composites RGB over white after the final reference resize", () => {
  for (const images of [[], [{ filename: "cup.png", subfolder: "grav/job", type: "input" as const }]]) {
    const snapshot = compileGeneration({ ...qwen, background: "opaque", operation: images.length ? "reference" : "text-to-image", images, width: 1536, height: 1024 });
    assert.match(String(snapshot.graph.conditioning.inputs.prompt), /fully opaque/);
    assert.equal(snapshot.parameters.prompt, qwen.prompt);
    assert.equal(snapshot.graph.background_split.class_type, "SplitImageWithAlpha");
    assert.deepEqual(snapshot.graph.background_split.inputs.image, [images.length ? "output_resize" : "decode", 0]);
    assert.equal(snapshot.graph.background_opacity.class_type, "InvertMask");
    assert.deepEqual(snapshot.graph.background_opacity.inputs.mask, ["background_split", 1]);
    assert.equal(snapshot.graph.background_white.class_type, "EmptyImage");
    assert.deepEqual(snapshot.graph.background_white.inputs, { width: 1536, height: 1024, batch_size: 1, color: 0xffffff });
    assert.equal(snapshot.graph.background_opaque.class_type, "ImageCompositeMasked");
    assert.deepEqual(snapshot.graph.background_opaque.inputs, { destination: ["background_white", 0], source: ["background_split", 0], mask: ["background_opacity", 0], x: 0, y: 0, resize_source: false });
    assert.deepEqual(snapshot.graph.output.inputs.images, ["background_opaque", 0]);
    assert.equal("auxiliaryArtifacts" in snapshot, false);
    verifySnapshot(snapshot);
  }
});

test("other image families cut out the final image once using pinned auxiliary weights and soft alpha", () => {
  for (const model of listModels().filter(model => !FAMILY_RECIPES[model.familyId].nativeTransparency)) {
    for (const operation of FAMILY_RECIPES[model.familyId].operations) {
      const input = { ...request, modelId: model.id, operation, images: operation === "text-to-image" ? [] : [{ filename: "cup.png", subfolder: "grav/job", type: "input" as const }] };
      const normal = compileGeneration(input);
      const snapshot = compileGeneration({ ...input, background: "transparent" });
      assert.deepEqual(snapshot.model.artifacts, normal.model.artifacts, "Optional weights do not alter the image-model manifest");
      assert.deepEqual(snapshot.auxiliaryArtifacts, [BIREFNET_ARTIFACT]);
      assert.notEqual(snapshot.auxiliaryArtifacts![0], BIREFNET_ARTIFACT);
      assert.equal(snapshot.graph.background_model.class_type, "LoadBackgroundRemovalModel");
      assert.deepEqual(snapshot.graph.background_model.inputs, { bg_removal_name: BIREFNET_ARTIFACT.filename });
      assert.deepEqual(snapshot.graph.background_mask, { class_type: "RemoveBackground", inputs: { bg_removal_model: ["background_model", 0], image: normal.graph.output.inputs.images } });
      assert.deepEqual(snapshot.graph.background_invert, { class_type: "InvertMask", inputs: { mask: ["background_mask", 0] } });
      assert.deepEqual(snapshot.graph.background_rgba, { class_type: "JoinImageWithAlpha", inputs: { image: normal.graph.output.inputs.images, alpha: ["background_invert", 0] } });
      assert.deepEqual(snapshot.graph.output.inputs.images, ["background_rgba", 0]);
      assert.equal(Object.values(snapshot.graph).filter(node => node.class_type === "LoadBackgroundRemovalModel").length, 1);
      assert.deepEqual(compileGeneration({ ...input, background: "opaque" }).graph, normal.graph);
      verifySnapshot(snapshot);
    }
  }
});

test("optional cutout availability checks both core node schemas and auxiliary file inventory", () => {
  const snapshot = compileGeneration({ ...request, background: "transparent" });
  const found = discovery();
  assert.equal(checkCapabilities(snapshot, found).available, true);
  found.models.background_removal = [];
  assert(checkCapabilities(snapshot, found).issues.some(issue => issue.code === "MISSING_MODEL" && issue.message.includes("background_removal/birefnet")));
  assert.equal(checkCapabilities(compileGeneration(request), found).available, true, "Missing cutout weights must not disable normal generation");
  for (const node of ["LoadBackgroundRemovalModel", "RemoveBackground", "InvertMask", "JoinImageWithAlpha"]) {
    const missing = discovery(); delete missing.objectInfo[node];
    assert(checkCapabilities(snapshot, missing).issues.some(issue => issue.code === "MISSING_NODE" && issue.message.includes(node)));
  }
  const wrong = discovery(); wrong.objectInfo.RemoveBackground.input!.required!.bg_removal_model = ["MODEL"];
  assert(checkCapabilities(snapshot, wrong).issues.some(issue => issue.code === "INVALID_LINK"));
  const mutated = structuredClone(snapshot); mutated.auxiliaryArtifacts![0].sha256 = "0".repeat(64);
  assert.throws(() => verifySnapshot(mutated), { code: "INVALID_SNAPSHOT" });
});

test("old immutable snapshots without a background parameter remain verifiable", () => {
  const { hash: _, ...content } = compileGeneration(request);
  delete (content.parameters as Partial<typeof content.parameters>).background;
  const legacy = { ...content, hash: createHash("sha256").update(canonicalJson(content)).digest("hex") } as ExecutionSnapshot;
  assert.doesNotThrow(() => verifySnapshot(legacy));
  assert.equal(checkCapabilities(legacy, discovery()).available, true);
  assert.equal("background" in legacy.parameters, false);
});

test("HTTP discovery supports BiRefNet inventory and falls back to the core loader on older workers", async t => {
  const worker = await fakeComfy(); t.after(worker.close);
  Object.assign(worker.state.info, structuredClone(backgroundNodes));
  worker.state.responseOverride = path => path === "/models/background_removal" ? { body: JSON.stringify(["birefnet.safetensors"]) } : undefined;
  const client = new ComfyClient(worker.url);
  let found = await client.discover();
  assert.deepEqual(found.models.background_removal, ["birefnet.safetensors"]);
  assert.equal(found.modelSources.background_removal, "models-api");
  worker.state.responseOverride = undefined; worker.state.foldersMissing = true;
  found = await client.discover();
  assert.deepEqual(found.models.background_removal, ["birefnet.safetensors"]);
  assert.equal(found.modelSources.background_removal, "loader-schema");
  assert.equal(checkCapabilities(compileGeneration({ ...request, background: "transparent" }), found).available, true);
  delete worker.state.info.LoadBackgroundRemovalModel;
  found = await client.discover();
  assert.deepEqual(found.models.background_removal, []);
  assert.equal(checkCapabilities(compileGeneration(request), found).available, true);
});

test("RGBA output downloads retain transparent and partially transparent PNG pixels byte for byte", async t => {
  // A real 2×2 PNG, color type 6, with alpha values 0, 64, 128 and 255.
  const rgba = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nGP4z8DAwPCfwQFENvz///8/ADHlB7oJZKpXAAAAAElFTkSuQmCC", "base64");
  const worker = await fakeComfy(); t.after(worker.close);
  const id = randomUUID();
  worker.state.history[id] = completed();
  worker.state.outputBytes = rgba;
  const client = new ComfyClient(worker.url);
  const snapshot = compileGeneration({ ...request, background: "transparent" });
  const result = await client.inspect(id, snapshot);
  const fetched = await client.fetchOutput(id, result.outputs[0], snapshot);
  assert.equal(fetched.mediaType, "image/png");
  assert.deepEqual(Buffer.from(fetched.bytes), rgba);
});
