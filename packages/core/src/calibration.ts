import type { CalibrationState } from "./contracts.ts";

export interface CanonicalCalibrationEvidence {
  readonly canonicalDepthTexture: GPUTexture;
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
}

export type CalibrationEvidenceRejectionReason =
  | "missing-canonical-depth-texture"
  | "invalid-source-frame-id"
  | "invalid-capture-timestamp"
  | "older-evidence"
  | "timestamp-conflict";

export type CalibrationEvidenceOutcome =
  | {
      readonly status: "accepted";
      readonly changed: true;
      readonly generation: number;
    }
  | {
      readonly status: "duplicate";
      readonly changed: false;
      readonly generation: number;
    }
  | {
      readonly status: "rejected";
      readonly changed: false;
      readonly reason: CalibrationEvidenceRejectionReason;
      readonly generation: number;
    };

export type CalibrationEvaluation =
  | {
      readonly usable: true;
      readonly canonicalDepthTexture: GPUTexture;
      readonly confidenceScale: 1;
    }
  | {
      readonly usable: false;
      readonly confidenceScale: 0;
      readonly reason:
        | "relative-only"
        | "lost"
        | "source-frame-mismatch"
        | "capture-timestamp-mismatch";
    };

export interface CalibrationTransition {
  readonly previous: Readonly<CalibrationState>;
  readonly current: Readonly<CalibrationState>;
  readonly generation: number;
}

export interface CalibrationStateMachineOptions {
  readonly initialStatus?: "relative-only" | "lost";
  readonly onTransition?: (transition: CalibrationTransition) => void;
  readonly releaseCanonicalDepthTexture?: (texture: GPUTexture) => void;
}

export type CalibrationInvalidationOutcome = {
  readonly status: "relative-only" | "lost";
  readonly changed: boolean;
  readonly generation: number;
};

interface AssociatedEvidence {
  readonly canonicalDepthTexture: GPUTexture;
  readonly sourceFrameId: string;
  readonly captureTimestamp: number;
}

function nonMetricState(
  status: "relative-only" | "lost",
): Readonly<CalibrationState> {
  return Object.freeze({ status });
}

function calibratedState(
  canonicalDepthTexture: GPUTexture,
): Readonly<CalibrationState> {
  return Object.freeze({ status: "calibrated", canonicalDepthTexture });
}

export class CalibrationStateMachine {
  readonly #onTransition?: (transition: CalibrationTransition) => void;
  readonly #releaseCanonicalDepthTexture?: (texture: GPUTexture) => void;

  #state: Readonly<CalibrationState>;
  #evidence: AssociatedEvidence | undefined;
  #generation = 0;

  constructor(options: CalibrationStateMachineOptions = {}) {
    this.#state = nonMetricState(options.initialStatus ?? "relative-only");
    this.#onTransition = options.onTransition;
    this.#releaseCanonicalDepthTexture =
      options.releaseCanonicalDepthTexture;
  }

  get state(): Readonly<CalibrationState> {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  acceptEvidence(
    evidence: CanonicalCalibrationEvidence,
  ): CalibrationEvidenceOutcome {
    if (evidence.canonicalDepthTexture == null) {
      return this.#rejected("missing-canonical-depth-texture");
    }
    if (
      typeof evidence.sourceFrameId !== "string" ||
      evidence.sourceFrameId.length === 0
    ) {
      return this.#rejected("invalid-source-frame-id");
    }
    if (
      typeof evidence.captureTimestamp !== "number" ||
      !Number.isFinite(evidence.captureTimestamp)
    ) {
      return this.#rejected("invalid-capture-timestamp");
    }

    const previousEvidence = this.#evidence;
    if (previousEvidence !== undefined) {
      const exactDuplicate =
        evidence.canonicalDepthTexture ===
          previousEvidence.canonicalDepthTexture &&
        evidence.sourceFrameId === previousEvidence.sourceFrameId &&
        evidence.captureTimestamp === previousEvidence.captureTimestamp;
      if (exactDuplicate) {
        return {
          status: "duplicate",
          changed: false,
          generation: this.#generation,
        };
      }
      if (evidence.captureTimestamp < previousEvidence.captureTimestamp) {
        return this.#rejected("older-evidence");
      }
      if (evidence.captureTimestamp === previousEvidence.captureTimestamp) {
        return this.#rejected("timestamp-conflict");
      }
    }

    const previousState = this.#state;
    this.#evidence = Object.freeze({
      canonicalDepthTexture: evidence.canonicalDepthTexture,
      sourceFrameId: evidence.sourceFrameId,
      captureTimestamp: evidence.captureTimestamp,
    });
    this.#state = calibratedState(evidence.canonicalDepthTexture);
    this.#generation += 1;
    this.#notifyTransition(previousState);

    if (
      previousEvidence !== undefined &&
      previousEvidence.canonicalDepthTexture !== evidence.canonicalDepthTexture
    ) {
      this.#release(previousEvidence.canonicalDepthTexture);
    }

    return {
      status: "accepted",
      changed: true,
      generation: this.#generation,
    };
  }

  evaluate(
    sourceFrameId: string,
    captureTimestamp: number,
  ): CalibrationEvaluation {
    if (this.#state.status === "relative-only") {
      return {
        usable: false,
        confidenceScale: 0,
        reason: "relative-only",
      };
    }
    if (this.#state.status === "lost") {
      return { usable: false, confidenceScale: 0, reason: "lost" };
    }

    const evidence = this.#evidence;
    if (evidence === undefined || evidence.sourceFrameId !== sourceFrameId) {
      return {
        usable: false,
        confidenceScale: 0,
        reason: "source-frame-mismatch",
      };
    }
    if (evidence.captureTimestamp !== captureTimestamp) {
      return {
        usable: false,
        confidenceScale: 0,
        reason: "capture-timestamp-mismatch",
      };
    }

    return {
      usable: true,
      canonicalDepthTexture: evidence.canonicalDepthTexture,
      confidenceScale: 1,
    };
  }

  markRelativeOnly(): CalibrationInvalidationOutcome {
    return this.#invalidate("relative-only");
  }

  markLost(): CalibrationInvalidationOutcome {
    return this.#invalidate("lost");
  }

  #invalidate(
    status: "relative-only" | "lost",
  ): CalibrationInvalidationOutcome {
    if (this.#state.status === status) {
      return { status, changed: false, generation: this.#generation };
    }

    const previousState = this.#state;
    const previousEvidence = this.#evidence;
    this.#evidence = undefined;
    this.#state = nonMetricState(status);
    this.#generation += 1;
    this.#notifyTransition(previousState);

    if (previousEvidence !== undefined) {
      this.#release(previousEvidence.canonicalDepthTexture);
    }

    return { status, changed: true, generation: this.#generation };
  }

  #rejected(
    reason: CalibrationEvidenceRejectionReason,
  ): CalibrationEvidenceOutcome {
    return {
      status: "rejected",
      changed: false,
      reason,
      generation: this.#generation,
    };
  }

  #notifyTransition(previous: Readonly<CalibrationState>): void {
    try {
      this.#onTransition?.(
        Object.freeze({
          previous,
          current: this.#state,
          generation: this.#generation,
        }),
      );
    } catch {
      // Observers cannot interrupt calibration state changes.
    }
  }

  #release(texture: GPUTexture): void {
    try {
      this.#releaseCanonicalDepthTexture?.(texture);
    } catch {
      // Resource observers cannot interrupt calibration state changes.
    }
  }
}
