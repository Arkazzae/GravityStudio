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
| POST | `/api/mcp` | MCP tool requests over Streamable HTTP |

Uploads accept an optional `X-Filename` header, percent-encoded for non-ASCII names. The upload response contains the input `id` directly. Pass those IDs in the generation request's `images` array. The catalog describes which models accept references. Dimensions, steps, guidance, seed, negative prompt and denoise are validated by the selected family recipe.

Jobs retain the accepted recipe, model filenames, parameters and placement budget. A worker disconnect can produce `interrupted`: the server keeps looking for that existing generation and does not submit it again automatically. Running or interrupted jobs cannot be cancelled through this version of the API.

If the worker has lost the generation after a restart, the owner can choose **Close unknown job** in the queue or Activity panel. After explicit acknowledgement, the server checks the original worker's queue and history again. Only an absent job still marked `interrupted` is closed as `failed`, with an explanation retained in its record, releasing its resource reservation. A reported job resumes recovery; an unreachable worker keeps its reservation. Closing never resubmits the generation, and a result that appears later will not be recovered automatically.

This administrative action is `POST /api/jobs/:id/resolve` with `{ "acknowledge": true }`. It requires the owner's browser session and an allowed Origin; bearer tokens and MCP tools cannot perform it.

Progress messages can describe a single sampler node. They are not an overall completion percentage.

## Runtime setup and model library

The studio interface uses these administrative endpoints. All require the owner's browser session; mutations also require an allowed `Origin`. Bearer tokens and MCP clients cannot install runtimes or download models.

| Method | Path | Request or result |
| --- | --- | --- |
| GET | `/api/runtime` | Setup phase, selected worker count and errors |
| POST | `/api/runtime` | Start setup with `{ "gpuIds": ["detected-device-id"] }`; returns HTTP 202 |
| GET | `/api/models/library` | Catalog, imported checkpoints and current download progress |
| POST | `/api/models/download` | Download `{ "modelId": "sdxl-base" }`, or import `{ "url": "https://huggingface.co/owner/repository/resolve/main/model.safetensors", "name": "My checkpoint", "familyId": "sdxl" }`; returns HTTP 202 |
| POST | `/api/models/activate` | Verify and activate installed files with `{ "modelId": "sdxl-base" }` |

Setup detects the available container engine, preserves existing worker assignments and ports, adds newly selected GPUs, tests them and saves the selected workers in studio settings. Generations and configuration changes are blocked while setup is running. Poll `GET /api/runtime` until `busy` is false.

Downloads run on the server and continue when the browser page closes. The library accepts Hugging Face safetensors files, checks sizes and file structure, and verifies catalog checksums when available. Imports currently support complete SDXL / Illustrious checkpoints; other families use their catalog's complete artifact set. Imported files receive a recorded SHA-256 digest. Completed downloads are activated when a configured managed worker can see the files; otherwise activate them after setting up generation. For gated models, accept the model license and save a Hugging Face token in **Settings → Integrations**. A saved token takes precedence over the legacy `HF_TOKEN` environment variable. Authorization is sent only to `huggingface.co`, never its redirected storage hosts.

## Integrations

These endpoints require the owner's browser session. Mutations and access checks require an allowed `Origin`. Responses use `Cache-Control: private, no-store`; no operation returns a saved secret. Keys must contain 8–4096 visible ASCII characters without internal whitespace; surrounding whitespace is trimmed.

| Method | Path | Request or result |
| --- | --- | --- |
| GET | `/api/integrations` | `{ providers: [{ id, name, description, credential }] }` |
| PUT | `/api/integrations/:provider` | Save or replace with `{ "apiKey": "..." }`; returns safe provider metadata |
| DELETE | `/api/integrations/:provider` | Remove the saved key; returns provider metadata with `credential: null` |
| POST | `/api/integrations/:provider/test` | Send `{}` to check the saved key; returns `{ ok: true, message }` |

Provider IDs are `huggingface`, `civitai`, `gemini`, `openai`, `anthropic` and `nanogpt`. `credential` is either `null` or `{ suffix, updatedAt }`; `suffix` contains only the last four characters. Saving does not automatically contact a provider. Checks use fixed HTTPS endpoints, reject redirects, have a timeout and never relay upstream response bodies or secrets. A failed check preserves the saved key. One check per provider may run at a time; replacing or deleting a key during a check invalidates its result.

Checks use authenticated read operations: Hugging Face account identity, Civitai account identity, Gemini / OpenAI / Anthropic model listing and NanoGPT usage. They do not generate content or verify billing, model licenses or access to every model. Hugging Face downloads use the saved key; cloud inference is not part of this release.

Provider references: [Hugging Face account identity](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api#huggingface_hub.HfApi.whoami), [Civitai authentication](https://github.com/civitai/civitai-developer-docs/blob/main/site/guide/authentication.md), [Gemini models](https://ai.google.dev/api/models), [OpenAI models](https://developers.openai.com/api/reference/resources/models/methods/list), [Anthropic models](https://platform.claude.com/docs/en/api/models/list), [NanoGPT usage](https://docs.nano-gpt.com/api-reference/endpoint/usage).

See [integration key storage](../../README.md#integration-keys) for master key configuration, backups and the limits of encryption.

## MCP

Configure a Streamable HTTP client with the studio URL ending in `/api/mcp` and an `Authorization: Bearer` header. The endpoint accepts POST requests and authenticates every exchange; it does not require a persistent MCP session. Clients must accept JSON and SSE responses as defined by the transport.

The tools are `gravity_models_list`, `gravity_jobs_list`, `gravity_job_get`, `gravity_job_submit`, `gravity_job_cancel` and `gravity_inputs_list`. Submission takes `request` and `idempotencyKey`; reading/cancelling a job takes `jobId`. Image uploads use the REST endpoint.

Administrative operations such as changing workers, replacing model files, and creating or revoking tokens are restricted to the owner's browser session. Browser mutations require an allowed Origin. Bearer clients can omit Origin; if provided, it must still match `GRAVITY_ALLOWED_ORIGINS`.
