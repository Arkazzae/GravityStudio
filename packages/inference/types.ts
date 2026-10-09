export type FamilyId = "sdxl" | "flux-2-klein-4b" | "flux-2-klein-9b" | "krea-2" | "qwen-image-2.1";
export type Operation = "text-to-image" | "image-to-image" | "reference";
export type ArtifactRole = "checkpoint" | "diffusion" | "text-encoder" | "vae";
export type ModelFolder = "checkpoints" | "diffusion_models" | "text_encoders" | "vae";

export interface ModelArtifact {
  role: ArtifactRole;
  folder: ModelFolder;
  /** Relative to the ComfyUI model folder, including any user subdirectory. */
  filename: string;
  sha256?: string;
  source?: string;
}

export interface SamplingDefaults {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  negativePrompt: string;
  clipSkip: number;
}

/** Checkpoint data, independent of machines, processes and GPU addresses. */
export interface ModelManifest {
  id: string;
  name: string;
  familyId: FamilyId;
  revision: string;
  artifacts: ModelArtifact[];
  defaults?: Partial<SamplingDefaults>;
  /** A variant may narrow, but cannot add to, its family's operations. */
  operations?: Operation[];
  description?: string;
  license?: string;
}

export interface FamilyRecipe {
  id: FamilyId;
  name: string;
  revision: string;
  operations: readonly Operation[];
  artifacts: readonly ArtifactRole[];
  defaults: Readonly<SamplingDefaults>;
  dimensions: { multiple: number; min: number; max: number; maxPixels: number };
  maxReferences: number;
}

export interface InputImage {
  filename: string;
  subfolder: string;
  type: "input";
}

export interface GenerationRequest {
  modelId: string;
  operation?: Operation;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  clipSkip?: number;
  denoise?: number;
  /** Worker-side image references, supplied by the trusted application. */
  images?: InputImage[];
}

export interface ResolvedParameters extends SamplingDefaults {
  prompt: string;
  seed: number;
  denoise: number;
}

export type GraphLink = [string, number];
export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, string | number | boolean | GraphLink>;
}
export type WorkflowGraph = Record<string, WorkflowNode>;

/** Persist the whole snapshot before submission; hashes describe recipes, not installed file integrity. */
export interface ExecutionSnapshot {
  schemaVersion: 1;
  recipe: { familyId: FamilyId; revision: string; operation: Operation };
  model: ModelManifest;
  parameters: ResolvedParameters;
  inputs: InputImage[];
  graph: WorkflowGraph;
  outputs: { node: string; field: "images" }[];
  hash: string;
}

export class InferenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InferenceError";
    this.code = code;
  }
}
