import type { StudioModel } from './api';

export interface Brand {
  family: string;
  src: string | null;
  initial: string;
}

const catalogBrands: Record<string, { family: string; file?: string }> = {
  'sdxl-base': { family: 'SDXL', file: 'stability.svg' },
  'wai-illustrious-v17': { family: 'Illustrious' },
  'flux-2-klein-4b': { family: 'FLUX', file: 'flux.svg' },
  'flux-2-klein-9b': { family: 'FLUX', file: 'flux.svg' },
  'krea-2-turbo': { family: 'Krea', file: 'krea.svg' },
  'qwen-image-2.1': { family: 'Qwen', file: 'qwen.svg' },
  'ideogram-4-fp8': { family: 'Ideogram', file: 'ideogram.svg' },
};

/** Known publishers use their own marks; imported checkpoints keep their own initial. */
export function modelBrand(model: Pick<StudioModel, 'id' | 'name' | 'family'>): Brand {
  const known = Object.hasOwn(catalogBrands, model.id) ? catalogBrands[model.id] : undefined;
  return {
    family: known?.family ?? model.family,
    src: known?.file ? `/brands/${known.file}` : null,
    initial: (Array.from(model.name.trim())[0] || '?').toLocaleUpperCase(),
  };
}
