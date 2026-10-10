import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IMAGE_ASPECT_RATIOS, fitImageSize, imageQualityForSize, imageQualityPresets,
  imageSizeForQuality, imageSizeForRatio, imageSizeProblem,
} from '../../apps/studio/src/lib/image-settings.ts';
import type { ImageQualityPreset, ImageSizeModel } from '../../apps/studio/src/lib/image-settings.ts';

function presets(fast: number, standard: number, high: number): ImageQualityPreset[] {
  return [{ id: 'fast', pixels: fast }, { id: 'standard', pixels: standard }, { id: 'high', pixels: high }];
}

const models: Record<string, ImageSizeModel> = {
  sdxl: { defaults: { width: 1024, height: 1024 }, dimensions: { min: 256, max: 2048, multiple: 8, maxPixels: 2_097_152 }, qualityPresets: presets(768 ** 2, 896 ** 2, 1024 ** 2).map(preset => ({ ...preset, minSide: 512 })) },
  flux: { defaults: { width: 1024, height: 1024 }, dimensions: { min: 256, max: 2048, multiple: 16, maxPixels: 2_097_152 }, qualityPresets: presets(768 ** 2, 1024 ** 2, 2_097_152) },
  krea: { defaults: { width: 1024, height: 1024 }, dimensions: { min: 256, max: 2048, multiple: 16, maxPixels: 4_194_304 }, qualityPresets: presets(1024 ** 2, 2_097_152, 2048 ** 2) },
  qwen: { defaults: { width: 1024, height: 1024 }, dimensions: { min: 256, max: 4096, multiple: 32, maxPixels: 4_400_000 }, qualityPresets: presets(1024 ** 2, 2_097_152, 2048 ** 2) },
  ideogram: { defaults: { width: 1024, height: 1024 }, dimensions: { min: 256, max: 2048, multiple: 16, maxPixels: 4_194_304 }, qualityPresets: presets(1024 ** 2, 2_097_152, 2048 ** 2) },
};

test('every family grid supports all quality and aspect combinations within the model limits', () => {
  for (const [name, model] of Object.entries(models)) {
    const dimensions = model.dimensions!;
    for (const preset of imageQualityPresets(model)) {
      for (const aspect of IMAGE_ASPECT_RATIOS) {
        const context = `${name}: ${preset.id}, ${aspect}`;
        const size = imageSizeForQuality(model, preset.id, aspect);
        assert.ok(size, context);
        assert.equal(imageSizeProblem(model, size.width, size.height), null, context);
        const ratio = aspect === 'auto' ? model.defaults.width / model.defaults.height : aspect.split(':').map(Number).reduce((x, y) => x / y);
        assert.ok(Math.abs(size.width / size.height / ratio - 1) <= .02, context);
        const attainablePixels = Math.min(preset.pixels, dimensions.maxPixels, dimensions.max ** 2 / ratio, dimensions.max ** 2 * ratio);
        assert.ok(Math.abs(size.width * size.height / attainablePixels - 1) < .1, context);
        const classified = imageQualityForSize(model, size.width, size.height, aspect);
        assert.notEqual(classified, 'custom', context);
        // At a long-side cap, two qualities can legitimately produce the same dimensions.
        if (classified !== 'custom') assert.deepEqual(imageSizeForQuality(model, classified, aspect), size, context);
      }
    }
  }
});

test('High resolution survives shape changes and Auto uses the default shape at High resolution', () => {
  const model = models.flux;
  const square = imageSizeForQuality(model, 'high', '1:1')!;
  const landscape = imageSizeForQuality(model, 'high', '16:9')!;
  const portrait = imageSizeForQuality(model, 'high', '9:16')!;
  for (const [aspect, size] of [['1:1', square], ['16:9', landscape], ['9:16', portrait]] as const) {
    assert.equal(imageQualityForSize(model, size.width, size.height, aspect), 'high');
    assert.ok(size.width * size.height > 1_900_000);
  }
  assert.deepEqual(imageSizeForQuality(model, 'high', 'auto'), square);
  assert.notDeepEqual(square, model.defaults);
  const landscapeDefault = { ...model, defaults: { width: 1536, height: 1024 } };
  assert.deepEqual(imageSizeForQuality(landscapeDefault, 'high', 'auto'), imageSizeForQuality(landscapeDefault, 'high', '3:2'));
});

test('quality changes retain a custom aspect while manual resolution can retain its pixel budget on shape change', () => {
  for (const model of Object.values(models)) {
    const current = { width: 1200, height: 1000 };
    for (const preset of imageQualityPresets(model)) {
      const size = imageSizeForQuality(model, preset.id, 'custom', current);
      assert.ok(size);
      assert.ok(Math.abs(size.width / size.height / 1.2 - 1) <= .02);
      assert.equal(imageSizeProblem(model, size.width, size.height), null);
      assert.equal(imageQualityForSize(model, size.width, size.height, 'custom'), preset.id);
    }
    const changed = imageSizeForRatio(model, '16:9', current.width * current.height)!;
    assert.ok(Math.abs(changed.width * changed.height / (current.width * current.height) - 1) < .1);
    assert.equal(imageQualityForSize(model, changed.width, changed.height, '16:9'), 'custom');
  }
});

test('manual dimensions classify as Custom unless they exactly match the fitted quality at that shape', () => {
  const model = models.flux;
  assert.equal(imageQualityForSize(model, 1024, 1024), 'standard');
  assert.equal(imageQualityForSize(model, 1040, 1024), 'custom');
  assert.equal(imageQualityForSize(model, 1008, 1040, '1:1'), 'custom');
  assert.equal(imageQualityForSize(model, 1025, 1024), 'custom');
  assert.equal(imageQualityForSize(model, 2048, 2048), 'custom');
  assert.equal(imageQualityForSize(model, NaN, 1024), 'custom');
  assert.equal(imageQualityForSize(model, 1024, Infinity), 'custom');
});

test('quality fitting obeys separate axis limits and disables unavailable shapes', () => {
  const limited: ImageSizeModel = {
    ...models.qwen,
    limits: { width: { min: 512, max: 1536, step: 64 }, height: { min: 256, max: 1024, step: 32 } },
  };
  const landscape = imageSizeForQuality(limited, 'high', '16:9')!;
  assert.ok(landscape);
  assert.equal(imageSizeProblem(limited, landscape.width, landscape.height), null);
  assert.ok(landscape.width <= 1536 && landscape.height <= 1024);
  const fixed: ImageSizeModel = { ...models.flux, limits: { width: { min: 512, max: 512 }, height: { min: 512, max: 512 } } };
  assert.equal(imageSizeForQuality(fixed, 'fast', '16:9'), null);
  assert.equal(imageSizeForQuality(models.flux, 'high', 'custom'), null);
  assert.equal(imageSizeForQuality(models.flux, 'high', 'custom', { width: 0, height: 1024 }), null);
  assert.equal(fitImageSize(models.flux, Infinity, 1_048_576), null);
  assert.equal(imageSizeForRatio(models.flux, '1:1', NaN), null);
});

test('quality-specific minimum sides preserve SDXL recommendations without changing manual limits', () => {
  const model = models.sdxl;
  const ultrawide = imageSizeForQuality(model, 'fast', '21:9')!;
  assert.ok(ultrawide.width >= 512 && ultrawide.height >= 512);
  assert.ok(ultrawide.width * ultrawide.height > 768 ** 2, 'The grid can round up to honor the short-side minimum');
  assert.equal(imageQualityForSize(model, ultrawide.width, ultrawide.height, '21:9'), 'fast');
  assert.equal(imageSizeProblem(model, 512, 256), null, 'Manual dimensions retain the underlying family limits');
  const unavailable = { ...model, limits: { height: { min: 256, max: 448, step: 8 } } };
  assert.equal(imageSizeForQuality(unavailable, 'fast', '21:9'), null);
});

test('older catalogs derive model-relative resolution tiers and omit duplicate capped tiers', () => {
  const legacy: ImageSizeModel = { defaults: { width: 1024, height: 1024 } };
  assert.deepEqual(imageQualityPresets(legacy), presets(768 ** 2, 1024 ** 2, 2_097_152));
  assert.equal(imageQualityForSize(legacy, 1024, 1024), 'standard');
  const capped = { ...legacy, dimensions: { min: 256, max: 1024, multiple: 16, maxPixels: 1_048_576 } };
  assert.deepEqual(imageQualityPresets(capped).map(preset => preset.id), ['fast', 'standard']);
  assert.equal(imageSizeForQuality(capped, 'high', '1:1'), null);
  assert.deepEqual(imageQualityPresets({ ...legacy, qualityPresets: [] }), []);
});
