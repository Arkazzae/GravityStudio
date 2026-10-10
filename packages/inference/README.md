# Image recipes and model files

This package compiles portable image requests into ComfyUI API graphs. A family owns the graph and parameter rules; a model manifest selects weights and defaults. Checkpoints in the same family share the implementation. GPU assignments, memory budgets and worker endpoints belong to the server configuration.

## Included recipes

| Family | Operations | Default catalog models |
| --- | --- | --- |
| SDXL | Text to image; image to image; ReVision references; masks/outpaint; optional refiner | SDXL Base 1.0, WAI Illustrious v17 |
| FLUX.2 Klein 4B | Text to image; reference editing | FLUX.2 Klein 4B distilled |
| FLUX.2 Klein 9B | Text to image; reference editing | Family recipe only; supply a compatible manifest |
| Krea 2 | Text to image; style references; style LoRAs | Krea 2 Turbo FP8 |
| Qwen Image 2.1 | Text to image; reference editing | Qwen Image 2.1 BF16 |
| Ideogram 4 | Text to image; image to image; masks/outpaint; experimental reference | Ideogram 4 FP8 |

SDXL image-to-image scales and center-crops the input to the selected dimensions before encoding it. Klein accepts up to four references. Its native scheduler uses the output dimensions; this recipe does not expose a negative prompt. Krea accepts up to two style references with its optional official style-reference adapter. Its nine official style LoRAs are separate downloads; compatible LoRAs may be chained within the selected model's advertised limit and the assigned worker's memory budget.

Qwen Image 2.1 accepts up to ten references in order; address them as `<image1>`, `<image2>`, and so on in the prompt. Reference encoding preserves aspect ratio at approximately one megapixel per image, while the output uses the dimensions selected in Studio. Choose an output aspect ratio close to the first reference to preserve the composition. The recipe follows the official custom-size workflow, supports dimensions in multiples of 32 up to 4.4 million pixels, and defaults to 25 steps with Euler/simple and guidance 1. Negative prompts take effect when guidance exceeds 1. Set `background: "transparent"` to include its native RGBA instructions automatically. The optional prompt enhancement model is not loaded.

Qwen recipe revision 3 works around [reported noisy reference edits](https://github.com/Comfy-Org/ComfyUI/issues/16435) on certain sampling grids. Ordinary references use a 992-pixel resolution budget. When the requested latent grid contains a multiple of 2,048 tokens, sampling adds 32 pixels to each dimension. Ordinary reference outputs are scaled back; source-matched, masked and outpainted inputs instead receive temporary right/bottom padding, cropped away before the protected source is composited. This preserves the editing geometry. Scheduling includes the larger internal canvas; text-to-image is unchanged.

Ideogram 4 FP8 supports text-to-image with 20 steps, Euler sampling and guidance 7 by default. It uses a native resolution-aware schedule and uses the publisher's separate final polishing sampler. Fast/Standard/High select 12/20/48 total steps and 1/2/3 polishing steps respectively. Studio converts a plain prompt into the publisher's minimal caption format locally; it does not call Magic Prompt or another hosted service. Image-to-image uses the source latent and a denoising fraction. Experimental reference mode locks a source panel in a 2048×1024 internal canvas and crops the generated 1024×1024 panel; it is distinct from native multimodal image conditioning. Negative prompts remain unavailable. Dimensions use a 16-pixel grid, from 256 to 2048 per side, with aspect ratios up to 6:1. Initial memory budgets are estimates of 48 GiB RAM and 28 GiB VRAM at 1024×1024; larger images reserve more memory. These estimates do not establish that generation will fit on a particular GPU.

The managed runtime pins [ComfyUI v0.39.0](https://github.com/Comfy-Org/ComfyUI/tree/b0b743566f65daafc423b4fea8a2fbda94b3384a). These recipes use its built-in nodes and do not require custom node packs. The [schema regression fixture](../../tests/inference/fixtures/comfy-v0.39.0-signatures.json) records the pinned source file digests, socket types and loader enums. Tests cover graph compatibility and the HTTP/WebSocket protocol. GPU execution and model quality still require a real generation on the selected hardware.

## Background and transparency

Requests accept `background: "auto" | "opaque" | "transparent"`; omitted values resolve to `"auto"`. Auto preserves each recipe's original prompt and graph. Transparent uses Qwen's native RGBA generation; other families add the core BiRefNet mask and alpha-compositing nodes after decoding and before PNG saving. The original prompt remains in the snapshot, while Qwen's encoder receives the explicit transparency instruction.

Opaque requests leave RGB model graphs unchanged. For Qwen, they request an opaque scene and composite any remaining alpha over white after the final output resize, producing RGB pixels. The generated image can still depict patterns or objects described by the prompt; background mode controls actual alpha rather than recognizing simulated checkerboards.

BiRefNet requires the optional `background_removal/birefnet.safetensors` artifact from [the pinned Comfy-Org repository](https://huggingface.co/Comfy-Org/BiRefNet/tree/5a1bd8ae750548f8cd42e3c8afa854fd3eba0fb1). Its digest is exported as `BIREFNET_ARTIFACT`. Only cutout snapshots include this file in `auxiliaryArtifacts`; ordinary generation and native Qwen transparency do not require it. `BIREFNET_MEMORY` reserves an estimated additional 4 GiB RAM and 2 GiB VRAM for scheduling. The core model processes a 1024-pixel canvas and restores its soft mask to the requested dimensions.

## Editing and adapters

`mask` is a separate input image with white RGB pixels indicating the edit region. `outpaint` supplies grid-aligned padding and is mutually exclusive with a mask. The server resolves `sourceSize` from the owned first input; API callers cannot override this metadata. Source matching preserves aspect ratio within the family’s grid and pixel limits, without center-cropping. Masked SDXL, Klein, Qwen and Ideogram graphs protect latent regions and composite the original source back outside the mask, including its alpha. Ultra restoration runs after this composite and may refine the whole final image.

`GENERATION_EXTENSIONS` contains pinned Krea style/reference weights, SDXL ReVision’s CLIP Vision G and the SDXL Refiner checkpoint. SDXL LoRAs patch model and CLIP; compatible Klein, Qwen and Krea LoRAs patch the model. Extension manifests and files are frozen in each snapshot and included in worker capability checks and resource reservations. Selecting a family declares architecture compatibility; the downloader validates safetensors structure and digest, not the training provenance of an imported adapter.

LoRA choices retain request order when constructing the loader chain and hashing the execution snapshot. `effectiveModelLoraLimit()` combines the recipe's supported stack size with an optional narrower `maxLoras` in the checkpoint manifest. The shared request ceiling is 32; Ideogram currently permits none. A preset import freezes its effective limit. This policy bounds graph size; the server separately accounts for the entire stack's estimated memory on one assigned worker.

Standalone `compileBackgroundRemoval()` uses BiRefNet on an existing image, preserves dimensions and multiplies the foreground opacity by the source opacity. The server runs it through the durable queue with owned inputs/outputs and protects its source from deletion until the job terminates.

## Install weights

Put existing model files in the worker's model directory. The managed deployment mounts this directory at `/models`. On an existing ComfyUI installation, use its `models` directory or configured equivalent. Subdirectories are supported; choose the corresponding relative filename in Hardware settings.

| Catalog model | Folder | Expected filename |
| --- | --- | --- |
| SDXL Base 1.0 | `checkpoints` | `sd_xl_base_1.0.safetensors` |
| WAI Illustrious v17 | `checkpoints` | `waiIllustriousSDXL_v170.safetensors` |
| FLUX.2 Klein 4B | `diffusion_models` | `flux-2-klein-4b.safetensors` |
| FLUX.2 Klein 4B | `text_encoders` | `qwen_3_4b.safetensors` |
| FLUX.2 Klein 4B | `vae` | `flux2-vae.safetensors` |
| Krea 2 Turbo | `diffusion_models` | `krea2_turbo_fp8_scaled.safetensors` |
| Krea 2 Turbo | `text_encoders` | `qwen3vl_4b_bf16.safetensors` |
| Krea 2 Turbo | `vae` | `qwen_image_vae.safetensors` |
| Qwen Image 2.1 | `diffusion_models` | `qwen_image_2.1_bf16.safetensors` |
| Qwen Image 2.1 | `text_encoders` | `qwen3vl_8b_bf16.safetensors` |
| Qwen Image 2.1 | `vae` | `qwen_image_2.1_vae_bf16.safetensors` |
| Ideogram 4 FP8 | `diffusion_models` | `ideogram4_fp8_scaled.safetensors` |
| Ideogram 4 FP8 | `diffusion_models` | `ideogram4_unconditional_fp8_scaled.safetensors` |
| Ideogram 4 FP8 | `text_encoders` | `qwen3vl_8b_fp8_scaled.safetensors` |
| Ideogram 4 FP8 | `vae` | `flux2-vae.safetensors` |

Use the model publishers' files and licenses:

- SDXL: [Stability AI's pinned repository](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/tree/462165984030d82259a11f4367a4eed129e94a7b), under CreativeML Open RAIL++-M.
- Klein: [Black Forest Labs' model card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) and [Comfy-Org's pinned ComfyUI files](https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/tree/5f526678002e43af5551dadb73ce2e8c91b43afe), published under Apache-2.0. The older `Comfy-Org/flux2-klein` address redirects to this repository.
- Krea: [Krea's Turbo model card](https://huggingface.co/krea/Krea-2-Turbo) and [Comfy-Org's pinned files](https://huggingface.co/Comfy-Org/Krea-2/tree/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96), with the Krea 2 Community License linked by the publisher.
- Qwen: [the publisher's model card](https://huggingface.co/Qwen/Qwen-Image-2.1) and [Comfy-Org's pinned BF16 files](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/cb504a4090723e43f17ad01cec0359490e2de613). The [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) permits non-commercial research and evaluation; commercial use requires a separate license. The three BF16 files total approximately 30.2 GiB. The recipe uses automatic, lossless KV cache placement in GPU or host memory.
- WAI: [the creator's model version](https://civitai.com/models/827184?modelVersionId=2883731). Access and download permissions are controlled by Civitai and the creator. A configured filename does not prove that this version is available to download or grant permission to use it.
- Ideogram: [the publisher's FP8 model card](https://huggingface.co/ideogram-ai/ideogram-4-fp8) and [Comfy-Org's pinned files](https://huggingface.co/Comfy-Org/Ideogram-4/tree/2aa6c75ce6d5fabded0ca4d0f76abbfaf8edc87d), under the [Ideogram Non-Commercial Model Agreement](https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md). Commercial use requires a separate license. The four files total approximately 27.5 GiB; an existing Klein VAE with the matching digest is reused. If Hugging Face requires access approval, accept the publisher's terms with your own account and configure its authorized token in Models → Hugging Face.

Artifact URLs and expected SHA-256 digests are in [catalog.ts](./catalog.ts). The default Klein VAE comes from the Klein repository; its digest starts with `868fe7b3`. Another published file with the same filename exists in the FLUX.2 dev repository with a different digest. Compare the full digest when selecting an exact artifact.

```sh
sha256sum /models/checkpoints/sd_xl_base_1.0.safetensors
```

The Models panel downloads weights from Hugging Face when requested, verifies their SHA-256 and safetensors structure, and activates them after checking worker capabilities. `getModelPresets()` advertises reviewed catalog templates. `createCheckpointManifest()` replaces their primary weights, optionally replaces supported dependency roles, and freezes the preset identity, effective defaults, quality settings and allowed operations in a persisted manifest. Operations can be narrowed but cannot exceed the preset's capabilities. A package revision covers the complete manifest after all file digests are recorded.

Separately loaded text encoders, VAEs and secondary diffusion weights can be overridden within the recipe's existing roles. SDXL's current checkpoint loader keeps its embedded encoder and VAE; external replacements require a recipe change. File validation establishes structure and integrity, not tensor architecture compatibility or the imported weights' license. Model readiness probes use an allowed operation, including variants that require an input image.

Worker discovery checks filenames and node capabilities through the ComfyUI API. It reports `integrity: "filenames-only"`: the standard API does not verify bytes on a remote worker. Library downloads are verified separately on the studio host. If you override an artifact filename in advanced settings, the server removes the catalog's expected digest and download source from that resolved artifact.

## Add a fine-tune

For an existing catalog entry, select the installed checkpoint in Hardware settings. To give another compatible checkpoint its own name and defaults, add a manifest to `DEFAULT_MODELS` in [catalog.ts](./catalog.ts). No graph file or new worker is needed.

For example, a locally supplied Illustrious checkpoint can use:

```ts
const model: ModelManifest = {
  id: "my-illustration",
  name: "My Illustration",
  familyId: "sdxl",
  revision: "1",
  artifacts: [
    { role: "checkpoint", folder: "checkpoints", filename: "my-illustration.safetensors" },
  ],
  defaults: {
    steps: 30,
    cfg: 6,
    sampler: "euler_ancestral",
    scheduler: "normal",
    clipSkip: 2,
  },
};
```

Use the creator's recommended defaults. Distilled/base variants, different text encoders and 4B/9B architectures are meaningful compatibility differences. Select the matching family and artifacts; a display name alone cannot establish compatibility. A model may restrict its family's operations, but cannot add a new graph operation through metadata.

## Execution and recovery

`compileGeneration()` produces a snapshot containing the resolved model manifest, family revision, effective parameters, uploaded input references and final graph. Its canonical SHA-256 changes when those inputs change. Persist the snapshot before submission so job history survives catalog updates.

`checkCapabilities()` compares the snapshot with `/object_info` and the worker's model inventory. The server separately admits the job against the selected GPU and shared host RAM. Initial memory budgets are estimates, not measurements; they can require adjustment for the worker, checkpoint precision and image size.

`ComfyClient.submit()` sends the durable job UUID as `prompt_id` and `client_id`, also retaining it in metadata for older workers. ComfyUI does not itself guarantee idempotent submission. The coordinator must serialize submissions, save its submitting state first, and reconcile uncertain requests without blindly replaying them. History and queue state determine completion; WebSocket sampling counts describe individual nodes, not a whole-job percentage.

Output downloads are restricted to files returned by the successful job's history. Idle release uses `/free` after checking the queue. It keeps ComfyUI running and lets the next checkpoint use the same worker process.
