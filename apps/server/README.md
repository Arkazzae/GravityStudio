# Studio API

The web application proxies `/api/*` to the API process. Generation, catalog and image operations require an owner session or a bearer token created in **Settings → Advanced settings → API access**. Runtime configuration and model downloads require the owner's browser session.

The examples below use `GRAVITY_TOKEN` from your environment. Tokens are displayed once when created; the server stores only their hashes.

```sh
curl http://127.0.0.1:4321/api/catalog \
  -H "Authorization: Bearer $GRAVITY_TOKEN"

curl http://127.0.0.1:4321/api/jobs \
  -H "Authorization: Bearer $GRAVITY_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: mountain-image-001' \
  -d '{"modelId":"sdxl-base","prompt":"A mountain lake at dawn","seed":1234}'
```

A successful submission returns HTTP 202 and `{ "job": ... }`. Read `GET /api/jobs/:id` until its status is `succeeded`, `failed` or `cancelled`. Output URLs in the result require the same authentication.

Retry an uncertain submission with the **same key and exactly the same request**. A repeated key returns the original job; changing the request with that key returns a conflict. Use a new key for an intentional new generation.

## Operations

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/catalog` | Models, family capabilities, parameters and availability |
| GET | `/api/jobs` | Recent generations belonging to the account |
| POST | `/api/jobs` | Accept a generation with `Idempotency-Key` |
| GET | `/api/jobs/:id` | Job status and saved outputs |
| POST | `/api/jobs/:id/cancel` | Cancel a queued job; send `{}` |
| GET | `/api/inputs` | Uploaded reference images |
| POST | `/api/inputs` | Upload raw PNG/JPEG/WebP bytes, up to 20 MiB |
| GET | `/api/inputs/:id` | Read a private reference image |
| DELETE | `/api/inputs/:id` | Delete an imported image; active or interrupted generations using it return `409 INPUT_IN_USE` |
| POST | `/api/mcp` | MCP tool requests over Streamable HTTP |

Uploads accept an optional `X-Filename` header, percent-encoded for non-ASCII names. The upload response contains the input `id` directly. Pass those IDs in the generation request's `images` array. The catalog describes which models accept references. Dimensions, steps, guidance, seed, negative prompt and denoise are validated by the selected family recipe.

Each catalog model includes family `qualityPresets`: `fast`, `standard` and `high`, with a target `pixels` count and optional recommended `minSide`. These resolution choices also apply to imported checkpoints in that family. Fit the target to the selected aspect ratio and the model's `dimensions` limits, then submit explicit `width` and `height`; quality does not change sampling settings and is not a generation request field.

Jobs retain the accepted recipe, model filenames, parameters and placement budget. A worker disconnect can produce `interrupted`: the server keeps looking for that existing generation and does not submit it again automatically. Running or interrupted jobs cannot be cancelled through this version of the API.

If the worker has lost the generation after a restart, the owner can choose **Close unknown job** in the queue or Activity panel. After explicit acknowledgement, the server checks the original worker's queue and history again. Only an absent job still marked `interrupted` is closed as `failed`, with an explanation retained in its record, releasing its resource reservation. A reported job resumes recovery; an unreachable worker keeps its reservation. Closing never resubmits the generation, and a result that appears later will not be recovered automatically.

This administrative action is `POST /api/jobs/:id/resolve` with `{ "acknowledge": true }`. It requires the owner's browser session and an allowed Origin; bearer tokens and MCP tools cannot perform it.

Progress messages can describe a single sampler node. They are not an overall completion percentage.

## Account profile

`GET /api/account` returns `{ revision, displayName, workspaceName, avatarTheme }`. `PUT /api/account` accepts exactly those four fields and returns the saved profile with an incremented revision. Both require the owner's browser session; writes also require an allowed `Origin`. Bearer tokens and MCP clients cannot access the profile.

Names are trimmed and must contain 1–64 characters without control characters. Avatar themes are `studio`, `lime`, `mint`, `blue`, `violet` and `rose`. A stale revision returns `409 ACCOUNT_CHANGED`; reload the current profile before saving again. The profile is stored per owner in SQLite. It changes presentation only: the login username and media ownership stay the same, and a workspace name does not create a separate workspace.

## Runtime setup and model library

The studio interface uses these administrative endpoints. All require the owner's browser session; mutations also require an allowed `Origin`. Bearer tokens and MCP clients cannot install runtimes or download models.

| Method | Path | Request or result |
| --- | --- | --- |
| GET | `/api/runtime` | Setup phase, selected worker count and errors |
| POST | `/api/runtime` | Start setup with `{ "gpuIds": ["detected-device-id"] }`; returns HTTP 202 |
| POST | `/api/workers/:id/unload` | Send `{}` to request an idle image worker's cache release; returns `{ "requested": true }` |
| GET | `/api/models/library` | Catalog, imported checkpoints and current download progress |
| POST | `/api/models/download` | Download `{ "modelId": "sdxl-base" }`, or import `{ "url": "https://huggingface.co/owner/repository/resolve/main/model.safetensors", "name": "My checkpoint", "familyId": "sdxl" }`; returns HTTP 202 |
| POST | `/api/models/activate` | Verify and activate installed files with `{ "modelId": "sdxl-base" }` |

Setup detects the available container engine, preserves existing worker assignments and ports, adds newly selected GPUs, tests them and saves the selected workers in studio settings. Generations and configuration changes are blocked while setup is running. Poll `GET /api/runtime` until `busy` is false.

Worker cache release is coordinated with scheduling. Busy workers, interrupted generations that retain a reservation, and overlapping releases are rejected. The request covers that worker's cached models, not a particular checkpoint, and leaves files on disk. Acceptance does not mean unloading has finished: use the measured VRAM in `GET /api/state` to observe memory changes. Its worker entries include `canRelease` for the activity panel; the server checks again when an unload is requested.

Downloads run on the server and continue when the browser page closes. The library accepts Hugging Face safetensors files, checks sizes and file structure, and verifies catalog checksums when available. Imports currently support complete SDXL / Illustrious checkpoints; other families use their catalog's complete artifact set. Imported files receive a recorded SHA-256 digest. Completed downloads are activated when a configured managed worker can see the files; otherwise activate them after setting up generation. For gated models, accept the model license and save a Hugging Face token in **Settings → Integrations**. A saved token takes precedence over the legacy `HF_TOKEN` environment variable. Authorization is sent only to `huggingface.co`, never its redirected storage hosts.

## Upscaling

`GET /api/upscalers` lists installed upscalers, worker readiness, supported scales and the maximum output dimension. `POST /api/upscale` accepts an owner session or bearer token and requires an `Idempotency-Key`. For example:

```json
{
  "operation": "upscale",
  "modelId": "nomos2-hq",
  "source": { "type": "output", "jobId": "<source-job-uuid>", "outputId": "<source-output-id>" },
  "scale": 2
}
```

For an imported image, use `"source": { "type": "input", "inputId": "<input-uuid>" }`. Sources must belong to the authenticated account; URLs and filesystem paths are not accepted. Supported model IDs are `nomos2-hq`, `seedvr2-3b` and `seedvr2-7b`. Scale is 2 or 4, with a maximum output of 4096 pixels per side. An optional nonnegative integer `seed` defaults to 42 for reproducible SeedVR2 restoration.

Submission returns HTTP 202 with `{ job }`. Read `/api/jobs/:id`, cancel queued work and retrieve private outputs using the existing job endpoints. Upscale jobs have `input.operation: "upscale"` and report source dimensions, output dimensions and scale in `parameters`. They preserve source images and save results separately. An active job prevents deletion of its source. Identical retries return the same job, including after restart; reusing a key with a different request returns HTTP 409.

MCP exposes `gravity_upscalers_list` and `gravity_upscale_submit` (arguments `{ request, idempotencyKey }`). Upscaler downloads use the session-only model library endpoints and become usable automatically on compatible workers after all files are present. Upscalers are utility models and do not appear in the generation catalog.

## Integrations

These endpoints require the owner's browser session. Mutations and access checks require an allowed `Origin`. Responses use `Cache-Control: private, no-store`; no operation returns a saved secret. Keys must contain 8–4096 visible ASCII characters without internal whitespace; surrounding whitespace is trimmed.

| Method | Path | Request or result |
| --- | --- | --- |
| GET | `/api/integrations` | `{ providers: [{ id, name, description, credential }] }` |
| PUT | `/api/integrations/:provider` | Save or replace with `{ "apiKey": "..." }`; returns safe provider metadata |
| DELETE | `/api/integrations/:provider` | Remove the saved key; returns provider metadata with `credential: null` |
| POST | `/api/integrations/:provider/test` | Send `{}` to check the saved key; returns `{ ok: true, message }` |

Provider IDs are `huggingface`, `civitai`, `gemini`, `openai`, `anthropic` and `nanogpt`. `credential` is either `null` or `{ suffix, updatedAt }`; `suffix` contains only the last four characters. Saving does not automatically contact a provider. Checks use fixed HTTPS endpoints, reject redirects, have a timeout and never relay upstream response bodies or secrets. A failed check preserves the saved key. One check per provider may run at a time; replacing or deleting a key during a check invalidates its result.

Checks use authenticated read operations: Hugging Face account identity, Civitai account identity, Gemini / OpenAI / Anthropic model listing and NanoGPT usage. They do not generate content or verify billing, model licenses or access to every model. Hugging Face downloads and the Gemini prompt assistant use their saved keys.

Provider references: [Hugging Face account identity](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api#huggingface_hub.HfApi.whoami), [Civitai authentication](https://github.com/civitai/civitai-developer-docs/blob/main/site/guide/authentication.md), [Gemini models](https://ai.google.dev/api/models), [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list), [Anthropic models](https://platform.claude.com/docs/en/api/models/list), [NanoGPT usage](https://docs.nano-gpt.com/api-reference/endpoint/usage).

See [integration key storage](../../README.md#integration-keys) for master key configuration, backups and the limits of encryption.

## Text models and prompt refinement

These operations require the owner's browser session, with an allowed `Origin` for mutations and refinement. Existing bearer tokens and MCP clients cannot invoke them. No request accepts an arbitrary upstream address: the owner configures the connection separately.

| Method | Path | Request or result |
| --- | --- | --- |
| GET | `/api/text/settings` | `{ revision, connection: { baseUrl, credential }, assistant }`; secrets are never returned |
| PUT | `/api/text/connection` | `{ revision, baseUrl, apiKey? }`; omitted key preserves it for the same URL, `null` removes it |
| GET | `/api/text/models?provider=gemini` | `{ provider, models: [{ id, name, inputTokenLimit?, outputTokenLimit? }] }`; also accepts `openai-compatible` and `local` |
| PUT | `/api/text/assistant` | `{ revision, provider, modelId }`; set both provider and model ID to `null` to disable |
| POST | `/api/prompts/refine` | `{ settingsRevision, imageModelId, prompt, instruction? }`; returns `{ prompt, originalPrompt, provider, modelId, usage? }` |
| GET | `/api/text/local` | MiMo installation, runtime, download progress and GPU selection |
| POST | `/api/text/local` | Prepare `{ "modelId": "mimo-v2.6-distill-qwen-9b" }` in the background; returns HTTP 202 |
| PUT | `/api/text/local` | `{ revision, gpuIds }`; an empty list follows enabled local Studio GPUs |
| POST | `/api/text/local/unload` | `{}` unloads an idle local model; active requests return HTTP 409 |

Settings use optimistic revisions; stale writes or refinements return HTTP 409. Choosing a model validates it against that connection's catalog. Discovery is cached for up to 60 seconds; `refresh=true` explicitly checks the provider again. Changing the compatible endpoint's URL clears its selected assistant and previous key. Compatible keys are stored separately from the named OpenAI integration.

Refinement accepts up to 16,000 prompt characters and 2,000 instruction characters. At least one must contain text. Each model's context limit applies separately. Requests use the image family's instructions, return validated JSON and preserve quoted passages and image markers. Reference image files are never sent. One refinement may run at a time, with a 45-second deadline for external providers and 180 seconds for local cold loading plus inference. Browser disconnects abort the upstream request. Incomplete output, malformed JSON and provider failures leave the original prompt unchanged; failed generation requests are not automatically retried.

Use provider `local` with `mimo-v2.6-distill-qwen-9b` after preparation. Model listing does not load weights onto a GPU. Its 8,192-token context reserves 2,048 output tokens and template overhead; input checking is deliberately conservative. The runtime keeps resident weights across requests, shares memory budgets with image workers, and unloads idle weights under pressure or after the configured idle interval. A container left by a crash is stopped during startup before image scheduling resumes. Automatic GPU selection respects disabled image workers; only a host without configured local image workers falls back to all supported GPUs.

This operation proposes text only: it does not submit an image job. The browser applies the proposal only if its draft still matches, provides Undo and uses the resulting prompt for a separate image submission. These endpoints are not an incoming OpenAI-compatible chat API.

## MCP

Configure a Streamable HTTP client with the studio URL ending in `/api/mcp` and an `Authorization: Bearer` header. The endpoint accepts POST requests and authenticates every exchange; it does not require a persistent MCP session. Clients must accept JSON and SSE responses as defined by the transport.

The tools are `gravity_models_list`, `gravity_jobs_list`, `gravity_job_get`, `gravity_job_submit`, `gravity_job_cancel` and `gravity_inputs_list`. Submission takes `request` and `idempotencyKey`; reading/cancelling a job takes `jobId`. Image uploads use the REST endpoint.

Administrative operations such as changing workers, replacing model files, and creating or revoking tokens are restricted to the owner's browser session. Browser mutations require an allowed Origin. Bearer clients can omit Origin; if provided, it must still match `GRAVITY_ALLOWED_ORIGINS`.
