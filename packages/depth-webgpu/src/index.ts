export const TRANSFORMERS_JS_VERSION = "4.2.0";
export const TRANSFORMERS_JS_ESM_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm";
export const DEPTH_MODEL_ID = "onnx-community/depth-anything-v2-small";
export const DEPTH_MODEL_REVISION =
  "4472b7362082ad9968fee890ca0f1e5aca36b93d";
export const DEPTH_MODEL_DTYPE = "q4";
export const RELATIVE_DEPTH_ORIENTATION = "near-is-one";
export const ONNX_RUNTIME_WEB_VERSION = "1.29.0";
export const ONNX_RUNTIME_WEBGPU_ESM_URL =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.webgpu.bundle.min.mjs";
export const METRIC_DEPTH_MODEL_ID =
  "77ukhtar/depth-anything-v2-metric-onnx";
export const METRIC_DEPTH_MODEL_REVISION =
  "a4259a3c45137b6eb32c84fcd95b86cd54c255b9";
export const METRIC_DEPTH_MODEL_FILENAME = "model.onnx";
export const METRIC_DEPTH_MODEL_URL =
  "https://huggingface.co/77ukhtar/depth-anything-v2-metric-onnx/resolve/a4259a3c45137b6eb32c84fcd95b86cd54c255b9/model.onnx";
export const METRIC_DEPTH_MODEL_SHA256 =
  "badcaa28c923da4b0bfaa370ed709acfa00e9f743d295d5443e2149a383413c9";
export const METRIC_DEPTH_MODEL_SIZE_BYTES = 98_941_181;
export const METRIC_DEPTH_MODEL_LICENSE = "Apache-2.0";
export const METRIC_DEPTH_MODEL_FAMILY =
  "Depth Anything V2 Metric Hypersim Small";
export const METRIC_DEPTH_INPUT_NAME = "pixel_values";
export const METRIC_DEPTH_INPUT_SHAPE = [1, 3, 518, 518] as const;
export const METRIC_DEPTH_INPUT_DTYPE = "float32";
export const METRIC_DEPTH_OUTPUT_NAME = "predicted_depth";
export const METRIC_DEPTH_OUTPUT_SHAPE = [1, 518, 518] as const;
export const METRIC_DEPTH_OUTPUT_UNIT = "meter";
export const METRIC_DEPTH_OUTPUT_MIN_METERS = 0;
export const METRIC_DEPTH_OUTPUT_MAX_METERS = 20;
export const METRIC_DEPTH_OUTPUT_ORIENTATION = "far-is-larger";
export const METRIC_DEPTH_INPUT_SIZE = 518;
export const METRIC_DEPTH_IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
export const METRIC_DEPTH_IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export type RawDepthOrientation = "near-is-larger" | "near-is-smaller";

export interface CapturedVideoFrame {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
  readonly release?: () => void;
  readonly close?: () => void;
}

export interface RelativeRuntimeDepthResult {
  readonly kind?: "relative";
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  readonly orientation: RawDepthOrientation;
}

export interface NativeMetricRuntimeDepthResult {
  readonly kind: "native-metric";
  readonly data: Float32Array;
  readonly width: typeof METRIC_DEPTH_INPUT_SIZE;
  readonly height: typeof METRIC_DEPTH_INPUT_SIZE;
}

export type RuntimeDepthResult =
  | RelativeRuntimeDepthResult
  | NativeMetricRuntimeDepthResult;

export interface DepthEstimator {
  infer(
    input: {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
    },
    options: { readonly signal: AbortSignal },
  ): Promise<RuntimeDepthResult>;
  dispose?(): void | Promise<void>;
}

export interface DepthRuntime {
  createEstimator(options: {
    readonly model: typeof DEPTH_MODEL_ID;
    readonly revision: typeof DEPTH_MODEL_REVISION;
    readonly device: "webgpu";
    readonly dtype: typeof DEPTH_MODEL_DTYPE;
    readonly signal?: AbortSignal;
  }): Promise<DepthEstimator>;
  dispose?(): void | Promise<void>;
}

export type FrameCapture = (
  frame: VideoFrame,
) => CapturedVideoFrame | Promise<CapturedVideoFrame>;

export interface WebGPUDepthProviderOptions {
  readonly device: GPUDevice;
  readonly runtime?: DepthRuntime;
  readonly nativeMetricRuntimeDependencies?: NativeMetricDepthRuntimeDependencies;
  readonly capture?: FrameCapture;
}

interface PendingInference {
  readonly sequence: number;
  readonly capture: CapturedVideoFrame;
  readonly resolve: (frame: ProviderDepthFrame) => void;
  readonly reject: (error: unknown) => void;
}

interface ActiveInference extends PendingInference {
  readonly controller: AbortController;
  readonly generation: number;
}

export interface ProviderDepthFrame {
  readonly depth: GPUTexture;
  readonly rawInverseDepth: Float32Array;
  readonly rawOrientation: "near-is-larger";
  readonly confidence?: GPUTexture;
  readonly representation: "inverse-z";
  readonly scale: "relative";
  readonly unit: null;
  readonly nativeMetric?: NativeMetricDepthEvidence;
  readonly captureTimestamp: number;
  readonly sourceFrameId: string;
  readonly uvTransform: Float32Array;
  readonly width: number;
  readonly height: number;
}

export interface NativeMetricDepthEvidence {
  readonly linearZMeters: Float32Array;
  readonly validity: Uint8Array;
  readonly inverseZ: Float32Array;
  readonly width: typeof METRIC_DEPTH_INPUT_SIZE;
  readonly height: typeof METRIC_DEPTH_INPUT_SIZE;
  readonly representation: "linear-z";
  readonly scale: "metric";
  readonly unit: "meter";
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
}

interface NativeMetricOrtTensor {
  readonly type?: string;
  readonly data?: unknown;
  readonly dims?: ArrayLike<number>;
}

interface NativeMetricOrtSession {
  readonly inputNames?: readonly string[];
  readonly outputNames?: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, NativeMetricOrtTensor>>;
  release?(): void | Promise<void>;
}

interface NativeMetricOrtModule {
  readonly Tensor: new (
    type: "float32",
    data: Float32Array,
    dims: readonly number[],
  ) => unknown;
  readonly InferenceSession: {
    create(
      model: Uint8Array,
      options: { readonly executionProviders: readonly ["webgpu"] },
    ): Promise<NativeMetricOrtSession>;
  };
}

interface MetricModelResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface NativeMetricDepthRuntimeDependencies {
  readonly loadOrt?: () => Promise<NativeMetricOrtModule>;
  readonly fetch?: (
    url: string,
    init: { readonly signal?: AbortSignal },
  ) => Promise<MetricModelResponse>;
  readonly crypto?: {
    readonly subtle: {
      digest(algorithm: "SHA-256", data: ArrayBuffer): Promise<ArrayBuffer>;
    };
  };
  readonly resize?: (
    input: {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
    },
    options: { readonly signal: AbortSignal },
  ) => Uint8ClampedArray | Promise<Uint8ClampedArray>;
  readonly expectedModelSizeBytes?: number;
  readonly expectedModelSha256?: string;
}

const TEXTURE_USAGE_COPY_DST = 0x02;
const TEXTURE_USAGE_BINDING = 0x04;
const IDENTITY_UV_TRANSFORM = new Float32Array([
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
]);

function abortError(message: string): Error {
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function releaseCapture(capture: CapturedVideoFrame): void {
  try {
    (capture.release ?? capture.close)?.();
  } catch {
    // Capture cleanup must not hide the inference outcome.
  }
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validateCapture(capture: CapturedVideoFrame): void {
  if (
    !validDimension(capture.width) ||
    !validDimension(capture.height) ||
    capture.pixels.length !== capture.width * capture.height * 4 ||
    typeof capture.sourceFrameId !== "string" ||
    capture.sourceFrameId.length === 0 ||
    !Number.isFinite(capture.captureTimestamp)
  ) {
    throw new TypeError("Frame capture returned invalid pixels or association");
  }
}

export async function captureVideoFrame(
  frame: VideoFrame,
): Promise<CapturedVideoFrame> {
  const width = frame.displayWidth || frame.codedWidth;
  const height = frame.displayHeight || frame.codedHeight;
  const timestamp = frame.timestamp;
  if (
    !validDimension(width) ||
    !validDimension(height) ||
    !Number.isFinite(timestamp)
  ) {
    throw new TypeError("VideoFrame dimensions and timestamp must be valid");
  }

  const bytes = new Uint8Array(width * height * 4);
  await frame.copyTo(bytes, { format: "RGBA" });
  return {
    pixels: new Uint8ClampedArray(bytes.buffer),
    width,
    height,
    sourceFrameId: `video-frame:${timestamp}`,
    captureTimestamp: timestamp / 1_000,
  };
}

export function normalizeMetricRgbaToNchw(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const expectedLength =
    METRIC_DEPTH_INPUT_SIZE * METRIC_DEPTH_INPUT_SIZE * 4;
  if (
    !(rgba instanceof Uint8ClampedArray) ||
    width !== METRIC_DEPTH_INPUT_SIZE ||
    height !== METRIC_DEPTH_INPUT_SIZE ||
    rgba.length !== expectedLength
  ) {
    throw new TypeError(
      "Metric depth input must be a Uint8ClampedArray containing exactly 518x518 RGBA pixels",
    );
  }

  const planeSize = width * height;
  const output = new Float32Array(3 * planeSize);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const rgbaOffset = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      output[channel * planeSize + pixel] =
        (rgba[rgbaOffset + channel]! / 255 -
          METRIC_DEPTH_IMAGENET_MEAN[channel]!) /
        METRIC_DEPTH_IMAGENET_STD[channel]!;
    }
  }
  return output;
}

export function createNativeMetricDepthEvidence(
  values: ArrayLike<number>,
  width: number,
  height: number,
  sourceFrameId: string,
  captureTimestamp: number,
): NativeMetricDepthEvidence {
  const sampleCount = METRIC_DEPTH_INPUT_SIZE ** 2;
  if (
    values == null ||
    width !== METRIC_DEPTH_INPUT_SIZE ||
    height !== METRIC_DEPTH_INPUT_SIZE ||
    values.length !== sampleCount
  ) {
    throw new TypeError(
      "Metric depth output must contain exactly 518x518 samples",
    );
  }
  if (
    typeof sourceFrameId !== "string" ||
    sourceFrameId.trim().length === 0 ||
    !Number.isFinite(captureTimestamp)
  ) {
    throw new TypeError(
      "Metric depth evidence requires a nonempty sourceFrameId and finite captureTimestamp",
    );
  }

  const linearZMeters = new Float32Array(sampleCount);
  const validity = new Uint8Array(sampleCount);
  const inverseZ = new Float32Array(sampleCount);
  linearZMeters.fill(Number.NaN);
  inverseZ.fill(Number.NaN);

  let validCount = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = values[index];
    if (
      typeof sample !== "number" ||
      !Number.isFinite(sample) ||
      sample <= METRIC_DEPTH_OUTPUT_MIN_METERS ||
      sample > METRIC_DEPTH_OUTPUT_MAX_METERS
    ) {
      continue;
    }

    const linearZ = Math.fround(sample);
    const reciprocal = Math.fround(1 / linearZ);
    if (linearZ <= 0 || !Number.isFinite(reciprocal)) continue;

    linearZMeters[index] = linearZ;
    inverseZ[index] = reciprocal;
    validity[index] = 1;
    validCount += 1;
  }

  if (validCount === 0) {
    throw new RangeError("Metric depth output contains no valid samples");
  }

  return Object.freeze({
    linearZMeters,
    validity,
    inverseZ,
    width: METRIC_DEPTH_INPUT_SIZE,
    height: METRIC_DEPTH_INPUT_SIZE,
    representation: "linear-z",
    scale: "metric",
    unit: "meter",
    sourceFrameId,
    captureTimestamp,
  });
}

export function normalizeRelativeDepth(
  values: ArrayLike<number>,
  orientation: RawDepthOrientation,
): Float32Array {
  if (
    orientation !== "near-is-larger" &&
    orientation !== "near-is-smaller"
  ) {
    throw new TypeError("Unknown raw depth orientation");
  }

  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (Number.isFinite(value)) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }

  const normalized = new Float32Array(values.length);
  const range = maximum - minimum;
  if (!Number.isFinite(range) || range <= 0) {
    return normalized;
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!Number.isFinite(value)) {
      normalized[index] = 0;
      continue;
    }
    const increasing = (value - minimum) / range;
    normalized[index] =
      orientation === "near-is-larger" ? increasing : 1 - increasing;
  }
  return normalized;
}

export function preserveRawNearIsLargerDepth(values: ArrayLike<number>, orientation: RawDepthOrientation): Float32Array {
  if (orientation !== "near-is-larger") throw new TypeError("Metric calibration requires stable near-is-larger raw output");
  const raw = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    raw[index] = Number.isFinite(value) ? value : Number.NaN;
  }
  return raw;
}

function paddedRows(
  source: Float32Array | Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): { data: Float32Array | Uint8Array; bytesPerRow: number } {
  const unpaddedBytes = width * bytesPerPixel;
  const bytesPerRow = Math.ceil(unpaddedBytes / 256) * 256;
  const elementsPerRow = bytesPerRow / bytesPerPixel;
  const data =
    bytesPerPixel === 4
      ? new Float32Array(elementsPerRow * height)
      : new Uint8Array(bytesPerRow * height);
  for (let row = 0; row < height; row += 1) {
    data.set(
      source.subarray(row * width, (row + 1) * width),
      row * elementsPerRow,
    );
  }
  return { data, bytesPerRow };
}

function extractRuntimeDepth(value: unknown): {
  data: ArrayLike<number>;
  width: number;
  height: number;
} {
  const result = (Array.isArray(value) ? value[0] : value) as {
    predicted_depth?: {
      data?: ArrayLike<number>;
      dims?: ArrayLike<number>;
      width?: number;
      height?: number;
    };
    depth?: {
      data?: ArrayLike<number>;
      dims?: ArrayLike<number>;
      width?: number;
      height?: number;
    };
  };
  const depth = result?.predicted_depth ?? result?.depth;
  const dims = depth?.dims;
  const width = depth?.width ?? dims?.[dims.length - 1] ?? 0;
  const height = depth?.height ?? dims?.[dims.length - 2] ?? 0;
  if (!depth?.data || !validDimension(width) || !validDimension(height)) {
    throw new TypeError("Transformers.js returned an invalid depth tensor");
  }
  return { data: depth.data, width, height };
}

function throwIfAborted(signal: AbortSignal, message: string): void {
  if (signal.aborted) throw abortError(message);
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

async function resizeMetricRgba(
  input: {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
  },
  options: { readonly signal: AbortSignal },
): Promise<Uint8ClampedArray> {
  throwIfAborted(options.signal, "Metric depth resize aborted");
  if (
    !validDimension(input.width) ||
    !validDimension(input.height) ||
    input.data.length !== input.width * input.height * 4
  ) {
    throw new TypeError("Metric depth resize received invalid RGBA pixels");
  }
  if (
    input.width === METRIC_DEPTH_INPUT_SIZE &&
    input.height === METRIC_DEPTH_INPUT_SIZE
  ) {
    return new Uint8ClampedArray(input.data);
  }

  const image = new ImageData(
    new Uint8ClampedArray(input.data),
    input.width,
    input.height,
  );
  const bitmap = await createImageBitmap(image, {
    resizeWidth: METRIC_DEPTH_INPUT_SIZE,
    resizeHeight: METRIC_DEPTH_INPUT_SIZE,
    resizeQuality: "high",
  });
  try {
    throwIfAborted(options.signal, "Metric depth resize aborted");
    const canvas = new OffscreenCanvas(
      METRIC_DEPTH_INPUT_SIZE,
      METRIC_DEPTH_INPUT_SIZE,
    );
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas is unavailable for metric depth");
    context.drawImage(
      bitmap,
      0,
      0,
      METRIC_DEPTH_INPUT_SIZE,
      METRIC_DEPTH_INPUT_SIZE,
    );
    throwIfAborted(options.signal, "Metric depth resize aborted");
    return new Uint8ClampedArray(
      context.getImageData(
        0,
        0,
        METRIC_DEPTH_INPUT_SIZE,
        METRIC_DEPTH_INPUT_SIZE,
      ).data,
    );
  } finally {
    bitmap.close();
  }
}

function hasExactNames(actual: readonly string[] | undefined, name: string): boolean {
  return actual?.length === 1 && actual[0] === name;
}

function hasExactDims(
  actual: ArrayLike<number> | undefined,
  expected: readonly number[],
): boolean {
  return actual?.length === expected.length &&
    expected.every((value, index) => actual[index] === value);
}

export function createNativeMetricDepthRuntime(
  dependencies: NativeMetricDepthRuntimeDependencies = {},
): DepthRuntime {
  let releaseSession: (() => Promise<void>) | undefined;

  return {
    async createEstimator(options) {
      if (releaseSession) {
        throw new Error("Native metric estimator was already created");
      }
      const signal = options.signal ?? new AbortController().signal;
      const fetchModel = dependencies.fetch ?? ((url, init) =>
        globalThis.fetch(url, init));
      const cryptoProvider = dependencies.crypto ?? globalThis.crypto;
      const expectedSize = dependencies.expectedModelSizeBytes ??
        METRIC_DEPTH_MODEL_SIZE_BYTES;
      const expectedSha = dependencies.expectedModelSha256 ??
        METRIC_DEPTH_MODEL_SHA256;

      throwIfAborted(signal, "Metric depth initialization aborted");
      const response = await fetchModel(METRIC_DEPTH_MODEL_URL, { signal });
      throwIfAborted(signal, "Metric depth initialization aborted");
      if (!response.ok) {
        throw new Error(`Metric depth model fetch failed (${response.status})`);
      }
      const modelBytes = await response.arrayBuffer();
      throwIfAborted(signal, "Metric depth initialization aborted");
      if (modelBytes.byteLength !== expectedSize) {
        throw new TypeError("Metric depth model byte length did not match its pin");
      }
      if (!cryptoProvider?.subtle) {
        throw new Error("Web Crypto is required to verify the metric depth model");
      }
      const digest = await cryptoProvider.subtle.digest("SHA-256", modelBytes);
      throwIfAborted(signal, "Metric depth initialization aborted");
      if (bytesToHex(digest) !== expectedSha) {
        throw new TypeError("Metric depth model SHA-256 did not match its pin");
      }

      const loadOrt = dependencies.loadOrt ?? (async () =>
        await import(ONNX_RUNTIME_WEBGPU_ESM_URL) as NativeMetricOrtModule);
      throwIfAborted(signal, "Metric depth initialization aborted");
      const ort = await loadOrt();
      throwIfAborted(signal, "Metric depth initialization aborted");
      const session = await ort.InferenceSession.create(
        new Uint8Array(modelBytes),
        { executionProviders: ["webgpu"] },
      );

      let released = false;
      let releasePromise: Promise<void> | undefined;
      const releaseOnce = (): Promise<void> => {
        if (!releasePromise) {
          released = true;
          releasePromise = Promise.resolve(session.release?.()).then(() => undefined);
        }
        return releasePromise;
      };
      releaseSession = releaseOnce;

      if (signal.aborted) {
        await releaseOnce();
        throw abortError("Metric depth initialization aborted");
      }
      if (
        !hasExactNames(session.inputNames, METRIC_DEPTH_INPUT_NAME) ||
        !hasExactNames(session.outputNames, METRIC_DEPTH_OUTPUT_NAME)
      ) {
        await releaseOnce();
        throw new TypeError("Metric depth model tensor names did not match their pins");
      }

      const resize = dependencies.resize ?? resizeMetricRgba;
      return {
        async infer(input, inferenceOptions) {
          if (released) throw new Error("Metric depth estimator is disposed");
          throwIfAborted(inferenceOptions.signal, "Metric depth inference aborted");
          const resized = await resize(input, inferenceOptions);
          throwIfAborted(inferenceOptions.signal, "Metric depth inference aborted");
          if (
            !(resized instanceof Uint8ClampedArray) ||
            resized.length !== METRIC_DEPTH_INPUT_SIZE ** 2 * 4
          ) {
            throw new TypeError("Metric depth resize must return exactly 518x518 RGBA pixels");
          }
          const normalized = normalizeMetricRgbaToNchw(
            resized,
            METRIC_DEPTH_INPUT_SIZE,
            METRIC_DEPTH_INPUT_SIZE,
          );
          const tensor = new ort.Tensor(
            METRIC_DEPTH_INPUT_DTYPE,
            normalized,
            METRIC_DEPTH_INPUT_SHAPE,
          );
          const outputs = await session.run({
            [METRIC_DEPTH_INPUT_NAME]: tensor,
          });
          throwIfAborted(inferenceOptions.signal, "Metric depth inference aborted");
          if (!Object.prototype.hasOwnProperty.call(outputs, METRIC_DEPTH_OUTPUT_NAME)) {
            throw new TypeError("Metric depth output tensor is missing");
          }
          const output = outputs[METRIC_DEPTH_OUTPUT_NAME];
          if (
            output?.type !== METRIC_DEPTH_INPUT_DTYPE ||
            !(output.data instanceof Float32Array) ||
            !hasExactDims(output.dims, METRIC_DEPTH_OUTPUT_SHAPE) ||
            output.data.length !== METRIC_DEPTH_INPUT_SIZE ** 2
          ) {
            throw new TypeError("Metric depth output tensor did not match its pin");
          }
          if (!output.data.some((value) =>
            Number.isFinite(value) &&
            value > METRIC_DEPTH_OUTPUT_MIN_METERS &&
            value <= METRIC_DEPTH_OUTPUT_MAX_METERS
          )) {
            throw new RangeError("Metric depth output contains no valid samples");
          }
          return {
            kind: "native-metric",
            data: output.data,
            width: METRIC_DEPTH_INPUT_SIZE,
            height: METRIC_DEPTH_INPUT_SIZE,
          };
        },
        dispose: releaseOnce,
      };
    },
    async dispose() {
      await releaseSession?.();
    },
  };
}

export function createTransformersDepthRuntime(): DepthRuntime {
  return {
    async createEstimator({ model, revision, dtype }) {
      const transformers = await import(TRANSFORMERS_JS_ESM_URL) as {
        RawImage: new (
          data: Uint8ClampedArray,
          width: number,
          height: number,
          channels: number,
        ) => unknown;
        pipeline(
          task: "depth-estimation",
          modelId: string,
          options: { revision: string; device: "webgpu"; dtype: string },
        ): Promise<{
          (image: unknown): Promise<unknown>;
          dispose?(): void | Promise<void>;
        }>;
      };
      const pipeline = await transformers.pipeline("depth-estimation", model, {
        revision,
        device: "webgpu",
        dtype,
      });
      return {
        async infer(input, { signal }) {
          if (signal.aborted) throw abortError("Inference aborted");
          const image = new transformers.RawImage(
            input.data,
            input.width,
            input.height,
            4,
          );
          const output = await pipeline(image);
          if (signal.aborted) throw abortError("Inference aborted");
          return {
            ...extractRuntimeDepth(output),
            orientation: "near-is-larger",
          };
        },
        dispose: () => pipeline.dispose?.(),
      };
    },
  };
}

export type WebGPUDepthProviderState =
  | "new"
  | "initializing"
  | "ready"
  | "failed"
  | "stopped"
  | "disposed";

export class WebGPUMonocularDepthProvider {
  readonly #device: GPUDevice;
  readonly #runtime: DepthRuntime;
  readonly #capture: FrameCapture;
  #state: WebGPUDepthProviderState = "new";
  #initialization: Promise<void> | undefined;
  #estimator: DepthEstimator | undefined;
  #sequence = 0;
  #generation = 0;
  #active: ActiveInference | undefined;
  #pending: PendingInference | undefined;
  #textures = new Set<GPUTexture>();
  #disposal: Promise<void> | undefined;

  constructor(options: WebGPUDepthProviderOptions) {
    this.#device = options.device;
    this.#runtime = options.runtime ?? createTransformersDepthRuntime();
    this.#capture = options.capture ?? captureVideoFrame;
  }

  get state(): WebGPUDepthProviderState {
    return this.#state;
  }

  initialize(): Promise<void> {
    if (this.#state === "ready") return Promise.resolve();
    if (this.#state === "initializing") return this.#initialization!;
    if (this.#state !== "new") {
      return Promise.reject(new Error(`Cannot initialize a ${this.#state} provider`));
    }

    this.#state = "initializing";
    const generation = this.#generation;
    this.#initialization = this.#runtime.createEstimator({
      model: DEPTH_MODEL_ID,
      revision: DEPTH_MODEL_REVISION,
      device: "webgpu",
      dtype: DEPTH_MODEL_DTYPE,
    }).then(async (estimator) => {
      if (this.#state !== "initializing" || this.#generation !== generation) {
        await estimator.dispose?.();
        throw abortError("Initialization superseded");
      }
      this.#estimator = estimator;
      this.#state = "ready";
    }, (error: unknown) => {
      if (this.#state === "initializing") this.#state = "failed";
      throw error;
    });
    return this.#initialization;
  }

  infer(frame: VideoFrame): Promise<ProviderDepthFrame> {
    if (this.#state !== "ready") {
      return Promise.reject(new Error(`Cannot infer in ${this.#state} state`));
    }

    const sequence = ++this.#sequence;
    return new Promise((resolve, reject) => {
      Promise.resolve(this.#capture(frame)).then((capture) => {
        try {
          validateCapture(capture);
        } catch (error) {
          releaseCapture(capture);
          reject(error);
          return;
        }
        if (this.#state !== "ready" || sequence !== this.#sequence) {
          releaseCapture(capture);
          reject(abortError("Inference superseded"));
          return;
        }
        this.#enqueue({ sequence, capture, resolve, reject });
      }, reject);
    });
  }

  abort(): void {
    this.#generation += 1;
    this.#active?.controller.abort();
    if (this.#pending) {
      releaseCapture(this.#pending.capture);
      this.#pending.reject(abortError("Inference aborted"));
      this.#pending = undefined;
    }
  }

  stop(): void {
    if (this.#state === "stopped" || this.#state === "disposed") return;
    this.abort();
    this.#state = "stopped";
  }

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.stop();
    this.#state = "disposed";
    this.#disposal = (async () => {
      await this.#initialization?.catch(() => undefined);
      const estimator = this.#estimator;
      this.#estimator = undefined;
      await estimator?.dispose?.();
      for (const texture of this.#textures) texture.destroy();
      this.#textures.clear();
      await this.#runtime.dispose?.();
    })();
    return this.#disposal;
  }

  #enqueue(request: PendingInference): void {
    if (this.#active) {
      this.#active.controller.abort();
      if (this.#pending) {
        releaseCapture(this.#pending.capture);
        this.#pending.reject(abortError("Inference superseded"));
      }
      this.#pending = request;
      return;
    }
    this.#start(request);
  }

  #start(request: PendingInference): void {
    const active: ActiveInference = {
      ...request,
      controller: new AbortController(),
      generation: this.#generation,
    };
    this.#active = active;
    void this.#run(active);
  }

  async #run(active: ActiveInference): Promise<void> {
    try {
      const result = await this.#estimator!.infer({
        data: active.capture.pixels,
        width: active.capture.width,
        height: active.capture.height,
      }, { signal: active.controller.signal });
      if (
        active.controller.signal.aborted ||
        active.generation !== this.#generation ||
        this.#state !== "ready"
      ) {
        throw abortError("Inference aborted");
      }
      active.resolve(this.#createFrame(result, active.capture));
    } catch (error) {
      active.reject(error);
    } finally {
      releaseCapture(active.capture);
      if (this.#active === active) this.#active = undefined;
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending && this.#state === "ready") this.#start(pending);
      else if (pending) {
        releaseCapture(pending.capture);
        pending.reject(abortError("Provider stopped"));
      }
    }
  }

  #createFrame(
    result: RuntimeDepthResult,
    capture: CapturedVideoFrame,
  ): ProviderDepthFrame {
    if (
      !validDimension(result.width) ||
      !validDimension(result.height) ||
      result.data.length !== result.width * result.height
    ) {
      throw new TypeError("Runtime returned invalid depth dimensions");
    }
    const rawInverseDepth = preserveRawNearIsLargerDepth(result.data, result.orientation);
    const normalized = normalizeRelativeDepth(rawInverseDepth, result.orientation);
    const created: GPUTexture[] = [];
    try {
      const depth = this.#upload("r32float", normalized, result.width, result.height);
      created.push(depth);
      for (const texture of created) this.#textures.add(texture);
      return {
        depth,
        rawInverseDepth,
        rawOrientation: "near-is-larger",
        representation: "inverse-z",
        scale: "relative",
        unit: null,
        captureTimestamp: capture.captureTimestamp,
        sourceFrameId: capture.sourceFrameId,
        uvTransform: new Float32Array(IDENTITY_UV_TRANSFORM),
        width: result.width,
        height: result.height,
      };
    } catch (error) {
      for (const texture of created) texture.destroy();
      throw error;
    }
  }

  #upload(
    format: "r32float" | "r8unorm",
    source: Float32Array | Uint8Array,
    width: number,
    height: number,
  ): GPUTexture {
    const texture = this.#device.createTexture({
      label: `monocular-depth-${format}`,
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_BINDING,
    });
    const bytesPerPixel = format === "r32float" ? 4 : 1;
    const upload = paddedRows(source, width, height, bytesPerPixel);
    try {
      this.#device.queue.writeTexture(
        { texture },
        upload.data,
        { offset: 0, bytesPerRow: upload.bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      return texture;
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }
}
