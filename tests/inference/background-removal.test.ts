import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_REMOVAL_MODEL, compileBackgroundRemoval, isBackgroundRemovalSnapshot, verifySnapshot } from "../../packages/inference/index.ts";
import { assertPinnedGraph } from "./pinned-schema.test.ts";
const image = { filename: "source.png", subfolder: "grav/source", type: "input" as const };
const request = { image, sourceWidth: 257, sourceHeight: 193 };

test("standalone background removal preserves odd original canvas and intersects existing alpha", () => {
  const snapshot = compileBackgroundRemoval(request);
  assertPinnedGraph(snapshot.graph);
  assert.equal(isBackgroundRemovalSnapshot(snapshot), true);
  assert.deepEqual(snapshot.parameters, { sourceWidth: 257, sourceHeight: 193, width: 257, height: 193 });
  assert.deepEqual(snapshot.graph.original_opacity.inputs, { mask: ["source", 1] });
  assert.deepEqual(snapshot.graph.opacity.inputs, { destination: ["foreground", 0], source: ["original_opacity", 0], x: 0, y: 0, operation: "multiply" });
  assert.deepEqual(snapshot.graph.alpha.inputs, { mask: ["opacity", 0] });
  assert.deepEqual(snapshot.graph.rgba.inputs, { image: ["source", 0], alpha: ["alpha", 0] });
  assert.equal(Object.values(snapshot.graph).some(node => node.class_type === "ImageScale"), false);
  assert.deepEqual(snapshot.outputs, [{ node: "output", field: "images" }]);
  verifySnapshot(snapshot);
});

test("cutout snapshots freeze source and model, replay pinned weights, and detect changes", () => {
  const model = structuredClone(BACKGROUND_REMOVAL_MODEL);
  const snapshot = compileBackgroundRemoval(request, model);
  assert.equal(compileBackgroundRemoval(request, snapshot.model).hash, snapshot.hash);
  model.artifacts[0].filename = "later.safetensors";
  assert.notEqual(snapshot.model.artifacts[0].filename, model.artifacts[0].filename);
  const rebound = compileBackgroundRemoval({ ...request, image: { ...image, subfolder: "grav/otherworker" } }, snapshot.model);
  assert.equal(rebound.model.artifacts[0].filename, snapshot.model.artifacts[0].filename);
  assert.notEqual(rebound.hash, snapshot.hash);
  const damaged = structuredClone(snapshot); damaged.parameters.width++;
  assert.throws(() => verifySnapshot(damaged), { code: "INVALID_SNAPSHOT" });
});

test("cutout rejects paths and canvases beyond explicit bounds without hidden downscaling", () => {
  for (const patch of [{ sourceWidth: 8193 }, { sourceWidth: 8192, sourceHeight: 8192 }, { sourceWidth: 0 }, { sourceHeight: 2.5 }, { sourceHeight: Infinity }, { image: { ...image, filename: "../private.png" } }, { unknown: true }]) assert.throws(() => compileBackgroundRemoval({ ...request, ...patch }), { code: "INVALID_INPUT" });
  assert.doesNotThrow(() => compileBackgroundRemoval({ ...request, sourceWidth: 8192, sourceHeight: 2048 }));
  const model = structuredClone(BACKGROUND_REMOVAL_MODEL); model.artifacts[0].filename = "../unsafe";
  assert.throws(() => compileBackgroundRemoval(request, model), { code: "INVALID_MODEL" });
});
