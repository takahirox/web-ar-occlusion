export type MetricDistanceProvenance =
  | "native-metric"
  | "manual-known-plane";

export interface MetricDistanceObservation {
  readonly sourceId: string;
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
  readonly depthMeters: number;
  readonly normalizedX: number;
  readonly provenance: MetricDistanceProvenance;
}

export type MetricDistanceStatus =
  | "starting"
  | "unavailable"
  | "approximate"
  | "refining"
  | "stable";

export type MetricDistanceGuidance =
  | "acquire-target"
  | "keep-target-framed"
  | "move-slowly-side-to-side"
  | "hold-steady-when-noisy"
  | "stable-repeatability-accuracy-unverified";

export type MetricDistanceUnavailableReason =
  | "source-mismatch"
  | "invalid-observation"
  | "out-of-order"
  | MetricDistanceInvalidationType;

export type MetricDistanceInvalidationType =
  | "tracking-lost"
  | "stale-result"
  | "calibration-lost"
  | "provider-failure";

export type MetricDistanceEvent =
  | Readonly<{
      type: "observation";
      observation: MetricDistanceObservation;
    }>
  | Readonly<{ type: MetricDistanceInvalidationType }>;

export interface MetricDistanceState {
  readonly sourceId: string;
  readonly status: MetricDistanceStatus;
  readonly observations: readonly Readonly<MetricDistanceObservation>[];
  readonly displayDepthMeters: number | null;
  readonly medianDepthMeters: number | null;
  readonly stability: number;
  readonly coverage: number;
  readonly horizontalEvidence: number;
  readonly temporalRepeatability: number;
  readonly consecutiveQualifyingWindows: number;
  readonly guidance: MetricDistanceGuidance;
  readonly unavailableReason: MetricDistanceUnavailableReason | null;
}

const WINDOW_SIZE = 8;
const STABILITY_THRESHOLD = 0.8;
const REQUIRED_HORIZONTAL_SPAN = 0.08;
const REQUIRED_QUALIFYING_WINDOWS = 3;
const SMOOTHING_ALPHA = 0.35;
const EMPTY_OBSERVATIONS = Object.freeze(
  [] as Readonly<MetricDistanceObservation>[],
);
const OBSERVATION_FIELDS = Object.freeze([
  "captureTimestamp",
  "depthMeters",
  "normalizedX",
  "provenance",
  "sourceFrameId",
  "sourceId",
]);

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function unavailableState(
  sourceId: string,
  unavailableReason: MetricDistanceUnavailableReason | null,
  status: "starting" | "unavailable" = "unavailable",
): Readonly<MetricDistanceState> {
  return Object.freeze({
    sourceId,
    status,
    observations: EMPTY_OBSERVATIONS,
    displayDepthMeters: null,
    medianDepthMeters: null,
    stability: 0,
    coverage: 0,
    horizontalEvidence: 0,
    temporalRepeatability: 0,
    consecutiveQualifyingWindows: 0,
    guidance:
      status === "starting"
        ? "acquire-target"
        : "move-slowly-side-to-side",
    unavailableReason,
  });
}

function hasExactObservationFields(
  observation: Record<string, unknown>,
): boolean {
  const keys = Object.keys(observation).sort();
  return (
    keys.length === OBSERVATION_FIELDS.length &&
    keys.every((key, index) => key === OBSERVATION_FIELDS[index])
  );
}

function isValidObservation(
  value: unknown,
): value is MetricDistanceObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const observation = value as Record<string, unknown>;
  return (
    hasExactObservationFields(observation) &&
    typeof observation.sourceId === "string" &&
    observation.sourceId.length > 0 &&
    typeof observation.sourceFrameId === "string" &&
    observation.sourceFrameId.length > 0 &&
    typeof observation.captureTimestamp === "number" &&
    Number.isFinite(observation.captureTimestamp) &&
    observation.captureTimestamp >= 0 &&
    typeof observation.depthMeters === "number" &&
    Number.isFinite(observation.depthMeters) &&
    observation.depthMeters > 0 &&
    typeof observation.normalizedX === "number" &&
    Number.isFinite(observation.normalizedX) &&
    observation.normalizedX >= 0 &&
    observation.normalizedX <= 1 &&
    (observation.provenance === "native-metric" ||
      observation.provenance === "manual-known-plane")
  );
}

function isInvalidationType(
  value: unknown,
): value is MetricDistanceInvalidationType {
  return (
    value === "tracking-lost" ||
    value === "stale-result" ||
    value === "calibration-lost" ||
    value === "provider-failure"
  );
}

function guidanceFor(
  status: MetricDistanceStatus,
  count: number,
  stability: number,
  horizontalSpan: number,
): MetricDistanceGuidance {
  if (status === "stable") {
    return "stable-repeatability-accuracy-unverified";
  }
  if (count <= 2) return "move-slowly-side-to-side";
  if (count < WINDOW_SIZE) return "move-slowly-side-to-side";
  if (stability < STABILITY_THRESHOLD) return "hold-steady-when-noisy";
  if (horizontalSpan < REQUIRED_HORIZONTAL_SPAN) {
    return "move-slowly-side-to-side";
  }
  return "keep-target-framed";
}

export function createMetricDistanceState(
  sourceId: string,
): Readonly<MetricDistanceState> {
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    throw new TypeError("sourceId must be a nonempty string");
  }
  return unavailableState(sourceId, null, "starting");
}

export function reduceMetricDistanceState(
  state: Readonly<MetricDistanceState>,
  event: MetricDistanceEvent,
): Readonly<MetricDistanceState> {
  if (typeof event !== "object" || event === null) {
    return unavailableState(state.sourceId, "invalid-observation");
  }

  if (isInvalidationType(event.type)) {
    return unavailableState(state.sourceId, event.type);
  }
  if (event.type !== "observation" || !isValidObservation(event.observation)) {
    return unavailableState(state.sourceId, "invalid-observation");
  }

  const observation = event.observation;
  if (observation.sourceId !== state.sourceId) {
    return unavailableState(state.sourceId, "source-mismatch");
  }

  const previous = state.observations[state.observations.length - 1];
  if (
    state.observations.some(
      (item) => item.sourceFrameId === observation.sourceFrameId,
    ) ||
    (previous !== undefined &&
      observation.captureTimestamp <= previous.captureTimestamp)
  ) {
    return unavailableState(state.sourceId, "out-of-order");
  }

  const accepted = Object.freeze({ ...observation });
  const observations = Object.freeze(
    [...state.observations, accepted].slice(-WINDOW_SIZE),
  );
  const depths = observations.map((item) => item.depthMeters);
  const medianDepthMeters = median(depths);
  const absoluteDeviations = depths.map((depth) =>
    Math.abs(depth - medianDepthMeters),
  );
  const medianAbsoluteDeviation = median(absoluteDeviations);
  const stability = clamp(
    1 -
      (1.4826 * medianAbsoluteDeviation / medianDepthMeters) /
        0.03,
  );
  const coverage = clamp(observations.length / WINDOW_SIZE);
  const horizontalValues = observations.map((item) => item.normalizedX);
  const horizontalSpan =
    Math.max(...horizontalValues) - Math.min(...horizontalValues);
  const horizontalEvidence = clamp(
    horizontalSpan / REQUIRED_HORIZONTAL_SPAN,
  );
  const temporalRepeatability =
    coverage * stability * (0.5 + 0.5 * horizontalEvidence);
  const qualifying =
    observations.length === WINDOW_SIZE &&
    stability >= STABILITY_THRESHOLD &&
    horizontalSpan >= REQUIRED_HORIZONTAL_SPAN;
  const consecutiveQualifyingWindows = qualifying
    ? state.consecutiveQualifyingWindows + 1
    : 0;
  const status: MetricDistanceStatus =
    consecutiveQualifyingWindows >= REQUIRED_QUALIFYING_WINDOWS
      ? "stable"
      : observations.length <= 2
        ? "approximate"
        : "refining";

  let displayDepthMeters = medianDepthMeters;
  if (observations.length === WINDOW_SIZE && state.displayDepthMeters !== null) {
    const limit = Math.max(0.05, 0.05 * medianDepthMeters);
    const smoothed =
      state.displayDepthMeters +
      SMOOTHING_ALPHA * (medianDepthMeters - state.displayDepthMeters);
    displayDepthMeters = clamp(
      smoothed,
      state.displayDepthMeters - limit,
      state.displayDepthMeters + limit,
    );
  }

  return Object.freeze({
    sourceId: state.sourceId,
    status,
    observations,
    displayDepthMeters,
    medianDepthMeters,
    stability,
    coverage,
    horizontalEvidence,
    temporalRepeatability,
    consecutiveQualifyingWindows,
    guidance: guidanceFor(
      status,
      observations.length,
      stability,
      horizontalSpan,
    ),
    unavailableReason: null,
  });
}
