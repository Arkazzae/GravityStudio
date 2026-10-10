export type FamilyId = "sdxl" | "flux-2-klein-4b" | "flux-2-klein-9b" | "krea-2" | "qwen-image-2.1" | "ideogram-4";
export type Operation = "text-to-image" | "image-to-image" | "reference";
export type BackgroundMode = "auto" | "opaque" | "transparent";
export type ArtifactRole = "checkpoint" | "diffusion" | "diffusion-unconditional" | "text-encoder" | "vae" | "background-removal" | "upscale";
export type ModelFolder = "checkpoints" | "diffusion_models" | "text_encoders" | "vae" | "background_removal" | "upscale_models";

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

export interface ImageQualityPreset {
  id: "fast" | "standard" | "high";
  /** Target output pixel count, fitted to the selected aspect ratio and family limits. */
  pixels: number;
  /** Recommended minimum side for preset fitting; manual family limits remain authoritative. */
  minSide?: number;
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
  licenseUrl?: string;
}

export interface FamilyRecipe {
  id: FamilyId;
  name: string;
  revision: string;
  operations: readonly Operation[];
  artifacts: readonly ArtifactRole[];
  defaults: Readonly<SamplingDefaults>;
  dimensions: { multiple: number; min: number; max: number; maxPixels: number };
  qualityPresets: readonly ImageQualityPreset[];
  nativeTransparency?: true;
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
  background?: BackgroundMode;
  /** Worker-side image references, supplied by the trusted application. */
  images?: InputImage[];
}

export interface ResolvedParameters extends SamplingDefaults {
  prompt: string;
  seed: number;
  denoise: number;
  background: BackgroundMode;
}

export type GraphLink = [string, number];
export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, string | number | boolean | GraphLink>;
}
export type WorkflowGraph = Record<string, WorkflowNode>;

export type UpscalerFamilyId = "nomos2" | "seedvr2";
export type UpscaleScale = 2 | 4;

export interface UpscalerManifest {
  id: string;
  name: string;
  familyId: UpscalerFamilyId;
  revision: string;
  artifacts: ModelArtifact[];
  description: string;
  license?: string;
  licenseUrl?: string;
  scales: UpscaleScale[];
  maxOutputDimension: number;
  /** Conservative scheduling estimates, not measured peaks on the current worker. */
  memory: { ramBytes: number; vramBytes: number };
}

export interface UpscaleRequest {
  modelId: string;
  scale: UpscaleScale;
  sourceWidth: number;
  sourceHeight: number;
  image: InputImage;
  seed?: number;
}

export interface UpscaleParameters {
  scale: UpscaleScale;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  seed: number;
}

/** Persist the whole snapshot before submission; hashes describe recipes, not installed file integrity. */
interface SnapshotBase {
  schemaVersion: 1;
  inputs: InputImage[];
  /** Optional postprocessing weights, separate from the image model's required files. */
  auxiliaryArtifacts?: ModelArtifact[];
  graph: WorkflowGraph;
  outputs: { node: string; field: "images" }[];
  hash: string;
}

export interface GenerationSnapshot extends SnapshotBase {
  recipe: { familyId: FamilyId; revision: string; operation: Operation };
  model: ModelManifest;
  parameters: ResolvedParameters;
}

export interface UpscaleSnapshot extends SnapshotBase {
  recipe: { familyId: UpscalerFamilyId; revision: string; operation: "upscale" };
  model: UpscalerManifest;
  parameters: UpscaleParameters;
}

export type ExecutionSnapshot = GenerationSnapshot | UpscaleSnapshot;

export function isUpscaleSnapshot(snapshot: ExecutionSnapshot): snapshot is UpscaleSnapshot {
  return snapshot.recipe.operation === "upscale";
}

export class InferenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InferenceError";
    this.code = code;
  }
}
