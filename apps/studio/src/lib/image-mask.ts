/** A bounded vector history; white edits a pixel and black preserves it. */
export interface MaskPoint { x: number; y: number }
export interface MaskStroke { points: MaskPoint[]; radius: number; erase: boolean }
export const MAX_MASK_PIXELS = 16_777_216;
export const MAX_MASK_STROKES = 128;
export const MAX_MASK_POINTS = 8192;

export function maskDimensionsValid(width: number, height: number): boolean {
  return [width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 32768) && width * height <= MAX_MASK_PIXELS;
}

/** Pointer coordinates stay in original-image pixels at every display size. */
export function maskPoint(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, width: number, height: number): MaskPoint | null {
  if (![x, y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || !maskDimensionsValid(width, height)) return null;
  return { x: Math.max(0, Math.min(width - 1, (x - rect.left) / rect.width * width)), y: Math.max(0, Math.min(height - 1, (y - rect.top) / rect.height * height)) };
}

/** Render round brush capsules without antialiasing or transparent mask pixels. */
export function rasterizeMask(width: number, height: number, strokes: readonly MaskStroke[], base?: Uint8Array): Uint8Array {
  if (!maskDimensionsValid(width, height) || strokes.length > MAX_MASK_STROKES || strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) > MAX_MASK_POINTS || base && base.length !== width * height) throw new Error('The mask exceeds the editor limits.');
  const pixels = base ? Uint8Array.from(base, value => value >= 128 ? 255 : 0) : new Uint8Array(width * height);
  for (const stroke of strokes) {
    if (!Number.isFinite(stroke.radius) || stroke.radius < .5 || stroke.radius > 2048 || !stroke.points.length || stroke.points.some(point => ![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.x > width - 1 || point.y < 0 || point.y > height - 1)) throw new Error('The mask contains an invalid brush stroke.');
    const radiusSquared = stroke.radius ** 2;
    for (let index = 0; index < stroke.points.length; index++) {
      const a = stroke.points[Math.max(0, index - 1)], b = stroke.points[index];
      const dx = b.x - a.x, dy = b.y - a.y, distanceSquared = dx * dx + dy * dy;
      const left = Math.max(0, Math.floor(Math.min(a.x, b.x) - stroke.radius)), right = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + stroke.radius));
      const top = Math.max(0, Math.floor(Math.min(a.y, b.y) - stroke.radius)), bottom = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + stroke.radius));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const t = distanceSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / distanceSquared)) : 0;
        if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= radiusSquared) pixels[y * width + x] = stroke.erase ? 0 : 255;
      }
    }
  }
  return pixels;
}

/** Fill a bounded output strip; PNG export never needs a second full RGBA copy. */
export function maskRgba(pixels: Uint8Array, start: number, count: number): Uint8ClampedArray<ArrayBuffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > pixels.length) throw new Error('Invalid mask region.');
  const rgba = new Uint8ClampedArray(count * 4);
  for (let index = 0; index < count; index++) {
    const value = pixels[start + index] >= 128 ? 255 : 0, offset = index * 4;
    rgba[offset] = value; rgba[offset + 1] = value; rgba[offset + 2] = value; rgba[offset + 3] = 255;
  }
  return rgba;
}
