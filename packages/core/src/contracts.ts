export type CalibrationState =
  | {
      status: "calibrated";
      canonicalDepthTexture: GPUTexture;
    }
  | {
      status: "relative-only";
      canonicalDepthTexture?: never;
    }
  | {
      status: "lost";
      canonicalDepthTexture?: never;
    };

export interface DepthFrame {
  depth: GPUTexture;
  confidence: GPUTexture;
  representation: "linear-z" | "inverse-z";
  scale: "metric" | "relative";
  unit: "meter" | null;
  captureTimestamp: number;
  sourceFrameId: string;
  uvTransform: Float32Array;
  width: number;
  height: number;
}

export interface OcclusionFrame {
  occlusionTexture: GPUTexture;
  confidenceTexture?: GPUTexture;
  depthTexture?: GPUTexture;
  timestamp: number;
  quality: {
    confidence: number;
    depthAgeMs: number;
    trackingConfidence: number;
  };
}

export interface DepthProvider {
  initialize(): Promise<void>;
  infer(frame: VideoFrame): Promise<DepthFrame>;
}

export type MotionEstimate =
  | {
      type: "pose";
      transform: Float32Array;
      confidence: number;
    }
  | {
      type: "flow";
      flowTexture: GPUTexture;
      confidence: number;
    };

export interface MotionProvider {
  update(
    previousFrame: VideoFrame,
    currentFrame: VideoFrame,
  ): Promise<MotionEstimate>;
}

export type QualityProfileName = "performance" | "balanced" | "quality";

export interface QualityProfile {
  inferenceHz: number;
  inputSize: readonly [width: number, height: number];
  maxDepthAgeMs: number;
  edgeRefinement: boolean;
  opticalFlow: boolean;
  segmentation: boolean;
}

export interface EngineCreateOptions {
  source: HTMLVideoElement;
  quality: QualityProfileName;
}

export interface EngineUpdateInput {
  cameraPose: Float32Array;
  projectionMatrix: Float32Array;
  virtualDepthTexture: GPUTexture;
}

export type EngineLifecycleState =
  | "new"
  | "initializing"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";
