import assert from "node:assert/strict";
import test from "node:test";

import { evaluateQuality, getQualityMetric, type QualityEvaluationInput } from "../src/quality.ts";

function input(): QualityEvaluationInput {
  const provenance = {
    evaluatedAt: "2026-01-02T03:04:05.000Z",
    sourceKind: "synthetic-fixture" as const,
    sourceId: "validity-mask-fixture",
    sourceDigest: "0".repeat(64),
    implementationId: "implementation-a",
    implementationDigest: "1".repeat(64),
    configDigest: "2".repeat(64),
    evaluatorVersion: "quality-v1",
  };
  return {
    schemaVersion: 1,
    kind: "web-ar-occlusion-quality-input",
    provenance,
    depthScale: "metric",
    frames: [
      { id: "f0", timestampMs: 0, width: 2, height: 1, predictedMask: [0, 1], referenceMask: [0, 1], predictedDepth: [1, 2], referenceDepth: [1, 2], confidence: [1, 1], renderedAlpha: [0, 1], referenceRenderedAlpha: [0, 1] },
      { id: "f1", timestampMs: 20, width: 2, height: 1, predictedMask: [1, 0], referenceMask: [1, 0], predictedDepth: [2, 1], referenceDepth: [2, 1], confidence: [1, 1], renderedAlpha: [1, 0], referenceRenderedAlpha: [1, 0] },
    ],
  };
}

test("validityMask validates binary samples and excludes invalid evidence", () => {
  const baseline = input();
  const allValid: QualityEvaluationInput = { ...baseline, frames: baseline.frames.map((frame) => ({ ...frame, validityMask: [1, 1] })) };
  assert.deepEqual(evaluateQuality(allValid), evaluateQuality(baseline));

  const malformed = input();
  malformed.frames[0]!.validityMask = [1];
  assert.throws(() => evaluateQuality(malformed), /validityMask length mismatch/);
  malformed.frames[0]!.validityMask = [1, 2];
  assert.throws(() => evaluateQuality(malformed), /validityMask samples must be 0 or 1/);

  const excluded = input();
  excluded.frames = excluded.frames.map((frame) => ({ ...frame, validityMask: [0, 0] }));
  const artifact = evaluateQuality(excluded);
  assert.ok(artifact.metrics.every((metric) => metric.status !== "known"));
  assert.deepEqual(getQualityMetric(artifact, "confidence.coverage"), { name: "confidence.coverage", status: "missing", unit: "ratio", sampleCount: 0, reason: "no-valid-pixels" });
});
