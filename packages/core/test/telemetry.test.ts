import assert from "node:assert/strict";
import test from "node:test";

import {
  TELEMETRY_EVENT_TYPES,
  isTelemetryEnvelope,
  serializeTelemetryEvent,
  type RenderUpdateTelemetryEvent,
} from "../src/telemetry.ts";

const renderUpdate = {
  schemaVersion: 1,
  eventType: "render-update",
  engineInstanceId: "engine-1",
  displayTimestamp: 1000,
  sourceFrameId: "frame-1",
  requestedProfile: "balanced",
  activeProfile: "balanced",
  reasonCode: "render-updated",
  payload: {
    displayedFrameCount: 1,
    droppedFrameCount: 0,
    totalGpuFrameTime: {
      availability: "unavailable",
      availabilityReason: "timestamp-queries-unsupported",
    },
    occlusionGpuTime: {
      availability: "unavailable",
      availabilityReason: "timestamp-queries-unsupported",
    },
    keyframe: {
      availability: "unavailable",
      usabilityReason: "no-keyframe",
    },
    calibrationState: "relative-only",
    aggregateConfidence: null,
    trackingConfidence: null,
    disocclusionState: "unavailable",
    profile: "balanced",
  },
} satisfies RenderUpdateTelemetryEvent;

test("exports the exact telemetry event types", () => {
  assert.deepEqual(TELEMETRY_EVENT_TYPES, [
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
  ]);
});

test("serializes a telemetry event for a JSON round trip", () => {
  assert.deepEqual(JSON.parse(serializeTelemetryEvent(renderUpdate)), renderUpdate);
});

test("accepts a valid render-update envelope", () => {
  assert.equal(isTelemetryEnvelope(renderUpdate), true);
});

test("rejects invalid telemetry envelopes", () => {
  const { payload: _payload, ...withoutPayload } = renderUpdate;

  const invalidEnvelopes: unknown[] = [
    { ...renderUpdate, schemaVersion: 2 },
    { ...renderUpdate, eventType: "unknown-event" },
    { ...renderUpdate, engineInstanceId: "" },
    { ...renderUpdate, displayTimestamp: Number.NaN },
    { ...renderUpdate, displayTimestamp: Number.POSITIVE_INFINITY },
    { ...renderUpdate, displayTimestamp: -1 },
    { ...renderUpdate, sourceFrameId: 1 },
    { ...renderUpdate, requestedProfile: "unknown-profile" },
    { ...renderUpdate, activeProfile: "unknown-profile" },
    { ...renderUpdate, reasonCode: "unknown-reason" },
    withoutPayload,
  ];

  for (const envelope of invalidEnvelopes) {
    assert.equal(isTelemetryEnvelope(envelope), false);
  }
});
