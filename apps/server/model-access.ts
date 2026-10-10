import { ApiError } from "../../packages/contracts/index.ts";
import { isRelativeFile } from "../../packages/inference/index.ts";

export interface ModelRepository { id: string; url: string }
export type ModelAccessStatus = "available" | "gated" | "unauthorized" | "forbidden" | "not_found" | "unavailable";
export interface ModelRepositoryAccess extends ModelRepository { status: ModelAccessStatus; message: string }
export interface ModelAccessResult {
  modelId?: string;
  available: boolean;
  hasToken: boolean;
  checkedAt: string;
  repositories: ModelRepositoryAccess[];
}
export interface ModelDownloadAccess {
  repository: ModelRepository;
  status: Exclude<ModelAccessStatus, "available">;
  message: string;
}

const accessMessages: Record<ModelAccessStatus, string> = {
  available: "The required model files are available to download.",
  gated: "Open this Hugging Face repository to accept its terms or request access. Save a token from the same account under Models → Hugging Face, then check again.",
  unauthorized: "Hugging Face could not authorize access to this file. Check your token under Models → Hugging Face and its repository permissions.",
  forbidden: "Hugging Face denied access to this file. Check that your account and token have permission to read this repository.",
  not_found: "The repository, revision, or model file was not found. Check the file link and your repository access.",
  unavailable: "Hugging Face could not confirm access to this file. Check the connection and try again.",
};

/** Accept file links, never repository pages or arbitrary download servers. */
export function huggingFaceFile(value: unknown): string {
  const invalid = (message: string) => new ApiError(400, "INVALID_MODEL_SOURCE", message);
  if (typeof value !== "string" || value.length > 2048) throw invalid("Paste a Hugging Face .safetensors file link.");
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("Paste a complete Hugging Face .safetensors file link."); }
  if (url.protocol !== "https:" || url.hostname !== "huggingface.co" || url.port || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => key !== "download")) throw invalid("Use an HTTPS huggingface.co file link without credentials.");
  let parts: string[];
  try { parts = url.pathname.slice(1).split("/").map(part => decodeURIComponent(part)); } catch { throw invalid("The file link contains invalid characters."); }
  const [owner, repo, action, revision, ...files] = parts;
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(owner ?? "") || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo ?? "") || !["blob", "resolve"].includes(action) || !revision || revision.length > 128 || !isRelativeFile(parts.join("/")) || parts.some(part => part.includes("/")) || !files.length || !files.at(-1)!.endsWith(".safetensors")) throw invalid("Choose a .safetensors file using a Hugging Face blob or resolve link.");
  return `https://huggingface.co/${[owner, repo, "resolve", revision, ...files].map(encodeURIComponent).join("/")}`;
}

export function modelRepository(source: unknown): ModelRepository {
  const [owner, repo] = new URL(huggingFaceFile(source)).pathname.slice(1).split("/");
  return { id: `${owner}/${repo}`, url: `https://huggingface.co/${owner}/${repo}` };
}

/** Invalid/non-Hub catalog sources have no account-access link. Never performs network I/O. */
export function modelRepositories(sources: unknown[]): ModelRepository[] {
  const repositories = new Map<string, ModelRepository>();
  for (const source of sources) {
    try { const repository = modelRepository(source); repositories.set(repository.id, repository); } catch { /* Local-only catalog source. */ }
  }
  return [...repositories.values()];
}

// Official storage hosts: https://huggingface.co/docs/hub/models-downloading
const downloadHosts = new Set([
  "huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co",
  "cas-bridge.xethub.hf.co", "cas-server.xethub.hf.co", "cas-server.xethub-eu.hf.co",
  "transfer.xethub.hf.co", "transfer.xethub-eu.hf.co", "us.aws.cdn.hf.co", "us.gcp.cdn.hf.co",
]);
export function checkDownloadUrl(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || url.port || !downloadHosts.has(url.hostname)) throw new ApiError(400, "UNSAFE_MODEL_REDIRECT", "Hugging Face redirected this file to an unsupported download host.");
}

export function modelAccessResponse(repository: ModelRepository, response: Pick<Response, "status" | "headers">): ModelRepositoryAccess {
  const code = response.headers.get("x-error-code");
  // Hub error headers are more specific than the HTTP status: GatedRepo commonly returns 401.
  const status: ModelAccessStatus = code === "GatedRepo" ? "gated"
    : ["EntryNotFound", "RevisionNotFound"].includes(code ?? "") ? "not_found"
    : response.status === 401 ? "unauthorized"
    : response.status === 403 ? "forbidden"
    : response.status === 404 || code === "RepoNotFound" ? "not_found"
    : response.status >= 200 && response.status < 300 ? "available" : "unavailable";
  return { ...repository, status, message: accessMessages[status] };
}

export class ModelAccessError extends ApiError {
  readonly access: ModelDownloadAccess;
  constructor(result: ModelRepositoryAccess) {
    const status = result.status === "available" ? "unavailable" : result.status;
    super(status === "unavailable" ? 502 : 403, `MODEL_ACCESS_${status.toUpperCase()}`, accessMessages[status]);
    this.access = { repository: { id: result.id, url: result.url }, status, message: this.message };
  }
}

/** Probe pinned file metadata; a safe signed CDN redirect proves Hub authorization without fetching weights. */
export async function checkModelFileAccess(source: string, options: { fetch: typeof fetch; token?: string; signal: AbortSignal }): Promise<ModelRepositoryAccess> {
  const repository = modelRepository(source);
  let url = new URL(huggingFaceFile(source));
  try {
    for (let redirects = 0; redirects < 8; redirects++) {
      options.signal.throwIfAborted();
      checkDownloadUrl(url);
      const headers: Record<string, string> = { "Accept-Encoding": "identity" };
      if (url.hostname === "huggingface.co" && options.token) headers.Authorization = `Bearer ${options.token}`;
      const response = await options.fetch(url, { method: "HEAD", headers, redirect: "manual", signal: options.signal });
      // Never read an upstream error body or return a signed redirect URL to the caller.
      await response.body?.cancel();
      options.signal.throwIfAborted();
      if (response.headers.get("x-error-code") === "GatedRepo") return modelAccessResponse(repository, response);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        url = new URL(location, url);
        checkDownloadUrl(url);
        if (url.hostname !== "huggingface.co") return { ...repository, status: "available", message: accessMessages.available };
      } else return modelAccessResponse(repository, response);
    }
  } catch { /* The public result never includes provider bodies, URLs, abort reasons, or fetch errors. */ }
  return { ...repository, status: "unavailable", message: accessMessages.unavailable };
}
