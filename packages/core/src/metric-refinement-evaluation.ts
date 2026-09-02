import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  evaluateRecordedMetricDepth,
  type CrossingMeasurement,
  type RecordedMetricFrame,
} from "./recorded-metric-evaluation.ts";

export type MetricRefinementMethod =
  | "zero-shot"
  | "passive-refinement"
  | "guided-fallback";

export interface MetricRefinementTraceSample {
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
  readonly scale: number;
  readonly shiftMeters: number;
  readonly stage: "approximate" | "refining" | "stable";
  readonly supportCount: number;
  readonly inlierCount: number;
  readonly normalizedResidual: number | null;
}

export interface MetricRefinementEvaluationArm {
  readonly method: MetricRefinementMethod;
  readonly frames: readonly RecordedMetricFrame[];
  readonly refinementTrace: readonly MetricRefinementTraceSample[];
  readonly guidancePromptCount: number;
  readonly manualAnchorCount: number;
  readonly totalUserInteractions: number;
}

export interface MetricRefinementEvaluationSession {
  readonly sessionId: string;
  readonly sourceId: string;
  readonly startedAtMs: number;
  readonly arms: readonly MetricRefinementEvaluationArm[];
}

export interface MetricRefinementComparisonInput {
  readonly schemaVersion: 1;
  readonly kind: "web-ar-occlusion-metric-refinement-comparison-input";
  readonly corpusId: string;
  readonly corpusDigest: string;
  readonly virtualZThresholds: readonly number[];
  readonly sessions: readonly MetricRefinementEvaluationSession[];
}

export interface MetricRefinementArmEvaluation {
  readonly method: MetricRefinementMethod;
  readonly metric: {
    readonly maeMeters: number;
    readonly rmseMeters: number;
    readonly absRel: number;
    readonly sampleCount: number;
  };
  readonly crossings: readonly CrossingMeasurement[];
  readonly timeToFirstUsableMs: number | null;
  readonly timeToStableMs: number | null;
  readonly guidancePromptCount: number;
  readonly manualAnchorCount: number;
  readonly totalUserInteractions: number;
  readonly scaleShiftTrace: readonly MetricRefinementTraceSample[];
}

export interface MetricRefinementComparisonEvaluation {
  readonly schemaVersion: 1;
  readonly kind: "web-ar-occlusion-metric-refinement-comparison-evaluation";
  readonly corpusId: string;
  readonly corpusDigest: string;
  readonly sessions: readonly Readonly<{
    sessionId: string;
    sourceId: string;
    arms: readonly MetricRefinementArmEvaluation[];
  }>[];
  readonly summary: {
    readonly sessionCount: number;
    readonly guidedMovementRequiredFraction: number;
    readonly manualCalibrationRequiredFraction: number;
    readonly methods: readonly Readonly<{
      method: MetricRefinementMethod;
      meanMaeMeters: number;
      meanRmseMeters: number;
      meanCrossingAccuracy: number;
      meanTimeToFirstUsableMs: number | null;
      meanTimeToStableMs: number | null;
      stableSessionFraction: number;
      meanGuidancePromptCount: number;
      meanManualAnchorCount: number;
      meanUserInteractions: number;
    }>[];
  };
}

const METHODS: readonly MetricRefinementMethod[] = Object.freeze([
  "zero-shot",
  "passive-refinement",
  "guided-fallback",
]);

function nonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validDepth(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function sameValues(
  left: readonly (number | null)[],
  right: readonly (number | null)[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
}

function validateSharedFrames(
  expected: readonly RecordedMetricFrame[],
  actual: readonly RecordedMetricFrame[],
  sourceId: string,
): void {
  if (expected.length !== actual.length) {
    throw new TypeError("comparison arms must use the same recorded frames");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index]!;
    const right = actual[index]!;
    if (
      left.id !== right.id ||
      left.sourceId !== sourceId || right.sourceId !== sourceId ||
      left.sourceFrameId !== right.sourceFrameId ||
      left.captureTimestamp !== right.captureTimestamp ||
      !sameValues(left.referenceLinearZ, right.referenceLinearZ)
    ) {
      throw new TypeError(
        "comparison arms must share exact source association and ground truth",
      );
    }
  }
}

function validateTrace(
  trace: readonly MetricRefinementTraceSample[],
  frames: readonly RecordedMetricFrame[],
): readonly MetricRefinementTraceSample[] {
  if (!Array.isArray(trace)) throw new TypeError("refinement trace is required");
  const frameById = new Map(frames.map((frame) => [frame.sourceFrameId, frame]));
  let previousTimestamp = -Infinity;
  return Object.freeze(trace.map((sample) => {
    const frame = frameById.get(sample.sourceFrameId);
    if (
      !frame ||
      sample.captureTimestamp !== frame.captureTimestamp ||
      sample.captureTimestamp <= previousTimestamp ||
      !Number.isFinite(sample.scale) || sample.scale <= 0 ||
      !Number.isFinite(sample.shiftMeters) ||
      !["approximate", "refining", "stable"].includes(sample.stage) ||
      !nonnegativeInteger(sample.supportCount) ||
      !nonnegativeInteger(sample.inlierCount) ||
      sample.inlierCount > sample.supportCount ||
      (sample.normalizedResidual !== null &&
        (!Number.isFinite(sample.normalizedResidual) || sample.normalizedResidual < 0))
    ) {
      throw new TypeError("metric refinement trace is malformed or unassociated");
    }
    previousTimestamp = sample.captureTimestamp;
    return Object.freeze({ ...sample });
  }));
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nullableMean(values: readonly (number | null)[]): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length === 0 ? null : mean(finite);
}

function evaluateArm(
  arm: MetricRefinementEvaluationArm,
  session: MetricRefinementEvaluationSession,
  virtualZThresholds: readonly number[],
): MetricRefinementArmEvaluation {
  if (
    !nonnegativeInteger(arm.guidancePromptCount) ||
    !nonnegativeInteger(arm.manualAnchorCount) ||
    !nonnegativeInteger(arm.totalUserInteractions) ||
    arm.totalUserInteractions <
      arm.guidancePromptCount + arm.manualAnchorCount
  ) {
    throw new TypeError("metric refinement interaction counts are invalid");
  }
  const evaluation = evaluateRecordedMetricDepth({
    schemaVersion: 1,
    kind: "web-ar-occlusion-recorded-metric-input",
    virtualZThresholds,
    frames: arm.frames,
  });
  const trace = validateTrace(arm.refinementTrace, arm.frames);
  const firstUsable = arm.frames.find((frame) =>
    frame.predictedLinearZ.some(validDepth)
  );
  const firstStable = trace.find((sample) => sample.stage === "stable");
  if (
    arm.frames.some((frame) => frame.captureTimestamp < session.startedAtMs) ||
    (firstStable && firstStable.captureTimestamp < session.startedAtMs)
  ) {
    throw new TypeError("metric refinement timestamps precede session start");
  }
  return Object.freeze({
    method: arm.method,
    metric: evaluation.metric,
    crossings: evaluation.crossings,
    timeToFirstUsableMs: firstUsable
      ? firstUsable.captureTimestamp - session.startedAtMs
      : null,
    timeToStableMs: firstStable
      ? firstStable.captureTimestamp - session.startedAtMs
      : null,
    guidancePromptCount: arm.guidancePromptCount,
    manualAnchorCount: arm.manualAnchorCount,
    totalUserInteractions: arm.totalUserInteractions,
    scaleShiftTrace: trace,
  });
}

export function evaluateMetricRefinementComparison(
  input: MetricRefinementComparisonInput,
): MetricRefinementComparisonEvaluation {
  if (
    input?.schemaVersion !== 1 ||
    input.kind !== "web-ar-occlusion-metric-refinement-comparison-input" ||
    typeof input.corpusId !== "string" || input.corpusId.length === 0 ||
    !/^[a-f0-9]{64}$/.test(input.corpusDigest) ||
    !Array.isArray(input.sessions) || input.sessions.length === 0
  ) {
    throw new TypeError("invalid metric refinement comparison input");
  }
  const sessionIds = new Set<string>();
  const sessions = Object.freeze(input.sessions.map((session) => {
    if (
      typeof session.sessionId !== "string" || session.sessionId.length === 0 ||
      sessionIds.has(session.sessionId) ||
      typeof session.sourceId !== "string" || session.sourceId.length === 0 ||
      !Number.isFinite(session.startedAtMs) || session.startedAtMs < 0 ||
      !Array.isArray(session.arms) || session.arms.length !== METHODS.length
    ) {
      throw new TypeError("metric refinement comparison session is malformed");
    }
    sessionIds.add(session.sessionId);
    const armByMethod = new Map(session.arms.map((arm) => [arm.method, arm]));
    if (
      armByMethod.size !== METHODS.length ||
      METHODS.some((method) => !armByMethod.has(method))
    ) {
      throw new TypeError("each session requires exactly the three comparison methods");
    }
    const baseline = armByMethod.get("zero-shot")!;
    for (const method of METHODS) {
      validateSharedFrames(baseline.frames, armByMethod.get(method)!.frames, session.sourceId);
    }
    const arms = Object.freeze(METHODS.map((method) =>
      evaluateArm(armByMethod.get(method)!, session, input.virtualZThresholds)
    ));
    return Object.freeze({
      sessionId: session.sessionId,
      sourceId: session.sourceId,
      arms,
    });
  }));

  const methodSummaries = Object.freeze(METHODS.map((method) => {
    const arms = sessions.map((session) =>
      session.arms.find((arm) => arm.method === method)!
    );
    return Object.freeze({
      method,
      meanMaeMeters: mean(arms.map((arm) => arm.metric.maeMeters)),
      meanRmseMeters: mean(arms.map((arm) => arm.metric.rmseMeters)),
      meanCrossingAccuracy: mean(arms.flatMap((arm) =>
        arm.crossings.map((crossing) => crossing.accuracy)
      )),
      meanTimeToFirstUsableMs: nullableMean(
        arms.map((arm) => arm.timeToFirstUsableMs),
      ),
      meanTimeToStableMs: nullableMean(arms.map((arm) => arm.timeToStableMs)),
      stableSessionFraction:
        arms.filter((arm) => arm.timeToStableMs !== null).length / arms.length,
      meanGuidancePromptCount: mean(arms.map((arm) => arm.guidancePromptCount)),
      meanManualAnchorCount: mean(arms.map((arm) => arm.manualAnchorCount)),
      meanUserInteractions: mean(arms.map((arm) => arm.totalUserInteractions)),
    });
  }));
  const passiveArms = sessions.map((session) =>
    session.arms.find((arm) => arm.method === "passive-refinement")!
  );
  const guidedArms = sessions.map((session) =>
    session.arms.find((arm) => arm.method === "guided-fallback")!
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: "web-ar-occlusion-metric-refinement-comparison-evaluation",
    corpusId: input.corpusId,
    corpusDigest: input.corpusDigest,
    sessions,
    summary: Object.freeze({
      sessionCount: sessions.length,
      guidedMovementRequiredFraction:
        passiveArms.filter((arm) => arm.guidancePromptCount > 0).length /
        sessions.length,
      manualCalibrationRequiredFraction:
        guidedArms.filter((arm) => arm.manualAnchorCount > 0).length /
        sessions.length,
      methods: methodSummaries,
    }),
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 1) {
    throw new TypeError("usage: metric-refinement-evaluation.ts INPUT.json");
  }
  const parsed: unknown = JSON.parse(await readFile(argv[0]!, "utf8"));
  process.stdout.write(`${JSON.stringify(
    evaluateMetricRefinementComparison(parsed as MetricRefinementComparisonInput),
  )}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
