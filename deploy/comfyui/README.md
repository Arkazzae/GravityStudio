# Managed ComfyUI workers

Gravity builds one shared image per backend and starts one ComfyUI worker per selected GPU. Three NVIDIA cards therefore use three worker containers built from the same CUDA image. Compatible model families share each worker and one model directory; adding a checkpoint does not create another container.

The installer currently targets **Linux x86_64**. Its automated tests use hardware fixtures and mocked container commands. These images have not yet been built or qualified on real GPUs in this project. A detected card, a successful runtime smoke test and a validated model workload are separate states.

## Review and start

Run these commands from the repository on the GPU host, under the account that owns Gravity's storage:

```sh
pnpm doctor
node scripts/runtime.ts plan
node scripts/runtime.ts prepare
node scripts/runtime.ts up
```

`plan` probes hardware and prerequisites and prints the proposed deployment. It does not write files or start containers. `prepare` creates the empty storage directories and saves the plan and Compose JSON. `up` builds the images, creates or reuses matching containers, starts them and runs real GPU smoke tests. The first build downloads the pinned runtime and Python dependencies; it does not download model weights.

Select an engine, storage path, GPUs or the first loopback port when needed:

```sh
pnpm doctor --podman
node scripts/runtime.ts plan --engine podman --data-dir /srv/gravity --json
node scripts/runtime.ts up --engine podman --data-dir /srv/gravity
```

Repeat `--gpu ID` to select particular IDs from the hardware report. Repeat the same selection and storage options for `prepare` and `up`. The default data directory is `GRAVITY_DATA_DIR`, or `./storage`.

Each worker listens only on a host loopback port, starting at `8188`. The saved deployment includes its endpoint and device ID. Add that endpoint as a local worker in Studio and enable it after verification. A Studio server on another machine needs a separately configured authenticated connection or tunnel; these APIs are not published on the LAN automatically.

```sh
node scripts/runtime.ts connections
node scripts/runtime.ts smoke
node scripts/runtime.ts stop
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

Rootless Podman uses `--userns keep-id`, so the worker's configured UID can write the private host-owned state directories. The generated Compose configuration carries the same mapping. The web application needs no container socket. Run the installer directly on the GPU host. It refuses known nested-container environments and containers whose ownership or deployment labels differ from the reviewed plan. Changes to an existing deployment require draining and explicitly recreating affected containers; `up` will not silently replace them.

## Storage

All workers mount `storage/models` read-only. Place licensed model files in the matching ComfyUI folders:

| Folder | Contents |
| --- | --- |
| `checkpoints` | Complete checkpoints, such as SDXL |
| `diffusion_models` | Separate diffusion/transformer weights |
| `text_encoders` or `clip` | Text encoders required by a recipe |
| `vae` | Autoencoders |
| `loras` | LoRA adapters |
| `controlnet`, `clip_vision`, `upscale_models`, `embeddings` | Optional supporting models |

Each worker has separate `input`, `output`, `temp` and `user` directories under `storage/workers/<worker-name>`. `storage/runtime` contains the reviewed plan, Compose JSON, worker-settings proposal and smoke evidence. Storage is outside the tracked source tree and survives container removal.
