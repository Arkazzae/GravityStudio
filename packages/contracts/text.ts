import type { IntegrationCredential } from "./index.ts";

export type TextProviderId = "gemini" | "openai-compatible" | "local";
export interface TextModel { id: string; name: string; inputTokenLimit?: number; outputTokenLimit?: number }
export interface TextSettings {
  revision: number;
  /** API base URL, including /v1 where required. Empty means unconfigured. */
  connection: { baseUrl: string; credential: IntegrationCredential | null };
  assistant: { provider: TextProviderId; modelId: string } | null;
}
export interface TextModels { provider: TextProviderId; models: TextModel[] }
export interface TextConnectionInput { revision: number; baseUrl: string; apiKey?: string | null }
export interface TextAssistantInput { revision: number; provider: TextProviderId | null; modelId: string | null }
export interface PromptRefinementInput { settingsRevision: number; prompt: string; imageModelId: string; instruction?: string }
export interface PromptRefinementResult {
  prompt: string;
  originalPrompt: string;
  provider: TextProviderId;
  modelId: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LocalTextStatus {
  revision: number;
  model: { id: string; name: string; quantization: string; sizeBytes: number; source: string; license: string; contextTokens: number };
  phase: 'idle' | 'downloading' | 'preparing' | 'ready' | 'loaded' | 'loading' | 'running' | 'stopping' | 'failed';
  ready: boolean;
  installed: boolean;
  busy: boolean;
  message: string;
  error: string | null;
  download: { receivedBytes: number; totalBytes: number } | null;
  gpuId: string | null;
  /** Empty follows enabled local Studio GPUs, or all compatible GPUs before image setup. */
  gpuIds: string[];
  gpus: { id: string; name: string; memoryBytes: number; supported: boolean; reason?: string; pciAddress?: string }[];
}
