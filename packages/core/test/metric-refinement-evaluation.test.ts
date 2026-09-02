import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateMetricRefinementComparison,
  type MetricRefinementEvaluationArm,
} from "../src/metric-refinement-evaluation.ts";

const referenceFrames = [
  {
    id: "recorded-1",
    sourceId: "recording-a",
    sourceFrameId: "frame-1",
    captureTimestamp: 100,
    predictedLinearZ: [1, 2, 4],
    referenceLinearZ: [1, 2, 4],
  },
  {
    id: "recorded-2",
    sourceId: "recording-a",
    sourceFrameId: "frame-2",
    captureTimestamp: 200,
    predictedLinearZ: [1, 2, 4],
    referenceLinearZ: [1, 2, 4],
  },
] as const;

function arm(
  method: MetricRefinementEvaluationArm["method"],
  offset: number,
  overrides: Partial<MetricRefinementEvaluationArm> = {},
): MetricRefinementEvaluationArm {
  const frames = referenceFrames.map((frame) => ({
    ...frame,
    predictedLinearZ: frame.referenceLinearZ.map((value) => value + offset),
    referenceLinearZ: [...frame.referenceLinearZ],
  }));
  return {
    method,
    frames,
    refinementTrace: method === "zero-shot" ? [{
      sourceFrameId: "frame-1",
      captureTimestamp: 100,
      scale: 1,
      shiftMeters: 0,
      stage: "approximate",
      supportCount: 0,
      inlierCount: 0,
      normalizedResidual: null,
    }] : [{
      sourceFrameId: "frame-1",
      captureTimestamp: 100,
      scale: 1,
      shiftMeters: 0,
      stage: "refining",
      supportCount: 64,
      inlierCount: 58,
      normalizedResidual: 0.04,
    }, {
      sourceFrameId: "frame-2",
      captureTimestamp: 200,
      scale: 1.01,
      shiftMeters: 0.02,
      stage: "stable",
      supportCount: 72,
      inlierCount: 68,
      normalizedResidual: 0.02,
    }],
    guidancePromptCount: method === "zero-shot" ? 0 : 1,
    manualAnchorCount: method === "guided-fallback" ? 2 : 0,
    totalUserInteractions: method === "zero-shot"
      ? 0
      : method === "guided-fallback" ? 3 : 1,
    ...overrides,
  };
}

function input() {
  return {
    schemaVersion: 1 as const,
    kind: "web-ar-occlusion-metric-refinement-comparison-input" as const,
    corpusId: "ground-truth-sequence-a",
    corpusDigest: "a".repeat(64),
    virtualZThresholds: [1.5, 3],
    sessions: [{
      sessionId: "session-a",
      sourceId: "recording-a",
      startedAtMs: 0,
      arms: [
        arm("zero-shot", 0.4),
        arm("passive-refinement", 0.1),
        arm("guided-fallback", 0),
      ],
    }],
  };
}

test("compares all three same-corpus arms including timing and interaction cost", () => {
  const output = evaluateMetricRefinementComparison(input());
  const [zeroShot, passive, guided] = output.sessions[0]!.arms;

  assert.equal(output.kind, "web-ar-occlusion-metric-refinement-comparison-evaluation");
  assert.equal(output.corpusId, "ground-truth-sequence-a");
  assert.equal(output.summary.sessionCount, 1);
  assert.ok(passive!.metric.maeMeters < zeroShot!.metric.maeMeters);
  assert.ok(guided!.metric.maeMeters < passive!.metric.maeMeters);
  assert.equal(zeroShot!.timeToFirstUsableMs, 100);
  assert.equal(zeroShot!.timeToStableMs, null);
  assert.equal(passive!.timeToStableMs, 200);
  assert.equal(guided!.manualAnchorCount, 2);
  assert.equal(guided!.totalUserInteractions, 3);
  assert.equal(output.summary.guidedMovementRequiredFraction, 1);
  assert.equal(output.summary.manualCalibrationRequiredFraction, 1);

  const passiveSummary = output.summary.methods.find((item) =>
    item.method === "passive-refinement"
  )!;
  assert.equal(passiveSummary.meanTimeToFirstUsableMs, 100);
  assert.equal(passiveSummary.meanTimeToStableMs, 200);
  assert.equal(passiveSummary.stableSessionFraction, 1);
  assert.equal(passiveSummary.meanGuidancePromptCount, 1);
  assert.equal(passiveSummary.meanManualAnchorCount, 0);
  assert.equal(passiveSummary.meanUserInteractions, 1);
  assert.equal(passive!.scaleShiftTrace[1]!.scale, 1.01);
  assert.equal(passive!.scaleShiftTrace[1]!.shiftMeters, 0.02);
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.sessions));
  assert.ok(Object.isFrozen(passive!.scaleShiftTrace));
});

test("requires exactly zero-shot, passive-refinement, and guided-fallback", () => {
  const missing = input();
  missing.sessions[0]!.arms.pop();
  assert.throws(
    () => evaluateMetricRefinementComparison(missing),
    /session is malformed|three comparison methods/,
  );

  const duplicate = input();
  duplicate.sessions[0]!.arms[2] = arm("passive-refinement", 0);
  assert.throws(
    () => evaluateMetricRefinementComparison(duplicate),
    /three comparison methods/,
  );
});

test("rejects incomparable ground truth, associations, traces, and interactions", () => {
  const groundTruth = input();
  groundTruth.sessions[0]!.arms[1]!.frames[0]!.referenceLinearZ[0] = 9;
  assert.throws(
    () => evaluateMetricRefinementComparison(groundTruth),
    /same recorded frames|exact source association and ground truth/,
  );

  const association = input();
  association.sessions[0]!.arms[1]!.frames[0]!.sourceFrameId = "different";
  assert.throws(
    () => evaluateMetricRefinementComparison(association),
    /exact source association and ground truth/,
  );

  const trace = input();
  trace.sessions[0]!.arms[1]!.refinementTrace[0]!.captureTimestamp = 999;
  assert.throws(
    () => evaluateMetricRefinementComparison(trace),
    /trace is malformed or unassociated/,
  );

  const interactions = input();
  interactions.sessions[0]!.arms[2]!.totalUserInteractions = 1;
  assert.throws(
    () => evaluateMetricRefinementComparison(interactions),
    /interaction counts are invalid/,
  );
});

test("keeps unavailable stable timing explicit rather than fabricating zero", () => {
  const value = input();
  value.sessions[0]!.arms[1] = arm("passive-refinement", 0.1, {
    refinementTrace: [{
      sourceFrameId: "frame-1",
      captureTimestamp: 100,
      scale: 1,
      shiftMeters: 0,
      stage: "refining",
      supportCount: 64,
      inlierCount: 58,
      normalizedResidual: 0.04,
    }],
  });
  const output = evaluateMetricRefinementComparison(value);
  const passive = output.sessions[0]!.arms.find((item) =>
    item.method === "passive-refinement"
  )!;
  const summary = output.summary.methods.find((item) =>
    item.method === "passive-refinement"
  )!;
  assert.equal(passive.timeToStableMs, null);
  assert.equal(summary.meanTimeToStableMs, null);
  assert.equal(summary.stableSessionFraction, 0);
});
