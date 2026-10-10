# Studio API

The web application proxies `/api/*` and `/v1/*` to the API process. Use the public Studio origin, normally `http://127.0.0.1:4321`, for both clients and the browser. Requests require an account session or a scoped bearer token created in **Settings → API access**. Runtime configuration, downloads and provider credentials require an administrator's browser session.

The examples below use `GRAVITY_TOKEN` from your environment. Tokens are displayed once when created; the server stores only their hashes.

## Authentication and permissions

Use `Authorization: Bearer $GRAVITY_TOKEN`. Token creation and revocation require the account's browser session. Choose an expiration of 7, 30, 90 or 365 days, or no expiration; 90 days is the default. Permissions are enforced on REST, OpenAI-compatible and MCP requests, independently of the account's role. Existing tokens retain their image permissions and receive no new language-model permission automatically.

| Scope | Access |
| --- | --- |
| `models:read` | Catalog, capabilities, adapters and model discovery |
| `jobs:read` | Own generation history, settings and progress |
| `jobs:write` | Generate, edit, upscale and remove backgrounds |
| `jobs:cancel` | Cancel own queued jobs |
| `assets:read` | Own references, output metadata and downloads |
| `assets:write` | Upload or reuse references and set favorites |
| `assets:delete` | Permanently delete own images |
| `text:generate` | Chat and prompt refinement through configured language providers |
| `system:read` | Resource status and own server-time allowance |

OpenAI image generation requires `jobs:write` and `assets:read`; edits also require `assets:write`. Native generation using references or a mask, upscaling and background removal also require `assets:read`. Add `jobs:read` to poll durable jobs and `models:read` to discover models. `text:generate` can use external providers configured by the administrator, so grant it deliberately. Tokens cannot change upstream URLs, access provider secrets or administer Studio. `GET /api/access` requires `models:read` and describes the current connection's permissions and available models.

Bearer clients can omit `Origin`; if supplied, it must match `GRAVITY_ALLOWED_ORIGINS`. Browser mutations require an allowed Origin. Use HTTPS for remote connections. MCP uses the same personal tokens; OAuth discovery, OAuth consent and a bundled stdio transport are not implemented.

## Native image API

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

### Operations

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/catalog` | Models, family capabilities, parameters and availability |
| GET | `/api/generation-tools?modelId=...` | Compatible LoRAs and adapters with worker readiness |
| GET | `/api/jobs` | Recent generations belonging to the account |
| POST | `/api/jobs` | Accept a generation with `Idempotency-Key` |
| GET | `/api/jobs/:id` | Job status and saved outputs |
| POST | `/api/jobs/:id/cancel` | Cancel a queued job; send `{}` |
| GET | `/api/inputs` | Uploaded reference images |
| POST | `/api/inputs/from-output` | Reuse `{ jobId, outputId }` as a reference without adding duplicate assets |
| POST | `/api/inputs` | Upload raw PNG/JPEG/WebP bytes, up to 20 MiB |
| GET | `/api/inputs/:id` | Read a private reference image |
| DELETE | `/api/inputs/:id` | Delete an imported image; active or interrupted generations using it return `409 INPUT_IN_USE` |
| GET | `/api/favorites` | Own favorite generated images |
| PUT | `/api/jobs/:id/outputs/:outputId/favorite` | Set `{ "favorite": true }` or `false` |
| DELETE | `/api/jobs/:id/outputs/:outputId` | Delete one output while preserving job history |
| GET, POST | `/api/background-removal` | BiRefNet readiness, or submit `{ "source": ... }` with an idempotency key |
| POST | `/api/mcp` | MCP tool requests over Streamable HTTP |

Uploads accept an optional `X-Filename` header, percent-encoded for non-ASCII names. The upload response contains the input `id` directly. Pass those IDs in the generation request's `images` array. The catalog describes which models accept references. The selected recipe validates dimensions, sampling, reference counts and available editing tools. Native requests also accept `maskId` (white edits, black preserves), `outpaint: { left, right, top, bottom }`, `matchSource`, `refiner`, `referenceStrength` and up to four `loras: [{ id, strength }]` when supported. Masks must match the first reference; masks and outpainting are mutually exclusive.

Each catalog model includes family `qualityPresets`: `fast`, `standard` and `high`, with a pixel budget, optional minimum side and sampling profile. Submit `quality` to apply that profile; supplied width/height establish the aspect ratio, then the recipe fits its pixel budget and grid. Explicit `steps` and `cfg` override profile sampling. Omit quality to request explicit dimensions within the family limits. `ultra` uses High followed by SeedVR2 7B to a 4096-pixel longest edge and requires the installed upscaler. Source-matched edits and masks retain their source canvas before an optional Ultra finish.

Jobs retain the accepted recipe, model filenames, parameters and placement budget. A worker disconnect can produce `interrupted`: the server keeps looking for that existing generation and does not submit it again automatically. Running or interrupted jobs cannot be cancelled through this version of the API.

If the worker has lost the generation after a restart, the owner can choose **Close unknown job** in the queue or Activity panel. After explicit acknowledgement, the server checks the original worker's queue and history again. Only an absent job still marked `interrupted` is closed as `failed`, with an explanation retained in its record, releasing its resource reservation. A reported job resumes recovery; an unreachable worker keeps its reservation. Closing never resubmits the generation, and a result that appears later will not be recovered automatically.

This recovery action is `POST /api/jobs/:id/resolve` with `{ "acknowledge": true }`. It requires the job owner's browser session and an allowed Origin; bearer tokens and MCP tools cannot perform it.

Progress messages can describe a single sampler node. They are not an overall completion percentage.

## OpenAI-compatible gateway

Set the client's base URL to `https://YOUR_STUDIO/v1` and its API key to the Studio token. `/api/v1` is an alias. Choose IDs returned by `/v1/models`: image IDs such as `sdxl-base`, language IDs such as `text/local/mimo-v2.6-distill-qwen-9b`, or `studio-assistant` for the configured prompt assistant. Catalog entries include `type`; image entries also expose `ready` and capabilities.

| Method | Path relative to `/v1` | Supported behavior |
| --- | --- | --- |
| GET | `/models`, `/models/:id` | Image and configured language models |
| POST | `/chat/completions` | Text messages, optional SSE streaming, function calls and structured output when supported upstream |
| POST | `/images/generations` | Prompt to image, `n` from 1 to 10 |
| POST | `/images/edits` | Multipart images/mask or JSON references |
| GET, POST | `/files` | List references or upload an image with `purpose=vision` |
| GET, DELETE | `/files/:id` | Read reference metadata or delete an owned reference |
| GET | `/files/:id/content` | Download an owned reference |

This is a supported subset of the OpenAI API. Responses, embeddings, audio, video, image variations and image streaming are not provided. Unsupported parameters are rejected. Chat accepts text and text content parts, including function-call conversations, with one completion per request. Tool execution remains the client's responsibility. Function tools, JSON/schema output and reasoning options depend on the selected upstream model. The Studio gateway does not store chat conversations or retry them automatically; disconnecting aborts the provider request. Local chat uses the shared GPU reservations and work-time allowance.

The Python SDK can use the [Chat Completions interface](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create) against Studio:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["GRAVITY_BASE_URL"],  # e.g. http://127.0.0.1:4321/v1
    api_key=os.environ["GRAVITY_TOKEN"],
    max_retries=0,
    timeout=200.0,
)

stream = client.chat.completions.create(
    model="studio-assistant",
    messages=[{"role": "user", "content": "Describe a quiet seaside scene."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")
```

Use an installed image model to generate an image:

```sh
curl http://127.0.0.1:4321/v1/images/generations \
  -H "Authorization: Bearer $GRAVITY_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: mountain-openai-001' \
  -d '{"model":"sdxl-base","prompt":"A mountain lake at dawn","size":"1024x1024","response_format":"b64_json"}'
```

The default result is `{ "created": ..., "data": [{ "b64_json": ... }], "output_format": "png" }`. Output formats are PNG, JPEG and WebP; JPEG/WebP accept `output_compression` from 0 to 100. `background` accepts `auto`, `opaque` or `transparent`, subject to model/tool readiness; JPEG cannot preserve transparency. `quality` maps `low`/`medium`/`high` to Studio Fast/Standard/High, and also accepts `fast`, `standard`, `high`, `ultra` and `auto`. Explicit quality uses the family pixel budget and sampling profile, with `size` selecting aspect ratio. Omit quality, or use `auto`, to use explicit native dimensions. Additional native controls go in `studio`, for example `"studio": { "seed": 1234, "steps": 20, "loras": [{ "id": "my-lora", "strength": 0.7 }] }`.

### Reference files and masks

Upload a reusable reference as multipart `file=@reference.png` with `purpose=vision` to `/v1/files`; its returned ID is also a native Studio input ID. PNG/JPEG/WebP inputs are limited to 20 MiB. Edits accept files under `image` or repeated `image[]`, or JSON `"images": [{ "file_id": "INPUT_UUID" }]`. JSON references can instead contain `image_url` with a base64 data URL; remote URLs are not fetched. Family reference limits still apply.

```sh
curl http://127.0.0.1:4321/v1/images/edits \
  -H "Authorization: Bearer $GRAVITY_TOKEN" \
  -H 'Idempotency-Key: twilight-edit-001' \
  -F 'model=sdxl-base' \
  -F 'image=@reference.png' \
  -F 'prompt=Keep the composition and turn morning into twilight' \
  -F 'size=1024x1024'
```

For a mask, add `-F 'mask=@mask.png'`. OpenAI masks require an alpha channel and the same dimensions as the first reference: transparent pixels select what to edit. Studio converts this to its native white-edit mask convention. JSON masks accept the same `file_id` or base64 `image_url` form as references. Uploading a source once and reusing its ID avoids duplicate assets. `POST /api/inputs/from-output` also returns the existing reference for a previously selected output.

### Durable image responses and private links

Supply an `Idempotency-Key` before starting image generation, editing or a file upload. Keys contain 8–128 letters, digits, dots, underscores, colons or dashes. Repeating the same request returns the original job or upload; changing any request settings under that key returns HTTP 409. Without a supplied key, image generation creates a new key and returns it in `Idempotency-Key`.

Image calls normally wait up to 180 seconds. Send `Prefer: respond-async` to receive HTTP 202 with `jobs` and an empty `data` array immediately. `X-Gravity-Job-Ids` lists accepted IDs and `Location` points to the first `/api/jobs/:id`. A timeout returns `IMAGE_JOB_PENDING` with `error.job_ids`; accepted work continues. Poll those IDs or repeat the identical request with the original key. Failed/interrupted jobs return their IDs and are never regenerated implicitly. A multi-image request may be partially accepted if a later item fails; inspect the returned IDs before creating more work.

`response_format: "url"` returns links valid for 15 minutes. These are opaque bearer links whose hashes are stored on the server; possessing the link authorizes that download without an additional header. The link stops working if its account is disabled or its output is deleted. Ordinary job and MCP media URLs remain authenticated. Configure `GRAVITY_ALLOWED_ORIGINS` with the public Studio origin so generated links use a reachable address. Image bytes and links use private, no-store responses.

## Account profile

`GET /api/account` returns `{ revision, displayName, workspaceName, avatarTheme }`. `PUT /api/account` accepts exactly those four fields and returns the saved profile with an incremented revision. Both require the account's browser session; writes also require an allowed `Origin`. Bearer tokens and MCP clients cannot access the profile.

Names are trimmed and must contain 1–64 characters without control characters. Avatar themes are `studio`, `lime`, `mint`, `blue`, `violet` and `rose`. A stale revision returns `409 ACCOUNT_CHANGED`; reload the current profile before saving again. The profile is stored per account in SQLite. It changes presentation only: the login username and media ownership stay the same, and a workspace name does not create a separate workspace.

## Runtime setup and model library

The studio interface uses these administrative endpoints. All require an administrator's browser session; mutations also require an allowed `Origin`. Bearer tokens and MCP clients cannot install runtimes or download models.

| Method | Path | Request or result |
| --- | --- | --- |
| GET | `/api/runtime` | Setup phase, selected worker count and errors |
| POST | `/api/runtime` | Start setup with `{ "gpuIds": ["detected-device-id"] }`; returns HTTP 202 |
| POST | `/api/workers/:id/unload` | Send `{}` to request an idle image worker's cache release; returns `{ "requested": true }` |
| GET | `/api/models/library` | Catalog, checkpoint presets, imported checkpoints and current download progress |
| POST | `/api/models/download` | Download `{ "modelId": "sdxl-base" }`, or import compatible weights with `{ "presetId": "flux-2-klein-4b", "url": "https://huggingface.co/owner/repository/resolve/main/model.safetensors", "name": "My checkpoint" }`; returns HTTP 202 |
| POST | `/api/models/activate` | Verify and activate installed files with `{ "modelId": "sdxl-base" }` |

Setup detects the available container engine, preserves existing worker assignments and ports, adds newly selected GPUs, tests them and saves the selected workers in studio settings. Generations and configuration changes are blocked while setup is running. Poll `GET /api/runtime` until `busy` is false.

Worker cache release is coordinated with scheduling. Busy workers, interrupted generations that retain a reservation, and overlapping releases are rejected. The request covers that worker's cached models, not a particular checkpoint, and leaves files on disk. Acceptance does not mean unloading has finished: use the measured VRAM in `GET /api/state` to observe memory changes. Its worker entries include `canRelease` for the activity panel; the server checks again when an unload is requested.

Downloads run on the server and continue when the browser page closes. Checkpoint imports accept Hugging Face `.safetensors` links with a reviewed `presetId`. Optional `dependencies: [{ "role": "text-encoder", "url": "https://huggingface.co/owner/repository/resolve/main/encoder.safetensors" }]` replaces only existing dependency roles; unspecified files retain their pinned preset sources and hashes. Optional `operations` narrows the preset's operations, and `defaults` overrides validated sampling settings. Pass the same complete import body to `/api/models/access` to check every effective source. Legacy `{ url, name, familyId: "sdxl" }` imports remain supported.

The library checks sizes, safetensors structure and catalog checksums. Imported files receive recorded SHA-256 digests, and the final revision covers the whole package. Completed downloads are activated when a configured managed worker can see all required files; otherwise activate them after setting up generation. File validation does not prove architecture compatibility. For gated models, accept the model license and save a Hugging Face token in **Settings → Integrations**. A saved token takes precedence over the legacy `HF_TOKEN` environment variable. Authorization is sent only to `huggingface.co`, never its redirected storage hosts.

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

These endpoints require an administrator's browser session. Mutations and access checks require an allowed `Origin`. Responses use `Cache-Control: private, no-store`; no operation returns a saved secret. Keys must contain 8–4096 visible ASCII characters without internal whitespace; surrounding whitespace is trimmed.

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

Connection changes, model discovery through `/api/text/models` and local runtime management require an administrator's browser session. Signed-in users can read their safe assistant settings and local readiness. Refinement also accepts tokens with `text:generate`; bearer requests can omit `settingsRevision` to use the current selection, and MCP `gravity_prompt_refine` fills it automatically. Browser refinement retains the explicit revision check. No generation request accepts an arbitrary upstream address: an administrator configures the connection separately.

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

```sh
curl http://127.0.0.1:4321/api/prompts/refine \
  -H "Authorization: Bearer $GRAVITY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"imageModelId":"sdxl-base","prompt":"A mountain lake","instruction":"Add warm dawn light"}'
```

Settings use optimistic revisions; stale writes or refinements return HTTP 409. Choosing a model validates it against that connection's catalog. Discovery is cached for up to 60 seconds; `refresh=true` explicitly checks the provider again. Changing the compatible endpoint's URL clears its selected assistant and previous key. Compatible keys are stored separately from the named OpenAI integration.

Refinement accepts up to 16,000 prompt characters and 2,000 instruction characters. At least one must contain text. Each model's context limit applies separately. Requests use the image family's instructions, return validated JSON and preserve quoted passages and image markers. Reference image files are never sent. One refinement may run at a time, with a 45-second deadline for external providers and 180 seconds for local cold loading plus inference. Browser disconnects abort the upstream request. Incomplete output, malformed JSON and provider failures leave the original prompt unchanged; failed generation requests are not automatically retried.

Use provider `local` with `mimo-v2.6-distill-qwen-9b` after preparation. Model listing does not load weights onto a GPU. Its 8,192-token context reserves 2,048 output tokens and template overhead; input checking is deliberately conservative. The runtime keeps resident weights across requests, shares memory budgets with image workers, and unloads idle weights under pressure or after the configured idle interval. A container left by a crash is stopped during startup before image scheduling resumes. Automatic GPU selection respects disabled image workers; only a host without configured local image workers falls back to all supported GPUs.

This operation proposes text only: it does not submit an image job. The browser applies the proposal only if its draft still matches, provides Undo and uses the resulting prompt for a separate image submission. For general incoming conversations, use `/v1/chat/completions` as described above.

## MCP

Configure a Streamable HTTP client with `https://YOUR_STUDIO/api/mcp` and `Authorization: Bearer <Studio token>`. `/api/v1/mcp` and `/v1/mcp` are aliases. Requests use POST, with JSON/SSE response support and no persistent MCP session. The server uses the official SDK and supports the legacy `2025-11-25` and current `2026-07-28` protocol forms. Modern clients must send the required MCP method/name transport headers; use the client SDK rather than inventing a JSON-RPC transport.

The connection can expose 27 tools. `tools/list` and resource templates are filtered by its permissions, with access checked again when a tool executes.

| Area | Tools |
| --- | --- |
| Discovery | `gravity_capabilities_get`, `gravity_models_list`, `gravity_model_get`, `gravity_generation_tools_list`, `gravity_upscalers_list`, `gravity_background_removal_status` |
| Generation | `gravity_job_submit`, `gravity_upscale_submit`, `gravity_background_remove` |
| Jobs | `gravity_jobs_list`, `gravity_job_get`, `gravity_job_wait`, `gravity_job_cancel` |
| References | `gravity_inputs_list`, `gravity_input_upload`, `gravity_input_from_output`, `gravity_input_delete` |
| Outputs | `gravity_outputs_list`, `gravity_output_get`, `gravity_favorites_list`, `gravity_output_set_favorite`, `gravity_output_delete` |
| Language | `gravity_text_models_list`, `gravity_text_chat`, `gravity_prompt_refine` |
| Status | `gravity_system_get`, `gravity_work_time_get` |

Generation submission takes `{ request, idempotencyKey }`; `gravity_background_remove` takes `{ source, idempotencyKey }`. `gravity_input_upload` accepts `{ name, mimeType, data, idempotencyKey }`, where `data` is base64 without a data-URL prefix, limited to 2 MiB decoded. Use REST or `/v1/files` for larger images. Retrying an upload preserves its original input ID. Native masks, canvas extension, LoRAs, reference strength, refiner and quality profiles use the same family checks as the UI.

`gravity_job_wait` waits at most 20 seconds and reports `timedOut`; another wait reads the same job. MCP chat returns the complete nonstreamed result, while `/v1/chat/completions` supports token streaming. Prompt refinement returns text without editing browser drafts or starting image generation. Both language tools use configured local or external providers and require `text:generate`.

Resource templates are `gravity://models/{modelId}`, `gravity://jobs/{jobId}` and `gravity://jobs/{jobId}/outputs/{outputId}`. They return JSON metadata; large image bytes are downloaded separately. Tool results contain equivalent JSON text and `structuredContent.data`; operation failures use `isError: true` with an error code. System status excludes private worker addresses, device identifiers and other users' jobs.

Runtime changes, model installation, credentials, account administration and token management are not exposed as MCP tools. This endpoint provides bearer-token authentication, not OAuth login, local filesystem tools or a bundled stdio launcher.
