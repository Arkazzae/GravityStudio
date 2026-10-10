import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskDimensionsValid, maskPoint, maskRgba, rasterizeMask, MAX_MASK_POINTS, MAX_MASK_STROKES } from '../../apps/studio/src/lib/image-mask.ts';

test('mask coordinates refer to source pixels independently of preview scale and clamp to the image', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 };
  assert.deepEqual(maskPoint(110, 70, rect, 1600, 800), { x: 800, y: 400 });
  assert.deepEqual(maskPoint(-50, 500, rect, 1600, 800), { x: 0, y: 799 });
  assert.equal(maskPoint(10, 20, { ...rect, width: 0 }, 1600, 800), null);
  assert.equal(maskPoint(Infinity, 20, rect, 1600, 800), null);
});

test('round brush strokes edit a continuous capsule with untouched black pixels outside it', () => {
  const pixels = rasterizeMask(8, 5, [{ points: [{ x: 1, y: 2 }, { x: 6, y: 2 }], radius: 1, erase: false }]);
  assert.equal(pixels.length, 40);
  assert.deepEqual([...pixels.slice(0, 8)], Array(8).fill(0));
  assert.deepEqual([...pixels.slice(16, 24)], Array(8).fill(255));
  assert.deepEqual([...pixels.slice(8, 16)], [0, 255, 255, 255, 255, 255, 255, 0]);
  assert.deepEqual([...new Set(pixels)].sort(), [0, 255]);
});

test('erase and undo replay vector strokes without mutating the original mask', () => {
  const base = Uint8Array.from([0, 127, 128, 255, 255, 255, 255, 255, 0]);
  const stroke = { points: [{ x: 1, y: 1 }], radius: .5, erase: true };
  const erased = rasterizeMask(3, 3, [stroke], base);
  assert.equal(erased[4], 0);
  assert.equal(base[4], 255);
  assert.equal(rasterizeMask(3, 3, [], base)[4], 255);
  assert.deepEqual([...rasterizeMask(3, 3, [], base)].slice(0, 3), [0, 0, 255]);
});

test('PNG output strips are binary RGB and fully opaque, including unchanged pixels', () => {
  assert.deepEqual([...maskRgba(Uint8Array.from([0, 127, 128, 255]), 1, 3)], [0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
  assert.throws(() => maskRgba(new Uint8Array(3), 2, 2));
});

test('mask allocations and vector histories have explicit limits before allocation', () => {
  assert.equal(maskDimensionsValid(4096, 4096), true);
  for (const [width, height] of [[4097, 4096], [32769, 1], [0, 1], [1.5, 3], [Infinity, 1]]) assert.equal(maskDimensionsValid(width, height), false);
  const dot = { points: [{ x: 0, y: 0 }], radius: 1, erase: false };
  assert.throws(() => rasterizeMask(1, 1, Array(MAX_MASK_STROKES + 1).fill(dot)));
  assert.throws(() => rasterizeMask(1, 1, [{ ...dot, points: Array(MAX_MASK_POINTS + 1).fill({ x: 0, y: 0 }) }]));
  assert.throws(() => rasterizeMask(4097, 4096, []));
  assert.throws(() => rasterizeMask(2, 2, [], new Uint8Array(3)));
  for (const radius of [0, NaN, Infinity, 2049]) assert.throws(() => rasterizeMask(1, 1, [{ ...dot, radius }]));
  assert.throws(() => rasterizeMask(1, 1, [{ ...dot, points: [{ x: NaN, y: 0 }] }]));
});
