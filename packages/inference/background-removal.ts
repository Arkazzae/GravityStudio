import { BIREFNET_ARTIFACT, BIREFNET_MEMORY, isRelativeFile } from "./catalog.ts";
import { snapshotHash, validateInputImage } from "./compiler.ts";
import { InferenceError } from "./types.ts";
import type { BackgroundRemovalSnapshot, InputImage, WorkflowGraph } from "./types.ts";

export const BACKGROUND_REMOVAL_MODEL = {
  id: "birefnet" as const, name: "BiRefNet", familyId: "birefnet" as const, revision: "1" as const,
  artifacts: [{ ...BIREFNET_ARTIFACT }], memory: { ...BIREFNET_MEMORY },
};

/** Segmentation retains the original canvas and intersects its existing alpha. */
export function compileBackgroundRemoval(request: { image: InputImage; sourceWidth: number; sourceHeight: number }, model: BackgroundRemovalSnapshot["model"] = BACKGROUND_REMOVAL_MODEL): BackgroundRemovalSnapshot {
  if (!request || typeof request !== "object" || Object.keys(request).some(key => !["image", "sourceWidth", "sourceHeight"].includes(key))) throw new InferenceError("INVALID_INPUT", "Choose an image to remove its background.");
  const { sourceWidth, sourceHeight } = request;
  if (![sourceWidth, sourceHeight].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || sourceWidth * sourceHeight > 16_777_216) throw new InferenceError("INVALID_INPUT", "Background removal supports images up to 16 megapixels and 8192 pixels per side.");
  validateInputImage(request.image);
  if (model.id !== "birefnet" || model.familyId !== "birefnet" || model.artifacts.length !== 1 || model.artifacts[0].role !== "background-removal" || model.artifacts[0].folder !== "background_removal" || !isRelativeFile(model.artifacts[0].filename)) throw new InferenceError("INVALID_MODEL", "Choose the supported BiRefNet background removal model.");
  const image = request.image.subfolder ? `${request.image.subfolder}/${request.image.filename}` : request.image.filename;
  const graph: WorkflowGraph = {
    source: { class_type: "LoadImage", inputs: { image } },
    model: { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: model.artifacts[0].filename } },
    foreground: { class_type: "RemoveBackground", inputs: { bg_removal_model: ["model", 0], image: ["source", 0] } },
    original_opacity: { class_type: "InvertMask", inputs: { mask: ["source", 1] } },
    opacity: { class_type: "MaskComposite", inputs: { destination: ["foreground", 0], source: ["original_opacity", 0], x: 0, y: 0, operation: "multiply" } },
    alpha: { class_type: "InvertMask", inputs: { mask: ["opacity", 0] } },
    rgba: { class_type: "JoinImageWithAlpha", inputs: { image: ["source", 0], alpha: ["alpha", 0] } },
    output: { class_type: "SaveImage", inputs: { images: ["rgba", 0], filename_prefix: "grav-cutout" } },
  };
  const content: Omit<BackgroundRemovalSnapshot, "hash"> = {
    schemaVersion: 1, recipe: { familyId: "birefnet", revision: "1", operation: "remove-background" },
    model: structuredClone(model), parameters: { sourceWidth, sourceHeight, width: sourceWidth, height: sourceHeight },
    inputs: [structuredClone(request.image)], graph, outputs: [{ node: "output", field: "images" }],
  };
  return { ...content, hash: snapshotHash(content) };
}
