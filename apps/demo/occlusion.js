/**
 * Maps sphere geometry into a strict subrange of frame-normalized inverse depth.
 * This is diagnostic ordering, not metric depth: endpoint headroom lets 1 occlude
 * the center while keeping background 0 from occluding every sphere fragment.
 */
export const DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM = 0.05;
export const DIAGNOSTIC_RELATIVE_DEPTH_CEILING =
  1 - DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM;

export function mapSphereRelativeDepthForDiagnosticOcclusion(sphereRelativeDepth) {
  if (!Number.isFinite(sphereRelativeDepth)) {
    throw new TypeError('Sphere relative depth must be finite.');
  }
  const clamped = Math.min(1, Math.max(0, sphereRelativeDepth));
  return DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM +
    clamped * (DIAGNOSTIC_RELATIVE_DEPTH_CEILING - DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM);
}

export function isDiagnosticSphereFragmentOccluded(
  realRelativeDepth,
  sphereRelativeDepth,
  depthValid
) {
  return depthValid &&
    Number.isFinite(realRelativeDepth) &&
    Number.isFinite(sphereRelativeDepth) &&
    realRelativeDepth > mapSphereRelativeDepthForDiagnosticOcclusion(sphereRelativeDepth);
}

export function updateMetricCrossing(previousOccluded, realZ, virtualZ, entryHysteresis, exitHysteresis, valid) {
  if (!valid || !Number.isFinite(realZ) || realZ <= 0 || !Number.isFinite(virtualZ) || virtualZ <= 0 || !Number.isFinite(entryHysteresis) || entryHysteresis < 0 || !Number.isFinite(exitHysteresis) || exitHysteresis < 0) return false;
  return previousOccluded
    ? realZ < virtualZ + exitHysteresis
    : realZ < virtualZ - entryHysteresis;
}

export function updateMetricCrossingMask(previous, linearZ, validity, virtualZ, entryHysteresis, exitHysteresis) {
  if (linearZ.length !== validity.length || (previous !== null && previous.length !== linearZ.length)) throw new TypeError("crossing buffers must have matching lengths");
  const output = new Uint8Array(linearZ.length);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = updateMetricCrossing(
      (previous?.[index] ?? 0) !== 0,
      linearZ[index],
      virtualZ,
      entryHysteresis,
      exitHysteresis,
      validity[index] === 1,
    ) ? 255 : 0;
  }
  return output;
}

export function sampleMetricDepthProbe(linearZ, validity, width, height, normalizedX, normalizedY, radius = 2) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || linearZ.length !== width * height || validity.length !== linearZ.length) {
    throw new TypeError('metric probe buffers must match positive integer dimensions');
  }
  if (!Number.isFinite(normalizedX) || !Number.isFinite(normalizedY) || normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
    throw new RangeError('metric probe coordinates must be normalized');
  }
  if (!Number.isSafeInteger(radius) || radius < 0) throw new RangeError('metric probe radius must be a non-negative integer');

  const centerX = Math.min(width - 1, Math.floor(normalizedX * width));
  const centerY = Math.min(height - 1, Math.floor(normalizedY * height));
  const samples = [];
  for (let y = Math.max(0, centerY - radius); y <= Math.min(height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(width - 1, centerX + radius); x += 1) {
      const index = y * width + x;
      const depth = Number(linearZ[index]);
      if (validity[index] === 1 && Number.isFinite(depth) && depth > 0) samples.push(depth);
    }
  }
  if (samples.length === 0) return Object.freeze({ valid: false, centerX, centerY, sampleCount: 0 });
  samples.sort((left, right) => left - right);
  const middle = Math.floor(samples.length / 2);
  const depthMeters = samples.length % 2 === 1 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
  return Object.freeze({ valid: true, centerX, centerY, sampleCount: samples.length, depthMeters });
}
