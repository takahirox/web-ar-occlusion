import assert from "node:assert/strict";
import test from "node:test";

import {
  CalibrationStateMachine,
  type CalibrationTransition,
  type CanonicalCalibrationEvidence,
} from "../src/calibration.ts";

function texture(label: string): GPUTexture {
  return Object.freeze({ label }) as unknown as GPUTexture;
}

function evidence(
  canonicalDepthTexture: GPUTexture,
  sourceFrameId = "frame-1",
  captureTimestamp = 10,
): CanonicalCalibrationEvidence {
  return { canonicalDepthTexture, sourceFrameId, captureTimestamp };
}

test("starts relative-only with a frozen exact-state snapshot", () => {
  const calibration = new CalibrationStateMachine();

  assert.deepEqual(calibration.state, { status: "relative-only" });
  assert.equal(Object.isFrozen(calibration.state), true);
  assert.equal(calibration.generation, 0);
  assert.deepEqual(calibration.evaluate("frame-1", 10), {
    usable: false,
    confidenceScale: 0,
    reason: "relative-only",
  });
});

test("can be constructed lost", () => {
  const calibration = new CalibrationStateMachine({ initialStatus: "lost" });

  assert.deepEqual(calibration.state, { status: "lost" });
  assert.equal(Object.isFrozen(calibration.state), true);
  assert.equal(calibration.generation, 0);
  assert.deepEqual(calibration.evaluate("frame-1", 10), {
    usable: false,
    confidenceScale: 0,
    reason: "lost",
  });
});

test("rejects invalid evidence without changing state or generation", () => {
  const calibration = new CalibrationStateMachine();
  const canonicalDepthTexture = texture("canonical");

  assert.deepEqual(
    calibration.acceptEvidence({
      canonicalDepthTexture: null as unknown as GPUTexture,
      sourceFrameId: "frame-1",
      captureTimestamp: 10,
    }),
    {
      status: "rejected",
      changed: false,
      reason: "missing-canonical-depth-texture",
      generation: 0,
    },
  );
  assert.deepEqual(
    calibration.acceptEvidence({
      canonicalDepthTexture,
      sourceFrameId: "",
      captureTimestamp: 10,
    }),
    {
      status: "rejected",
      changed: false,
      reason: "invalid-source-frame-id",
      generation: 0,
    },
  );
  assert.deepEqual(
    calibration.acceptEvidence({
      canonicalDepthTexture,
      sourceFrameId: "frame-1",
      captureTimestamp: Number.NaN,
    }),
    {
      status: "rejected",
      changed: false,
      reason: "invalid-capture-timestamp",
      generation: 0,
    },
  );
  assert.deepEqual(calibration.state, { status: "relative-only" });
  assert.equal(calibration.generation, 0);
});

test("accepts canonical evidence and requires its exact association", () => {
  const calibration = new CalibrationStateMachine();
  const canonicalDepthTexture = texture("canonical");

  assert.deepEqual(
    calibration.acceptEvidence(evidence(canonicalDepthTexture)),
    { status: "accepted", changed: true, generation: 1 },
  );
  assert.deepEqual(calibration.state, {
    status: "calibrated",
    canonicalDepthTexture,
  });
  assert.equal(Object.isFrozen(calibration.state), true);
  assert.deepEqual(calibration.evaluate("frame-1", 10), {
    usable: true,
    canonicalDepthTexture,
    confidenceScale: 1,
  });
  assert.deepEqual(calibration.evaluate("another-frame", 10), {
    usable: false,
    confidenceScale: 0,
    reason: "source-frame-mismatch",
  });
  assert.deepEqual(calibration.evaluate("frame-1", 11), {
    usable: false,
    confidenceScale: 0,
    reason: "capture-timestamp-mismatch",
  });
});

test("leaves exact duplicates unchanged and rejects non-newer evidence", () => {
  const calibration = new CalibrationStateMachine();
  const firstTexture = texture("first");
  const otherTexture = texture("other");
  const first = evidence(firstTexture, "frame-1", 10);

  calibration.acceptEvidence(first);

  assert.deepEqual(calibration.acceptEvidence(first), {
    status: "duplicate",
    changed: false,
    generation: 1,
  });
  assert.deepEqual(
    calibration.acceptEvidence(evidence(otherTexture, "frame-0", 9)),
    {
      status: "rejected",
      changed: false,
      reason: "older-evidence",
      generation: 1,
    },
  );
  assert.deepEqual(
    calibration.acceptEvidence(evidence(otherTexture, "frame-2", 10)),
    {
      status: "rejected",
      changed: false,
      reason: "timestamp-conflict",
      generation: 1,
    },
  );
  assert.deepEqual(calibration.evaluate("frame-1", 10), {
    usable: true,
    canonicalDepthTexture: firstTexture,
    confidenceScale: 1,
  });
  assert.equal(calibration.generation, 1);
});

test("replacement releases only a different superseded texture", () => {
  const released: GPUTexture[] = [];
  const calibration = new CalibrationStateMachine({
    releaseCanonicalDepthTexture: (value) => released.push(value),
  });
  const firstTexture = texture("first");
  const secondTexture = texture("second");

  calibration.acceptEvidence(evidence(firstTexture, "frame-1", 10));
  assert.deepEqual(
    calibration.acceptEvidence(evidence(secondTexture, "frame-2", 11)),
    { status: "accepted", changed: true, generation: 2 },
  );
  assert.deepEqual(released, [firstTexture]);

  assert.deepEqual(
    calibration.acceptEvidence(evidence(secondTexture, "frame-3", 12)),
    { status: "accepted", changed: true, generation: 3 },
  );
  assert.deepEqual(released, [firstTexture]);
  assert.deepEqual(calibration.evaluate("frame-3", 12), {
    usable: true,
    canonicalDepthTexture: secondTexture,
    confidenceScale: 1,
  });
});

test("invalidations release evidence immediately and are idempotent", () => {
  const released: GPUTexture[] = [];
  const calibration = new CalibrationStateMachine({
    releaseCanonicalDepthTexture: (value) => released.push(value),
  });
  const canonicalDepthTexture = texture("canonical");

  calibration.acceptEvidence(evidence(canonicalDepthTexture));
  assert.deepEqual(calibration.markRelativeOnly(), {
    status: "relative-only",
    changed: true,
    generation: 2,
  });
  assert.deepEqual(released, [canonicalDepthTexture]);
  assert.deepEqual(calibration.evaluate("frame-1", 10), {
    usable: false,
    confidenceScale: 0,
    reason: "relative-only",
  });
  assert.deepEqual(calibration.markRelativeOnly(), {
    status: "relative-only",
    changed: false,
    generation: 2,
  });

  assert.deepEqual(calibration.markLost(), {
    status: "lost",
    changed: true,
    generation: 3,
  });
  assert.deepEqual(calibration.markLost(), {
    status: "lost",
    changed: false,
    generation: 3,
  });
  assert.deepEqual(released, [canonicalDepthTexture]);
  assert.deepEqual(calibration.evaluate("frame-1", 10), {
    usable: false,
    confidenceScale: 0,
    reason: "lost",
  });
});

test("notifies frozen transitions with monotonically increasing generations", () => {
  const transitions: CalibrationTransition[] = [];
  const calibration = new CalibrationStateMachine({
    onTransition: (transition) => transitions.push(transition),
  });
  const canonicalDepthTexture = texture("canonical");

  calibration.acceptEvidence(evidence(canonicalDepthTexture));
  calibration.markLost();
  calibration.markRelativeOnly();

  assert.deepEqual(
    transitions.map((transition) => [
      transition.previous.status,
      transition.current.status,
      transition.generation,
    ]),
    [
      ["relative-only", "calibrated", 1],
      ["calibrated", "lost", 2],
      ["lost", "relative-only", 3],
    ],
  );
  assert.equal(transitions.every(Object.isFrozen), true);
});

test("isolates transition and release callback exceptions", () => {
  const firstTexture = texture("first");
  const secondTexture = texture("second");
  let transitionCalls = 0;
  const released: GPUTexture[] = [];
  const calibration = new CalibrationStateMachine({
    onTransition: () => {
      transitionCalls += 1;
      throw new Error("transition observer failed");
    },
    releaseCanonicalDepthTexture: (value) => {
      released.push(value);
      throw new Error("release observer failed");
    },
  });

  assert.deepEqual(
    calibration.acceptEvidence(evidence(firstTexture, "frame-1", 10)),
    { status: "accepted", changed: true, generation: 1 },
  );
  assert.deepEqual(
    calibration.acceptEvidence(evidence(secondTexture, "frame-2", 11)),
    { status: "accepted", changed: true, generation: 2 },
  );
  assert.deepEqual(calibration.markLost(), {
    status: "lost",
    changed: true,
    generation: 3,
  });

  assert.equal(transitionCalls, 3);
  assert.deepEqual(released, [firstTexture, secondTexture]);
  assert.deepEqual(calibration.state, { status: "lost" });
  assert.equal(calibration.generation, 3);
});
