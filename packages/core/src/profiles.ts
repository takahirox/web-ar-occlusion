import type { QualityProfile, QualityProfileName } from "./contracts.js";

export const QUALITY_PROFILES: Readonly<
  Record<QualityProfileName, QualityProfile>
> = Object.freeze({
  performance: Object.freeze({
    inferenceHz: 8,
    inputSize: Object.freeze([320, 192] as const),
    maxDepthAgeMs: 250,
    edgeRefinement: false,
    opticalFlow: false,
    segmentation: false,
  }),
  balanced: Object.freeze({
    inferenceHz: 12,
    inputSize: Object.freeze([384, 224] as const),
    maxDepthAgeMs: 250,
    edgeRefinement: true,
    opticalFlow: false,
    segmentation: false,
  }),
  quality: Object.freeze({
    inferenceHz: 18,
    inputSize: Object.freeze([480, 270] as const),
    maxDepthAgeMs: 200,
    edgeRefinement: true,
    opticalFlow: false,
    segmentation: false,
  }),
});

export const ADAPTIVE_QUALITY_CONTROL = Object.freeze({
  downgrade: Object.freeze({
    gpuP95MsAbove: 14,
    gpuP95DurationMs: 2_000,
    droppedFramesPercentAbove: 5,
  }),
  recovery: Object.freeze({
    gpuP95MsBelow: 10,
    droppedFramesPercentBelow: 1,
    continuousDurationMs: 10_000,
  }),
  cooldownMs: 10_000,
});

export const QUALITY_PROFILE_ORDER: readonly QualityProfileName[] = Object.freeze([
  "quality",
  "balanced",
  "performance",
]);
