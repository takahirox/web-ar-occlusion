import assert from 'node:assert/strict';
import test from 'node:test';

import { rgbGuidedMedian5x5 } from '../main.js';

function opaquePixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) pixels[index * 4 + 3] = 255;
  return pixels;
}

test('RGB-guided median uses the fixed 5x5 neighborhood', () => {
  const width = 5;
  const height = 5;
  const values = new Float32Array(width * height).fill(1);
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) values[y * width + x] = 9;
  }

  const output = rgbGuidedMedian5x5(values, opaquePixels(width, height), width, height);

  assert.equal(output[2 * width + 2], 1);
  assert.equal(values[2 * width + 2], 9);
});

test('RGB-guided median includes distance 24 and excludes distance 25', () => {
  const width = 3;
  const height = 1;
  const values = Float32Array.of(1, 10, 20);
  const pixels = opaquePixels(width, height);
  pixels[0] = 24;
  pixels[8] = 25;

  const withBoundaryNeighbor = rgbGuidedMedian5x5(values, pixels, width, height);

  assert.equal(withBoundaryNeighbor[1], 1);

  pixels[0] = 25;
  const withBothNeighborsRejected = rgbGuidedMedian5x5(values, pixels, width, height);

  assert.equal(withBothNeighborsRejected[1], 10);
});
