# Gravity Studio

A self-hosted image studio for your GPU server. Write a prompt, add reference images, and keep generations in a private gallery. A shared ComfyUI runtime serves multiple model families; adding a checkpoint does not create another container.

**Development preview.** The application, queue, protocol integration and setup flow have automated tests. The managed ROCm runtime has completed real image generations on one dual Radeon AI PRO R9700 host. NVIDIA hardware and other AMD configurations remain unverified; see [runtime validation](deploy/comfyui/README.md#hardware-validation) for the tested scope.

## What is included

- The Image workspace: model and aspect ratio selection, advanced sampling settings, reference images, generation queue and persistent gallery.
- Drop or paste PNG, JPEG and WebP files anywhere in Image to add references, or in Assets to import them into the library. Each file can be up to 20 MiB; reference counts follow the selected model.
- Family recipes for SDXL / Illustrious, FLUX.2 Klein, Krea 2, Qwen Image 2.1 and Ideogram 4. The catalog includes SDXL Base, WAI Illustrious v17, Klein 4B, Krea 2 Turbo, Qwen Image 2.1 and Ideogram 4 FP8.
- AMD and NVIDIA detection, GPU selection with automatic runtime setup, and configurable RAM / VRAM reserves.
- A model library with Hugging Face downloads and checkpoint imports based on supported model presets.
- Image upscaling with Nomos2 HQ and SeedVR2 3B / 7B on the same ComfyUI workers.
- Durable SQLite jobs, retry protection and recovery after a server restart or lost ComfyUI connection.
- Private S3 media storage with a provided RustFS container and verified migration of existing images.
- Administrator and user accounts, one-use invitations, private galleries, scoped API tokens with expiration, a REST API and an MCP endpoint.
- An OpenAI-compatible gateway for image generation/editing and streamed text conversations with configured local or external models.
- One Settings workspace with role-based administration, model management, disk usage, server-time allowances and SMTP, Resend or Cloudflare invitation email.
- A slide-out Account panel with a saved display name, avatar colors and workspace name.
- Encrypted integration keys for Hugging Face, Civitai, Gemini, OpenAI, Anthropic and NanoGPT, with access checks in Settings.
- A prompt assistant with managed local MiMo, Gemini and existing OpenAI-compatible text endpoints, manual refinement, instruction-based rewriting and Undo.
- Live GPU memory and runtime activity, optional completion sounds and desktop notifications, and an installable PWA with manual updates.

This first version focuses on image generation and language-model access. A standalone chat workspace, video, audio and training are outside this release.

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

Open the avatar in the top bar to edit **Account**. Display name, avatar color and workspace name are saved on the server and follow the user across devices; the login username stays the same. The workspace name is a personal label and does not create another workspace. The panel also provides completion preferences, app installation and updates, and sign out. Sound and desktop notification preferences apply immediately and stay in the current browser; **Cancel** discards only profile edits.

### Accounts and administration

Open **Settings**. Tabs are grouped into **Personal**, **Creation**, **Server** and **Administration**. Everyone can manage personal preferences and API access, and view their own server-time allowance; administrator-only tabs add users, invitations, mail, models, storage and server configuration. The first owner becomes an administrator; upgrading an existing installation preserves that account and its data. Administrators manage users, invitations, server-time allowances and mail. Server settings, model downloads and provider credentials require an administrator's browser session. Each user's images, references and API tokens remain private.

Create an invitation with a role, expiration and optional initial time allowance. Copy its link or explicitly send it by email. Links can be used once and can be revoked before acceptance. Studio stores only their hashes. There is no open registration. Suspension immediately revokes sessions and API tokens; reactivation requires signing in again. Deleting an account removes its images and account data, retaining an anonymous usage ledger. Active jobs and uploads must finish first; queued jobs are cancelled. Interrupted jobs must be resolved before deletion. Failed storage cleanup leaves the account disabled and retries automatically.

**Work time** measures time reserved for model loading, execution and handling the result. Overlapping tasks count once per user. Queue waits, browsing, downloads and idle models are free. Administrators have unlimited time; invited users receive the allowance chosen in their invitation and can receive later adjustments with a reason. Exhaustion blocks new work and pauses queued admission, while active jobs finish normally and may leave a negative balance. Interrupted image jobs retain their reservation until resolved. Local prompt refinement and chat count; external provider requests do not use the machine-time allowance. Earlier completed jobs are not charged retroactively.

Under **Settings → Mail**, configure a sender and choose authenticated SMTP (implicit TLS or required STARTTLS), Resend, or Cloudflare Email Service. Secrets use the same encrypted credential vault as model integrations. Resend needs an API key and verified sending domain. Cloudflare uses its [SMTP sending service](https://developers.cloudflare.com/email-service/api/send-emails/smtp/), an onboarded sending domain and an API token with **Email Sending:Edit** permission. Email Routing alone is insufficient. **Send test email** sends only when explicitly requested; saving settings does not send a message. Provider acceptance does not guarantee inbox delivery.

### Install the app and enable notifications

Open **Settings → App** to install Studio when your browser supports installation, or use the browser's install/share menu. PWA installation and desktop notifications require HTTPS or localhost; a plain HTTP address on your LAN does not qualify. The service worker runs in production builds only.

The top-bar bell shows recent job activity and controls completion sounds and desktop notifications. Both are off by default and saved per browser. Desktop permission is requested only when you enable it. Keep Studio open in a background tab or app window to receive completion alerts; there is no push delivery after closing it. System notifications contain model names, never prompts or generated images.

Updates appear under **Settings → App** and reload only when you choose **Reload app**. Finish active work and save settings first. The offline screen explains how to reconnect: generating and browsing your gallery still require the server. Only public app assets and this fallback screen are cached, not authenticated pages, API responses or private images.

### Set up generation

In **Settings → GPUs**, check the GPUs to use and choose **Set up generation**. On Linux x86_64, the studio detects a ready Docker or Podman installation, finds free ports, builds the pinned ComfyUI runtime, tests each selected GPU and connects the workers automatically. Progress stays visible in the studio; you can leave the page while setup continues.

Then open **Settings → Models** to download a catalog model or import compatible Hugging Face `.safetensors` weights. Select a model preset to inherit its workflow, supporting files and sampling settings. **Advanced import options** can replace separately loaded text encoders, VAEs or secondary diffusion weights, and restrict a checkpoint to text-to-image. Replacements must match the preset's architecture; downloading a valid safetensors file does not establish compatibility. Studio checks access to every required file before downloading and verifies the complete package before activation. **Check access** can also be run separately. Catalog entries without a download source can use files already placed in the shared model directory.

For a gated repository, open the repository link to accept its terms or request access on Hugging Face, then save a read token from that account under **Settings → Models → Hugging Face** or **Settings → Integrations**. A fine-grained token must allow access to the required repository. Studio does not accept terms on your behalf. Repository access and the model license are separate: publicly downloadable files still carry their license conditions. Model cards show repository and available license links, including the separate commercial-license requirements for Qwen Image 2.1 and Ideogram 4.

Change the GPU checkboxes later and apply the selection. Existing worker identities and ports are retained; newly selected GPUs get additional workers. Finish or cancel queued generations before changing the selection. An existing ComfyUI installation can be connected through **Advanced settings**.

For terminal use, runtime setup is also available as one command:

```sh
pnpm runtime up
```

`pnpm runtime plan` is an optional preview, and `--engine docker` or `--engine podman` overrides automatic engine selection. The CLI reads `.env` and reuses a saved deployment. It handles the runtime; model downloads and automatic studio registration are available through the interface.

The installer builds one shared image per backend, CUDA or ROCm, and starts one worker per selected GPU. All workers read `storage/models/`. Compatible checkpoints use the same workers.

See [runtime installation](deploy/comfyui/README.md) for device permissions, selecting GPUs, verification and stopping workers. See [model files and recipes](packages/inference/README.md) for the required weights and their sources.

### Image quality

Choose an aspect ratio for the shape, then **Fast**, **Standard** or **High** for that model family's native resolution and sampling profile. You can override steps and guidance afterwards in Advanced. Distilled models keep their recommended short sampling schedule.

**Ultra** generates at High resolution and finishes with **SeedVR2 7B** in the same job. The final image has a 4096-pixel longest edge, with the shorter edge rounded to an even pixel count; transparency is preserved. Source-matched and masked edits keep their source canvas before the final upscale. Install SeedVR2 7B under **Settings → Models → Tools**. Ultra requires a connected worker with the generation and upscaler files, compatible nodes and sufficient configured memory capacity. It does not silently substitute another upscaler. Reusing an Ultra image restores its native generation canvas and the Ultra finish.

### Edit and guide images

Attach a reference and open its thumbnail to paint a mask or extend the canvas. White mask pixels are regenerated; the protected source is composited back after sampling. Source matching fits the original aspect ratio to the model's grid and size limits. Saved drafts and reused generations retain their source, mask and extension settings.

Qwen supports up to ten references, including transparency; Klein supports four. Ideogram provides image-to-image and an experimental single-reference mode using a fixed 1024-square output. Its internal reference canvas is larger and needs a separate memory check. Advanced also accepts the publisher's structured JSON caption; the prompt assistant can prepare it through the configured language provider.

Download Krea's style-reference adapter and nine official style LoRAs, SDXL ReVision CLIP Vision, or SDXL Refiner in **Settings → Models → Tools**. Imported Hugging Face LoRAs require an explicit compatible family. LoRA import supports SDXL, Klein 4B/9B, Qwen and Krea; Ideogram's dual-model workflow is excluded. Installed files enable a feature only when an assigned worker supports its complete workflow. ReVision provides conceptual image guidance rather than identity locking.

**Remove background** in an image preview creates a separate BiRefNet job for an imported or generated image. It retains the original dimensions and intersects the existing transparency with the foreground mask. Download BiRefNet in Tools first.

### Disk and object storage usage

Administrators can open **Settings → Storage** to see the data volume's capacity, used space and available space, plus a breakdown of Studio files and the largest model files. Model weights, language models, supporting tools, local images, database files and runtime files are counted separately. Disk usage includes other applications on the same volume; Studio file sizes do not include container layers stored elsewhere. Scans are cached for 30 seconds and identify partial or unavailable results.

For S3/RustFS, the panel separately totals the imported and generated images recorded in Studio. This is the size of those managed objects, not the bucket's total usage or the remote disk's capacity. It does not scan unrelated objects or expose storage credentials.

### Upscale an image

Download **Nomos2 HQ**, **SeedVR2 3B** or **SeedVR2 7B** under **Settings → Models → Tools**. Open a generated or imported image and choose **Upscale**, then select a downloaded model and 2× or 4×. Output is limited to 4096 pixels per side. The action becomes available when a connected worker has all required weights and nodes.

Upscaling creates a separate queued job and saves a new image, preserving the original and its transparency. It shares generation's worker selection, memory reservations, restart recovery and private media storage. Source images cannot be deleted while an upscale is active. Nomos2 runs a native 4× restoration and reduces it for 2× output; SeedVR2 uses the native ComfyUI diffusion workflow. Memory requirements are estimates and vary with source size and hardware. No additional container or custom node installation is required.

### Different hardware

Each GPU has its own memory budget. Three 24 GiB cards remain three separate devices; the scheduler does not treat them as a 72 GiB GPU. Multiple independent jobs can run concurrently when the configured concurrency limit and host RAM allow it. Adjust these limits under **Settings → Advanced settings**.

The activity control in the top bar shows queued and running generations, each local GPU's measured VRAM use, host RAM, and the local assistant's runtime state. Cancel waiting jobs or release an idle worker's cache there. Image cache release applies to the whole worker and never deletes model files; its next job loads the required weights again. A connected image worker does not imply that a particular checkpoint remains loaded.

Model memory budgets start as editable estimates. A successful connection confirms the ComfyUI API and required files/nodes; it does not certify model speed, image quality or fit on a particular card. The runtime smoke test separately checks actual GPU execution. GPU fixtures cover dual R9700, triple RTX 3090, B100 and mixed-vendor configurations.

External workers are supported. Their reported memory is checked before admission. Workers without reliable GPU identity on the same remote hostname are serialized. Use a consistent hostname for workers on the same machine so host RAM is accounted together.

## API and MCP

Open **Settings → API access** to copy connection details and create a token. Choose image creation, read-only library access, language models, all Studio workflows, or individual permissions. Tokens expire after 7, 30, 90 or 365 days, or can have no expiration. The secret is displayed once; revoke it from the same panel. Model downloads, provider credentials and administration remain restricted to administrator browser sessions.

| Interface | Default local address | Available workflows |
| --- | --- | --- |
| OpenAI-compatible API | `http://127.0.0.1:4321/v1` | Model discovery, chat completions with streaming, image generation and editing, reference files |
| MCP over Streamable HTTP | `http://127.0.0.1:4321/api/mcp` | Images, editing, upscaling, cutout, owned assets and favorites, durable jobs, text/refine and server status |
| Studio REST API | `http://127.0.0.1:4321/api` | Native image controls, job progress and authenticated media |

Clients authenticate with `Authorization: Bearer <Studio token>`. This release uses personal access tokens; it does not provide OAuth login or a bundled stdio MCP server. MCP exposes only tools allowed by the token. Local models use the same GPU scheduling and server-time allowance as Studio; external text requests use the administrator's configured provider connection. Grant `text:generate` explicitly to enable those requests.

Image requests enter the same durable queue and gallery as the web interface. Supply an `Idempotency-Key` and reuse it with the identical request after a lost response. OpenAI image calls can use `Prefer: respond-async` to return accepted job IDs immediately. Disconnecting does not cancel accepted image jobs. Chat requests stream directly and are not durable jobs.

See [API usage](apps/server/README.md) for the supported compatibility subset, permissions, curl and SDK examples, image masks and recovery behavior.

## Integration keys

Open **Settings → Integrations** to save, replace, remove or check a provider key. The panel shows only the last four characters of a saved key; there is no reveal or export operation. An administrator's browser session is required to manage integrations. Studio API tokens and MCP clients cannot read or manage them.

Keys are encrypted with AES-256-GCM before being written to SQLite. The server uses `GRAVITY_CREDENTIALS_KEY` when supplied (32 random bytes encoded as base64), otherwise it creates a private `credentials.key` file in the data directory. Keep this master key stable and back it up securely: losing it makes saved keys unreadable. For deployments, supply it through your secret manager and keep it separate from database backups. Encryption protects a database copy; someone with access to the running server or both the database and master key can still recover credentials. Use HTTPS when accessing Studio over a network.

The saved Hugging Face token is used for model downloads; `HF_TOKEN` remains a fallback for existing installations. The Gemini key also powers the prompt assistant. The remaining named providers currently support credential management and authenticated access checks. Checks do not generate content or prove access to every model.

### Prompt assistant

For a local assistant, open **Settings → Models → Language → Local Studio**, download **MiMo V2.6 Distill Qwen 9B**, then choose **Use for assistant**. Studio downloads verified Q8_0 weights and a pinned llama.cpp GPU image, and manages one container for this runtime. GPU selection follows the enabled Studio GPUs by default; an optional checkbox selection assigns a different set to the assistant. [Runtime details](deploy/llamacpp/README.md) describe supported builds and requirements.

Models can remain together in VRAM when their weights, working-memory budgets and reserves fit. MiMo loads on demand and stays warm for subsequent requests. Image admission accounts for its retained reservation and can unload it when idle under memory pressure. Active requests retain their reservation until they finish; cancellation and uncertain failures require a confirmed container stop before releasing memory. The idle-unload interval in Generation also applies to MiMo; zero disables time-based unloading. **Unload from GPU** explicitly releases the local model. Memory budgets are conservative estimates, not a guarantee of fit for every workload.

Save a Gemini key in **Settings → Integrations**, or configure the **OpenAI-compatible endpoint** there with its API base URL (including `/v1` where required) and optional separate key. This connects to an existing server, such as llama.cpp; Studio does not start or schedule that text runtime. Changing the endpoint address clears its assistant selection and discards its previous key. Supply a replacement key when the new destination needs one.

In **Settings → Models → Language** or **Settings → Assistant**, load the available models and choose **Use for assistant**. Compatible endpoints must support model listing and chat completions with JSON output. Discovery lists candidates; a successful refinement confirms support for the request format. Studio never silently switches providers or retries an ambiguous generation.

Open **AI** in the prompt dock to **Refine** the current prompt or **Rewrite** it with an instruction. Guidance follows the selected image model's family. Only text is sent to the provider; reference images stay in Studio. Generation uses the resulting prompt without another automatic refinement. Undo restores the preceding prompt until you edit it, and Cancel stops waiting and aborts the upstream request. The provider may still charge for work it has already performed.

Refinement accepts an active user's browser session or a token with `text:generate`, including MCP clients. Existing tokens need that permission granted through a newly created token before they can invoke language models. Responses have time and size limits, incomplete output is rejected, and replies cannot replace a draft edited during the request. Quoted lettering and image markers are preserved; edit the original prompt directly when changing them. Cloud adapters are covered with protocol fixtures; no live paid-provider inference is part of the automated tests.

## Data and deployment

By default, `storage/` contains the database, account credentials, session/token hashes, private inputs and outputs, and managed worker state. Model weights live in `storage/models/`. These directories and `.env` are excluded from Git.

For primary object storage, use the [provided RustFS service](deploy/rustfs/README.md) or an existing private S3-compatible bucket. New references and generated images are written directly to that bucket; the authenticated gallery URLs stay the same. [Storage configuration and migration](docs/storage.md) covers credential setup, verified migration of existing files, backups and recovery. SQLite, weights and ComfyUI working files remain on the host.

Back up the data directory while Studio is stopped, together with the private bucket when S3 is enabled. Keep the S3 connection credentials and credential encryption key securely; model weights can be backed up separately.

Both application processes bind to localhost by default. For access from other machines, put the web application behind your HTTPS reverse proxy and set `GRAVITY_ALLOWED_ORIGINS` to its exact origin. `GRAVITY_STUDIO_HOST` controls the web bind address. Keep the API and ComfyUI worker ports private. Automatic setup runs the host's container CLI under the studio service account; that account needs engine and GPU access. The application does not install custom nodes from the web interface.

## Development checks

```sh
pnpm check
pnpm build
pnpm test:browser
```

The browser test uses a local Chrome/Chromium executable (`CHROME_BIN` can override its location), a temporary database and the real application/API. ComfyUI is a protocol fixture; no model inference occurs. Screenshots and temporary development artifacts stay outside version control.

Keep contributions focused and independently reviewable. A compatible fine-tune normally adds a model manifest; a new architecture adds a family recipe and capability checks. Host paths and physical GPU IDs belong in local settings.
