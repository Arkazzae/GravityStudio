# Gravity Studio

A self-hosted image studio for your GPU server. Write a prompt, add reference images, and keep generations in a private gallery. A shared ComfyUI runtime serves multiple model families; adding a checkpoint does not create another container.

**Development preview.** The application, queue, protocol integration and setup flow have automated tests. The managed ROCm runtime has completed real image generations on one dual Radeon AI PRO R9700 host. NVIDIA hardware and other AMD configurations remain unverified; see [runtime validation](deploy/comfyui/README.md#hardware-validation) for the tested scope.

## What is included

- The Image workspace: model and aspect ratio selection, advanced sampling settings, reference images, generation queue and persistent gallery.
- Family recipes for SDXL / Illustrious, FLUX.2 Klein and Krea 2. The initial catalog includes SDXL Base, WAI Illustrious v17, Klein 4B and Krea 2 Turbo.
- AMD and NVIDIA detection, a setup wizard, individual GPU assignments and configurable RAM / VRAM reserves.
- Durable SQLite jobs, retry protection and recovery after a server restart or lost ComfyUI connection.
- Owner login, revocable API tokens, a REST API and an MCP endpoint.

This first version focuses on image generation. LLM serving, video, audio, training and an OpenAI-compatible API are outside this release.

## Start the studio

Use Node.js **24.13 or newer** and **pnpm 10.32.1**. Run the application directly on the GPU host to detect all local devices.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
pnpm start
```

Open **http://127.0.0.1:4321**. Create the owner account using the key in `storage/setup.key`. The key is generated on first startup and is never sent to the browser automatically.

For development, use `pnpm dev` instead of the build/start commands. The web application and API run as two processes; neither needs its own container. Stop both with Ctrl+C.

### Connect ComfyUI

You can connect an existing ComfyUI installation in **Hardware & setup**, or prepare managed workers on Linux x86_64:

```sh
pnpm doctor
pnpm runtime plan --engine docker
pnpm runtime up --engine docker
```

`plan` checks prerequisites and shows device assignments. `up` downloads and builds the pinned runtime images, starts workers and runs GPU smoke tests. Use `--engine podman` for Podman. These commands do not download model weights.

The installer builds one shared image per backend, CUDA or ROCm, and starts one worker per selected GPU. All workers read `storage/models/`. Their endpoints start at `http://127.0.0.1:8188`; the command prints the exact GPU-to-port mapping. Add those endpoints in the wizard, select the matching physical GPU, test the connection, and enable the models whose files are installed.

See [runtime installation](deploy/comfyui/README.md) for device permissions, selecting GPUs, verification and stopping workers. See [model files and recipes](packages/inference/README.md) for the required weights and their sources.

### Different hardware

Each GPU has its own memory budget. Three 24 GiB cards remain three separate devices; the scheduler does not treat them as a 72 GiB GPU. Multiple independent jobs can run concurrently when the configured concurrency limit and host RAM allow it. Set these limits in Hardware & setup.

Model memory budgets start as editable estimates. A successful connection confirms the ComfyUI API and required files/nodes; it does not certify model speed, image quality or fit on a particular card. The runtime smoke test separately checks actual GPU execution. GPU fixtures cover dual R9700, triple RTX 3090, B100 and mixed-vendor configurations.

External workers are supported. Their reported memory is checked before admission. Workers without reliable GPU identity on the same remote hostname are serialized. Use a consistent hostname for workers on the same machine so host RAM is accounted together.

## API and MCP

Create a token under **Hardware & setup → API access**. Use it as an `Authorization: Bearer` header. Tokens can generate and read images; server configuration requires an owner browser session.

The MCP endpoint is **`http://127.0.0.1:4321/api/mcp`**, using Streamable HTTP. It exposes model listing, image submission, job status, queued-job cancellation and reference image listing. Each submission needs an idempotency key. Disconnecting a client does not cancel its generation.

See [API usage](apps/server/README.md) for requests and response behavior.

## Data and deployment

`storage/` contains the database, owner credentials, session/token hashes, private inputs and outputs, and managed worker state. Model weights live in `storage/models/`. These directories and `.env` are excluded from Git. Back up the entire data directory while the studio is stopped; keep model weights separately if preferred.

Both application processes bind to localhost by default. For access from other machines, put the web application behind your HTTPS reverse proxy and set `GRAVITY_ALLOWED_ORIGINS` to its exact origin. `GRAVITY_STUDIO_HOST` controls the web bind address. Keep the API and ComfyUI worker ports private. The application does not mount a Docker socket or install custom nodes from the web interface.

## Development checks

```sh
pnpm check
pnpm build
pnpm test:browser
```

The browser test uses a local Chrome/Chromium executable (`CHROME_BIN` can override its location), a temporary database and the real application/API. ComfyUI is a protocol fixture; no model inference occurs. Screenshots and temporary development artifacts stay outside version control.

Keep contributions focused and independently reviewable. A compatible fine-tune normally adds a model manifest; a new architecture adds a family recipe and capability checks. Host paths and physical GPU IDs belong in local settings.
