import { verifySnapshot } from "./compiler.ts";
import type { ExecutionSnapshot, ModelFolder, WorkflowGraph } from "./types.ts";

export interface NodeInfo {
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]>; hidden?: Record<string, unknown> };
  output?: string[];
  output_node?: boolean;
}

export interface ComfyDiscovery {
  objectInfo: Record<string, NodeInfo>;
  models: Partial<Record<ModelFolder, string[]>>;
  /** Sources show when an older worker was discovered through loader enum values. */
  modelSources: Partial<Record<ModelFolder, "models-api" | "loader-schema">>;
}

export interface CapabilityIssue {
  code: "MISSING_MODEL" | "MISSING_NODE" | "INVALID_NODE_INPUT" | "INVALID_LINK";
  message: string;
  node?: string;
}

export interface CapabilityCheck {
  available: boolean;
  issues: CapabilityIssue[];
  /** ComfyUI's standard API does not provide file digests or prove architecture compatibility. */
  integrity: "filenames-only";
}

export function comboOptions(schema: unknown[] | undefined): unknown[] | undefined {
  if (Array.isArray(schema?.[0])) return schema[0];
  const options = schema?.[1];
  if (schema?.[0] === "COMBO" && options && typeof options === "object" && "options" in options && Array.isArray(options.options)) return options.options;
  return undefined;
}

function validateGraph(graph: WorkflowGraph, info: Record<string, NodeInfo>): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const schema = info[node.class_type];
    const invalid = (message: string) => issues.push({ code: "INVALID_NODE_INPUT", message: `${node.class_type}: ${message}`, node: id });
    if (!schema) { issues.push({ code: "MISSING_NODE", message: `Install a worker version that provides ${node.class_type}.`, node: id }); continue; }
    const required = schema.input?.required ?? {};
    const inputs = { ...required, ...schema.input?.optional };
    for (const key of Object.keys(required)) if (!(key in node.inputs)) invalid(`missing required input ${key}.`);
    for (const [name, value] of Object.entries(node.inputs)) {
      const input = inputs[name];
      if (!Array.isArray(input) || !input.length) { invalid(`input ${name} is unavailable on this worker.`); continue; }
      if (Array.isArray(value)) {
        const upstream = graph[value[0]];
        const output = upstream && info[upstream.class_type]?.output;
        if (!upstream || !Number.isInteger(value[1]) || value[1] < 0 || !output || value[1] >= output.length) {
          issues.push({ code: "INVALID_LINK", message: `${node.class_type}: input ${name} has an invalid graph connection.`, node: id });
        } else if (typeof input[0] === "string" && input[0] !== "*" && output[value[1]] !== "*" && !input[0].split(",").includes(output[value[1]])) {
          issues.push({ code: "INVALID_LINK", message: `${node.class_type}: input ${name} has an incompatible graph connection.`, node: id });
        }
        continue;
      }
      const options = comboOptions(input);
      if (options) {
        // LoadImage validates scoped upload paths itself; its selector can list
        // only top-level files and need not include the uploaded subdirectory.
        const config = input[1];
        const upload = config && typeof config === "object" && "image_upload" in config && config.image_upload === true;
        if (!upload && !options.includes(value)) invalid(`the worker does not support the selected ${name}.`);
        continue;
      }
      if (input[0] === "INT" && !Number.isSafeInteger(value)) invalid(`${name} must be an integer.`);
      if (input[0] === "FLOAT" && (typeof value !== "number" || !Number.isFinite(value))) invalid(`${name} must be numeric.`);
      if (input[0] === "STRING" && typeof value !== "string") invalid(`${name} must be text.`);
      if (input[0] === "BOOLEAN" && typeof value !== "boolean") invalid(`${name} must be boolean.`);
      const limits = input[1];
      if (typeof value === "number" && limits && typeof limits === "object") {
        if ("min" in limits && typeof limits.min === "number" && value < limits.min || "max" in limits && typeof limits.max === "number" && value > limits.max) invalid(`${name} is outside the worker's supported range.`);
      }
    }
  }
  return issues;
}

export function checkCapabilities(snapshot: ExecutionSnapshot, discovery: ComfyDiscovery): CapabilityCheck {
  verifySnapshot(snapshot);
  const issues = validateGraph(snapshot.graph, discovery.objectInfo);
  for (const artifact of snapshot.model.artifacts) {
    if (!discovery.models[artifact.folder]?.includes(artifact.filename)) {
      issues.push({ code: "MISSING_MODEL", message: `Missing ${artifact.folder}/${artifact.filename}.` });
    }
  }
  return { available: issues.length === 0, issues, integrity: "filenames-only" };
}
