export const TRANSFORMERS_JS_VERSION = "4.2.0";
export const TRANSFORMERS_JS_ESM_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm";
export const DEPTH_MODEL_ID = "onnx-community/depth-anything-v2-small";
export const DEPTH_MODEL_REVISION =
  "4472b7362082ad9968fee890ca0f1e5aca36b93d";
export const DEPTH_MODEL_DTYPE = "q4";
export const RELATIVE_DEPTH_ORIENTATION = "near-is-one";

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

export interface RuntimeDepthResult {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  readonly orientation: RawDepthOrientation;
}

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
  }): Promise<DepthEstimator>;
  dispose?(): void | Promise<void>;
}

export type FrameCapture = (
  frame: VideoFrame,
) => CapturedVideoFrame | Promise<CapturedVideoFrame>;

export interface WebGPUDepthProviderOptions {
  readonly device: GPUDevice;
  readonly runtime?: DepthRuntime;
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
  readonly confidence?: GPUTexture;
  readonly representation: "inverse-z";
  readonly scale: "relative";
  readonly unit: null;
  readonly captureTimestamp: number;
  readonly sourceFrameId: string;
  readonly uvTransform: Float32Array;
  readonly width: number;
  readonly height: number;
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
    const normalized = normalizeRelativeDepth(result.data, result.orientation);
    const created: GPUTexture[] = [];
    try {
      const depth = this.#upload("r32float", normalized, result.width, result.height);
      created.push(depth);
      for (const texture of created) this.#textures.add(texture);
      return {
        depth,
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
