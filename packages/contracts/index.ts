export const JOB_STATUSES = ["queued", "preparing", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;
export type JobStatus = typeof JOB_STATUSES[number];
export type ArtifactFolder = "checkpoints" | "diffusion_models" | "text_encoders" | "vae" | "loras" | "clip_vision" | "background_removal" | "upscale_models";
export interface WorkerSettings {
  id: string;
  name: string;
  baseUrl: string;
  deviceIds: string[];
  enabled: boolean;
  /** Separate remote hosts do not share the local host's RAM budget. */
  location: "local" | "remote";
  maxConcurrentJobs: 1;
}
export interface ModelConfiguration {
  modelId: string;
  enabled: boolean;
  artifacts: Record<string, string>;
  workerIds: string[];
  /** Missing values retain the automatic assignment behavior of older settings. */
  workerSelection?: "automatic" | "manual";
  /** Measured or conservative limits for this particular environment. */
  memory: { ramBytes: number; vramBytes: number; source: "estimate" | "measured" };
}
export interface StudioSettings {
  revision: number;
  workers: WorkerSettings[];
  modelConfigurations: ModelConfiguration[];
  policy: { ramReserveBytes: number; vramReserveBytes: number; maxConcurrentJobs: number; idleUnloadSeconds: number };
}
export type IntegrationProviderId = "huggingface" | "civitai" | "gemini" | "openai" | "anthropic" | "nanogpt";
/** Safe metadata only. Saved credentials never cross the server boundary. */
export interface IntegrationCredential { suffix: string; updatedAt: string }
export interface IntegrationStatus {
  id: IntegrationProviderId;
  name: string;
  description: string;
  credential: IntegrationCredential | null;
}
export interface IntegrationTestResult { ok: true; message: string }
export interface GenerationInput {
  /** High native resolution followed by SeedVR2 7B to a 4096px longest edge. */
  quality?: "fast" | "standard" | "high" | "ultra";
  modelId: string;
  background?: "auto" | "opaque" | "transparent";
  operation?: "text-to-image" | "image-to-image" | "reference";
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  denoise?: number;
  sampler?: string;
  scheduler?: string;
  images?: string[];
  /** Owned lossless mask input; white pixels select the area to change. */
  maskId?: string;
  outpaint?: { left: number; right: number; top: number; bottom: number };
  matchSource?: boolean;
  refiner?: boolean;
  referenceStrength?: number;
  loras?: { id: string; strength: number }[];
}
export interface SavedOutput {
  id: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes: number;
  sha256: string;
}
export type UpscaleSource = { type: "input"; inputId: string } | { type: "output"; jobId: string; outputId: string };
export interface UpscaleInput {
  operation: "upscale";
  modelId: string;
  source: UpscaleSource;
  scale: 2 | 4;
  seed?: number;
}
export interface BackgroundRemovalInput {
  operation: "remove-background";
  modelId: "birefnet";
  source: UpscaleSource;
}
export type JobInput = GenerationInput | UpscaleInput | BackgroundRemovalInput;
export function isUpscaleInput(input: JobInput): input is UpscaleInput { return input.operation === "upscale"; }
export function isBackgroundRemovalInput(input: JobInput): input is BackgroundRemovalInput { return input.operation === "remove-background"; }
export function isImageToolInput(input: JobInput): input is UpscaleInput | BackgroundRemovalInput { return isUpscaleInput(input) || isBackgroundRemovalInput(input); }
export interface UpscalerCard {
  id: string;
  name: string;
  description: string;
  scales: (2 | 4)[];
  maxOutputDimension: number;
  installed: boolean;
  ready: boolean;
  missingReasons: string[];
}
export interface PublicOutput extends SavedOutput { favorite: boolean }
export interface PublicJob {
  id: string;
  modelId: string;
  modelName: string;
  prompt: string;
  input: JobInput;
  parameters: Record<string, unknown>;
  status: JobStatus;
  stage: string;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
  workerId: string | null;
  outputs: PublicOutput[];
  error: string | null;
}
export interface PublicInput { id: string; url: string; name: string; width: number; height: number; mimeType: string }
export interface Owner { id: string; username: string; role: "admin" | "user" }
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "ApiError"; this.status = status; this.code = code;
  }
}
