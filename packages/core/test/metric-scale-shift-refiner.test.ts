import assert from "node:assert/strict";
import test from "node:test";

import {
  createMetricScaleShiftRefinerState,
  refineMetricScaleShift,
  resetMetricScaleShiftRefinerState,
} from "../src/metric-scale-shift-refiner.ts";

const WIDTH = 64;
const HEIGHT = 48;

function surface(
  sourceFrameId: string,
  captureTimestamp: number,
  sourceId = "camera-a",
) {
  const linearZ = new Float32Array(WIDTH * HEIGHT);
  const validity = new Uint8Array(linearZ.length).fill(1);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      linearZ[y * WIDTH + x] = 1 +
        ((Math.floor(x / 8) + 2 * Math.floor(y / 8)) % 9) * 0.5;
    }
  }
  return {
    sourceId,
    sourceFrameId,
    captureTimestamp,
    width: WIDTH,
    height: HEIGHT,
    linearZ,
    validity,
  };
}

function biasedTranslated(previous, sourceFrameId, captureTimestamp) {
  const linearZ = new Float32Array(previous.linearZ.length);
  linearZ.fill(Number.NaN);
  const validity = new Uint8Array(previous.validity.length);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH - 1; x += 1) {
      const source = y * WIDTH + x;
      const target = y * WIDTH + x + 1;
      if (previous.validity[source] === 1) {
        linearZ[target] = (previous.linearZ[source] - 0.1) / 1.05;
        validity[target] = 1;
      }
    }
  }
  return {
    sourceId: previous.sourceId,
    sourceFrameId,
    captureTimestamp,
    width: WIDTH,
    height: HEIGHT,
    linearZ,
    validity,
  };
}

function biased(previous, sourceFrameId, captureTimestamp) {
  const linearZ = new Float32Array(previous.linearZ.length);
  const validity = new Uint8Array(previous.validity);
  for (let index = 0; index < linearZ.length; index += 1) {
    linearZ[index] = validity[index] === 1
      ? (previous.linearZ[index] - 0.02) / 1.005
      : Number.NaN;
  }
  return {
    sourceId: previous.sourceId,
    sourceFrameId,
    captureTimestamp,
    width: WIDTH,
    height: HEIGHT,
    linearZ,
    validity,
  };
}

function translatedRmse(candidate, reference) {
  let squared = 0;
  let count = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH - 1; x += 1) {
      const expected = reference.linearZ[y * WIDTH + x];
      const actual = candidate.linearZ[y * WIDTH + x + 1];
      if (Number.isFinite(expected) && Number.isFinite(actual)) {
        squared += (actual - expected) ** 2;
        count += 1;
      }
    }
  }
  return Math.sqrt(squared / count);
}

test("publishes an immediate copied native prior", () => {
  const input = surface("frame-1", 1);
  const before = new Float32Array(input.linearZ);
  const result = refineMetricScaleShift(
    createMetricScaleShiftRefinerState(),
    input,
  );

  assert.equal(result.output.diagnostics.applied, false);
  assert.equal(result.output.diagnostics.stage, "approximate");
  assert.equal(result.output.diagnostics.reason, "native-prior");
  assert.equal(result.output.diagnostics.scale, 1);
  assert.equal(result.output.diagnostics.shiftMeters, 0);
  assert.equal(result.output.diagnostics.residualRmseMeters, null);
  assert.deepEqual(result.output.linearZ, input.linearZ);
  assert.deepEqual(result.output.validity, input.validity);
  assert.notStrictEqual(result.output.linearZ, input.linearZ);
  assert.notStrictEqual(result.output.validity, input.validity);
  assert.deepEqual(input.linearZ, before);
});

test("bounded affine refinement improves temporal alignment of a biased successor", () => {
  const reference = surface("frame-1", 1);
  const seeded = refineMetricScaleShift(
    createMetricScaleShiftRefinerState(),
    reference,
  );
  const current = biasedTranslated(reference, "frame-2", 2);
  const nativeRmse = translatedRmse(current, reference);
  const refined = refineMetricScaleShift(seeded.state, current);

  assert.equal(refined.output.diagnostics.applied, true);
  assert.equal(refined.output.diagnostics.stage, "refining");
  assert.equal(refined.output.diagnostics.reason, "refined");
  assert.ok(refined.output.diagnostics.supportCount >= 48);
  assert.ok(refined.output.diagnostics.inlierCount >= 36);
  assert.ok(refined.output.diagnostics.scale > 1);
  assert.ok(refined.output.diagnostics.scale - 1 <= 0.02 + Number.EPSILON);
  assert.ok(refined.output.diagnostics.shiftMeters > 0);
  assert.ok(refined.output.diagnostics.shiftMeters <= 0.05 + Number.EPSILON);
  assert.ok(translatedRmse(refined.output, reference) < nativeRmse);
  for (let index = 0; index < current.linearZ.length; index += 1) {
    if (current.validity[index] === 1) {
      assert.ok(
        Math.abs(refined.output.linearZ[index] - current.linearZ[index]) <=
          0.1 + 1e-6,
      );
    }
  }
});

test("requires accepted settled updates before temporal stability", () => {
  let transition = refineMetricScaleShift(
    createMetricScaleShiftRefinerState(),
    surface("frame-0", 0),
  );
  for (let frame = 1; frame <= 5; frame += 1) {
    const next = biased(
      transition.state.previous,
      `frame-${frame}`,
      frame * 10,
    );
    transition = refineMetricScaleShift(transition.state, next);
    assert.equal(
      transition.output.diagnostics.stage,
      frame < 5 ? "refining" : "stable",
    );
  }
  assert.equal(
    transition.output.diagnostics.guidance,
    "temporally-stable-not-ground-truth",
  );
  assert.ok(transition.state.normalizedResidualEma <= 0.03);
});

test("low support and scene changes use an unrefined native prior", () => {
  const first = surface("frame-1", 1);
  const seeded = refineMetricScaleShift(
    createMetricScaleShiftRefinerState(),
    first,
  );
  const sparse = surface("frame-2", 2);
  sparse.validity.fill(0);
  sparse.validity.fill(1, 0, 9);
  const lowSupport = refineMetricScaleShift(seeded.state, sparse);
  assert.equal(lowSupport.output.diagnostics.applied, false);
  assert.equal(lowSupport.output.diagnostics.reason, "low-support");
  assert.deepEqual(lowSupport.output.linearZ, sparse.linearZ);
  assert.equal(lowSupport.state.scale, 1);
  assert.equal(lowSupport.state.shiftMeters, 0);

  const changed = surface("frame-3", 3);
  for (let index = 0; index < changed.linearZ.length; index += 1) {
    changed.linearZ[index] = 19 - (index * 37 % 170) / 10;
  }
  const sceneChange = refineMetricScaleShift(seeded.state, changed);
  assert.equal(sceneChange.output.diagnostics.applied, false);
  assert.notEqual(sceneChange.output.diagnostics.reason, "refined");
  assert.deepEqual(sceneChange.output.linearZ, changed.linearZ);
});

test("out-of-order work cannot rewind state and association breaks reseed", () => {
  const first = refineMetricScaleShift(
    createMetricScaleShiftRefinerState(),
    surface("frame-1", 100),
  );
  const newer = refineMetricScaleShift(
    first.state,
    biased(first.state.previous, "frame-2", 110),
  );
  const stale = refineMetricScaleShift(
    newer.state,
    surface("frame-stale", 110),
  );
  assert.strictEqual(stale.state, newer.state);
  assert.equal(stale.output.diagnostics.reason, "out-of-order");

  const changedSource = refineMetricScaleShift(
    newer.state,
    surface("frame-3", 120, "camera-b"),
  );
  assert.equal(changedSource.output.diagnostics.reason, "association-break");
  assert.equal(changedSource.state.scale, 1);
  assert.equal(changedSource.state.previous.sourceId, "camera-b");

  const late = refineMetricScaleShift(
    newer.state,
    surface("frame-4", 2_000),
  );
  assert.equal(late.output.diagnostics.reason, "association-break");
  assert.deepEqual(resetMetricScaleShiftRefinerState(), createMetricScaleShiftRefinerState());
});

test("rejects malformed contracts and never revives invalid pixels", () => {
  const malformed = surface("frame-1", 1);
  malformed.validity[0] = 2;
  assert.throws(
    () => refineMetricScaleShift(createMetricScaleShiftRefinerState(), malformed),
    /validity must be binary/,
  );

  const first = surface("frame-1", 1);
  first.validity[0] = 0;
  first.linearZ[0] = Number.NaN;
  const seeded = refineMetricScaleShift(
    createMetricScaleShiftRefinerState(),
    first,
  );
  const current = biased(first, "frame-2", 2);
  current.validity[0] = 0;
  current.linearZ[0] = -1;
  const refined = refineMetricScaleShift(seeded.state, current);
  assert.equal(refined.output.validity[0], 0);
  assert.equal(Number.isNaN(refined.output.linearZ[0]), true);
});
