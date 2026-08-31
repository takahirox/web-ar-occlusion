import assert from "node:assert/strict";
import test from "node:test";

import type { DepthFrame } from "../src/contracts.ts";
import {
  canonicalizeDepthSample,
  guardMetricCalibration,
  validateDepthFrame,
} from "../src/guards.ts";
import {
  ADAPTIVE_QUALITY_CONTROL,
  QUALITY_PROFILES,
} from "../src/profiles.ts";

const depthTexture = Object.freeze({}) as GPUTexture;
const confidenceTexture = Object.freeze({}) as GPUTexture;
const canonicalDepthTexture = Object.freeze({}) as GPUTexture;

function makeDepthFrame(
  overrides: Partial<DepthFrame> = {},
): DepthFrame {
  return {
    depth: depthTexture,
    confidence: confidenceTexture,
    representation: "linear-z",
    scale: "metric",
    unit: "meter",
    captureTimestamp: 123.5,
    sourceFrameId: "source-1",
    uvTransform: new Float32Array([1, 0, 0, 1]),
    width: 320,
    height: 192,
    ...overrides,
  };
}

function assertFrozenConfiguration(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "number") {
      assert.equal(Number.isFinite(value), true);
    } else {
      assert.ok(typeof value === "boolean" || typeof value === "string");
    }
    return 1;
  }

  assert.equal(Object.isFrozen(value), true);
  return Object.values(value).reduce(
    (count, child) => count + assertFrozenConfiguration(child),
    0,
  );
}

test("quality profiles expose the established presets", () => {
  assert.deepEqual(QUALITY_PROFILES, {
    performance: {
      inferenceHz: 8,
      inputSize: [320, 192],
      maxDepthAgeMs: 250,
      edgeRefinement: false,
      opticalFlow: false,
      segmentation: false,
    },
    balanced: {
      inferenceHz: 12,
      inputSize: [384, 224],
      maxDepthAgeMs: 250,
      edgeRefinement: true,
      opticalFlow: false,
      segmentation: false,
    },
    quality: {
      inferenceHz: 18,
      inputSize: [480, 270],
      maxDepthAgeMs: 200,
      edgeRefinement: true,
      opticalFlow: false,
      segmentation: false,
    },
  });
  assert.ok(assertFrozenConfiguration(QUALITY_PROFILES) > 0);
});

test("adaptive quality constants match the frozen control policy", () => {
  assert.deepEqual(ADAPTIVE_QUALITY_CONTROL, {
    downgrade: {
      gpuP95MsAbove: 14,
      gpuP95DurationMs: 2_000,
      droppedFramesPercentAbove: 5,
    },
    recovery: {
      gpuP95MsBelow: 10,
      droppedFramesPercentBelow: 1,
      continuousDurationMs: 10_000,
    },
    cooldownMs: 10_000,
  });
  assert.ok(assertFrozenConfiguration(ADAPTIVE_QUALITY_CONTROL) > 0);
});

test("validateDepthFrame accepts both valid scale and unit pairings", () => {
  const metric = makeDepthFrame();
  const relative = makeDepthFrame({ scale: "relative", unit: null });

  assert.deepEqual(validateDepthFrame(metric), { ok: true, value: metric });
  assert.deepEqual(validateDepthFrame(relative), {
    ok: true,
    value: relative,
  });
});

test("validateDepthFrame rejects invalid metadata", () => {
  const cases: Array<readonly [unknown, string]> = [
    [null, "invalid-frame"],
    [makeDepthFrame({ width: 0 }), "invalid-width"],
    [makeDepthFrame({ height: -1 }), "invalid-height"],
    [makeDepthFrame({ captureTimestamp: Number.NaN }), "invalid-capture-timestamp"],
    [makeDepthFrame({ sourceFrameId: "" }), "invalid-source-frame-id"],
    [makeDepthFrame({ uvTransform: new Float32Array() }), "invalid-uv-transform"],
    [makeDepthFrame({ uvTransform: new Float32Array([Number.NaN]) }), "invalid-uv-transform"],
    [{ ...makeDepthFrame(), depth: undefined }, "missing-depth-texture"],
    [{ ...makeDepthFrame(), confidence: null }, "missing-confidence-texture"],
    [{ ...makeDepthFrame(), representation: "radial" }, "invalid-representation"],
    [{ ...makeDepthFrame(), scale: "metric", unit: null }, "invalid-scale-unit-pair"],
    [{ ...makeDepthFrame(), scale: "relative", unit: "meter" }, "invalid-scale-unit-pair"],
  ];

  for (const [frame, reason] of cases) {
    assert.deepEqual(validateDepthFrame(frame), { ok: false, reason });
  }
});

test("canonicalizeDepthSample invalidates unusable depths", () => {
  for (const depth of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const sample = canonicalizeDepthSample(depth, 0.8);
    assert.equal(Number.isNaN(sample.depth), true);
    assert.equal(sample.confidence, 0);
  }
});

test("canonicalizeDepthSample clamps confidence", () => {
  assert.deepEqual(canonicalizeDepthSample(2, -0.25), {
    depth: 2,
    confidence: 0,
  });
  assert.deepEqual(canonicalizeDepthSample(2, 0.4), {
    depth: 2,
    confidence: 0.4,
  });
  assert.deepEqual(canonicalizeDepthSample(2, 1.25), {
    depth: 2,
    confidence: 1,
  });
  assert.deepEqual(canonicalizeDepthSample(2, Number.NaN), {
    depth: 2,
    confidence: 0,
  });
});

test("guardMetricCalibration accepts calibrated metric depth", () => {
  const calibration = {
    status: "calibrated" as const,
    canonicalDepthTexture,
  };

  assert.deepEqual(guardMetricCalibration(calibration), {
    ok: true,
    value: calibration,
  });
});

test("guardMetricCalibration rejects relative-only calibration", () => {
  assert.deepEqual(guardMetricCalibration({ status: "relative-only" }), {
    ok: false,
    reason: "relative-only",
  });
});

test("guardMetricCalibration rejects lost calibration", () => {
  assert.deepEqual(guardMetricCalibration({ status: "lost" }), {
    ok: false,
    reason: "lost",
  });
});
