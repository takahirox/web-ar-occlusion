import assert from "node:assert/strict";
import test from "node:test";

import {
  createMetricDistanceState,
  reduceMetricDistanceState,
} from "../src/metric-distance-state.ts";

const SOURCE_ID = "camera-a";

function observation(
  sourceFrameId,
  captureTimestamp = Number(String(sourceFrameId).replace(/\D/g, "")) || 1,
  overrides = {},
) {
  return {
    sourceId: SOURCE_ID,
    sourceFrameId,
    captureTimestamp,
    depthMeters: 2,
    normalizedX: sourceFrameId % 2 === 0 ? 0.45 : 0.55,
    provenance: "native-metric",
    ...overrides,
  };
}

function accept(state, item) {
  return reduceMetricDistanceState(state, {
    type: "observation",
    observation: item,
  });
}

function assertUnavailable(state, reason, message) {
  assert.equal(state.status, "unavailable", message);
  assert.equal(state.unavailableReason, reason);
  assert.equal(state.displayDepthMeters, null);
  assert.equal(state.medianDepthMeters, null);
  assert.deepEqual(state.observations, []);
  assert.equal(state.temporalRepeatability, 0);
  assert.equal(state.guidance, "move-slowly-side-to-side");
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.observations));
}

test("starts without presenting a distance", () => {
  const state = createMetricDistanceState(SOURCE_ID);

  assert.equal(state.status, "starting");
  assert.equal(state.displayDepthMeters, null);
  assert.equal(state.medianDepthMeters, null);
  assert.deepEqual(state.observations, []);
  assert.equal(state.guidance, "acquire-target");
  assert.equal(state.unavailableReason, null);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.observations));
});

test("first and second observations request side-to-side movement", () => {
  let state = createMetricDistanceState(SOURCE_ID);

  state = accept(state, observation("frame-1", 1));
  assert.equal(state.status, "approximate");
  assert.equal(state.guidance, "move-slowly-side-to-side");

  state = accept(state, observation("frame-2", 2));
  assert.equal(state.status, "approximate");
  assert.equal(state.guidance, "move-slowly-side-to-side");
});

test("constant samples progress from approximate through refining to stable", () => {
  let state = createMetricDistanceState(SOURCE_ID);

  for (let frame = 1; frame <= 10; frame += 1) {
    state = accept(
      state,
      observation(`frame-${frame}`, frame, {
        normalizedX: frame % 2 === 0 ? 0.45 : 0.55,
        provenance:
          frame % 2 === 0 ? "native-metric" : "manual-known-plane",
      }),
    );
    assert.equal(
      state.status,
      frame <= 2 ? "approximate" : frame <= 9 ? "refining" : "stable",
    );
  }

  assert.equal(state.stability, 1);
  assert.equal(state.coverage, 1);
  assert.equal(state.temporalRepeatability, 1);
  assert.equal(state.guidance, "stable-repeatability-accuracy-unverified");
  assert.deepEqual(
    new Set(state.observations.map((item) => item.provenance)),
    new Set(["native-metric", "manual-known-plane"]),
  );
  assert.equal("accuracy" in state, false);
});

test("accepted observations, history, and returned states are frozen", () => {
  const input = observation("frame-1", 1);
  const state = accept(createMetricDistanceState(SOURCE_ID), input);

  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.observations));
  assert.ok(Object.isFrozen(state.observations[0]));
  assert.notEqual(state.observations[0], input);
  input.depthMeters = 9;
  assert.equal(state.observations[0].depthMeters, 2);
});

test("alternating 1.8m and 2.2m samples remain noisy and never stable", () => {
  let state = createMetricDistanceState(SOURCE_ID);

  for (let frame = 1; frame <= 12; frame += 1) {
    state = accept(
      state,
      observation(`frame-${frame}`, frame, {
        depthMeters: frame % 2 === 0 ? 1.8 : 2.2,
      }),
    );
    assert.notEqual(state.status, "stable");
  }

  assert.equal(state.stability, 0);
  assert.equal(state.guidance, "hold-steady-when-noisy");
});

test("no horizontal travel caps repeatability at one half", () => {
  let state = createMetricDistanceState(SOURCE_ID);

  for (let frame = 1; frame <= 8; frame += 1) {
    state = accept(
      state,
      observation(`frame-${frame}`, frame, { normalizedX: 0.5 }),
    );
  }

  assert.equal(state.temporalRepeatability, 0.5);
  assert.equal(state.guidance, "move-slowly-side-to-side");
  assert.notEqual(state.status, "stable");
});

test("bad observations and invalidations immediately clear metric output", () => {
  const baseline = accept(
    createMetricDistanceState(SOURCE_ID),
    observation("frame-10", 10),
  );
  const cases = [
    [
      "source mismatch",
      {
        type: "observation",
        observation: observation("frame-11", 11, { sourceId: "camera-b" }),
      },
      "source-mismatch",
    ],
    [
      "duplicate frame",
      { type: "observation", observation: observation("frame-10", 11) },
      "out-of-order",
    ],
    [
      "repeated timestamp",
      { type: "observation", observation: observation("frame-11", 10) },
      "out-of-order",
    ],
    [
      "decreasing timestamp",
      { type: "observation", observation: observation("frame-11", 9) },
      "out-of-order",
    ],
    [
      "empty frame",
      { type: "observation", observation: observation("", 11) },
      "invalid-observation",
    ],
    [
      "negative timestamp",
      { type: "observation", observation: observation("frame-11", -1) },
      "invalid-observation",
    ],
    [
      "infinite timestamp",
      { type: "observation", observation: observation("frame-11", Infinity) },
      "invalid-observation",
    ],
    [
      "zero depth",
      {
        type: "observation",
        observation: observation("frame-11", 11, { depthMeters: 0 }),
      },
      "invalid-observation",
    ],
    [
      "NaN depth",
      {
        type: "observation",
        observation: observation("frame-11", 11, { depthMeters: Number.NaN }),
      },
      "invalid-observation",
    ],
    [
      "negative horizontal coordinate",
      {
        type: "observation",
        observation: observation("frame-11", 11, { normalizedX: -0.01 }),
      },
      "invalid-observation",
    ],
    [
      "horizontal coordinate above one",
      {
        type: "observation",
        observation: observation("frame-11", 11, { normalizedX: 1.01 }),
      },
      "invalid-observation",
    ],
    ["tracking lost", { type: "tracking-lost" }, "tracking-lost"],
    ["stale result", { type: "stale-result" }, "stale-result"],
    ["calibration lost", { type: "calibration-lost" }, "calibration-lost"],
    ["provider failure", { type: "provider-failure" }, "provider-failure"],
  ];

  for (const [name, event, reason] of cases) {
    assertUnavailable(
      reduceMetricDistanceState(baseline, event),
      reason,
      name,
    );
  }
});

test("the next valid exact-source sample restarts as approximate", () => {
  let state = accept(
    createMetricDistanceState(SOURCE_ID),
    observation("frame-100", 100),
  );
  state = reduceMetricDistanceState(state, { type: "provider-failure" });
  state = accept(state, observation("video-frame:12345", 1));

  assert.equal(state.status, "approximate");
  assert.equal(state.unavailableReason, null);
  assert.equal(state.observations.length, 1);
  assert.equal(state.observations[0].sourceId, SOURCE_ID);
  assert.equal(state.displayDepthMeters, 2);
});

test("each smoothing step is bounded by five centimeters or five percent", () => {
  let state = createMetricDistanceState(SOURCE_ID);

  for (let frame = 1; frame <= 12; frame += 1) {
    state = accept(
      state,
      observation(`frame-${frame}`, frame, {
        depthMeters: frame <= 8 ? 2 : 10,
      }),
    );
  }

  const previousDisplay = state.displayDepthMeters;
  state = accept(state, observation("frame-13", 13, { depthMeters: 10 }));
  const limit = Math.max(0.05, 0.05 * state.medianDepthMeters);

  assert.ok(
    Math.abs(state.displayDepthMeters - previousDisplay) <=
      limit + Number.EPSILON,
  );
});
