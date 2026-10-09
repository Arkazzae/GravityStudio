import type { IntegrationCredential } from "./index.ts";

export type TextProviderId = "gemini" | "openai-compatible";
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
