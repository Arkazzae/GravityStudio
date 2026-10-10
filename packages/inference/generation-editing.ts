import type { GenerationRequest, GraphLink, ModelManifest, ResolvedParameters, WorkflowGraph } from "./types.ts";

function name(image: { filename: string; subfolder: string }): string { return image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename; }

/** One canonical source, shared by reference conditioning, masked sampling and final compositing. */
export function appendEditingGraph(graph: WorkflowGraph, model: ModelManifest, p: ResolvedParameters, request: GenerationRequest): void {
  const masked = !!(request.mask || request.outpaint);
  if (!masked && !p.matchSource) return;
  const sourceWidth = p.width - (p.outpaint?.left ?? 0) - (p.outpaint?.right ?? 0);
  const sourceHeight = p.height - (p.outpaint?.top ?? 0) - (p.outpaint?.bottom ?? 0);
  graph.edit_source = { class_type: "LoadImage", inputs: { image: name(request.images![0]) } };
  graph.edit_rgba = { class_type: "JoinImageWithAlpha", inputs: { image: ["edit_source", 0], alpha: ["edit_source", 1] } };
  graph.edit_size = { class_type: "ImageScale", inputs: { image: ["edit_rgba", 0], upscale_method: "lanczos", width: sourceWidth, height: sourceHeight, crop: "disabled" } };
  let source: GraphLink = ["edit_size", 0], mask: GraphLink = ["edit_mask", 0];
  if (p.outpaint) {
    graph.edit_padding = { class_type: "ImagePadForOutpaint", inputs: { image: source, ...p.outpaint, feathering: 0 } };
    source = ["edit_padding", 0]; mask = ["edit_padding", 1];
  } else if (request.mask) {
    graph.edit_mask_image = { class_type: "LoadImage", inputs: { image: name(request.mask) } };
    graph.edit_mask_size = { class_type: "ImageScale", inputs: { image: ["edit_mask_image", 0], upscale_method: "nearest-exact", width: p.width, height: p.height, crop: "disabled" } };
    graph.edit_mask = { class_type: "ImageToMask", inputs: { image: ["edit_mask_size", 0], channel: "red" } };
  }
  let samplingSource = source, samplingMask = mask;
  if (model.familyId === "qwen-image-2.1" && p.samplingWidth && p.samplingHeight) {
    // Avoid ComfyUI's affected reference grid without resizing the source or
    // moving mask coordinates. Extra sampling margins are cropped before the
    // protected source is composited back onto the canonical edit canvas.
    graph.edit_sampling_padding = { class_type: "ImagePadForOutpaint", inputs: { image: source, left: 0, top: 0, right: p.samplingWidth - p.width, bottom: p.samplingHeight - p.height, feathering: 0 } };
    samplingSource = ["edit_sampling_padding", 0];
    if (masked) {
      graph.edit_sampling_free = { class_type: "SolidMask", inputs: { value: 1, width: p.samplingWidth, height: p.samplingHeight } };
      graph.edit_sampling_protected = { class_type: "InvertMask", inputs: { mask } };
      graph.edit_sampling_mask = { class_type: "MaskComposite", inputs: { destination: ["edit_sampling_free", 0], source: ["edit_sampling_protected", 0], x: 0, y: 0, operation: "subtract" } };
      samplingMask = ["edit_sampling_mask", 0];
    }
    graph.edit_sampling_crop = { class_type: "ImageCrop", inputs: { image: graph.output.inputs.images, width: p.width, height: p.height, x: 0, y: 0 } };
    graph.output.inputs.images = ["edit_sampling_crop", 0];
  }
  // RGB-only VAEs cannot consume source alpha. Qwen 2.1 explicitly supports RGBA.
  graph.edit_rgb = { class_type: "SplitImageWithAlpha", inputs: { image: source } };
  const pixels: GraphLink = model.familyId === "qwen-image-2.1" ? samplingSource : ["edit_rgb", 0];
  if (model.familyId === "qwen-image-2.1") {
    graph.conditioning.inputs["images.image_1"] = samplingSource;
    graph.conditioning.inputs.resolution = 0;
    if (!masked) graph.sample.inputs.latent_image = ["conditioning", 2];
  } else if (model.familyId.startsWith("flux-2-klein")) {
    graph.reference_0_size.inputs.image = pixels;
  } else if (graph.resize) graph.resize.inputs.image = pixels;
  if (!masked) return;
  const vae: GraphLink = model.familyId === "sdxl" ? ["checkpoint", 2] : ["vae", 0];
  graph.edit_encode = { class_type: model.familyId === "sdxl" ? "VAEEncodeForInpaint" : "VAEEncode", inputs: { pixels, vae, ...(model.familyId === "sdxl" ? { mask, grow_mask_by: 6 } : {}) } };
  graph.edit_latent = { class_type: "SetLatentNoiseMask", inputs: { samples: ["edit_encode", 0], mask: samplingMask } };
  graph.sample.inputs.latent_image = ["edit_latent", 0];
  const output = graph.output.inputs.images as GraphLink;
  // Core ImageCompositeMasked aligns RGB/RGBA channels and preserves all source
  // channels outside the edit mask; no VAE roundtrip can alter protected pixels.
  graph.edit_composite = { class_type: "ImageCompositeMasked", inputs: { destination: source, source: output, mask, x: 0, y: 0, resize_source: false } };
  graph.output.inputs.images = ["edit_composite", 0];
}

/** Experimental, bounded diptych recipe from its author's published native graph. */
export function appendIdeogramReference(graph: WorkflowGraph, request: GenerationRequest): void {
  graph.reference_input = { class_type: "LoadImage", inputs: { image: name(request.images![0]) } };
  graph.reference_size = { class_type: "ImageScale", inputs: { image: ["reference_input", 0], upscale_method: "lanczos", width: 1024, height: 1024, crop: "center" } };
  graph.reference_canvas = { class_type: "EmptyImage", inputs: { width: 2048, height: 1024, batch_size: 1, color: 0x808080 } };
  graph.reference_paste = { class_type: "ImageCompositeMasked", inputs: { destination: ["reference_canvas", 0], source: ["reference_size", 0], x: 0, y: 0, resize_source: false } };
  graph.reference_locked = { class_type: "SolidMask", inputs: { value: 0, width: 2048, height: 1024 } };
  graph.reference_free = { class_type: "SolidMask", inputs: { value: 1, width: 1024, height: 1024 } };
  graph.reference_mask = { class_type: "MaskComposite", inputs: { destination: ["reference_locked", 0], source: ["reference_free", 0], x: 1024, y: 0, operation: "add" } };
  graph.reference_encode = { class_type: "VAEEncode", inputs: { pixels: ["reference_paste", 0], vae: ["vae", 0] } };
  graph.reference_latent = { class_type: "SetLatentNoiseMask", inputs: { samples: ["reference_encode", 0], mask: ["reference_mask", 0] } };
  graph.sample.inputs.latent_image = ["reference_latent", 0];
  Object.assign(graph.schedule.inputs, { width: 2048, height: 1024 });
  graph.reference_crop = { class_type: "ImageCrop", inputs: { image: ["decode", 0], width: 1024, height: 1024, x: 1024, y: 0 } };
  graph.output.inputs.images = ["reference_crop", 0];
}
