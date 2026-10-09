import { ApiError, type IntegrationProviderId, type IntegrationStatus, type IntegrationTestResult } from "../../packages/contracts/index.ts";

export const INTEGRATION_PROVIDERS = [
  { id: "huggingface", name: "Hugging Face", description: "Connect your Hugging Face account for model access." },
  { id: "civitai", name: "Civitai", description: "Connect your Civitai account for model access." },
  { id: "gemini", name: "Gemini", description: "Connect Google's Gemini API." },
  { id: "openai", name: "OpenAI (GPT)", description: "Connect the OpenAI API." },
  { id: "anthropic", name: "Anthropic (Claude)", description: "Connect Anthropic's Claude API." },
  { id: "nanogpt", name: "NanoGPT", description: "Connect your NanoGPT API account." },
] as const satisfies readonly Omit<IntegrationStatus, "credential">[];

export function integrationProvider(value: string): IntegrationProviderId {
  const provider = INTEGRATION_PROVIDERS.find(item => item.id === value);
  if (!provider) throw new ApiError(404, "INTEGRATION_NOT_FOUND", "This integration does not exist.");
  return provider.id;
}

// These endpoints require authentication and do not run models or spend credits.
// Civitai and NanoGPT public model lists cannot verify whether a key is valid.
const CONNECTION_CHECKS: Record<IntegrationProviderId, { url: string; header: string; bearer?: boolean }> = {
  huggingface: { url: "https://huggingface.co/api/whoami-v2", header: "Authorization", bearer: true },
  civitai: { url: "https://civitai.com/api/v1/me", header: "Authorization", bearer: true },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models", header: "x-goog-api-key" },
  openai: { url: "https://api.openai.com/v1/models", header: "Authorization", bearer: true },
  anthropic: { url: "https://api.anthropic.com/v1/models", header: "x-api-key" },
  nanogpt: { url: "https://api.nano-gpt.com/api/v1/usage", header: "Authorization", bearer: true },
};

export async function testIntegration(provider: IntegrationProviderId, apiKey: string, fetcher: typeof fetch = fetch): Promise<IntegrationTestResult> {
  const check = CONNECTION_CHECKS[integrationProvider(provider)];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response: Response;
  try {
    const headers: Record<string, string> = { Accept: "application/json", [check.header]: check.bearer ? `Bearer ${apiKey}` : apiKey };
    if (provider === "anthropic") headers["anthropic-version"] = "2023-06-01";
    response = await fetcher(check.url, { method: "GET", headers, redirect: "error", signal: controller.signal });
  } catch {
    // Fetch exceptions can include a request URL or a provider's reflected key.
    if (controller.signal.aborted) throw new ApiError(504, "INTEGRATION_TIMEOUT", "The provider took too long to respond. Try again later.");
    throw new ApiError(502, "INTEGRATION_UNAVAILABLE", "Could not reach the provider. Try again later.");
  } finally {
    clearTimeout(timer);
  }

  // Never read or return upstream account data or error bodies.
  void response.body?.cancel().catch(() => {});
  if (response.status === 401) throw new ApiError(400, "INTEGRATION_AUTH_FAILED", "The provider rejected this key. Replace it and try again.");
  if (response.status === 403) throw new ApiError(400, "INTEGRATION_ACCESS_DENIED", "The provider denied access. Check this key's permissions.");
  if (response.status === 429) throw new ApiError(429, "INTEGRATION_RATE_LIMITED", "The provider is rate limiting requests. Try again later.");
  if (!response.ok) throw new ApiError(502, "INTEGRATION_UNAVAILABLE", "The provider could not complete the connection check. Try again later.");
  return { ok: true, message: "Connection verified. The provider accepted your saved key." };
}
