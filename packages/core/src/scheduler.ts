import type { DepthFrame, DepthProvider } from "./contracts.ts";
import {
  validateDepthFrame,
  type DepthFrameGuardReason,
} from "./guards.ts";

export interface CapturedDepthFrame {
  frame: VideoFrame;
  sourceFrameId: string;
  captureTimestamp: number;
}

export type LatestDepthSchedulerStatus = "running" | "stopped" | "disposed";

export interface LatestDepthSchedulerState {
  readonly status: LatestDepthSchedulerStatus;
  readonly generation: number;
  readonly inferenceInFlight: boolean;
  readonly hasPendingCapture: boolean;
}

interface OutcomeCapture {
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
}

export type LatestDepthSchedulerOutcome =
  | (OutcomeCapture & {
      readonly type: "published";
      readonly frame: DepthFrame;
    })
  | (OutcomeCapture & {
      readonly type: "discarded";
      readonly reason: "superseded" | "stale-generation" | "older";
    })
  | (OutcomeCapture & {
      readonly type: "discarded";
      readonly reason: "malformed";
      readonly guardReason: DepthFrameGuardReason;
    })
  | (OutcomeCapture & {
      readonly type: "discarded";
      readonly reason: "mismatched";
      readonly resultSourceFrameId: string;
      readonly resultCaptureTimestamp: number;
    })
  | (OutcomeCapture & {
      readonly type: "discarded";
      readonly reason: "rejected";
      readonly phase: "submit";
      readonly error: "invalid-capture" | "not-running";
    })
  | (OutcomeCapture & {
      readonly type: "discarded";
      readonly reason: "rejected";
      readonly phase: "inference";
      readonly error: unknown;
    });

export interface LatestDepthSchedulerOptions {
  readonly onOutcome?: (outcome: LatestDepthSchedulerOutcome) => void;
}

interface ActiveCapture extends CapturedDepthFrame {
  readonly generation: number;
}

export class LatestDepthScheduler {
  private status: LatestDepthSchedulerStatus = "running";
  private generation = 0;
  private active: ActiveCapture | null = null;
  private pending: CapturedDepthFrame | null = null;
  private published: DepthFrame | null = null;

  public constructor(
    private readonly provider: DepthProvider,
    private readonly options: LatestDepthSchedulerOptions = {},
  ) {}

  public get state(): LatestDepthSchedulerState {
    return {
      status: this.status,
      generation: this.generation,
      inferenceInFlight: this.active !== null,
      hasPendingCapture: this.pending !== null,
    };
  }

  public get latestPublishedFrame(): DepthFrame | null {
    return this.published;
  }

  public submit(capture: CapturedDepthFrame): void {
    if (!this.isValidCapture(capture)) {
      this.closeVideoFrame(capture.frame);
      this.emit({
        type: "discarded",
        reason: "rejected",
        phase: "submit",
        error: "invalid-capture",
        sourceFrameId: capture.sourceFrameId,
        captureTimestamp: capture.captureTimestamp,
      });
      return;
    }

    if (this.status !== "running") {
      this.closeVideoFrame(capture.frame);
      this.emit({
        type: "discarded",
        reason: "rejected",
        phase: "submit",
        error: "not-running",
        sourceFrameId: capture.sourceFrameId,
        captureTimestamp: capture.captureTimestamp,
      });
      return;
    }

    if (this.active === null) {
      this.start(capture);
      return;
    }

    const superseded = this.pending;
    this.pending = capture;
    if (superseded !== null) {
      this.closeVideoFrame(superseded.frame);
      this.emitCapture(superseded, "superseded");
    }
  }

  public stop(): void {
    if (this.status !== "running") return;
    this.status = "stopped";
    this.advanceGenerationAndClosePending();
  }

  public dispose(): void {
    if (this.status === "disposed") return;
    this.status = "disposed";
    this.advanceGenerationAndClosePending();
  }

  private start(capture: CapturedDepthFrame): void {
    const active: ActiveCapture = { ...capture, generation: this.generation };
    this.active = active;

    let inference: Promise<DepthFrame>;
    try {
      inference = this.provider.infer(active.frame);
    } catch (error) {
      this.finishRejected(active, error);
      return;
    }

    void Promise.resolve(inference).then(
      (result) => this.finishCompleted(active, result),
      (error: unknown) => this.finishRejected(active, error),
    );
  }

  private finishCompleted(active: ActiveCapture, result: unknown): void {
    if (active.generation !== this.generation || this.status !== "running") {
      this.destroyResult(result);
      this.emitCapture(active, "stale-generation");
      this.settle(active);
      return;
    }

    const validated = validateDepthFrame(result);
    if (!validated.ok) {
      this.destroyResult(result);
      this.emit({
        type: "discarded",
        reason: "malformed",
        guardReason: validated.reason,
        sourceFrameId: active.sourceFrameId,
        captureTimestamp: active.captureTimestamp,
      });
      this.settle(active);
      return;
    }

    const frame = validated.value;
    if (
      frame.sourceFrameId !== active.sourceFrameId ||
      frame.captureTimestamp !== active.captureTimestamp
    ) {
      this.destroyResult(frame);
      this.emit({
        type: "discarded",
        reason: "mismatched",
        sourceFrameId: active.sourceFrameId,
        captureTimestamp: active.captureTimestamp,
        resultSourceFrameId: frame.sourceFrameId,
        resultCaptureTimestamp: frame.captureTimestamp,
      });
    } else if (
      this.published !== null &&
      frame.captureTimestamp <= this.published.captureTimestamp
    ) {
      this.destroyResult(frame);
      this.emitCapture(active, "older");
    } else {
      this.published = frame;
      this.emit({
        type: "published",
        frame,
        sourceFrameId: active.sourceFrameId,
        captureTimestamp: active.captureTimestamp,
      });
    }

    this.settle(active);
  }

  private finishRejected(active: ActiveCapture, error: unknown): void {
    this.emit({
      type: "discarded",
      reason: active.generation === this.generation ? "rejected" : "stale-generation",
      ...(active.generation === this.generation
        ? { phase: "inference" as const, error }
        : {}),
      sourceFrameId: active.sourceFrameId,
      captureTimestamp: active.captureTimestamp,
    } as LatestDepthSchedulerOutcome);
    this.settle(active);
  }

  private settle(active: ActiveCapture): void {
    this.closeVideoFrame(active.frame);
    if (this.active === active) this.active = null;

    if (this.status !== "running" || this.pending === null) return;
    const next = this.pending;
    this.pending = null;
    this.start(next);
  }

  private advanceGenerationAndClosePending(): void {
    this.generation += 1;
    if (this.pending === null) return;
    const pending = this.pending;
    this.pending = null;
    this.closeVideoFrame(pending.frame);
    this.emitCapture(pending, "stale-generation");
  }

  private isValidCapture(capture: CapturedDepthFrame): boolean {
    return (
      typeof capture.sourceFrameId === "string" &&
      capture.sourceFrameId.length > 0 &&
      Number.isFinite(capture.captureTimestamp)
    );
  }

  private emitCapture(
    capture: OutcomeCapture,
    reason: "superseded" | "stale-generation" | "older",
  ): void {
    this.emit({ type: "discarded", reason, ...capture });
  }

  private emit(outcome: LatestDepthSchedulerOutcome): void {
    try {
      this.options.onOutcome?.(outcome);
    } catch {
      // Telemetry must not affect scheduling.
    }
  }

  private closeVideoFrame(frame: VideoFrame): void {
    try {
      frame.close();
    } catch {
      // Closing an already-closed frame is harmless to scheduler state.
    }
  }

  private destroyResult(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const candidate = value as { depth?: unknown; confidence?: unknown };
    const resources = new Set([candidate.depth, candidate.confidence]);
    for (const resource of resources) {
      if (
        typeof resource === "object" &&
        resource !== null &&
        "destroy" in resource &&
        typeof resource.destroy === "function"
      ) {
        try {
          resource.destroy();
        } catch {
          // Best-effort cleanup must not affect scheduling.
        }
      }
    }
  }
}
