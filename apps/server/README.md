# Studio API

The web application proxies `/api/*` to the API process. All image, model and job operations require an owner session or a bearer token created in **Hardware & setup → API access**.

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

## MCP

Configure a Streamable HTTP client with the studio URL ending in `/api/mcp` and an `Authorization: Bearer` header. The endpoint accepts POST requests and authenticates every exchange; it does not require a persistent MCP session. Clients must accept JSON and SSE responses as defined by the transport.

The tools are `gravity_models_list`, `gravity_jobs_list`, `gravity_job_get`, `gravity_job_submit`, `gravity_job_cancel` and `gravity_inputs_list`. Submission takes `request` and `idempotencyKey`; reading/cancelling a job takes `jobId`. Image uploads use the REST endpoint.

Administrative operations such as changing workers, replacing model files, and creating or revoking tokens are restricted to the owner's browser session. Browser mutations require an allowed Origin. Bearer clients can omit Origin; if provided, it must still match `GRAVITY_ALLOWED_ORIGINS`.
