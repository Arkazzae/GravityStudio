import type { ImageBackground, StudioModel } from './api';

export const imageBackgroundLabels: Record<ImageBackground, string> = { auto: 'Auto', opaque: 'Opaque', transparent: 'Transparent' };

export function imageBackground(value: unknown): ImageBackground {
  return value === 'opaque' || value === 'transparent' ? value : 'auto';
}

export function imageBackgroundProblem(model: StudioModel | undefined, background: ImageBackground): string | null {
  if (background !== 'transparent' || model?.capabilities?.background?.available) return null;
  return model?.capabilities?.background?.reason || 'Transparent background is unavailable for this model.';
}
