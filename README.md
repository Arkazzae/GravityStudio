# Gravity Studio

A self-hosted image studio for your GPU server. Write a prompt, add reference images, and keep generations in a private gallery. A shared ComfyUI runtime serves multiple model families; adding a checkpoint does not create another container.

**Development preview.** The application, queue, protocol integration and setup flow have automated tests. The managed ROCm runtime has completed real image generations on one dual Radeon AI PRO R9700 host. NVIDIA hardware and other AMD configurations remain unverified; see [runtime validation](deploy/comfyui/README.md#hardware-validation) for the tested scope.

## What is included

- The Image workspace: model and aspect ratio selection, advanced sampling settings, reference images, generation queue and persistent gallery.
- Family recipes for SDXL / Illustrious, FLUX.2 Klein and Krea 2. The initial catalog includes SDXL Base, WAI Illustrious v17, Klein 4B and Krea 2 Turbo.
- AMD and NVIDIA detection, GPU selection with automatic runtime setup, and configurable RAM / VRAM reserves.
- A model library with Hugging Face downloads and SDXL / Illustrious checkpoint imports.
- Durable SQLite jobs, retry protection and recovery after a server restart or lost ComfyUI connection.
- Owner login, revocable API tokens, a REST API and an MCP endpoint.
- Encrypted integration keys for Hugging Face, Civitai, Gemini, OpenAI, Anthropic and NanoGPT, with access checks in Settings.
- A prompt assistant with managed local MiMo, Gemini and existing OpenAI-compatible text endpoints, manual refinement, instruction-based rewriting and Undo.
- Recent activity, optional completion sounds and desktop notifications, and an installable PWA with manual updates.

This first version focuses on image generation and prompt assistance. A standalone chat workspace, video, audio, training and an incoming OpenAI-compatible API are outside this release.

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

### Install the app and enable notifications

Open **Settings → App** to install Studio when your browser supports installation, or use the browser's install/share menu. PWA installation and desktop notifications require HTTPS or localhost; a plain HTTP address on your LAN does not qualify. The service worker runs in production builds only.

The top-bar bell shows recent job activity and controls completion sounds and desktop notifications. Both are off by default and saved per browser. Desktop permission is requested only when you enable it. Keep Studio open in a background tab or app window to receive completion alerts; there is no push delivery after closing it. System notifications contain model names, never prompts or generated images.

Updates appear under **Settings → App** and reload only when you choose **Reload app**. Finish active work and save settings first. The offline screen explains how to reconnect: generating and browsing your gallery still require the server. Only public app assets and this fallback screen are cached, not authenticated pages, API responses or private images.

### Set up generation

In **Settings**, check the GPUs to use and choose **Set up generation**. On Linux x86_64, the studio detects a ready Docker or Podman installation, finds free ports, builds the pinned ComfyUI runtime, tests each selected GPU and connects the workers automatically. Progress stays visible in the studio; you can leave the page while setup continues.

Then open **Models** to download a catalog model or import a Hugging Face `.safetensors` checkpoint for the SDXL / Illustrious family. Downloads are checked before activation. Models requiring Hugging Face access need their license accepted and a token saved under **Settings → Integrations**. Catalog entries without a download source can use files already placed in the shared model directory.

Change the GPU checkboxes later and apply the selection. Existing worker identities and ports are retained; newly selected GPUs get additional workers. Finish or cancel queued generations before changing the selection. An existing ComfyUI installation can be connected through **Advanced settings**.

For terminal use, runtime setup is also available as one command:

```sh
pnpm runtime up
```

`pnpm runtime plan` is an optional preview, and `--engine docker` or `--engine podman` overrides automatic engine selection. The CLI reads `.env` and reuses a saved deployment. It handles the runtime; model downloads and automatic studio registration are available through the interface.

The installer builds one shared image per backend, CUDA or ROCm, and starts one worker per selected GPU. All workers read `storage/models/`. Compatible checkpoints use the same workers.

See [runtime installation](deploy/comfyui/README.md) for device permissions, selecting GPUs, verification and stopping workers. See [model files and recipes](packages/inference/README.md) for the required weights and their sources.

### Different hardware

Each GPU has its own memory budget. Three 24 GiB cards remain three separate devices; the scheduler does not treat them as a 72 GiB GPU. Multiple independent jobs can run concurrently when the configured concurrency limit and host RAM allow it. Adjust these limits under **Settings → Advanced settings**.

Model memory budgets start as editable estimates. A successful connection confirms the ComfyUI API and required files/nodes; it does not certify model speed, image quality or fit on a particular card. The runtime smoke test separately checks actual GPU execution. GPU fixtures cover dual R9700, triple RTX 3090, B100 and mixed-vendor configurations.

External workers are supported. Their reported memory is checked before admission. Workers without reliable GPU identity on the same remote hostname are serialized. Use a consistent hostname for workers on the same machine so host RAM is accounted together.

## API and MCP

Create a token under **Settings → Advanced settings → API access**. Use it as an `Authorization: Bearer` header. Tokens can generate and read images; runtime setup and model downloads require an owner browser session.

The MCP endpoint is **`http://127.0.0.1:4321/api/mcp`**, using Streamable HTTP. It exposes model listing, image submission, job status, queued-job cancellation and reference image listing. Each submission needs an idempotency key. Disconnecting a client does not cancel its generation.

See [API usage](apps/server/README.md) for requests and response behavior.

## Integration keys

Open **Settings → Integrations** to save, replace, remove or check a provider key. The panel shows only the last four characters of a saved key; there is no reveal or export operation. The owner's browser session is required to manage integrations. Studio API tokens and MCP clients cannot read or manage them.

Keys are encrypted with AES-256-GCM before being written to SQLite. The server uses `GRAVITY_CREDENTIALS_KEY` when supplied (32 random bytes encoded as base64), otherwise it creates a private `credentials.key` file in the data directory. Keep this master key stable and back it up securely: losing it makes saved keys unreadable. For deployments, supply it through your secret manager and keep it separate from database backups. Encryption protects a database copy; someone with access to the running server or both the database and master key can still recover credentials. Use HTTPS when accessing Studio over a network.

The saved Hugging Face token is used for model downloads; `HF_TOKEN` remains a fallback for existing installations. The Gemini key also powers the prompt assistant. The remaining named providers currently support credential management and authenticated access checks. Checks do not generate content or prove access to every model.

### Prompt assistant

For a local assistant, open **Models → Language → Local Studio**, download **MiMo V2.6 Distill Qwen 9B**, then choose **Use for assistant**. Studio downloads verified Q8_0 weights and a pinned llama.cpp GPU image, and manages one container for this runtime. GPU selection follows the enabled Studio GPUs by default; an optional checkbox selection assigns a different set to the assistant. [Runtime details](deploy/llamacpp/README.md) describe supported builds and requirements.

Models can remain together in VRAM when their weights, working-memory budgets and reserves fit. MiMo loads on demand and stays warm for subsequent requests. Image admission accounts for its retained reservation and can unload it when idle under memory pressure. Active requests retain their reservation until they finish; cancellation and uncertain failures require a confirmed container stop before releasing memory. The idle-unload interval in Generation also applies to MiMo; zero disables time-based unloading. **Unload from GPU** explicitly releases the local model. Memory budgets are conservative estimates, not a guarantee of fit for every workload.

Save a Gemini key in **Settings → Integrations**, or configure the **OpenAI-compatible endpoint** there with its API base URL (including `/v1` where required) and optional separate key. This connects to an existing server, such as llama.cpp; Studio does not start or schedule that text runtime. Changing the endpoint address clears its assistant selection and discards its previous key. Supply a replacement key when the new destination needs one.

In **Models → Language** or **Settings → Assistant**, load the available models and choose **Use for assistant**. Compatible endpoints must support model listing and chat completions with JSON output. Discovery lists candidates; a successful refinement confirms support for the request format. Studio never silently switches providers or retries an ambiguous generation.

Open **AI** in the prompt dock to **Refine** the current prompt or **Rewrite** it with an instruction. Guidance follows the selected image model's family. Only text is sent to the provider; reference images stay in Studio. Generation uses the resulting prompt without another automatic refinement. Undo restores the preceding prompt until you edit it, and Cancel stops waiting and aborts the upstream request. The provider may still charge for work it has already performed.

Refinement requires the owner's browser session. Existing Studio API tokens and MCP clients cannot invoke paid text requests. Responses have time and size limits, incomplete output is rejected, and replies cannot replace a draft edited during the request. Quoted lettering and image markers are preserved; edit the original prompt directly when changing them. Cloud adapters are covered with protocol fixtures; no live paid-provider inference is part of the automated tests.

## Data and deployment

`storage/` contains the database, owner credentials, session/token hashes, private inputs and outputs, and managed worker state. Model weights live in `storage/models/`. These directories and `.env` are excluded from Git. Back up the entire data directory while the studio is stopped; keep model weights separately if preferred.

Both application processes bind to localhost by default. For access from other machines, put the web application behind your HTTPS reverse proxy and set `GRAVITY_ALLOWED_ORIGINS` to its exact origin. `GRAVITY_STUDIO_HOST` controls the web bind address. Keep the API and ComfyUI worker ports private. Automatic setup runs the host's container CLI under the studio service account; that account needs engine and GPU access. The application does not install custom nodes from the web interface.

## Development checks

```sh
pnpm check
pnpm build
pnpm test:browser
```

The browser test uses a local Chrome/Chromium executable (`CHROME_BIN` can override its location), a temporary database and the real application/API. ComfyUI is a protocol fixture; no model inference occurs. Screenshots and temporary development artifacts stay outside version control.

Keep contributions focused and independently reviewable. A compatible fine-tune normally adds a model manifest; a new architecture adds a family recipe and capability checks. Host paths and physical GPU IDs belong in local settings.
