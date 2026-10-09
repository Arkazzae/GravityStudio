export interface Bootstrap { configured: boolean; authenticated: boolean; setupRequired?: boolean; setupKeyRequired?: boolean; user?: { id: string; username: string } }
export interface ParameterRange { min: number; max: number; step?: number; default: number }
export interface StudioModel {
  id: string; name: string; family: string; description?: string; ready: boolean;
  unavailableReason?: string; missingReasons?: string[]; requiredArtifactRoles?: string[];
  operations?: Array<'text-to-image' | 'image-to-image' | 'reference'>;
  dimensions?: { multiple: number; min: number; max: number; maxPixels: number };
  defaults: { width: number; height: number; steps: number; cfg: number; negativePrompt?: string };
  limits?: { width?: ParameterRange; height?: ParameterRange; steps?: ParameterRange; cfg?: ParameterRange; maxImages?: number };
  capabilities?: { imageInput?: boolean; maxImages?: number; negativePrompt?: boolean };
}
export interface Catalog { models: StudioModel[]; families: Array<{ id: string; name: string }> }
export interface Hardware {
  detectedAt: string;
  host: { platform: string; architecture: string; logicalCpuCount: number; memory: { totalBytes: number; availableBytes: number }; container: { detected: boolean; markers: string[] } };
  gpus: Array<{ id: string; vendor: string; name: string; architecture?: string; pciAddress?: string; uuid?: string; memory: { totalBytes: number | null; usedBytes: number | null }; driverVersion?: string }>;
  diagnostics: Array<{ level?: string; message?: string } | string>;
}
export interface Worker { id: string; name: string; baseUrl: string; deviceIds: string[]; enabled: boolean; location: "local" | "remote"; maxConcurrentJobs: 1 }
export interface ModelConfiguration { modelId: string; enabled: boolean; artifacts: Record<string, string>; workerIds: string[]; memory: { ramBytes: number; vramBytes: number; source: "estimate" | "measured" } }
export interface Settings { revision: number; workers: Worker[]; policy: { ramReserveBytes: number; vramReserveBytes: number; maxConcurrentJobs: number; idleUnloadSeconds: number }; modelConfigurations: ModelConfiguration[] }
export interface InputImage { id: string; url: string; name: string; width: number; height: number }
export interface GenerationParameters { width: number; height: number; steps: number; cfg: number; seed: number; negativePrompt?: string }
export interface Job {
  id: string; modelId: string; prompt: string; parameters: GenerationParameters;
  status: 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  stage?: string; progress: number | null; createdAt: string;
  outputs: Array<{ id: string; url: string; width?: number; height?: number; mimeType: string }>;
  error: string | null;
}
export interface StudioState { jobs: Job[]; workers: Array<Worker & { connected?: boolean; status?: string; error?: string }>; hardware: Hardware }
export interface WorkerProbe { connected: boolean; version?: string; error?: string; artifacts?: Record<string, string[]> }
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; } }
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers, cache: 'no-store', credentials: 'same-origin' });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(value?.error?.message || value?.error || value?.message || `Request failed (${response.status}).`, response.status);
  return value as T;
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export function bytes(value: number | null | undefined) { return value == null ? 'Unavailable' : `${(value / 1024 ** 3).toFixed(1)} GB`; }
