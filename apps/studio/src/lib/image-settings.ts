interface ImageSizeModel {
  defaults: { width: number; height: number };
  dimensions?: { min: number; max: number; multiple: number; maxPixels: number };
  limits?: { width?: { min: number; max: number; step?: number }; height?: { min: number; max: number; step?: number } };
}

export const IMAGE_ASPECT_RATIOS = ['auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9'] as const;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number];

export function imageSizeProblem(model: ImageSizeModel, width: number, height: number): string | null {
  const dimensions = model.dimensions ?? { min: 256, max: 2048, multiple: 16, maxPixels: 2_097_152 };
  for (const [label, value, range] of [['Width', width, model.limits?.width], ['Height', height, model.limits?.height]] as const) {
    const min = range?.min ?? dimensions.min;
    const max = range?.max ?? dimensions.max;
    const step = range?.step ?? dimensions.multiple;
    if (!Number.isFinite(value) || value < min || value > max) return `${label} must be between ${min} and ${max} pixels.`;
    if (value % step !== 0) return `${label} must be a multiple of ${step} pixels.`;
  }
  return width * height > dimensions.maxPixels ? `Keep the image within ${dimensions.maxPixels.toLocaleString('en')} pixels.` : null;
}

export function imageAspectRatio(width: number, height: number): Exclude<ImageAspectRatio, 'auto'> | 'custom' {
  const match = IMAGE_ASPECT_RATIOS.find(aspect => {
    if (aspect === 'auto') return false;
    const [x, y] = aspect.split(':').map(Number);
    return Math.abs(width / height / (x / y) - 1) < .03;
  });
  return match && match !== 'auto' ? match : 'custom';
}

/** Fit the original dock's aspect choices to the model's grid and default pixel budget. */
export function imageSizeForRatio(model: ImageSizeModel, aspect: ImageAspectRatio): { width: number; height: number } | null {
  if (aspect === 'auto') return { width: model.defaults.width, height: model.defaults.height };
  if (!IMAGE_ASPECT_RATIOS.includes(aspect)) return null;
  const [x, y] = aspect.split(':').map(Number);
  const ratio = x / y;
  const dimensions = model.dimensions ?? { min: 256, max: 2048, multiple: 16, maxPixels: 2_097_152 };
  const width = model.limits?.width ?? { min: dimensions.min, max: dimensions.max, step: dimensions.multiple };
  const height = model.limits?.height ?? { min: dimensions.min, max: dimensions.max, step: dimensions.multiple };
  const widthStep = width.step ?? dimensions.multiple;
  const heightStep = height.step ?? dimensions.multiple;
  const pixels = Math.min(dimensions.maxPixels, model.defaults.width * model.defaults.height, width.max ** 2 / ratio, height.max ** 2 * ratio);
  let best: { width: number; height: number } | null = null;
  let bestScore = Infinity;
  for (let w = Math.ceil(width.min / widthStep) * widthStep; w <= width.max; w += widthStep) {
    const units = w / ratio / heightStep;
    for (const n of new Set([Math.floor(units), Math.ceil(units)])) {
      const h = n * heightStep;
      if (h < height.min || h > height.max || w * h > dimensions.maxPixels) continue;
      const error = Math.abs(Math.log(w / h / ratio));
      if (error > .02) continue;
      const score = Math.abs(Math.log(w * h / pixels)) + 8 * error;
      if (score < bestScore) { best = { width: w, height: h }; bestScore = score; }
    }
  }
  return best;
}
