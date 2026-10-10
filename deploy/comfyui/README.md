# Managed ComfyUI workers

Gravity builds one shared image per backend and starts one ComfyUI worker per selected GPU. Three NVIDIA cards therefore use three worker containers built from the same CUDA image. Compatible model families share each worker and one model directory; adding a checkpoint does not create another container.

The installer currently targets **Linux x86_64**. Its automated tests use hardware fixtures and mocked container commands. The managed ROCm runtime has also been built and exercised on physical hardware as described below. A detected card, a successful runtime smoke test and a validated model workload are separate states.

## Hardware validation

On one host with two Radeon AI PRO R9700 GPUs (`gfx1201`), both workers passed the matrix multiplication, attention and convolution smoke tests. The runtime used ROCm 7.2.1, PyTorch 2.9.1 and ComfyUI 0.39.0.

Successful image generations covered WAI Illustrious through the SDXL recipe, FLUX.2 Klein 4B and Krea 2 Turbo. Klein reference-image generation and WAI image-to-image generation also completed, with the latter exercising the second GPU.

Studio UI checks also imported five distinct SDXL LoRAs from pinned Hugging Face revisions and generated with WAI Illustrious v17 at 1024×1024, 20 steps and seed `424242`, with each adapter at strength `0.2`. Both the selected order and its complete reverse executed successfully. Saved snapshots preserved the MODEL and CLIP chains, strengths and filenames; physical adapter SHA-256 digests and worker completion histories matched. Krea 2 Turbo also generated with one Darkbrush LoRA at strength `0.4`.

Admission checks kept a two-adapter Krea job queued while no GPU had its estimated VRAM budget plus reserve available; it was cancelled before submission. A four-adapter Krea job exceeded each GPU's total capacity under that policy and was rejected before worker submission. These checks validate scheduling behavior, not the minimum memory needed by those stacks. The configurable limit of 32 LoRAs is a recipe limit; five-adapter SDXL execution does not establish that every supported stack fits a particular GPU.

Additional synthetic-image checks covered standalone BiRefNet with existing alpha, WAI masked editing at 512×512, outpainting to 640×512 and Qwen source-matched RGBA editing at 512×512. Qwen source matching and masked editing also completed at 1024×1024 with the internal 1056×1056 pad/crop workaround. Masked/outpainted protected RGB pixels matched their source; alpha differed by at most one 8-bit level through ComfyUI's float conversion and PNG export. These are execution and compositing checks, not image-quality evaluations.

These results cover that installation and those workloads. Other AMD configurations and physical NVIDIA execution remain unverified. They do not establish model quality, maximum resolution, peak memory or performance guarantees; the project remains a development preview.

## Set up from the studio

Run the studio directly on the GPU host. In **Settings**, select the GPU checkboxes and choose **Set up generation**. The server checks Docker and Podman with their GPU prerequisites, prefers Podman when both are ready, chooses free loopback ports and builds the runtime. After each selected GPU passes its smoke test, its worker is connected automatically.

Use **Models** to download catalog weights or import a Hugging Face SDXL / Illustrious checkpoint. These files are shared by all managed workers. Runtime setup itself downloads only the image and Python dependencies.

Changing the selection preserves existing workers and their ports. Selecting a new GPU adds a worker; deselecting one disables its use by the studio without removing its container or files. Existing generations must finish or be cancelled before changing the selection.

## Optional command-line controls

Run commands from the repository on the GPU host, under the account that owns Gravity's storage. A separate planning step is unnecessary:

```sh
pnpm runtime up
```

Automatic engine selection checks actual GPU prerequisites, including NVIDIA container integration or AMD device access. A saved plan retains its engine, GPU assignments, ports and worker options. New deployments choose an available consecutive range beginning at port `8188` or higher. Occupied ports belonging to another process are never taken over.

For diagnostics or an explicit engine choice:

```sh
pnpm doctor
pnpm runtime plan --json
pnpm runtime up --engine podman --data-dir /srv/gravity
```

`plan` is a read-only preview. `prepare` saves a successful plan and creates its storage directories without building or starting containers. `up` prepares, builds, starts or reuses matching workers, then runs GPU smoke tests. Failed prerequisites do not replace a saved plan.

The CLI loads the repository's `.env`; the default data directory is `GRAVITY_DATA_DIR`, or `./storage`. For a new deployment, repeat `--gpu ID` to select IDs from the hardware report, or use `--port` to request a specific initial port. Omitted options reuse the saved configuration. CLI overrides that would change an existing deployment are rejected; the studio's GPU selection can safely add workers while retaining the original ones.

Each worker listens only on a host loopback port. The UI setup registers its endpoint automatically. If using only the CLI, use the saved endpoints in Studio's **Advanced settings**. A Studio server on another machine needs a separately configured authenticated connection or tunnel; worker APIs are not published on the LAN automatically.

```sh
pnpm runtime connections
pnpm runtime smoke
pnpm runtime stop
```

`connections` exports a worker-settings proposal compatible with Studio's worker fields. It leaves workers disabled and does not overwrite Studio settings. The same proposal is saved as `storage/runtime/workers.json`. `smoke` checks the saved deployment, confirms an idle queue, performs GPU matrix multiplication, attention and convolution, and records the runtime revision, immutable image ID and observed physical GPU. It does not establish model quality, maximum resolution or peak memory. `stop` requires empty worker queues and retains models and outputs.

## Pinned build profiles

| Profile | Official base | Candidate devices |
| --- | --- | --- |
| CUDA | PyTorch 2.10.0, CUDA 12.8.1, cuDNN 9 | Includes the detected targets used by RTX 3090 and B100 fixtures |
| ROCm | AMD PyTorch 2.9.1, ROCm 7.2.1, Ubuntu 24.04 | Radeon targets including the R9700 fixture |

[runtime.lock.json](runtime.lock.json) pins complete registry digests, ComfyUI **0.39.0** at commit `b0b743566f65daafc423b4fea8a2fbda94b3384a`, and the source archive checksum. [requirements.lock](requirements.lock) pins the additional Python 3.12 Linux wheels by version and SHA-256. Framework and accelerator libraries stay in their pinned base images; pip cannot replace ROCm with CUDA dependencies during the build. There are no startup package installs, custom-node downloads or model downloads.

Profile selection is a candidate match. The architecture reported by the driver and the smoke result determine actual runtime readiness. Unknown architectures remain unverified, unsupported architectures block managed startup, and a new image or driver requires new matching evidence. Multi-GPU sharding is not configured by this installer; each worker owns an independent GPU.

The source pins and installation choices follow [ComfyUI's release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.39.0), [PyTorch's version matrix](https://pytorch.org/get-started/previous-versions/) and [AMD's PyTorch installation guide](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/native_linux/install-pytorch.html). Check the [AMD Linux compatibility matrix](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/native_linux/native_linux_compatibility.html) for host OS and driver support.

## Host requirements

The pinned CUDA image contains CUDA 12.8.1. This installer requires **Linux NVIDIA driver 570.124.06 or newer** as a conservative profile baseline, following the toolkit's [corresponding driver version](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-toolkit-release-notes/index.html#cuda-toolkit-major-component-versions). This is not the general CUDA 12.x compatibility minimum: NVIDIA documents older-driver compatibility modes with feature and PTX restrictions, which this profile has not qualified. The smoke test remains necessary on either engine.

- **Docker + NVIDIA:** install the GPU driver and configure NVIDIA Container Toolkit for Docker. Workers use explicit GPU UUID reservations. See [Docker GPU reservations](https://docs.docker.com/compose/how-tos/gpu-support/) and [NVIDIA Container Toolkit setup](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
- **Podman + NVIDIA:** NVIDIA CDI entries must exist for the detected GPU UUIDs. The doctor checks `nvidia-ctk cdi list`. See [NVIDIA CDI support](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html).
- **AMD:** `/dev/kfd` and `/dev/dri` must be accessible. Docker receives their numeric supplemental group IDs. Rootless Podman uses `crun` and `keep-groups`; the host account must already have device access. `ROCR_VISIBLE_DEVICES` selects the GPU by UUID. The exposed render-device directory provides runtime placement rather than isolation from untrusted code.

Rootless Podman uses `--userns keep-id`, so the worker's configured UID can write the private host-owned state directories. The generated Compose configuration carries the same mapping. Run the studio and installer directly on the GPU host with engine and GPU permissions. The installer refuses known nested-container environments and containers whose ownership or deployment labels differ from the saved plan. Replacing an existing worker's runtime or configuration requires draining and explicitly recreating that container; `up` will not silently replace it.

## Storage

All workers mount `storage/models` read-only. The model library downloads into these folders; existing licensed files can also be placed there directly:

| Folder | Contents |
| --- | --- |
| `checkpoints` | Complete checkpoints, such as SDXL |
| `diffusion_models` | Separate diffusion/transformer weights |
| `text_encoders` or `clip` | Text encoders required by a recipe |
| `vae` | Autoencoders |
| `loras` | LoRA adapters |
| `controlnet`, `clip_vision`, `upscale_models`, `embeddings` | Optional supporting models |

Each worker has separate `input`, `output`, `temp` and `user` directories under `storage/workers/<worker-name>`. `storage/runtime` contains the reviewed plan, Compose JSON, worker-settings proposal and smoke evidence. Storage is outside the tracked source tree and survives container removal.
