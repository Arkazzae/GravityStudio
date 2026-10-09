export const JOB_STATUSES = ["queued", "preparing", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;
export type JobStatus = typeof JOB_STATUSES[number];
export type ArtifactFolder = "checkpoints" | "diffusion_models" | "text_encoders" | "vae" | "loras";
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
  /** Measured or conservative limits for this particular environment. */
  memory: { ramBytes: number; vramBytes: number; source: "estimate" | "measured" };
}
export interface StudioSettings {
  revision: number;
  workers: WorkerSettings[];
  modelConfigurations: ModelConfiguration[];
  policy: { ramReserveBytes: number; vramReserveBytes: number; maxConcurrentJobs: number; idleUnloadSeconds: number };
}
export interface GenerationInput {
  modelId: string;
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
export interface PublicJob {
  id: string;
  modelId: string;
  modelName: string;
  prompt: string;
  input: GenerationInput;
  parameters: Record<string, unknown>;
  status: JobStatus;
  stage: string;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
  workerId: string | null;
  outputs: SavedOutput[];
  error: string | null;
}
export interface PublicInput { id: string; url: string; name: string; width: number; height: number; mimeType: string }
export interface Owner { id: string; username: string }
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "ApiError"; this.status = status; this.code = code;
  }
}
