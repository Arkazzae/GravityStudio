export type ImageQuality = 'fast' | 'standard' | 'high';
export interface ImageQualityPreset { id: ImageQuality; pixels: number; minSide?: number }
export interface ImageSizeModel {
  defaults: { width: number; height: number };
  dimensions?: { min: number; max: number; multiple: number; maxPixels: number };
  limits?: { width?: { min: number; max: number; step?: number }; height?: { min: number; max: number; step?: number } };
  qualityPresets?: readonly ImageQualityPreset[];
}

const DEFAULT_DIMENSIONS = { min: 256, max: 2048, multiple: 16, maxPixels: 2_097_152 };

export const IMAGE_ASPECT_RATIOS = ['auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9'] as const;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number];

export function imageSizeProblem(model: ImageSizeModel, width: number, height: number): string | null {
  const dimensions = model.dimensions ?? DEFAULT_DIMENSIONS;
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

/** Fit a shape at an explicit resolution, or retain the model's default resolution. */
export function imageSizeForRatio(model: ImageSizeModel, aspect: ImageAspectRatio, pixels?: number): { width: number; height: number } | null {
  if (aspect === 'auto' && pixels === undefined) return { width: model.defaults.width, height: model.defaults.height };
  if (!IMAGE_ASPECT_RATIOS.includes(aspect)) return null;
  const [x, y] = aspect === 'auto' ? [model.defaults.width, model.defaults.height] : aspect.split(':').map(Number);
  return fitImageSize(model, x / y, pixels ?? model.defaults.width * model.defaults.height);
}

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

/** Older catalog responses still get distinct resolution choices within their limits. */
export function imageQualityPresets(model: ImageSizeModel): ImageQualityPreset[] {
  const dimensions = model.dimensions ?? DEFAULT_DIMENSIONS;
  const maximum = Math.min(dimensions.maxPixels, (model.limits?.width?.max ?? dimensions.max) * (model.limits?.height?.max ?? dimensions.max));
  const standard = Math.min(model.defaults.width * model.defaults.height, maximum);
  const presets = model.qualityPresets ?? [
    { id: 'fast', pixels: standard * .5625 },
    { id: 'standard', pixels: standard },
    { id: 'high', pixels: Math.min(standard * 2, maximum) },
  ];
  const seenPixels = new Set<number>();
  const seenIds = new Set<ImageQuality>();
  return presets.flatMap(preset => {
    const pixels = preset.pixels;
    if (!Number.isFinite(pixels) || pixels <= 0 || seenPixels.has(pixels) || seenIds.has(preset.id)) return [];
    seenPixels.add(pixels);
    seenIds.add(preset.id);
    return [{ ...preset, pixels }];
  });
}

export function imageSizeForQuality(model: ImageSizeModel, quality: ImageQuality, aspect: ImageAspectRatio | 'custom', current?: { width: number; height: number }): { width: number; height: number } | null {
  const preset = imageQualityPresets(model).find(preset => preset.id === quality);
  if (!preset) return null;
  const dimensions = model.dimensions ?? DEFAULT_DIMENSIONS;
  const qualityModel = preset.minSide ? {
    ...model,
    dimensions: { ...dimensions, min: Math.max(dimensions.min, preset.minSide) },
    limits: {
      ...model.limits,
      ...(model.limits?.width ? { width: { ...model.limits.width, min: Math.max(model.limits.width.min, preset.minSide) } } : {}),
      ...(model.limits?.height ? { height: { ...model.limits.height, min: Math.max(model.limits.height.min, preset.minSide) } } : {}),
    },
  } : model;
  if (aspect !== 'custom') return imageSizeForRatio(qualityModel, aspect, preset.pixels);
  if (!current) return null;
  const ratio = current.width / current.height;
  let size = fitImageSize(qualityModel, ratio, preset.pixels);
  // The rounded shape becomes the custom aspect. Settle on that grid so selecting
  // the same quality again does not move a dimension by another grid step.
  const seen = new Set<string>();
  while (size) {
    const key = `${size.width}:${size.height}`;
    if (seen.has(key)) break;
    seen.add(key);
    const next = fitImageSize(qualityModel, size.width / size.height, preset.pixels);
    if (!next || Math.abs(next.width / next.height / ratio - 1) > .02) break;
    size = next;
  }
  return size;
}

/** Only dimensions produced by a preset count as that quality; nearby manual sizes are custom. */
export function imageQualityForSize(model: ImageSizeModel, width: number, height: number, aspect: ImageAspectRatio | 'custom' = imageAspectRatio(width, height)): ImageQuality | 'custom' {
  if (imageSizeProblem(model, width, height)) return 'custom';
  for (const preset of imageQualityPresets(model)) {
    const expected = imageSizeForQuality(model, preset.id, aspect, { width, height });
    if (expected?.width === width && expected.height === height) return preset.id;
  }
  return 'custom';
}
