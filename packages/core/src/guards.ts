import type { CalibrationState, DepthFrame } from "./contracts.ts";

export type DepthFrameGuardReason =
  | "invalid-frame"
  | "invalid-width"
  | "invalid-height"
  | "invalid-capture-timestamp"
  | "invalid-source-frame-id"
  | "invalid-uv-transform"
  | "missing-depth-texture"
  | "missing-confidence-texture"
  | "invalid-representation"
  | "invalid-scale-unit-pair";

export type GuardResult<T, R extends string> =
  | { ok: true; value: T }
  | { ok: false; reason: R };

export function validateDepthFrame(
  value: unknown,
): GuardResult<DepthFrame, DepthFrameGuardReason> {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "invalid-frame" };
  }

  const frame = value as Record<string, unknown>;
  if (!Number.isInteger(frame.width) || (frame.width as number) <= 0) {
    return { ok: false, reason: "invalid-width" };
  }
  if (!Number.isInteger(frame.height) || (frame.height as number) <= 0) {
    return { ok: false, reason: "invalid-height" };
  }
  if (typeof frame.captureTimestamp !== "number" || !Number.isFinite(frame.captureTimestamp)) {
    return { ok: false, reason: "invalid-capture-timestamp" };
  }
  if (typeof frame.sourceFrameId !== "string" || frame.sourceFrameId.length === 0) {
    return { ok: false, reason: "invalid-source-frame-id" };
  }
  if (
    !(frame.uvTransform instanceof Float32Array) ||
    frame.uvTransform.length === 0 ||
    !frame.uvTransform.every(Number.isFinite)
  ) {
    return { ok: false, reason: "invalid-uv-transform" };
  }
  if (frame.depth == null) {
    return { ok: false, reason: "missing-depth-texture" };
  }
  if (frame.confidence == null) {
    return { ok: false, reason: "missing-confidence-texture" };
  }
  if (frame.representation !== "linear-z" && frame.representation !== "inverse-z") {
    return { ok: false, reason: "invalid-representation" };
  }
  if (
    !(
      (frame.scale === "metric" && frame.unit === "meter") ||
      (frame.scale === "relative" && frame.unit === null)
    )
  ) {
    return { ok: false, reason: "invalid-scale-unit-pair" };
  }

  return { ok: true, value: value as DepthFrame };
}

export interface CanonicalDepthSample {
  depth: number;
  confidence: number;
}

export function canonicalizeDepthSample(
  depth: number,
  confidence: number,
): CanonicalDepthSample {
  if (!Number.isFinite(depth) || depth <= 0) {
    return { depth: Number.NaN, confidence: 0 };
  }

  return {
    depth,
    confidence: Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : 0,
  };
}

export type CalibrationGuardReason =
  | "relative-only"
  | "lost"
  | "missing-canonical-depth-texture";

export type MetricCalibration = {
  status: "calibrated";
  canonicalDepthTexture: GPUTexture;
};

export function guardMetricCalibration(
  calibration: CalibrationState,
): GuardResult<MetricCalibration, CalibrationGuardReason> {
  if (calibration.status === "relative-only") {
    return { ok: false, reason: "relative-only" };
  }
  if (calibration.status === "lost") {
    return { ok: false, reason: "lost" };
  }
  if (calibration.canonicalDepthTexture == null) {
    return { ok: false, reason: "missing-canonical-depth-texture" };
  }

  return { ok: true, value: calibration };
}
