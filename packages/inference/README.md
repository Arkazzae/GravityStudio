# Image recipes and model files

This package compiles portable image requests into ComfyUI API graphs. A family owns the graph and parameter rules; a model manifest selects weights and defaults. Checkpoints in the same family share the implementation. GPU assignments, memory budgets and worker endpoints belong to the server configuration.

## Included recipes

| Family | Operations | Default catalog models |
| --- | --- | --- |
| SDXL | Text to image; image to image | SDXL Base 1.0, WAI Illustrious v17 |
| FLUX.2 Klein 4B | Text to image; reference editing | FLUX.2 Klein 4B distilled |
| FLUX.2 Klein 9B | Text to image; reference editing | Family recipe only; supply a compatible manifest |
| Krea 2 | Text to image | Krea 2 Turbo FP8 |

SDXL image-to-image scales and center-crops the input to the selected dimensions before encoding it. Klein accepts up to four references. Its native scheduler uses the output dimensions; this recipe does not expose a negative prompt. Krea reference editing, inpainting and arbitrary LoRA chains are not implemented by these recipes.

The managed runtime pins [ComfyUI v0.39.0](https://github.com/Comfy-Org/ComfyUI/tree/b0b743566f65daafc423b4fea8a2fbda94b3384a). These recipes use its built-in nodes and do not require custom node packs. The [schema regression fixture](../../tests/inference/fixtures/comfy-v0.39.0-signatures.json) records the pinned source file digests, socket types and loader enums. Tests cover graph compatibility and the HTTP/WebSocket protocol. GPU execution and model quality still require a real generation on the selected hardware.

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

Use the model publishers' files and licenses:

- SDXL: [Stability AI's pinned repository](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/tree/462165984030d82259a11f4367a4eed129e94a7b), under CreativeML Open RAIL++-M.
- Klein: [Black Forest Labs' model card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) and [Comfy-Org's pinned ComfyUI files](https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/tree/5f526678002e43af5551dadb73ce2e8c91b43afe), published under Apache-2.0. The older `Comfy-Org/flux2-klein` address redirects to this repository.
- Krea: [Krea's Turbo model card](https://huggingface.co/krea/Krea-2-Turbo) and [Comfy-Org's pinned files](https://huggingface.co/Comfy-Org/Krea-2/tree/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96), with the Krea 2 Community License linked by the publisher.
- WAI: [the creator's model version](https://civitai.com/models/827184?modelVersionId=2883731). Access and download permissions are controlled by Civitai and the creator. A configured filename does not prove that this version is available to download or grant permission to use it.

Artifact URLs and expected SHA-256 digests are in [catalog.ts](./catalog.ts). The default Klein VAE comes from the Klein repository; its digest starts with `868fe7b3`. Another published file with the same filename exists in the FLUX.2 dev repository with a different digest. Compare the full digest when selecting an exact artifact.

```sh
sha256sum /models/checkpoints/sd_xl_base_1.0.safetensors
```

The studio does not download weights automatically. Discovery checks filenames and node capabilities through the worker API. It reports `integrity: "filenames-only"`: the standard ComfyUI API does not verify the bytes of installed weights. If you override an artifact filename, the server removes the catalog's expected digest from that resolved artifact.

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
