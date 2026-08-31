import type {
  EngineLifecycleState,
  QualityProfileName,
} from "./contracts.ts";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_EVENT_TYPES = [
  "lifecycle",
  "inference-scheduled",
  "inference-completed",
  "inference-rejected",
  "inference-discarded",
  "keyframe-published",
  "keyframe-unusable",
  "calibration-transition",
  "render-update",
  "profile-transition",
  "profile-transition-blocked",
  "provider-failure",
  "device-loss",
] as const;

export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

export const TELEMETRY_REASON_CODES = [
  "engine-created",
  "initialization-started",
  "initialization-completed",
  "initialization-failed",
  "stop-requested",
  "stop-completed",
  "inference-due",
  "inference-completed",
  "provider-rejected",
  "superseded",
  "stale-generation",
  "source-mismatch",
  "malformed-output",
  "texture-contract-invalid",
  "older-than-published",
  "keyframe-published",
  "no-keyframe",
  "keyframe-over-age",
  "calibration-relative-only",
  "calibration-lost",
  "render-updated",
  "profile-requested",
  "profile-applied",
  "transition-blocked",
  "cooldown-active",
  "capability-unavailable",
  "provider-failure",
  "device-lost",
] as const;

export type TelemetryReasonCode = (typeof TELEMETRY_REASON_CODES)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type TelemetryDetailNamespaces = Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
>;

export interface TelemetryEnvelope<
  TEventType extends TelemetryEventType = TelemetryEventType,
  TPayload = unknown,
> {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  eventType: TEventType;
  engineInstanceId: string;
  /** Timestamp from the engine's monotonic display clock, in milliseconds. */
  displayTimestamp: number;
  sourceFrameId?: string;
  requestedProfile: QualityProfileName;
  /** Null until a requested profile becomes active. */
  activeProfile: QualityProfileName | null;
  reasonCode: TelemetryReasonCode;
  payload: TPayload;
  /** Detail objects keyed by a provider-owned namespace. */
  details?: TelemetryDetailNamespaces;
}

export interface LifecyclePayload {
  previousState: EngineLifecycleState | null;
  state: EngineLifecycleState;
}

export interface InferenceScheduledPayload {
  captureTimestamp: number;
  generation: number;
}

export interface InferenceCompletedPayload {
  captureTimestamp: number;
  completionTimestamp: number;
  generation: number;
}

export interface InferenceRejectedPayload {
  captureTimestamp: number;
  generation: number;
  message?: string;
}

export interface InferenceDiscardedPayload {
  captureTimestamp: number;
  completionTimestamp?: number;
  generation: number;
}

export interface KeyframePublishedPayload {
  captureTimestamp: number;
  completionTimestamp: number;
  ageMs: number;
}

export interface KeyframeUnusablePayload {
  captureTimestamp?: number;
  completionTimestamp?: number;
  ageMs?: number;
  usabilityReason: KeyframeUsabilityReason;
}

export type CalibrationStatus = "calibrated" | "relative-only" | "lost";

export interface CalibrationTransitionPayload {
  previousState: CalibrationStatus;
  state: CalibrationStatus;
}

export type GpuTimingAvailabilityReason =
  | "timestamp-queries-unsupported"
  | "timestamp-query-unavailable"
  | "sample-not-recorded";

export type GpuTimingSample =
  | {
      availability: "available";
      milliseconds: number;
      availabilityReason?: never;
    }
  | {
      availability: "unavailable";
      milliseconds?: never;
      availabilityReason: GpuTimingAvailabilityReason;
    };

export type KeyframeUsabilityReason =
  | "usable"
  | "no-keyframe"
  | "over-age"
  | "source-mismatch"
  | "invalid-texture"
  | "relative-only"
  | "calibration-lost";

export type RenderKeyframeSample =
  | {
      availability: "available";
      captureTimestamp: number;
      completionTimestamp: number;
      ageMs: number;
      usabilityReason: KeyframeUsabilityReason;
    }
  | {
      availability: "unavailable";
      captureTimestamp?: never;
      completionTimestamp?: never;
      ageMs?: never;
      usabilityReason: "no-keyframe";
    };

export type DisocclusionState = "inactive" | "active" | "unavailable";

export interface RenderUpdatePayload {
  displayedFrameCount: number;
  droppedFrameCount: number;
  totalGpuFrameTime: GpuTimingSample;
  occlusionGpuTime: GpuTimingSample;
  keyframe: RenderKeyframeSample;
  calibrationState: CalibrationStatus;
  aggregateConfidence: number | null;
  trackingConfidence: number | null;
  disocclusionState: DisocclusionState;
  profile: QualityProfileName | null;
}

export interface ProfileTransitionPayload {
  previousProfile: QualityProfileName | null;
  profile: QualityProfileName;
}

export interface ProfileTransitionBlockedPayload {
  currentProfile: QualityProfileName | null;
  requestedProfile: QualityProfileName;
}

export interface ProviderFailurePayload {
  providerNamespace: string;
  operation: "initialize" | "inference" | "motion";
  message?: string;
}

export interface DeviceLossPayload {
  message?: string;
}

export type LifecycleTelemetryEvent = TelemetryEnvelope<
  "lifecycle",
  LifecyclePayload
>;
export type InferenceScheduledTelemetryEvent = TelemetryEnvelope<
  "inference-scheduled",
  InferenceScheduledPayload
>;
export type InferenceCompletedTelemetryEvent = TelemetryEnvelope<
  "inference-completed",
  InferenceCompletedPayload
>;
export type InferenceRejectedTelemetryEvent = TelemetryEnvelope<
  "inference-rejected",
  InferenceRejectedPayload
>;
export type InferenceDiscardedTelemetryEvent = TelemetryEnvelope<
  "inference-discarded",
  InferenceDiscardedPayload
>;
export type KeyframePublishedTelemetryEvent = TelemetryEnvelope<
  "keyframe-published",
  KeyframePublishedPayload
>;
export type KeyframeUnusableTelemetryEvent = TelemetryEnvelope<
  "keyframe-unusable",
  KeyframeUnusablePayload
>;
export type CalibrationTransitionTelemetryEvent = TelemetryEnvelope<
  "calibration-transition",
  CalibrationTransitionPayload
>;
export type RenderUpdateTelemetryEvent = TelemetryEnvelope<
  "render-update",
  RenderUpdatePayload
>;
export type ProfileTransitionTelemetryEvent = TelemetryEnvelope<
  "profile-transition",
  ProfileTransitionPayload
>;
export type ProfileTransitionBlockedTelemetryEvent = TelemetryEnvelope<
  "profile-transition-blocked",
  ProfileTransitionBlockedPayload
>;
export type ProviderFailureTelemetryEvent = TelemetryEnvelope<
  "provider-failure",
  ProviderFailurePayload
>;
export type DeviceLossTelemetryEvent = TelemetryEnvelope<
  "device-loss",
  DeviceLossPayload
>;

export type TelemetryEvent =
  | LifecycleTelemetryEvent
  | InferenceScheduledTelemetryEvent
  | InferenceCompletedTelemetryEvent
  | InferenceRejectedTelemetryEvent
  | InferenceDiscardedTelemetryEvent
  | KeyframePublishedTelemetryEvent
  | KeyframeUnusableTelemetryEvent
  | CalibrationTransitionTelemetryEvent
  | RenderUpdateTelemetryEvent
  | ProfileTransitionTelemetryEvent
  | ProfileTransitionBlockedTelemetryEvent
  | ProviderFailureTelemetryEvent
  | DeviceLossTelemetryEvent;

export function serializeTelemetryEvent(event: TelemetryEvent): string {
  return JSON.stringify(event) as string;
}

const QUALITY_PROFILE_NAMES: readonly QualityProfileName[] = [
  "performance",
  "balanced",
  "quality",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contains(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

/** Validates only the common version 1 envelope, not event-specific payloads. */
export function isTelemetryEnvelope(value: unknown): value is TelemetryEnvelope {
  if (!isRecord(value)) {
    return false;
  }

  const sourceFrameIdIsValid =
    value.sourceFrameId === undefined || typeof value.sourceFrameId === "string";
  const activeProfileIsValid =
    value.activeProfile === null ||
    contains(QUALITY_PROFILE_NAMES, value.activeProfile);

  return (
    value.schemaVersion === TELEMETRY_SCHEMA_VERSION &&
    contains(TELEMETRY_EVENT_TYPES, value.eventType) &&
    typeof value.engineInstanceId === "string" &&
    Number.isFinite(value.displayTimestamp) &&
    (value.displayTimestamp as number) >= 0 &&
    sourceFrameIdIsValid &&
    contains(QUALITY_PROFILE_NAMES, value.requestedProfile) &&
    activeProfileIsValid &&
    contains(TELEMETRY_REASON_CODES, value.reasonCode) &&
    isRecord(value.payload)
  );
}
