/** Pure canvas fitting shared by the composer and generation compiler. */
export interface ImageSizeModel {
  defaults: { width: number; height: number };
  dimensions?: { min: number; max: number; multiple: number; maxPixels: number };
  limits?: { width?: { min: number; max: number; step?: number }; height?: { min: number; max: number; step?: number } };
}
const DEFAULT_DIMENSIONS = { min: 256, max: 2048, multiple: 16, maxPixels: 2_097_152 };

/** Search the model's grid while keeping the requested shape within 2%. */
export function fitImageSize(model: ImageSizeModel, ratio: number, requestedPixels: number): { width: number; height: number } | null {
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(requestedPixels) || requestedPixels <= 0) return null;
  const dimensions = model.dimensions ?? DEFAULT_DIMENSIONS;
  const width = model.limits?.width ?? { min: dimensions.min, max: dimensions.max, step: dimensions.multiple };
  const height = model.limits?.height ?? { min: dimensions.min, max: dimensions.max, step: dimensions.multiple };
  const widthStep = width.step ?? dimensions.multiple;
  const heightStep = height.step ?? dimensions.multiple;
  if (widthStep <= 0 || heightStep <= 0) return null;
  const pixels = Math.min(dimensions.maxPixels, requestedPixels, width.max ** 2 / ratio, height.max ** 2 * ratio);
  let best: { width: number; height: number } | null = null;
  let bestScore = Infinity;
  for (let w = Math.ceil(width.min / widthStep) * widthStep; w <= width.max; w += widthStep) {
    const units = w / ratio / heightStep;
    for (const n of new Set([Math.floor(units), Math.ceil(units)])) {
      const h = n * heightStep;
      if (h < height.min || h > height.max || w * h > dimensions.maxPixels) continue;
      const error = Math.abs(Math.log(w / h / ratio));
      if (Math.abs(w / h / ratio - 1) > .02) continue;
      const score = Math.abs(Math.log(w * h / pixels)) + 8 * error;
      if (score < bestScore) { best = { width: w, height: h }; bestScore = score; }
    }
  }
  return best;
}

/** Native SeedVR2 postprocessing trims odd sides; keep the 4K canvas even. */
export function ultraOutputSize(width: number, height: number): { width: number; height: number } {
  const factor = 4096 / Math.max(width, height);
  return { width: Math.max(2, 2 * Math.round(width * factor / 2)), height: Math.max(2, 2 * Math.round(height * factor / 2)) };
}
