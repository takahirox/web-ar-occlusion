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
