import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileGeneration, listModels } from '../../packages/inference/index.ts';
import { FAMILY_RECIPES } from '../../packages/inference/catalog.ts';
import { IMAGE_ASPECT_RATIOS, imageAspectRatio, imageSizeForRatio, imageSizeProblem } from '../../apps/studio/src/lib/image-settings.ts';

test('dock aspect choices compile for every image model within its grid and pixel budget', () => {
  for (const model of listModels()) {
    const baseline = compileGeneration({ modelId: model.id, prompt: 'A ceramic cup', seed: 1 });
    const dimensions = FAMILY_RECIPES[model.familyId].dimensions;
    for (const aspect of IMAGE_ASPECT_RATIOS) {
      const size = imageSizeForRatio({ defaults: baseline.parameters, dimensions }, aspect);
      assert.ok(size, `${model.id} supports ${aspect}`);
      const snapshot = compileGeneration({ modelId: model.id, prompt: 'A ceramic cup', seed: 1, ...size });
      assert.equal(snapshot.parameters.width, size.width);
      assert.equal(snapshot.parameters.height, size.height);
      assert.equal(size.width % dimensions.multiple, 0);
      assert.equal(size.height % dimensions.multiple, 0);
      assert.ok(size.width * size.height <= dimensions.maxPixels);
      assert.equal(imageSizeProblem({ defaults: baseline.parameters, dimensions }, size.width, size.height), null);
      assert.ok(Math.abs(size.width * size.height / (baseline.parameters.width * baseline.parameters.height) - 1) < .1, 'Changing shape keeps the default pixel budget');
      if (aspect === 'auto') assert.deepEqual(size, { width: baseline.parameters.width, height: baseline.parameters.height });
      else assert.equal(imageAspectRatio(size.width, size.height), aspect);
    }
  }
});

test('aspect fitting respects tighter limits and leaves unavailable shapes disabled', () => {
  const defaults = { width: 1024, height: 1024 };
  const dimensions = { min: 256, max: 2048, multiple: 16, maxPixels: 512 * 512 };
  const limited = imageSizeForRatio({ defaults, dimensions }, '16:9');
  assert.ok(limited);
  assert.ok(limited.width * limited.height <= dimensions.maxPixels);
  assert.equal(imageSizeForRatio({ defaults, dimensions: { ...dimensions, min: 512, max: 512 } }, '16:9'), null);
  assert.equal(imageAspectRatio(1200, 1000), 'custom');
});

test('manual dimensions cannot submit outside the model grid or shared pixel limit', () => {
  const model = { defaults: FAMILY_RECIPES.sdxl.defaults, dimensions: FAMILY_RECIPES.sdxl.dimensions };
  for (const [width, height] of [[2048, 2048], [1025, 1024], [1024, 257], [0, 1024], [NaN, 1024], [1024, Infinity]]) assert.ok(imageSizeProblem(model, width, height));
  assert.equal(imageSizeProblem(model, 2048, 1024), null);
});
