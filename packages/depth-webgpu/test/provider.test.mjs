import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPTH_MODEL_ID,
  DEPTH_MODEL_REVISION,
  DEPTH_MODEL_DTYPE,
  RELATIVE_DEPTH_ORIENTATION,
  TRANSFORMERS_JS_ESM_URL,
  TRANSFORMERS_JS_VERSION,
  WebGPUMonocularDepthProvider,
  captureVideoFrame,
  normalizeRelativeDepth,
  preserveRawNearIsLargerDepth,
} from "../src/index.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeGpu() {
  const textures = [];
  const writes = [];
  const device = {
    createTexture(descriptor) {
      const texture = {
        descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(texture);
      return texture;
    },
    queue: {
      writeTexture(destination, data, layout, size) {
        writes.push({
          destination,
          data: data.slice(),
          layout: { ...layout },
          size: { ...size },
        });
      },
    },
  };
  return { device, textures, writes };
}

function fakeCapture(frame) {
  return {
    pixels: frame.pixels,
    width: frame.width,
    height: frame.height,
    sourceFrameId: frame.sourceFrameId,
    captureTimestamp: frame.captureTimestamp,
    close: frame.close,
  };
}

function frame(id, timestamp, pixels = new Uint8ClampedArray(16), close) {
  return {
    pixels,
    width: 2,
    height: 2,
    sourceFrameId: id,
    captureTimestamp: timestamp,
    close,
  };
}

function runtimeWith(infer) {
  const calls = [];
  const lifecycle = { estimatorDisposals: 0, runtimeDisposals: 0 };
  const runtime = {
    async createEstimator(options) {
      calls.push(options);
      return {
        infer,
        dispose() {
          lifecycle.estimatorDisposals += 1;
        },
      };
    },
    dispose() {
      lifecycle.runtimeDisposals += 1;
    },
  };
  return { runtime, calls, lifecycle };
}

const result = (data = [1, 2, 3, 4]) => ({
  data,
  width: 2,
  height: 2,
  orientation: "near-is-larger",
});

test("preserves finite raw near-is-larger signal without per-frame normalization", () => {
  assert.deepEqual([...preserveRawNearIsLargerDepth([-4, 0.5, 9], "near-is-larger")], [-4, 0.5, 9]);
  assert.equal(Number.isNaN(preserveRawNearIsLargerDepth([NaN], "near-is-larger")[0]), true);
  assert.throws(() => preserveRawNearIsLargerDepth([1, 2], "near-is-smaller"), /near-is-larger/);
});

test("pins the browser runtime and model revision", () => {
  assert.equal(TRANSFORMERS_JS_VERSION, "4.2.0");
  assert.equal(
    TRANSFORMERS_JS_ESM_URL,
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm",
  );
  assert.doesNotMatch(TRANSFORMERS_JS_ESM_URL, /\/dist\/transformers\.web\.min\.js$/);
  assert.equal(DEPTH_MODEL_ID, "onnx-community/depth-anything-v2-small");
  assert.equal(
    DEPTH_MODEL_REVISION,
    "4472b7362082ad9968fee890ca0f1e5aca36b93d",
  );
  assert.equal(DEPTH_MODEL_DTYPE, "q4");
  assert.equal(RELATIVE_DEPTH_ORIENTATION, "near-is-one");
});

test("normalizes only finite depth with an explicit near/far orientation", () => {
  assert.deepEqual(
    [...normalizeRelativeDepth([2, 4, Number.NaN, Infinity, 3], "near-is-larger")],
    [0, 1, 0, 0, 0.5],
  );
  assert.deepEqual(
    [...normalizeRelativeDepth([2, 4, 3], "near-is-smaller")],
    [1, 0, 0.5],
  );
  assert.deepEqual(
    [...normalizeRelativeDepth([7, 7, Number.NaN], "near-is-larger")],
    [0, 0, 0],
  );
});

test("captures exact RGBA camera pixels and timestamp association", async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const videoFrame = {
    displayWidth: 2,
    displayHeight: 1,
    codedWidth: 2,
    codedHeight: 1,
    timestamp: 12_500,
    async copyTo(destination, options) {
      assert.deepEqual(options, { format: "RGBA" });
      destination.set(source);
    },
  };
  const capture = await captureVideoFrame(videoFrame);
  assert.deepEqual([...capture.pixels], [...source]);
  assert.equal(capture.sourceFrameId, "video-frame:12500");
  assert.equal(capture.captureTimestamp, 12.5);
});

test("forwards pixels and preserves association while uploading padded textures", async () => {
  const gpu = fakeGpu();
  const received = [];
  const fake = runtimeWith(async (input, options) => {
    received.push({ input, options });
    return result([1, 3, 2, Number.NaN]);
  });
  let releases = 0;
  const pixels = new Uint8ClampedArray([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
  ]);
  const provider = new WebGPUMonocularDepthProvider({
    device: gpu.device,
    runtime: fake.runtime,
    capture: fakeCapture,
  });

  const initializing = provider.initialize();
  assert.strictEqual(provider.initialize(), initializing);
  await initializing;
  const output = await provider.infer(
    frame("camera-17", 42.25, pixels, () => releases += 1),
  );

  assert.strictEqual(received[0].input.data, pixels);
  assert.equal(received[0].input.width, 2);
  assert.equal(received[0].input.height, 2);
  assert.equal(received[0].options.signal.aborted, false);
  assert.equal(output.sourceFrameId, "camera-17");
  assert.equal(output.captureTimestamp, 42.25);
  assert.equal(output.representation, "inverse-z");
  assert.equal(output.scale, "relative");
  assert.equal(output.unit, null);
  assert.equal(output.rawOrientation, "near-is-larger");
  assert.deepEqual([...output.rawInverseDepth], [1, 3, 2, NaN]);
  assert.equal(output.confidence, undefined);
  assert.equal(releases, 1);

  assert.equal(gpu.textures[0].descriptor.format, "r32float");
  assert.equal(gpu.textures.length, 1);
  assert.equal(gpu.writes[0].layout.bytesPerRow, 256);
  assert.equal(gpu.writes[0].layout.rowsPerImage, 2);
  assert.deepEqual([...gpu.writes[0].data.slice(0, 2)], [0, 1]);
  assert.deepEqual([...gpu.writes[0].data.slice(64, 66)], [0.5, 0]);
  assert.equal(gpu.writes.length, 1);
  await provider.dispose();
});

test("keeps only the latest pending inference and aborts superseded work", async () => {
  const gpu = fakeGpu();
  const first = deferred();
  const received = [];
  const fake = runtimeWith(async (input, { signal }) => {
    received.push({ input, signal });
    if (received.length === 1) return first.promise;
    return result();
  });
  const provider = new WebGPUMonocularDepthProvider({
    device: gpu.device,
    runtime: fake.runtime,
    capture: fakeCapture,
  });
  await provider.initialize();

  const active = provider.infer(frame("active", 1));
  const activeRejected = assert.rejects(active, { name: "AbortError" });
  await Promise.resolve();
  const replaced = provider.infer(frame("replaced", 2));
  const replacedRejected = assert.rejects(replaced, { name: "AbortError" });
  const latest = provider.infer(frame("latest", 3));
  first.resolve(result());

  await activeRejected;
  await replacedRejected;
  const output = await latest;
  assert.equal(output.sourceFrameId, "latest");
  assert.equal(received.length, 2);
  assert.equal(received[0].signal.aborted, true);
  await provider.dispose();
});

test("propagates inference failures and releases captures without fabricating output", async () => {
  const gpu = fakeGpu();
  const failure = new Error("model failed");
  const fake = runtimeWith(async () => {
    throw failure;
  });
  let releases = 0;
  const provider = new WebGPUMonocularDepthProvider({
    device: gpu.device,
    runtime: fake.runtime,
    capture: fakeCapture,
  });
  await provider.initialize();

  await assert.rejects(
    provider.infer(frame("failure", 4, undefined, () => releases += 1)),
    failure,
  );
  assert.equal(releases, 1);
  assert.equal(gpu.textures.length, 0);
  assert.equal(provider.state, "ready");
  await provider.dispose();
});

test("abort rejects active inference and stop rejects future inference", async () => {
  const gpu = fakeGpu();
  const pending = deferred();
  const fake = runtimeWith(() => pending.promise);
  const provider = new WebGPUMonocularDepthProvider({
    device: gpu.device,
    runtime: fake.runtime,
    capture: fakeCapture,
  });
  await provider.initialize();

  const inference = provider.infer(frame("abort", 5));
  const rejected = assert.rejects(inference, { name: "AbortError" });
  await Promise.resolve();
  provider.abort();
  pending.resolve(result());
  await rejected;
  provider.stop();
  provider.stop();
  assert.equal(provider.state, "stopped");
  await assert.rejects(provider.infer(frame("late", 6)), /stopped/);
  await provider.dispose();
});

test("dispose is idempotent and destroys textures, estimator, and runtime", async () => {
  const gpu = fakeGpu();
  const fake = runtimeWith(async () => result());
  let releases = 0;
  const provider = new WebGPUMonocularDepthProvider({
    device: gpu.device,
    runtime: fake.runtime,
    capture: fakeCapture,
  });
  await provider.initialize();
  await provider.infer(frame("dispose", 7, undefined, () => releases += 1));

  const disposal = provider.dispose();
  assert.strictEqual(provider.dispose(), disposal);
  await disposal;
  assert.equal(provider.state, "disposed");
  assert.equal(releases, 1);
  assert.ok(gpu.textures.every((texture) => texture.destroyed));
  assert.deepEqual(fake.lifecycle, {
    estimatorDisposals: 1,
    runtimeDisposals: 1,
  });
  await assert.rejects(provider.infer(frame("disposed", 8)), /disposed/);
});
