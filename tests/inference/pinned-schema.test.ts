import assert from "node:assert/strict";
import { test } from "node:test";
import signatures from "./fixtures/comfy-v0.39.0-signatures.json" with { type: "json" };
import { compileGeneration, DEFAULT_MODELS, FAMILY_RECIPES } from "../../packages/inference/index.ts";

interface Signature { required: Record<string, string | string[]>; optional: Record<string, string | string[]>; outputs: string[] }

// Required/optional sockets and enum values extracted statically from the
// pinned upstream Python definitions. Dynamic model/sampler lists remain
// COMBO here; runtime discovery validates their actual installed choices.
test("all supported model operations use sockets present in pinned ComfyUI v0.39.0", () => {
  assert.equal(signatures.commit, "b0b743566f65daafc423b4fea8a2fbda94b3384a");
  const definitions = signatures.nodes as Record<string, Signature>;
  for (const model of DEFAULT_MODELS) {
    for (const operation of model.operations ?? FAMILY_RECIPES[model.familyId].operations) {
      const snapshot = compileGeneration({ modelId: model.id, operation, prompt: "A ceramic cup", seed: 42, images: operation === "text-to-image" ? [] : [{ filename: "reference.png", subfolder: "grav/input", type: "input" }] }, model);
      for (const [id, node] of Object.entries(snapshot.graph)) {
        const definition = definitions[node.class_type];
        assert(definition, `${model.id}/${operation}: ${node.class_type} is absent from the pinned runtime`);
        const sockets = { ...definition.required, ...definition.optional };
        for (const required of Object.keys(definition.required)) assert(required in node.inputs, `${id} is missing ${required}`);
        for (const [input, value] of Object.entries(node.inputs)) {
          const expected = sockets[input];
          assert(expected, `${node.class_type}.${input} is absent from the pinned schema`);
          if (Array.isArray(value)) {
            const upstream = snapshot.graph[value[0]];
            assert(upstream, `${id}.${input} refers to a missing node`);
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
  }
});
