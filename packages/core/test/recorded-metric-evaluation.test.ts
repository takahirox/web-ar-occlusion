import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateRecordedMetricDepth } from "../src/recorded-metric-evaluation.ts";

const input = { schemaVersion: 1 as const, kind: "web-ar-occlusion-recorded-metric-input" as const, virtualZThresholds: [3, 1.5], frames: [{ id: "recorded-1", sourceId: "recording-1", sourceFrameId: "frame-1", captureTimestamp: 1000, predictedLinearZ: [1, 2, 4, null], referenceLinearZ: [1, 3, 4, 2] }] };

test("reports metric errors and each crossing threshold separately", () => {
  const output = evaluateRecordedMetricDepth(input);
  assert.equal(output.metric.sampleCount, 3);
  assert.equal(output.metric.maeMeters, 1 / 3);
  assert.ok(Math.abs(output.metric.rmseMeters - Math.sqrt(1 / 3)) < 1e-12);
  assert.equal(output.metric.absRel, 1 / 9);
  assert.deepEqual(output.crossings.map((item) => item.virtualZ), [1.5, 3]);
  assert.deepEqual(output.crossings[0], { virtualZ: 1.5, trueForeground: 1, falseForeground: 0, trueBackground: 2, falseBackground: 0, accuracy: 1, sampleCount: 3 });
  assert.deepEqual(output.crossings[1], { virtualZ: 3, trueForeground: 1, falseForeground: 1, trueBackground: 1, falseBackground: 0, accuracy: 2 / 3, sampleCount: 3 });
});

test("rejects missing thresholds and invalid depth without fabricating samples", () => {
  assert.throws(() => evaluateRecordedMetricDepth({ ...input, virtualZThresholds: [1] }), /at least two/);
  assert.throws(() => evaluateRecordedMetricDepth({ ...input, frames: [{ ...input.frames[0], id: "empty", predictedLinearZ: [null], referenceLinearZ: [1] }] }), /no jointly valid/);
  assert.throws(() => evaluateRecordedMetricDepth({ ...input, frames: [{ ...input.frames[0], sourceId: "" }] }), /malformed/);
  assert.throws(() => evaluateRecordedMetricDepth({ ...input, frames: [{ ...input.frames[0], sourceFrameId: "" }] }), /malformed/);
  assert.throws(() => evaluateRecordedMetricDepth({ ...input, frames: [{ ...input.frames[0], captureTimestamp: Number.NaN }] }), /malformed/);
  assert.throws(() => evaluateRecordedMetricDepth({ ...input, frames: [input.frames[0], { ...input.frames[0], id: "recorded-2" }] }), /duplicated/);
  assert.throws(() => evaluateRecordedMetricDepth({ ...input, frames: [input.frames[0], { ...input.frames[0], id: "recorded-2", sourceFrameId: "frame-2" }] }), /strictly increasing/);
});

test("CLI emits the same structured multi-threshold evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "metric-evaluation-"));
  try {
    const path = join(root, "input.json");
    await writeFile(path, JSON.stringify(input));
    const cli = fileURLToPath(new URL("../src/recorded-metric-evaluation.ts", import.meta.url));
    const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), evaluateRecordedMetricDepth(input));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
