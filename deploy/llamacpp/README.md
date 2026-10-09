# Local text runtime

Gravity Studio runs the local prompt assistant in one llama.cpp container. Installation downloads its GPU image and model; loading starts when the scheduler grants a GPU reservation. The container has no restart policy. Recovery stops a container left by an interrupted application before new GPU work starts.

The reservation covers a 12 GiB VRAM peak and 12 GiB host RAM budget. It permits image work on the same GPU when the combined budgets, existing allocations and configured reserves fit. Verified resident model buffers count toward the reservation instead of being counted twice. MiMo stays loaded between requests and releases its GPU when idle image work needs that memory or the configured idle timeout expires. Memory on separate GPUs is not pooled.

The first model is [MiMo V2.6 Distill Qwen 9B](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Distill-Qwen-9B), using the [ggml-org Q8_0 conversion](https://huggingface.co/ggml-org/MiMo-V2.6-Distill-Qwen-9B-GGUF/tree/81baddc39bc48924a88e87b8d31aceb03058e559). This MIT-licensed conversion is published by the llama.cpp maintainers, separately from Xiaomi's original BF16 weights. The model download is 9,527,498,048 bytes. The installer verifies its pinned revision and SHA-256 before use.

This text-only configuration preserves the conversion's embedded MiMo chat template, disables thinking for prompt refinement, and uses one request slot with an 8,192-token context. It does not download the optional vision projector. The scheduler owns GPU reservations and decides when to unload an idle model; llama.cpp cannot unload or resize the context automatically.

`runtime.lock.json` pins the official Linux x86-64 images to immutable manifests from llama.cpp commit `3d65c90d04d337e88f2b1f7f0061f40a5324e662` (`b11515`). ROCm 7.2.1 includes `gfx1201` for Radeon AI PRO R9700; CUDA 12.8.1 supports the listed NVIDIA architectures. Architecture compatibility is checked before installation; successful inference on a particular GPU still requires validation on that host. CPU-only hosts can use an external OpenAI-compatible server.

Docker or Podman must already be accessible to the application account. AMD requires `/dev/kfd` and `/dev/dri`; rootless Podman also needs `crun` and device-group access. NVIDIA requires Container Toolkit integration (CDI with Podman), with driver 570.124.06 or newer for this CUDA profile.

Radeon AI PRO R9700 with rootless Podman 4.9.3 has been validated for cold loading, repeated prompt refinement using the same resident container, and memory-pressure eviction followed by image generation. CUDA launch configuration is covered by automated tests; NVIDIA hardware validation is still pending.

The server binds a free loopback port starting at 18401. Its private API key is stored with mode `0600`, mounted as a read-only file, and never placed in container arguments. The model is also mounted read-only. Containers run as the application user with dropped capabilities, a read-only root filesystem and no host-network or privileged access. Ownership labels and immutable container IDs protect unrelated containers during stop and crash recovery.

Upstream references: [ROCm image build](https://github.com/ggml-org/llama.cpp/blob/3d65c90d04d337e88f2b1f7f0061f40a5324e662/.devops/rocm.Dockerfile), [CUDA image build](https://github.com/ggml-org/llama.cpp/blob/3d65c90d04d337e88f2b1f7f0061f40a5324e662/.devops/cuda.Dockerfile), [server options and API](https://github.com/ggml-org/llama.cpp/blob/3d65c90d04d337e88f2b1f7f0061f40a5324e662/tools/server/README.md).
