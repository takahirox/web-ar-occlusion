export interface RawDepthFrameEvidence {
  readonly sourceId: string;
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
  readonly rawInverseDepth: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

export interface KnownPlaneAnchor {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
  readonly rawInverseDepth: number;
  readonly distanceMeters: number;
}

export interface MetricCalibrationOptions {
  readonly nowTimestamp: number;
  readonly minimumDistanceMeters?: number;
  readonly maximumDistanceMeters?: number;
  readonly maximumAnchorAgeMs?: number;
  readonly maximumApplicationAgeMs?: number;
  readonly minimumRawSpan?: number;
  readonly maximumInverseDepthRmse?: number;
}

export interface MetricCalibrationModel {
  readonly sourceId: string;
  readonly slope: number;
  readonly intercept: number;
  readonly inverseDepthRmse: number;
  readonly minimumDistanceMeters: number;
  readonly maximumDistanceMeters: number;
  readonly newestAnchorTimestamp: number;
  readonly maximumApplicationAgeMs: number;
  readonly anchorIds: readonly string[];
}

export type MetricCalibrationFit =
  | { readonly valid: true; readonly state: "calibrated"; readonly model: Readonly<MetricCalibrationModel> }
  | { readonly valid: false; readonly state: "relative-only" | "lost"; readonly reason: string };

const DEFAULTS = Object.freeze({ minimumDistanceMeters: 0.1, maximumDistanceMeters: 20, maximumAnchorAgeMs: 60_000, maximumApplicationAgeMs: 60_000, minimumRawSpan: 1e-6, maximumInverseDepthRmse: 0.025 });

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
}

function source(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be non-empty`);
}

function resolveOptions(options: MetricCalibrationOptions) {
  finite(options.nowTimestamp, "nowTimestamp");
  const value = { ...DEFAULTS, ...options };
  if (value.minimumDistanceMeters <= 0 || value.maximumDistanceMeters <= value.minimumDistanceMeters || value.maximumAnchorAgeMs < 0 || value.maximumApplicationAgeMs < 0 || value.minimumRawSpan <= 0 || value.maximumInverseDepthRmse < 0) throw new RangeError("invalid metric calibration limits");
  return value;
}

export function captureKnownPlaneAnchor(input: {
  readonly id: string;
  readonly frame: RawDepthFrameEvidence;
  readonly expectedSourceFrameId: string;
  readonly expectedCaptureTimestamp: number;
  readonly x: number;
  readonly y: number;
  readonly radius?: number;
  readonly distanceMeters: number;
  readonly minimumDistanceMeters?: number;
  readonly maximumDistanceMeters?: number;
}): Readonly<KnownPlaneAnchor> {
  const minimum = input.minimumDistanceMeters ?? DEFAULTS.minimumDistanceMeters;
  const maximum = input.maximumDistanceMeters ?? DEFAULTS.maximumDistanceMeters;
  source(input.id, "anchor id");
  source(input.frame.sourceId, "source id");
  source(input.frame.sourceFrameId, "source frame id");
  finite(input.frame.captureTimestamp, "capture timestamp");
  finite(input.distanceMeters, "known distance");
  if (!Number.isSafeInteger(input.frame.width) || !Number.isSafeInteger(input.frame.height) || input.frame.width <= 0 || input.frame.height <= 0 || input.frame.rawInverseDepth.length !== input.frame.width * input.frame.height) throw new TypeError("raw depth dimensions are invalid");
  if (input.frame.sourceFrameId !== input.expectedSourceFrameId || input.frame.captureTimestamp !== input.expectedCaptureTimestamp) throw new Error("anchor source association mismatch");
  if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y) || input.x < 0 || input.y < 0 || input.x >= input.frame.width || input.y >= input.frame.height) throw new RangeError("anchor coordinate is outside the source frame");
  const radius = input.radius ?? 0;
  if (!Number.isSafeInteger(radius) || radius < 0) throw new RangeError("anchor radius must be a non-negative integer");
  if (input.distanceMeters < minimum || input.distanceMeters > maximum) throw new RangeError("known distance is outside the audited range");
  const samples: number[] = [];
  for (let y = Math.max(0, input.y - radius); y <= Math.min(input.frame.height - 1, input.y + radius); y += 1) {
    for (let x = Math.max(0, input.x - radius); x <= Math.min(input.frame.width - 1, input.x + radius); x += 1) {
      const value = Number(input.frame.rawInverseDepth[y * input.frame.width + x]);
      if (Number.isFinite(value)) samples.push(value);
    }
  }
  samples.sort((left, right) => left - right);
  if (samples.length === 0) throw new TypeError("raw anchor depth must contain a finite ROI sample");
  const middle = Math.floor(samples.length / 2);
  const rawInverseDepth = samples.length % 2 === 1 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2;
  return Object.freeze({ id: input.id, sourceId: input.frame.sourceId, sourceFrameId: input.frame.sourceFrameId, captureTimestamp: input.frame.captureTimestamp, rawInverseDepth, distanceMeters: input.distanceMeters });
}

export function fitKnownPlaneCalibration(anchors: readonly KnownPlaneAnchor[], options: MetricCalibrationOptions): MetricCalibrationFit {
  const limits = resolveOptions(options);
  if (anchors.length < 2) return { valid: false, state: "relative-only", reason: "at-least-two-anchors-required" };
  const ordered = [...anchors].sort((left, right) => left.captureTimestamp - right.captureTimestamp || left.sourceFrameId.localeCompare(right.sourceFrameId, "en") || left.id.localeCompare(right.id, "en"));
  if (new Set(ordered.map((anchor) => anchor.id)).size !== ordered.length) return { valid: false, state: "lost", reason: "duplicate-anchor-id" };
  const sourceId = ordered[0]!.sourceId;
  if (ordered.some((anchor) => !anchor.sourceId || !anchor.sourceFrameId || anchor.sourceId !== sourceId || !Number.isFinite(anchor.captureTimestamp) || !Number.isFinite(anchor.rawInverseDepth) || !Number.isFinite(anchor.distanceMeters))) return { valid: false, state: "lost", reason: "invalid-or-mismatched-anchor" };
  if (ordered.some((anchor) => anchor.distanceMeters < limits.minimumDistanceMeters || anchor.distanceMeters > limits.maximumDistanceMeters)) return { valid: false, state: "lost", reason: "anchor-distance-out-of-range" };
  const newest = Math.max(...ordered.map((anchor) => anchor.captureTimestamp));
  if (limits.nowTimestamp < newest || ordered.some((anchor) => limits.nowTimestamp - anchor.captureTimestamp > limits.maximumAnchorAgeMs)) return { valid: false, state: "lost", reason: "stale-anchor" };
  const xs = ordered.map((anchor) => anchor.rawInverseDepth);
  const ys = ordered.map((anchor) => 1 / anchor.distanceMeters);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const denominator = xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  if (Math.max(...xs) - Math.min(...xs) < limits.minimumRawSpan || denominator === 0) return { valid: false, state: "lost", reason: "insufficient-raw-range" };
  const slope = xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index]! - meanY), 0) / denominator;
  const intercept = meanY - slope * meanX;
  const inverseDepthRmse = Math.sqrt(xs.reduce((sum, value, index) => sum + (slope * value + intercept - ys[index]!) ** 2, 0) / xs.length);
  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || slope <= 0) return { valid: false, state: "lost", reason: "non-positive-near-is-larger-slope" };
  if (inverseDepthRmse > limits.maximumInverseDepthRmse) return { valid: false, state: "lost", reason: "residual-too-large" };
  const fitted = xs.map((value) => 1 / (slope * value + intercept));
  if (fitted.some((value) => !Number.isFinite(value) || value < limits.minimumDistanceMeters || value > limits.maximumDistanceMeters)) return { valid: false, state: "lost", reason: "fitted-depth-out-of-range" };
  return { valid: true, state: "calibrated", model: Object.freeze({ sourceId, slope, intercept, inverseDepthRmse, minimumDistanceMeters: limits.minimumDistanceMeters, maximumDistanceMeters: limits.maximumDistanceMeters, newestAnchorTimestamp: newest, maximumApplicationAgeMs: limits.maximumApplicationAgeMs, anchorIds: Object.freeze(ordered.map((anchor) => anchor.id)) }) };
}

export type MetricCalibrationApplication =
  | {
      readonly usable: true;
      readonly state: "calibrated";
      readonly sourceId: string;
      readonly sourceFrameId: string;
      readonly captureTimestamp: number;
      readonly representation: "linear-z";
      readonly scale: "metric";
      readonly unit: "meter";
      readonly linearZ: Float32Array;
      readonly validity: Uint8Array;
    }
  | { readonly usable: false; readonly state: "lost"; readonly reason: string };

export function applyKnownPlaneCalibration(frame: RawDepthFrameEvidence, model: Readonly<MetricCalibrationModel>, nowTimestamp: number): MetricCalibrationApplication {
  source(frame.sourceId, "source id");
  source(frame.sourceFrameId, "source frame id");
  finite(frame.captureTimestamp, "capture timestamp");
  finite(nowTimestamp, "application timestamp");
  if (frame.sourceId !== model.sourceId) return { usable: false, state: "lost", reason: "source-mismatch" };
  if (nowTimestamp < frame.captureTimestamp) return { usable: false, state: "lost", reason: "source-frame-from-future" };
  if (nowTimestamp - frame.captureTimestamp > model.maximumApplicationAgeMs) return { usable: false, state: "lost", reason: "source-frame-stale" };
  if (nowTimestamp - model.newestAnchorTimestamp > model.maximumApplicationAgeMs) return { usable: false, state: "lost", reason: "calibration-stale" };
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width <= 0 || frame.height <= 0 || frame.rawInverseDepth.length !== frame.width * frame.height) return { usable: false, state: "lost", reason: "depth-dimension-mismatch" };
  const linearZ = new Float32Array(frame.rawInverseDepth.length);
  const validity = new Uint8Array(frame.rawInverseDepth.length);
  for (let index = 0; index < linearZ.length; index += 1) {
    const raw = Number(frame.rawInverseDepth[index]);
    const inverseMeters = model.slope * raw + model.intercept;
    const z = 1 / inverseMeters;
    if (Number.isFinite(raw) && Number.isFinite(z) && inverseMeters > 0 && z >= model.minimumDistanceMeters && z <= model.maximumDistanceMeters) { linearZ[index] = z; validity[index] = 1; }
  }
  return {
    usable: true,
    state: "calibrated",
    sourceId: frame.sourceId,
    sourceFrameId: frame.sourceFrameId,
    captureTimestamp: frame.captureTimestamp,
    representation: "linear-z",
    scale: "metric",
    unit: "meter",
    linearZ,
    validity
  };
}
