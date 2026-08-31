# MVP specification

Status: final pre-implementation specification for GitHub Issue #1.

Implementation and measurement are future work. Every numeric value in this document—including rates, resolutions, ages, time windows, thresholds, percentiles, percentages, frame counts, pixel counts, and device-number identifiers where interpreted numerically—is an initial hypothesis until real-device evidence exists. The values are nevertheless the frozen MVP inputs and acceptance hypotheses. This document makes no benchmark-result claim.

Normative terms `MUST`, `MUST NOT`, `SHOULD`, and `MAY` describe the MVP implementation target.

## 1. Goal and prototype milestone

The MVP demonstrates visually stable, confidence-aware occlusion of virtual content by real scene geometry in a WebGPU web AR pipeline while preserving interactive display rate. It separates model-specific inference from engine behavior and does not block display-rate update or rendering on inference.

The prototype milestone comprises the baseline engine, provider contracts, GPU reprojection, temporal stabilization, hysteresis, edge refinement, soft compositing, telemetry, and the fixed validation protocol. It is complete only after implementation is measured on the reference matrix. Optical flow and segmentation are conditional experiments, not baseline milestone requirements.

The specification items are finalized. Runtime implementation, provider selection, clip capture, annotation production, device runs, measurements, and optional-feature experiments remain future work.

## 2. Public engine contract

The design is WebGPU-native and preserves `GPUTexture` throughout the depth and occlusion path.

`createOcclusionEngine` MUST receive:

- a video source; and
- a quality selection.

`update` MUST be non-blocking and accept:

- `cameraPose`;
- `projectionMatrix`; and
- `virtualDepthTexture`.

`update` and rendering MUST NOT await inference.

Each `OcclusionFrame` MUST return:

- `occlusionTexture`;
- optional `confidenceTexture`;
- optional `depthTexture`; and
- quality telemetry describing the active quality/profile state.

No CPU depth-buffer replacement, readback-based public contract, or alternate source-less engine contract is part of the MVP.

## 3. Depth provider contract

Depth providers are model-agnostic. A completed provider result MUST be a `DepthFrame` with exactly these fields:

| Field | Required contract |
| --- | --- |
| `depth` | `GPUTexture` containing depth values. |
| `confidence` | Required `GPUTexture`; values are in `[0,1]`. |
| `representation` | `linear-z` or `inverse-z`. |
| `scale` | `metric` or `relative`. |
| `unit` | `meter` for metric depth; `null` for relative depth. |
| `captureTimestamp` | Timestamp associated with source capture. |
| `sourceFrameId` | Identifier of the associated source frame. |
| `uvTransform` | Transform from engine UVs to provider depth UVs. |
| `width` | Depth-texture width. |
| `height` | Depth-texture height. |

No additional field is required by the frozen MVP contract.

Canonical metric depth is positive camera-space linear Z in metres. Relative depth MUST have `unit: null`. A non-finite or non-positive depth value is invalid and MUST have zero confidence.

Each provider's documentation MUST define:

- its output range;
- its camera forward-axis convention;
- its UV origin and orientation; and
- how `captureTimestamp` and `sourceFrameId` associate the result with the captured source frame.

Providers MUST normalize confidence to `[0,1]` and supply the required confidence texture. The engine MUST NOT infer undocumented conventions.

## 4. Calibration contract

`CalibrationState` is frozen to exactly these states and semantics:

| State | Required behavior |
| --- | --- |
| `calibrated` | Exposes canonical positive linear camera-space Z in metres. |
| `relative-only` | Returns zero confidence and no occlusion. It MUST NOT guess a metric mapping. |
| `lost` | Returns zero confidence and no occlusion. It MUST NOT guess a metric mapping. |

Only `calibrated` may expose canonical metric depth. A transition away from `calibrated` immediately makes the affected depth unusable for occlusion. There is no guessed scale, learned fallback scale, retained stale metric mapping, or replacement calibration contract in the MVP.

## 5. Architecture and dependency direction

The frozen data flow is:

1. The video source supplies captured frames and source association.
2. A model-agnostic depth provider asynchronously produces `DepthFrame` keyframes.
3. An optional model-agnostic motion provider asynchronously supplies motion information without changing the depth contract.
4. Calibration validates whether provider depth can become canonical metric depth.
5. A latest-completed-keyframe exchange publishes only usable, source-associated results.
6. GPU reprojection brings that keyframe to the current camera pose at display rate.
7. Motion-aware temporal stabilization and hysteresis reduce flicker without reviving invalid history.
8. Edge refinement preserves foreground boundaries.
9. Confidence-aware soft compositing combines real and virtual depth and emits `OcclusionFrame` plus telemetry.

Package dependencies MUST point from the application/integration layer into the engine, from the engine into provider contracts and GPU stages, and from provider implementations into provider contracts. Provider contracts MUST NOT depend on a model implementation, the application, or the engine orchestration layer. Depth and motion provider implementations MUST remain replaceable. GPU stages MUST consume the frozen contracts rather than model-specific tensors.

## 6. Asynchronous invariants

Inference runs asynchronously from display-rate update and rendering.

- `update` and render MUST never await depth or motion inference.
- The engine MUST use only the latest completed keyframe that is associated with a known source frame.
- An incomplete, future-associated, unassociated, superseded, calibration-invalid, or over-age result is unusable.
- Age is measured from the keyframe's `captureTimestamp` to the display update using it.
- A frame older than the active profile's maximum age MUST NOT contribute occlusion.
- In `balanced`, confidence decay begins at `100ms` and reaches zero at `250ms`.
- Disocclusion holes begin with zero confidence.
- A disocclusion hole MAY be spatially edge-filled, but MUST NOT be filled from stale history.
- When no usable frame exists, rendering MUST continue with no occlusion and MUST still emit telemetry.

Motion-aware stabilization MUST respect source association, validity, confidence, and age. Hysteresis MUST reduce rapid foreground/background toggling without allowing history to override invalid depth, zero confidence, a disocclusion, or an unusable keyframe.

## 7. Quality profiles

The profile defaults are frozen exactly as follows:

| Profile | Inference rate | Depth resolution | Maximum age | Edge refinement | Optical flow | Segmentation |
| --- | ---: | ---: | ---: | --- | --- | --- |
| `performance` | `8Hz` | `320x192` | `250ms` | off | off | off |
| `balanced` | `12Hz` | `384x224` | `250ms` | on | off | off |
| `quality` | `18Hz` | `480x270` | `200ms` | on | off | off |

These are defaults, not measurements. The baseline path keeps optical flow and segmentation disabled in every profile.

## 8. Adaptive quality control

Adaptive control MUST operate on the ordered levels `quality` → `balanced` → `performance`.

It MUST downgrade one level when either:

- total GPU frame-time p95 exceeds `14ms` for `2 seconds`; or
- dropped frames exceed `5 percent`.

It MUST recover only one level after both:

- total GPU frame-time p95 is below `10ms`; and
- dropped frames are below `1 percent`;

continuously for `10 seconds`.

Every profile change starts a `10-second` cooldown during which no further profile change may occur. Recovery never skips a level. At `performance`, a further downgrade trigger leaves the profile unchanged while telemetry records the condition. At `quality`, a recovery condition leaves the profile unchanged.

## 9. Reprojection, stabilization, and compositing

GPU reprojection MUST run at display rate using the current `cameraPose` and `projectionMatrix` and only the latest usable source-associated keyframe. It MUST produce validity/confidence information for reprojected samples and identify disocclusions.

Temporal stabilization MUST be motion-aware. It MUST combine current evidence only with valid, source-associated history, reject disoccluded or invalid history, and apply confidence-aware hysteresis at foreground/background transitions.

Edge refinement MUST operate on confidence and depth boundaries. Spatial filling is permitted only when it respects edges and does not import stale temporal history into disocclusions.

Soft compositing MUST compare canonical real depth with `virtualDepthTexture`, weight the decision by confidence, and avoid hard claims where confidence is zero. Zero confidence means no real-scene occlusion contribution.

## 10. Telemetry and failure behavior

Telemetry MUST make validation of active profile, profile changes, dropped frames, total GPU frame time, occlusion GPU time, keyframe age/usability, confidence behavior, and the acceptance hypotheses possible. Quality telemetry in `OcclusionFrame` MUST identify the active quality/profile state.

Provider failure, calibration loss, late inference, absent inference, invalid depth, and over-age depth MUST degrade to continued rendering with no occlusion for the affected evidence. They MUST NOT stall update/render or fabricate depth.

## 11. Acceptance hypotheses

The exact acceptance hypotheses are:

| Measure | Hypothesis |
| --- | ---: |
| Displayed FPS | at least `55` |
| Dropped frames | below `5 percent` |
| Occlusion GPU p95 | at most `5ms` |
| Existing-surface reprojected edge lag p95 | at most `2 display frames` |
| New foreground correction p95 | at most `150ms` |
| Ghost removal p95 | at most `150ms` |
| Static edge jitter p95 | at most `2 output pixels` |
| Front/back ordering error | at most `5 percent` |

These are unvalidated hypotheses, not benchmark results. The measurement procedure is normative in [validation.md](validation.md).

## 12. Conditional optical-flow and segmentation gates

Optical flow MAY be adopted only when all of the following are demonstrated:

- the baseline has a fast-motion lag or disocclusion failure;
- optical flow improves that failed measure by at least `20 percent` on identical input; and
- the result continues to meet `55FPS` and `5ms` occlusion GPU compliance.

Segmentation MAY be adopted only when all of the following are demonstrated:

- the baseline has a hand/person boundary or ordering failure;
- segmentation improves that failed measure by at least `20 percent` on identical input;
- foreground correction remains at most `150ms`; and
- the result continues to meet `55FPS` and `5ms` occlusion GPU compliance.

Absent complete gate evidence, each feature remains off.

## 13. Explicit non-goals

The MVP does not:

- choose or train a specific depth, motion, optical-flow, or segmentation model;
- infer a metric mapping from relative depth;
- block display rendering on inference;
- use stale history to fill disocclusions;
- require optical flow or segmentation in the baseline;
- replace WebGPU textures with a CPU public data path;
- claim production readiness, cross-device universality, or benchmark success;
- define a backend service, persistence system, native application, or non-WebGPU fallback; or
- implement runtime code in this specification change.

## 14. Finalization boundary

Sections 1–13 are the final pre-implementation MVP specification. Changes to these contracts or hypotheses require an explicit specification revision backed by evidence. Implementation and all measured conclusions are intentionally deferred.
