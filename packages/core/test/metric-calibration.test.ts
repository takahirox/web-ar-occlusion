import assert from "node:assert/strict";
import test from "node:test";
import { applyKnownPlaneCalibration, captureKnownPlaneAnchor, fitKnownPlaneCalibration } from "../src/metric-calibration.ts";

function frame(sourceId = "camera-1", sourceFrameId = "frame-1", captureTimestamp = 1000, rawInverseDepth = [1, 2, 3, 4]) {
  return { sourceId, sourceFrameId, captureTimestamp, rawInverseDepth, width: 2, height: 2 };
}

function anchor(id: string, rawInverseDepth: number, distanceMeters: number, captureTimestamp = 1000, sourceId = "camera-1") {
  return { id, sourceId, sourceFrameId: `frame-${id}`, captureTimestamp, rawInverseDepth, distanceMeters };
}

test("captures only exact source-associated finite raw evidence", () => {
  const evidence = frame();
  assert.deepEqual(captureKnownPlaneAnchor({ id: "a", frame: evidence, expectedSourceFrameId: "frame-1", expectedCaptureTimestamp: 1000, x: 1, y: 0, distanceMeters: 2 }), { id: "a", sourceId: "camera-1", sourceFrameId: "frame-1", captureTimestamp: 1000, rawInverseDepth: 2, distanceMeters: 2 });
  assert.deepEqual(captureKnownPlaneAnchor({ id: "roi", frame: frame("camera-1", "frame-1", 1000, [1, NaN, 100, 3]), expectedSourceFrameId: "frame-1", expectedCaptureTimestamp: 1000, x: 0, y: 0, radius: 1, distanceMeters: 2 }).rawInverseDepth, 3);
  assert.throws(() => captureKnownPlaneAnchor({ id: "a", frame: evidence, expectedSourceFrameId: "other", expectedCaptureTimestamp: 1000, x: 0, y: 0, distanceMeters: 1 }), /association mismatch/);
  assert.throws(() => captureKnownPlaneAnchor({ id: "a", frame: frame("camera-1", "frame-1", 1000, [NaN, 2, 3, 4]), expectedSourceFrameId: "frame-1", expectedCaptureTimestamp: 1000, x: 0, y: 0, distanceMeters: 1 }), /finite ROI sample/);
  assert.throws(() => captureKnownPlaneAnchor({ id: "empty", frame: frame("camera-1", "frame-1", 1000, [NaN, NaN, NaN, NaN]), expectedSourceFrameId: "frame-1", expectedCaptureTimestamp: 1000, x: 0, y: 0, radius: 1, distanceMeters: 1 }), /finite ROI sample/);
});

test("deterministically fits and applies 1 over z equals a d plus b", () => {
  const fit = fitKnownPlaneCalibration([
    anchor("far", 1, 2),
    anchor("near", 3, 1),
    anchor("middle", 2, 4 / 3),
  ], { nowTimestamp: 1000 });
  assert.equal(fit.valid, true);
  if (!fit.valid) return;
  assert.ok(Math.abs(fit.model.slope - 0.25) < 1e-12);
  assert.ok(Math.abs(fit.model.intercept - 0.25) < 1e-12);
  assert.ok(fit.model.inverseDepthRmse < 1e-12);
  const applied = applyKnownPlaneCalibration(frame("camera-1", "next", 1001, [1, 2, 3, Number.NaN]), fit.model, 1001);
  assert.equal(applied.usable, true);
  if (!applied.usable) return;
  assert.deepEqual([...applied.validity], [1, 1, 1, 0]);
  assert.ok(Math.abs(applied.linearZ[0]! - 2) < 1e-6);
  assert.ok(Math.abs(applied.linearZ[1]! - 4 / 3) < 1e-6);
  assert.ok(Math.abs(applied.linearZ[2]! - 1) < 1e-6);
  assert.equal(applied.linearZ[3], 0);
  assert.equal(applied.sourceId, "camera-1");
  assert.equal(applied.sourceFrameId, "next");
  assert.equal(applied.captureTimestamp, 1001);
  assert.equal(applied.representation, "linear-z");
  assert.equal(applied.scale, "metric");
  assert.equal(applied.unit, "meter");
});

test("rejects bad range, residual, direction, stale and mismatched evidence", () => {
  assert.deepEqual(fitKnownPlaneCalibration([anchor("a", 1, 1), anchor("b", 1, 2)], { nowTimestamp: 1000 }), { valid: false, state: "lost", reason: "insufficient-raw-range" });
  assert.deepEqual(fitKnownPlaneCalibration([anchor("a", 1, 1), anchor("b", 2, 2)], { nowTimestamp: 1000 }), { valid: false, state: "lost", reason: "non-positive-near-is-larger-slope" });
  assert.deepEqual(fitKnownPlaneCalibration([anchor("a", 1, 2), anchor("b", 3, 1), anchor("c", 2, 10)], { nowTimestamp: 1000, maximumInverseDepthRmse: 0.01 }), { valid: false, state: "lost", reason: "residual-too-large" });
  assert.deepEqual(fitKnownPlaneCalibration([anchor("a", 1, 2, 0), anchor("b", 3, 1, 0)], { nowTimestamp: 60_001 }), { valid: false, state: "lost", reason: "stale-anchor" });
  assert.deepEqual(fitKnownPlaneCalibration([anchor("a", 1, 2), anchor("b", 3, 1, 1000, "camera-2")], { nowTimestamp: 1000 }), { valid: false, state: "lost", reason: "invalid-or-mismatched-anchor" });
});

test("requires two anchors and fails closed when application is stale or from another source", () => {
  assert.deepEqual(fitKnownPlaneCalibration([anchor("a", 1, 2)], { nowTimestamp: 1000 }), { valid: false, state: "relative-only", reason: "at-least-two-anchors-required" });
  const fit = fitKnownPlaneCalibration([anchor("a", 1, 2), anchor("b", 3, 1)], { nowTimestamp: 1000, maximumApplicationAgeMs: 10 });
  assert.equal(fit.valid, true);
  if (!fit.valid) return;
  assert.deepEqual(applyKnownPlaneCalibration(frame("camera-2", "next", 1001), fit.model, 1001), { usable: false, state: "lost", reason: "source-mismatch" });
  assert.deepEqual(applyKnownPlaneCalibration(frame("camera-1", "next", 1011), fit.model, 1011), { usable: false, state: "lost", reason: "calibration-stale" });
  assert.deepEqual(applyKnownPlaneCalibration(frame("camera-1", "old", 1001), fit.model, 1012), { usable: false, state: "lost", reason: "source-frame-stale" });
  assert.deepEqual(applyKnownPlaneCalibration(frame("camera-1", "future", 1012), fit.model, 1011), { usable: false, state: "lost", reason: "source-frame-from-future" });
});
