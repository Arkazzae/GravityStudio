import type { JobInput } from '../../../../packages/contracts';
export type { UpscaleInput, UpscaleSource, UpscalerCard } from '../../../../packages/contracts';

export interface Bootstrap { configured: boolean; authenticated: boolean; setupRequired?: boolean; setupKeyRequired?: boolean; user?: { id: string; username: string; role: 'admin' | 'user'; email?: string | null } }
export type AvatarThemeId = 'studio' | 'lime' | 'mint' | 'blue' | 'violet' | 'rose';
export interface AccountProfile { revision: number; displayName: string; workspaceName: string; avatarTheme: AvatarThemeId }
export type ImageBackground = 'auto' | 'opaque' | 'transparent';
export interface ParameterRange { min: number; max: number; step?: number; default: number }
export interface StudioModel {
  id: string; name: string; family: string; description?: string; ready: boolean; installed: boolean;
  unavailableReason?: string; missingReasons?: string[]; requiredArtifactRoles?: string[];
  operations?: Array<'text-to-image' | 'image-to-image' | 'reference'>;
  dimensions?: { multiple: number; min: number; max: number; maxPixels: number };
  qualityPresets?: Array<{ id: 'fast' | 'standard' | 'high'; pixels: number; minSide?: number }>;
  defaults: { width: number; height: number; steps: number; cfg: number; negativePrompt?: string };
  limits?: { width?: ParameterRange; height?: ParameterRange; steps?: ParameterRange; cfg?: ParameterRange; maxImages?: number };
  capabilities?: { imageInput?: boolean; maxImages?: number; negativePrompt?: boolean; background?: { native: boolean; available: boolean; reason?: string }; ultra?: { available: boolean; transparentAvailable?: boolean; reason?: string; modelId: 'seedvr2-7b'; maxDimension: 4096 } };
}
export interface Catalog { models: StudioModel[]; families: Array<{ id: string; name: string }> }
export interface Hardware {
  detectedAt: string;
  host: { platform: string; architecture: string; logicalCpuCount: number; memory: { totalBytes: number; availableBytes: number }; container: { detected: boolean; markers: string[] } };
  gpus: Array<{ id: string; vendor: string; name: string; architecture?: string; pciAddress?: string; uuid?: string; memory: { totalBytes: number | null; usedBytes: number | null }; driverVersion?: string }>;
  diagnostics: Array<{ level?: string; message?: string } | string>;
}
export interface Worker { id: string; name: string; baseUrl: string; deviceIds: string[]; enabled: boolean; location: "local" | "remote"; maxConcurrentJobs: 1 }
export interface ModelConfiguration { modelId: string; enabled: boolean; artifacts: Record<string, string>; workerIds: string[]; workerSelection?: "automatic" | "manual"; memory: { ramBytes: number; vramBytes: number; source: "estimate" | "measured" } }
export interface Settings { revision: number; workers: Worker[]; managedWorkers?: Array<{ id: string; baseUrl: string; deviceId: string }>; policy: { ramReserveBytes: number; vramReserveBytes: number; maxConcurrentJobs: number; idleUnloadSeconds: number }; modelConfigurations: ModelConfiguration[] }
export interface RuntimeSetupStatus { phase: 'idle' | 'checking' | 'building' | 'testing' | 'connecting' | 'ready' | 'failed'; busy: boolean; message: string; error: string | null; engine: 'docker' | 'podman' | null; workerCount: number; updatedAt: string | null }
export type IntegrationProviderId = 'huggingface' | 'civitai' | 'gemini' | 'openai' | 'anthropic' | 'nanogpt';
export interface IntegrationStatus { id: IntegrationProviderId; name: string; description: string; credential: { suffix: string; updatedAt: string } | null }
export interface IntegrationTestResult { ok: true; message: string }
export interface ModelRepository { id: string; url: string }
export type ModelAccessStatus = 'available' | 'gated' | 'unauthorized' | 'forbidden' | 'not_found' | 'unavailable';
export interface ModelAccessResult { modelId?: string; available: boolean; hasToken: boolean; checkedAt: string; repositories: Array<ModelRepository & { status: ModelAccessStatus; message: string }> }
export interface LibraryModel { id: string; name: string; familyId: string; family: string; kind?: 'utility'; category?: 'upscale'; description?: string; license?: string; licenseUrl?: string; repositories: ModelRepository[]; source: 'catalog' | 'huggingface'; installed: boolean; enabled: boolean; downloadable: boolean; unavailableReason?: string; artifacts: Array<{ role: string; filename: string; installed: boolean }> }
export interface ModelDownload { id: string; modelId: string; modelName: string; status: 'downloading' | 'verifying' | 'activating' | 'succeeded' | 'failed'; stage: string; filename?: string; completedFiles: number; totalFiles: number; receivedBytes: number; totalBytes: number | null; error?: string; errorCode?: string; access?: { repository: ModelRepository; status: Exclude<ModelAccessStatus, 'available'>; message: string }; startedAt: string; updatedAt: string }
export interface ModelLibraryState { models: LibraryModel[]; download: ModelDownload | null }
export interface InputImage { id: string; url: string; name: string; width: number; height: number }
export interface GenerationParameters { width: number; height: number; steps: number; cfg: number; seed: number; negativePrompt?: string; background?: ImageBackground; quality?: 'ultra'; sourceWidth?: number; sourceHeight?: number; scale?: 2 | 4 }
export interface Job {
  id: string; modelId: string; modelName?: string; prompt: string; input?: JobInput; parameters: GenerationParameters;
  status: 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  stage?: string; progress: number | null; createdAt: string; updatedAt?: string; workerId?: string | null;
  outputs: Array<{ id: string; url: string; width?: number; height?: number; mimeType: string; favorite?: boolean }>;
  error: string | null;
}
export interface StudioState { jobs: Job[]; workers: Array<Worker & { connected?: boolean; status?: string; error?: string; canRelease?: boolean }>; hardware: Hardware }
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
export function isConnectionError(error: unknown) {
  return error instanceof TypeError || error instanceof Error && error.name === 'TimeoutError' || error instanceof ApiError && [408, 502, 503, 504].includes(error.status);
}
export function bytes(value: number | null | undefined) { return value == null ? 'Unavailable' : `${(value / 1024 ** 3).toFixed(1)} GB`; }
