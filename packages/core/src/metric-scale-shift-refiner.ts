export type MetricRefinementStage = "approximate" | "refining" | "stable";
export type MetricRefinementReason =
  | "native-prior"
  | "refined"
  | "out-of-order"
  | "association-break"
  | "low-support"
  | "insufficient-depth-span"
  | "ambiguous-fit"
  | "scene-change"
  | "fit-out-of-bounds";
export type MetricRefinementGuidance =
  | "collecting-temporal-evidence"
  | "passive-refinement-active"
  | "temporally-stable-not-ground-truth"
  | "using-unrefined-native-prior";

export interface MetricRefinerFrame {
  readonly sourceId: string;
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
  readonly width: number;
  readonly height: number;
  readonly linearZ: Float32Array;
  readonly validity: Uint8Array;
}

export interface MetricRefinerDiagnostics {
  readonly applied: boolean;
  readonly scale: number;
  readonly shiftMeters: number;
  readonly supportCount: number;
  readonly inlierCount: number;
  readonly residualRmseMeters: number | null;
  readonly normalizedResidual: number | null;
  readonly stage: MetricRefinementStage;
  readonly reason: MetricRefinementReason;
  readonly guidance: MetricRefinementGuidance;
}

export interface MetricRefinerOutput extends MetricRefinerFrame {
  readonly diagnostics: MetricRefinerDiagnostics;
}

export interface MetricScaleShiftRefinerState {
  readonly previous: MetricRefinerFrame | null;
  readonly scale: number;
  readonly shiftMeters: number;
  readonly acceptedUpdates: number;
  readonly settledUpdates: number;
  readonly normalizedResidualEma: number | null;
}

const GRID_COLUMNS = 16;
const GRID_ROWS = 12;
const PATCH_RADIUS_PX = 1;
const SEARCH_RADIUS_PX = 2;
const MIN_PATCH_SAMPLES = 5;
const MAX_PATCH_MAD_METERS = 0.03;
const MAX_PATCH_MAD_FRACTION = 0.02;
const MIN_MATCH_DEPTH_METERS = 0.1;
const MAX_MATCH_DEPTH_METERS = 20;
const MAX_MATCH_RELATIVE_ERROR = 0.2;
const AMBIGUITY_SCORE_EPSILON = 0.01;
const AMBIGUITY_DEPTH_METERS = 0.05;
const AMBIGUITY_DEPTH_FRACTION = 0.03;
const MAX_FRAME_GAP_MS = 1_500;
const MIN_SUPPORT = 48;
const MIN_DEPTH_SPAN_METERS = 0.5;
const MIN_SLOPE_SEPARATION_METERS = 0.25;
const MIN_SLOPE_PAIRS = 96;
const TRIM_SIGMA = 3;
const TRIM_FLOOR_METERS = 0.05;
const MIN_INLIERS = 36;
const MIN_INLIER_FRACTION = 0.65;
const MAX_RMSE_METERS = 0.15;
const MAX_NORMALIZED_RMSE = 0.06;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.25;
const MIN_SHIFT_METERS = -0.5;
const MAX_SHIFT_METERS = 0.5;
const SMOOTHING_ALPHA = 0.25;
const MAX_SCALE_CHANGE = 0.02;
const MAX_SHIFT_CHANGE_METERS = 0.05;
const MAX_FRAME_CORRECTION_CHANGE_METERS = 0.1;
const RESIDUAL_EMA_ALPHA = 0.2;
const STABLE_ACCEPTED_UPDATES = 5;
const STABLE_SETTLED_UPDATES = 3;
const SETTLED_SCALE_CHANGE = 0.005;
const SETTLED_SHIFT_CHANGE_METERS = 0.01;
const STABLE_NORMALIZED_RESIDUAL = 0.03;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(fraction * (sorted.length - 1))]!;
}

function validateFrame(frame: MetricRefinerFrame): void {
  if (
    typeof frame !== "object" || frame === null ||
    typeof frame.sourceId !== "string" || frame.sourceId.length === 0 ||
    typeof frame.sourceFrameId !== "string" || frame.sourceFrameId.length === 0 ||
    !Number.isFinite(frame.captureTimestamp) || frame.captureTimestamp < 0 ||
    !Number.isSafeInteger(frame.width) || frame.width <= 0 ||
    !Number.isSafeInteger(frame.height) || frame.height <= 0 ||
    !(frame.linearZ instanceof Float32Array) ||
    !(frame.validity instanceof Uint8Array) ||
    frame.linearZ.length !== frame.width * frame.height ||
    frame.validity.length !== frame.linearZ.length
  ) {
    throw new TypeError("Metric refiner frame contract is invalid");
  }
  for (const value of frame.validity) {
    if (value !== 0 && value !== 1) {
      throw new TypeError("Metric refiner validity must be binary");
    }
  }
}

function copyFrame(frame: MetricRefinerFrame): MetricRefinerFrame {
  return Object.freeze({
    sourceId: frame.sourceId,
    sourceFrameId: frame.sourceFrameId,
    captureTimestamp: frame.captureTimestamp,
    width: frame.width,
    height: frame.height,
    linearZ: new Float32Array(frame.linearZ),
    validity: new Uint8Array(frame.validity),
  });
}

function diagnostics(
  applied: boolean,
  scale: number,
  shiftMeters: number,
  supportCount: number,
  inlierCount: number,
  residualRmseMeters: number | null,
  normalizedResidual: number | null,
  stage: MetricRefinementStage,
  reason: MetricRefinementReason,
  guidance: MetricRefinementGuidance,
): MetricRefinerDiagnostics {
  return Object.freeze({
    applied,
    scale,
    shiftMeters,
    supportCount,
    inlierCount,
    residualRmseMeters,
    normalizedResidual,
    stage,
    reason,
    guidance,
  });
}

function outputFrom(
  frame: MetricRefinerFrame,
  frameDiagnostics: MetricRefinerDiagnostics,
): MetricRefinerOutput {
  const copied = copyFrame(frame);
  return Object.freeze({ ...copied, diagnostics: frameDiagnostics });
}

function stateWith(
  previous: MetricRefinerFrame | null,
  scale = 1,
  shiftMeters = 0,
  acceptedUpdates = 0,
  settledUpdates = 0,
  normalizedResidualEma: number | null = null,
): MetricScaleShiftRefinerState {
  return Object.freeze({
    previous,
    scale,
    shiftMeters,
    acceptedUpdates,
    settledUpdates,
    normalizedResidualEma,
  });
}

export function createMetricScaleShiftRefinerState(): MetricScaleShiftRefinerState {
  return stateWith(null);
}

export function resetMetricScaleShiftRefinerState(): MetricScaleShiftRefinerState {
  return createMetricScaleShiftRefinerState();
}

function patchDepth(
  frame: MetricRefinerFrame,
  centerX: number,
  centerY: number,
): number | null {
  const samples: number[] = [];
  for (
    let y = Math.max(0, centerY - PATCH_RADIUS_PX);
    y <= Math.min(frame.height - 1, centerY + PATCH_RADIUS_PX);
    y += 1
  ) {
    for (
      let x = Math.max(0, centerX - PATCH_RADIUS_PX);
      x <= Math.min(frame.width - 1, centerX + PATCH_RADIUS_PX);
      x += 1
    ) {
      const index = y * frame.width + x;
      const value = frame.linearZ[index]!;
      if (frame.validity[index] === 1 && Number.isFinite(value) && value > 0) {
        samples.push(value);
      }
    }
  }
  if (samples.length < MIN_PATCH_SAMPLES) return null;
  const center = median(samples);
  if (center < MIN_MATCH_DEPTH_METERS || center > MAX_MATCH_DEPTH_METERS) {
    return null;
  }
  const mad = median(samples.map((sample) => Math.abs(sample - center)));
  if (mad > Math.max(MAX_PATCH_MAD_METERS, MAX_PATCH_MAD_FRACTION * center)) {
    return null;
  }
  return center;
}

interface Pair {
  readonly x: number;
  readonly y: number;
}

function correspondences(
  state: MetricScaleShiftRefinerState,
  current: MetricRefinerFrame,
): Pair[] {
  const previous = state.previous!;
  const pairs: Pair[] = [];
  const usedCurrentCenters = new Set<number>();
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const normalizedY = (row + 0.5) / GRID_ROWS;
    const previousY = Math.min(
      previous.height - 1,
      Math.floor(normalizedY * previous.height),
    );
    const currentY = Math.min(
      current.height - 1,
      Math.floor(normalizedY * current.height),
    );
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const normalizedX = (column + 0.5) / GRID_COLUMNS;
      const previousX = Math.min(
        previous.width - 1,
        Math.floor(normalizedX * previous.width),
      );
      const currentX = Math.min(
        current.width - 1,
        Math.floor(normalizedX * current.width),
      );
      const y = patchDepth(previous, previousX, previousY);
      if (y === null) continue;
      const candidates: Array<{
        x: number;
        score: number;
        squaredDisplacement: number;
        centerX: number;
        centerY: number;
        centerIndex: number;
      }> = [];
      for (
        let candidateY = Math.max(0, currentY - SEARCH_RADIUS_PX);
        candidateY <= Math.min(current.height - 1, currentY + SEARCH_RADIUS_PX);
        candidateY += 1
      ) {
        for (
          let candidateX = Math.max(0, currentX - SEARCH_RADIUS_PX);
          candidateX <= Math.min(current.width - 1, currentX + SEARCH_RADIUS_PX);
          candidateX += 1
        ) {
          const centerIndex = candidateY * current.width + candidateX;
          if (usedCurrentCenters.has(centerIndex)) continue;
          const x = patchDepth(current, candidateX, candidateY);
          if (x === null) continue;
          const transformed = state.scale * x + state.shiftMeters;
          const score = Math.abs(transformed - y) / Math.max(y, 0.25);
          if (score > MAX_MATCH_RELATIVE_ERROR) continue;
          const deltaX = candidateX - currentX;
          const deltaY = candidateY - currentY;
          candidates.push({
            x,
            score,
            squaredDisplacement: deltaX * deltaX + deltaY * deltaY,
            centerX: candidateX,
            centerY: candidateY,
            centerIndex,
          });
        }
      }
      candidates.sort((left, right) =>
        left.score - right.score ||
        left.squaredDisplacement - right.squaredDisplacement ||
        left.centerY - right.centerY ||
        left.centerX - right.centerX
      );
      const best = candidates[0];
      if (!best) continue;
      const close = candidates.filter((candidate) =>
        candidate.score <= best.score + AMBIGUITY_SCORE_EPSILON
      );
      const transformedDepths = close.map((candidate) =>
        state.scale * candidate.x + state.shiftMeters
      );
      if (
        transformedDepths.length > 1 &&
        Math.max(...transformedDepths) - Math.min(...transformedDepths) >
          Math.max(AMBIGUITY_DEPTH_METERS, AMBIGUITY_DEPTH_FRACTION * y)
      ) {
        continue;
      }
      usedCurrentCenters.add(best.centerIndex);
      pairs.push({ x: best.x, y });
    }
  }
  return pairs;
}

interface Fit {
  readonly scale: number;
  readonly shiftMeters: number;
  readonly inlierCount: number;
  readonly rmse: number;
  readonly normalizedRmse: number;
}

function robustFit(pairs: readonly Pair[]): Fit | MetricRefinementReason {
  const current = pairs.map((pair) => pair.x);
  const reference = pairs.map((pair) => pair.y);
  if (
    percentile(current, 0.9) - percentile(current, 0.1) < MIN_DEPTH_SPAN_METERS ||
    percentile(reference, 0.9) - percentile(reference, 0.1) < MIN_DEPTH_SPAN_METERS
  ) {
    return "insufficient-depth-span";
  }
  const slopes: number[] = [];
  for (let left = 0; left < pairs.length; left += 1) {
    for (let right = left + 1; right < pairs.length; right += 1) {
      const deltaX = pairs[right]!.x - pairs[left]!.x;
      if (Math.abs(deltaX) < MIN_SLOPE_SEPARATION_METERS) continue;
      slopes.push((pairs[right]!.y - pairs[left]!.y) / deltaX);
    }
  }
  if (slopes.length < MIN_SLOPE_PAIRS) return "ambiguous-fit";
  const initialScale = median(slopes);
  const initialShift = median(
    pairs.map((pair) => pair.y - initialScale * pair.x),
  );
  const residuals = pairs.map((pair) =>
    pair.y - (initialScale * pair.x + initialShift)
  );
  const residualMedian = median(residuals);
  const residualMad = median(
    residuals.map((residual) => Math.abs(residual - residualMedian)),
  );
  const threshold = Math.max(
    TRIM_FLOOR_METERS,
    TRIM_SIGMA * 1.4826 * residualMad,
  );
  const inliers = pairs.filter((_, index) =>
    Math.abs(residuals[index]! - residualMedian) <= threshold
  );
  if (
    inliers.length < MIN_INLIERS ||
    inliers.length / pairs.length < MIN_INLIER_FRACTION
  ) {
    return "ambiguous-fit";
  }
  const meanX = inliers.reduce((sum, pair) => sum + pair.x, 0) / inliers.length;
  const meanY = inliers.reduce((sum, pair) => sum + pair.y, 0) / inliers.length;
  let numerator = 0;
  let denominator = 0;
  for (const pair of inliers) {
    numerator += (pair.x - meanX) * (pair.y - meanY);
    denominator += (pair.x - meanX) ** 2;
  }
  if (!Number.isFinite(denominator) || denominator <= Number.EPSILON) {
    return "ambiguous-fit";
  }
  const scale = numerator / denominator;
  const shiftMeters = meanY - scale * meanX;
  if (!Number.isFinite(scale) || !Number.isFinite(shiftMeters)) {
    return "ambiguous-fit";
  }
  let squared = 0;
  let normalizedSquared = 0;
  for (const pair of inliers) {
    const residual = pair.y - (scale * pair.x + shiftMeters);
    squared += residual ** 2;
    normalizedSquared += (residual / Math.max(pair.y, 0.25)) ** 2;
  }
  const rmse = Math.sqrt(squared / inliers.length);
  const normalizedRmse = Math.sqrt(normalizedSquared / inliers.length);
  if (rmse > MAX_RMSE_METERS || normalizedRmse > MAX_NORMALIZED_RMSE) {
    return "scene-change";
  }
  if (
    scale < MIN_SCALE || scale > MAX_SCALE ||
    shiftMeters < MIN_SHIFT_METERS || shiftMeters > MAX_SHIFT_METERS
  ) {
    return "fit-out-of-bounds";
  }
  return { scale, shiftMeters, inlierCount: inliers.length, rmse, normalizedRmse };
}

function nativeFallback(
  current: MetricRefinerFrame,
  reason: MetricRefinementReason,
  supportCount = 0,
  inlierCount = 0,
): Readonly<{
  state: MetricScaleShiftRefinerState;
  output: MetricRefinerOutput;
}> {
  const frameDiagnostics = diagnostics(
    false,
    1,
    0,
    supportCount,
    inlierCount,
    null,
    null,
    "approximate",
    reason,
    reason === "native-prior"
      ? "collecting-temporal-evidence"
      : "using-unrefined-native-prior",
  );
  const output = outputFrom(current, frameDiagnostics);
  return Object.freeze({ state: stateWith(copyFrame(output)), output });
}

export function refineMetricScaleShift(
  state: MetricScaleShiftRefinerState,
  current: MetricRefinerFrame,
): Readonly<{
  state: MetricScaleShiftRefinerState;
  output: MetricRefinerOutput;
}> {
  validateFrame(current);
  if (state.previous === null) return nativeFallback(current, "native-prior");
  const previous = state.previous;
  const gap = current.captureTimestamp - previous.captureTimestamp;
  if (
    current.sourceId !== previous.sourceId ||
    gap > MAX_FRAME_GAP_MS ||
    current.width < GRID_COLUMNS || current.height < GRID_ROWS
  ) {
    return nativeFallback(current, "association-break");
  }
  if (
    current.sourceFrameId === previous.sourceFrameId ||
    gap <= 0
  ) {
    const output = outputFrom(current, diagnostics(
      false, 1, 0, 0, 0, null, null,
      "approximate", "out-of-order", "using-unrefined-native-prior",
    ));
    return Object.freeze({ state, output });
  }

  const pairs = correspondences(state, current);
  if (pairs.length < MIN_SUPPORT) {
    return nativeFallback(current, "low-support", pairs.length);
  }
  const fit = robustFit(pairs);
  if (typeof fit === "string") {
    return nativeFallback(current, fit, pairs.length);
  }

  let scaleDelta = clamp(
    SMOOTHING_ALPHA * (fit.scale - state.scale),
    -MAX_SCALE_CHANGE,
    MAX_SCALE_CHANGE,
  );
  let shiftDelta = clamp(
    SMOOTHING_ALPHA * (fit.shiftMeters - state.shiftMeters),
    -MAX_SHIFT_CHANGE_METERS,
    MAX_SHIFT_CHANGE_METERS,
  );
  let minimumDepth = Infinity;
  let maximumDepth = -Infinity;
  for (let index = 0; index < current.linearZ.length; index += 1) {
    const value = current.linearZ[index]!;
    if (current.validity[index] === 1 && Number.isFinite(value) && value > 0) {
      minimumDepth = Math.min(minimumDepth, value);
      maximumDepth = Math.max(maximumDepth, value);
    }
  }
  const maximumCorrection = Math.max(
    Math.abs(scaleDelta * minimumDepth + shiftDelta),
    Math.abs(scaleDelta * maximumDepth + shiftDelta),
  );
  if (maximumCorrection > MAX_FRAME_CORRECTION_CHANGE_METERS) {
    const factor = MAX_FRAME_CORRECTION_CHANGE_METERS / maximumCorrection;
    scaleDelta *= factor;
    shiftDelta *= factor;
  }
  const scale = clamp(state.scale + scaleDelta, MIN_SCALE, MAX_SCALE);
  const shiftMeters = clamp(
    state.shiftMeters + shiftDelta,
    MIN_SHIFT_METERS,
    MAX_SHIFT_METERS,
  );
  const linearZ = new Float32Array(current.linearZ.length);
  const validity = new Uint8Array(current.validity.length);
  linearZ.fill(Number.NaN);
  for (let index = 0; index < current.linearZ.length; index += 1) {
    const nativeDepth = current.linearZ[index]!;
    const refinedDepth = scale * nativeDepth + shiftMeters;
    if (
      current.validity[index] === 1 &&
      Number.isFinite(nativeDepth) && nativeDepth > 0 &&
      Number.isFinite(refinedDepth) && refinedDepth > 0
    ) {
      linearZ[index] = refinedDepth;
      validity[index] = 1;
    }
  }
  const residualEma = state.normalizedResidualEma === null
    ? fit.normalizedRmse
    : (1 - RESIDUAL_EMA_ALPHA) * state.normalizedResidualEma +
      RESIDUAL_EMA_ALPHA * fit.normalizedRmse;
  const acceptedUpdates = state.acceptedUpdates + 1;
  const settledUpdates =
    Math.abs(scaleDelta) <= SETTLED_SCALE_CHANGE &&
    Math.abs(shiftDelta) <= SETTLED_SHIFT_CHANGE_METERS &&
    fit.normalizedRmse <= STABLE_NORMALIZED_RESIDUAL
      ? state.settledUpdates + 1
      : 0;
  const stage: MetricRefinementStage =
    acceptedUpdates >= STABLE_ACCEPTED_UPDATES &&
    settledUpdates >= STABLE_SETTLED_UPDATES &&
    residualEma <= STABLE_NORMALIZED_RESIDUAL
      ? "stable"
      : "refining";
  const frame: MetricRefinerFrame = Object.freeze({
    sourceId: current.sourceId,
    sourceFrameId: current.sourceFrameId,
    captureTimestamp: current.captureTimestamp,
    width: current.width,
    height: current.height,
    linearZ,
    validity,
  });
  const frameDiagnostics = diagnostics(
    true,
    scale,
    shiftMeters,
    pairs.length,
    fit.inlierCount,
    fit.rmse,
    fit.normalizedRmse,
    stage,
    "refined",
    stage === "stable"
      ? "temporally-stable-not-ground-truth"
      : "passive-refinement-active",
  );
  const output = Object.freeze({ ...frame, diagnostics: frameDiagnostics });
  return Object.freeze({
    state: stateWith(
      copyFrame(frame),
      scale,
      shiftMeters,
      acceptedUpdates,
      settledUpdates,
      residualEma,
    ),
    output,
  });
}
