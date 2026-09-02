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
