import assert from "node:assert/strict";
import { test } from "node:test";
import signatures from "./fixtures/comfy-v0.39.0-signatures.json" with { type: "json" };
import editingInfo from "./fixtures/editing-object-info.json" with { type: "json" };
import { compileGeneration, DEFAULT_MODELS, FAMILY_RECIPES } from "../../packages/inference/index.ts";
import type { WorkflowGraph } from "../../packages/inference/index.ts";

interface Signature { required: Record<string, string | string[]>; optional: Record<string, string | string[]>; outputs: string[] }

// Captured from the pinned worker, retaining only socket types, public enums
// and numeric bounds. Model files, image names and other dynamic lists are
// represented by COMBO, never copied from the deployment into this fixture.
const definitions: Record<string, Signature> = { ...signatures.nodes };
for (const [name, node] of Object.entries(editingInfo)) {
  const inputs = node.input as Record<string, Record<string, [string | string[], unknown]>>;
  definitions[name] = {
    required: Object.fromEntries(Object.entries(inputs.required ?? {}).map(([key, value]) => [key, value[0]])),
    optional: Object.fromEntries(Object.entries(inputs.optional ?? {}).map(([key, value]) => [key, value[0]])),
    outputs: node.output,
  };
}

export function assertPinnedGraph(graph: WorkflowGraph, context = "graph") {
  for (const [id, node] of Object.entries(graph)) {
    const definition = definitions[node.class_type];
    assert(definition, `${context}: ${node.class_type} is absent from the pinned runtime`);
    const sockets = { ...definition.required, ...definition.optional };
    for (const required of Object.keys(definition.required)) assert(required in node.inputs, `${id} is missing ${required}`);
    for (const [input, value] of Object.entries(node.inputs)) {
      const expected = sockets[input];
      assert(expected, `${node.class_type}.${input} is absent from the pinned schema`);
      if (Array.isArray(value)) {
        const upstream = graph[value[0]];
        assert(upstream, `${id}.${input} refers to a missing node`);
        assert(definitions[upstream.class_type], `${upstream.class_type} has no pinned schema`);
        assert.equal(definitions[upstream.class_type].outputs[value[1]], expected, `${id}.${input} has an incompatible output connection`);
      } else if (Array.isArray(expected)) assert(expected.includes(String(value)), `${node.class_type}.${input} rejects ${value}`);
      else if (expected === "INT") assert(Number.isSafeInteger(value), `${id}.${input} needs an integer`);
      else if (expected === "FLOAT") assert.equal(typeof value, "number");
      else if (expected === "STRING") assert.equal(typeof value, "string");
      else if (expected === "BOOLEAN") assert.equal(typeof value, "boolean");
      else assert.equal(expected, "COMBO", `${id}.${input} needs a connected ${expected} socket`);
    }
  }
}

// Required/optional sockets and enum values extracted statically from the
// pinned upstream Python definitions. Dynamic model/sampler lists remain
// COMBO here; runtime discovery validates their actual installed choices.
test("all supported model operations use sockets present in pinned ComfyUI v0.39.0", () => {
  assert.equal(signatures.commit, "b0b743566f65daafc423b4fea8a2fbda94b3384a");
  for (const model of DEFAULT_MODELS) {
    for (const operation of model.operations ?? FAMILY_RECIPES[model.familyId].operations) for (const background of ["auto", "opaque", "transparent"] as const) {
      const snapshot = compileGeneration({ modelId: model.id, operation, background, prompt: "A ceramic cup", seed: 42, images: operation === "text-to-image" ? [] : [{ filename: "reference.png", subfolder: "grav/input", type: "input" }] }, model);
      assertPinnedGraph(snapshot.graph, `${model.id}/${operation}`);
    }
  }
});
