# Normative implementation plan

Status: normative implementation plan. It makes the engineering decisions needed to begin implementation; it contains no runtime implementation, dependency selection, model selection, measurement, or benchmark result.

The frozen contracts, profiles, thresholds, reference devices, acceptance hypotheses, validation gates, and no-benchmark statements in [mvp-spec.md](mvp-spec.md), [validation.md](validation.md), and [issue-1-completion.md](issue-1-completion.md) remain authoritative and unchanged. If this plan conflicts with them, those documents win. Numeric values copied here are frozen hypotheses, not observations.

The supporting decisions are:

- [ADR 0001: TypeScript packages, type ownership, and GPU boundaries](decisions/0001-typescript-packages-and-gpu-boundaries.md)
- [ADR 0002: Engine execution, calibration, development, and validation](decisions/0002-engine-execution-calibration-and-validation.md)

## 1. Repository and package organization

The implementation MUST be a TypeScript npm workspace with exactly the six frozen package names below. Source, tests, shaders, and package-local documentation live with their owning package; browser applications live outside publishable packages.

```text
packages/
  core/          @web-ar-occlusion/core
  depth-webgpu/  @web-ar-occlusion/depth-webgpu
  depth-webxr/   @web-ar-occlusion/depth-webxr
  motion/        @web-ar-occlusion/motion
  three/         @web-ar-occlusion/three
  babylon/       @web-ar-occlusion/babylon
apps/
  demo/
fixtures/
  recorded/
  generated/
```

All packages MUST use strict TypeScript, ES modules, browser-oriented exports, and project references. Build output MUST NOT be imported across workspace source trees. Package manifests, compiler configuration, test tooling, and runtime dependencies are deliberately deferred to the package-scaffolding issue so they can be added together and reviewed as one dependency-bearing change.

`@web-ar-occlusion/core` owns every public structural type used at a package boundary: engine inputs and results, `DepthFrame`, `DepthProvider`, `MotionEstimate`, `MotionProvider`, calibration types, quality/profile identifiers, source-frame association, and telemetry. This prevents duplicate nominal types and circular dependencies. The other five packages depend only on `core` unless an integration's peer renderer is needed. `core` MUST NOT import any provider implementation, renderer integration, browser application, or renderer. `depth-webgpu`, `depth-webxr`, and `motion` implement contracts imported from `core`. `three` and `babylon` adapt their peer renderer to `core` and MUST NOT depend on one another. The demo is the composition root and may depend on packages and renderer libraries.

Public types MUST be exported from the `core` package root. Internal scheduling, render graphs, shader layouts, calibration fitting, and resource pools MUST remain package-private. Provider-specific tensors and model APIs MUST remain behind provider implementations.

## 2. WebGPU resource boundaries

The public path remains GPU-only. No public typed-array depth, canvas readback, mapped-buffer result, or CPU depth fallback is permitted.

The initial supported texture boundary is:

| Boundary | Required format and use |
| --- | --- |
| Provider `DepthFrame.depth` | `r16float` or `r32float`; `TEXTURE_BINDING`; one scalar value per texel in the declared representation and scale |
| Provider `DepthFrame.confidence` | `r8unorm` or `r16float`; `TEXTURE_BINDING`; normalized `[0,1]` |
| Canonical internal depth | engine-owned `r32float`; positive linear camera-space Z in metres; invalid samples have zero confidence |
| Canonical internal confidence | engine-owned `r8unorm`; normalized `[0,1]` |
| `virtualDepthTexture` | `r32float` color texture or `depth32float` depth texture with `TEXTURE_BINDING`; positive camera-space linear Z in metres |
| `OcclusionFrame.occlusionTexture` | engine-owned `r8unorm`; `TEXTURE_BINDING | RENDER_ATTACHMENT`; soft mask `[0,1]` |
| Optional output confidence | engine-owned `r8unorm`; `TEXTURE_BINDING` |
| Optional output depth | engine-owned `r32float`; `TEXTURE_BINDING`; canonical metric depth only |

The engine MUST inspect texture format, dimensions, usage, device ownership, and liveness before encoding work. Unsupported input MUST be rejected as unusable evidence, reported through telemetry, and degrade that update to zero occlusion without blocking rendering. Provider textures remain provider-owned and MUST remain valid until the engine releases the published keyframe. All canonical, history, mask, and output textures are engine-owned. The engine MUST use explicit bind-group layouts, must not copy provider data to CPU, and may perform GPU format normalization into canonical textures.

Output textures are borrowed views of engine state: valid until the next successful `update` or disposal and not destroyable by callers. This lifetime MUST be documented in the public API. All resources MUST be created on the engine's `GPUDevice`; cross-device textures are unusable.

## 3. Lifecycle and asynchronous state machine

The engine lifecycle is `new → initializing → ready → stopping → stopped`, with `failed` reachable from initialization and unrecoverable device loss. Initialization is asynchronous because device/provider setup may be asynchronous. Display-rate `update` is synchronous and non-blocking once ready. Calling it before readiness or after stopping returns no-occlusion state plus telemetry and schedules no work.

Inference scheduling uses one in-flight request per provider and a single latest-wins pending capture slot. A new capture replaces and closes the previous pending capture; there is no FIFO inference queue. When a request settles, the scheduler validates its generation, source association, texture contract, calibration state, and age, then atomically publishes it only if it is newer than the published keyframe. It immediately starts the latest pending capture if one exists. Superseded or invalid results are released without publication.

`update` snapshots the latest published usable keyframe at its start, evaluates age against the active frozen profile, encodes reprojection, stabilization, refinement, and compositing, and publishes an `OcclusionFrame`. It never waits for inference or motion. A completion arriving during encoding is considered only by the next update.

The render-loop state is:

| State | Output behavior |
| --- | --- |
| `no-keyframe` | zero occlusion; telemetry continues |
| `usable-keyframe` | reproject, stabilize, optionally refine according to the active frozen profile, and composite |
| `temporarily-unusable` | zero occlusion for affected evidence; do not revive history |
| `device-lost` or `stopped` | zero occlusion if an already-created safe output is available; otherwise report failure and encode no further GPU work |

Cancellation uses an engine generation token. Stop/dispose invalidates the token, closes pending engine-owned `VideoFrame` objects, prevents late promises from publishing, detaches callbacks, and destroys engine-owned GPU resources after submitted work is no longer referenced. The frozen provider methods do not accept a cancellation parameter, so cancellation MUST NOT pretend to abort provider work; late completion is contained and released. Stop and dispose are idempotent.

Provider rejection, malformed output, calibration loss, late or absent inference, over-age keyframes, and recoverable shader/encoding errors MUST emit telemetry and produce no occlusion for the affected update. Repeated provider failures use bounded retry at the active profile's normal scheduling opportunity, never a tight retry loop. Initialization failure and device loss transition to `failed`; recovery requires creating a new engine. Errors MUST NOT fabricate depth, retain stale calibration, or stall the caller's render loop.

## 4. Calibration and provider conformance

Provider conformance and calibration are separate boundaries.

A provider adapter owns model/native API conversion, texture production, confidence normalization, documented output range, axis and UV conventions, timestamps, source IDs, and scale/unit pairing. A reusable conformance suite owned by `core` checks all frozen `DepthFrame` and motion-provider requirements, including invalid samples and lifecycle behavior. Passing conformance means only that the adapter obeys the contract; it does not establish visual quality or metric accuracy.

The core calibration stage owns the exact `calibrated`, `relative-only`, and `lost` state machine. Metric linear depth may pass through after convention normalization. Relative or inverse depth is transformed to canonical metric depth only from explicit permitted mapping evidence and only while that evidence remains valid. Calibration evidence and its validity are inputs to the calibration stage, not fields added to `DepthFrame`. Loss immediately invalidates the canonical keyframe and history. No provider may silently label inferred relative values as metric.

The calibration fitter, evidence source, residual checks, and loss criteria remain internal. Each concrete evidence source MUST define its validity and revocation rules before implementation. Until one is implemented and verified, relative providers remain `relative-only` and produce zero occlusion.

## 5. Deterministic development path

Implementation MUST begin with fake providers and deterministic fixtures, before evaluating a real model:

- a fake metric depth provider that produces GPU textures from generated planes, steps, holes, moving foregrounds, and confidence ramps;
- a controllable fake provider for delayed, rejected, malformed, out-of-order, and superseded completions;
- a fake motion provider for identity and known transforms;
- generated camera poses, projection matrices, virtual sphere depth, and expected masks; and
- versioned recorded fixtures only after their provenance, source association, expected convention, and digest are documented.

Fixtures MUST use seeded generation or checked-in immutable inputs and exact expected metadata. They are test inputs, not benchmark evidence. Golden image tolerances MUST be declared by the test and may establish correctness bounds only; they MUST NOT be reported as device performance or model accuracy.

Real-provider selection is a bounded experiment, not an implementation assumption:

| Element | Required definition |
| --- | --- |
| Inputs | The same versioned fixed clips and annotations, the exact reference devices, each candidate adapter/version, and identical requested profiles |
| Metrics | Provider conformance; all frozen validation measures; inference completion latency as descriptive telemetry; failure rate; and visible-artifact records |
| Adoption threshold | Contract conformance has no failures, calibration never guesses metric scale, and every applicable frozen validation hypothesis and metadata requirement passes on both reference devices |
| Fallback | Select no real provider; retain the fake-provider vertical slice, report failed/missing evidence, and keep implementation model-agnostic |

No candidate is preferred or adopted in this plan. A candidate that fails a threshold MUST NOT be rescued by changing a frozen threshold. Optical flow and segmentation remain governed solely by their existing conditional gates.

## 6. Smallest vertical slice and demo

The first implementation milestone is the smallest camera-to-virtual-sphere slice:

1. acquire browser camera frames and assign monotonic source IDs and capture timestamps;
2. send cloned `VideoFrame` objects to the asynchronous fake metric provider;
3. publish only its latest completed, associated keyframe;
4. normalize it to canonical GPU depth/confidence;
5. reproject it for the current camera pose;
6. compare it with an `r32float` virtual-depth texture for one sphere;
7. emit an `r8unorm` soft occlusion texture and composite the sphere; and
8. show required telemetry and continue rendering with zero occlusion during missing, delayed, invalid, and over-age depth.

The slice uses identity/known fake motion first. It includes the baseline stabilization, hysteresis, profile-controlled edge refinement, and confidence behavior required by the frozen milestone; it does not select a real model, add WebXR as a requirement, or implement renderer adapters.

`apps/demo` is a private browser application with a capability/start screen, explicit camera permission action, WebGPU canvas, camera preview, one virtual sphere, requested/active profile selector, occlusion on/off diagnostic view, and a telemetry panel. Its composition root creates the device, video source, fake provider, and engine. It MUST use only public package exports. WebXR depth and renderer-specific examples are later routes or examples and MUST NOT become baseline dependencies.

## 7. Test and validation strategy

| Layer | Required coverage | Gate |
| --- | --- | --- |
| Unit | lifecycle transitions, latest-wins scheduling, source association, age/decay, hysteresis, calibration states, adaptive-control traces, cancellation, and telemetry serialization | deterministic tests pass with no GPU timing claims |
| Shader/geometry | UV transforms, linear/inverse conversion, reprojection, validity/disocclusion, depth comparison, confidence weighting, sphere depth, and edge cases using generated textures | GPU output agrees with declared fixture expectations/tolerances |
| Integration | fake providers through `core`, keyframe publication, failure degradation, resource lifetime, format rejection, and integration export boundaries | no render-path await or CPU public depth path; leak/error checks pass |
| Browser | camera permission/start/stop, WebGPU capability handling, background/foreground, resize, device loss, visible sphere occlusion, and telemetry panel | automated supported-browser checks plus documented manual camera checks pass |
| Real device | exact protocol, corpus, metadata, scenarios, and frozen gates in `validation.md` | complete per-device evidence for iPhone 15 Pro and Google Pixel 8; no generalization beyond evidence |

Browser mocks and synthetic GPU tests establish functional behavior only. GPU timestamps, FPS, visual metrics, and provider behavior become acceptance evidence only through the frozen real-device protocol. Tests MUST retain raw samples separately from computed summaries.

## 8. Telemetry ownership and schema

`@web-ar-occlusion/core` owns a versioned telemetry schema and event emission. Provider packages may supply namespaced detail records, but MUST NOT redefine core fields or compute acceptance conclusions.

Every event has `schemaVersion`, `eventType`, `engineInstanceId`, monotonic `displayTimestamp`, `sourceFrameId` when applicable, requested and active profile, and a reason code. Event families cover lifecycle, inference scheduled/completed/rejected/discarded, keyframe published/unusable, calibration transition, render update, profile transition/blocked transition, provider failure, and device loss.

Per-update samples include displayed/dropped-frame counters, total GPU frame time when supported, occlusion GPU time when supported, keyframe capture/completion timestamps and age, usability reason, calibration state, aggregate confidence, tracking confidence, disocclusion state, and profile. Unsupported timing is explicitly absent with an availability reason, never zero-filled. The recorder owns raw samples; validation tooling computes percentiles and pass/fail summaries. Schema version changes require migration notes and fixture updates.

## 9. Issue-ready phased backlog

| ID | Deliverable | Depends on | Acceptance criteria | Exit gate |
| --- | --- | --- | --- | --- |
| I-01 | Workspace and six package shells | none | exact frozen names; strict TS/project references; dependency-direction checks; no runtime model | all package type-check smoke tests pass |
| I-02 | Core public contracts and telemetry schema | I-01 | frozen fields and states represented without additions to `DepthFrame`/`OcclusionFrame`; schema fixtures versioned | API/type review maps every field to normative specs |
| I-03 | Deterministic fixtures and fake providers | I-02 | generated GPU fixtures plus delay, error, malformed, and out-of-order controls | deterministic conformance tests pass |
| I-04 | Lifecycle, scheduler, and keyframe exchange | I-02, I-03 | one in flight/latest pending; atomic newer-only publication; non-blocking update; cancellation/failure behavior | unit and integration tests prove all async invariants |
| I-05 | Canonicalization and calibration state machine | I-02, I-03 | formats/conventions validated; exact three states; relative/lost yield zero confidence and occlusion | conformance and state-path tests pass |
| I-06 | GPU reprojection and disocclusion | I-04, I-05 | display-rate reprojection, validity, confidence, age rejection, and zero-confidence holes | generated geometry/shader fixtures pass |
| I-07 | Stabilization, hysteresis, refinement, compositing | I-06 | frozen thresholds/profile switches; soft mask; invalid history never revived | shader and temporal sequence fixtures pass |
| I-08 | Adaptive control and measurement hooks | I-02, I-07 | exact frozen transitions/cooldown; raw timing availability represented | controlled traces and telemetry schema tests pass |
| I-09 | Camera-to-sphere browser demo | I-03–I-08 | public APIs only; camera start/stop; fake-provider slice; diagnostic/telemetry UI; graceful no-occlusion path | first-milestone definition of done below is satisfied |
| I-10 | Provider conformance harness | I-03, I-05 | reusable depth/motion contract suite and documentation template | fake providers pass; deliberately invalid providers fail |
| I-11 | Real depth-provider experiment | I-09, I-10 | bounded experiment executed without changing frozen gates | candidate adopted only under §5 threshold, otherwise no selection |
| I-12 | Renderer adapters | I-09 | Three.js and Babylon.js packages consume public `core` contracts and preserve texture semantics | package and browser integration tests pass independently |
| I-13 | Fixed corpus and validation runner | I-08, I-09 | immutable versioned clips/annotations, raw samples, summaries, exact metadata | protocol review confirms `validation.md` coverage |
| I-14 | Reference-device validation | I-11, I-13 | exact devices and 60-second post-warm-up runs; results reported per environment | evidence is complete or explicitly failed/missing; no invented claims |

Issues I-11 and I-12 may proceed independently after I-09. Optional optical-flow or segmentation work MUST be opened only after I-14 identifies the corresponding baseline failure and MUST use the unchanged adoption gate.

## 10. First implementation milestone definition of done

Milestone 1 is done only when I-01 through I-09 are complete and all of the following are true:

- the six exact workspace packages exist with enforced dependency direction, while the demo composes only the packages needed by the slice;
- public types preserve every frozen field, state, texture, source-association, and non-blocking invariant;
- a real browser camera drives a virtual sphere through the deterministic fake metric provider without selecting or bundling a model;
- inference is demonstrably off the render critical path, with one in-flight request, latest-wins backpressure, newer-only publication, and safe late-completion disposal;
- GPU reprojection, disocclusion validity, temporal stabilization, `0.65`/`0.35` hysteresis, profile-controlled refinement, and soft confidence-aware compositing operate through the declared texture formats;
- missing, delayed, malformed, rejected, uncalibrated, over-age, and device-loss paths do not fabricate occlusion or block rendering;
- lifecycle, provider/resource ownership, cancellation, and output lifetimes are documented and covered by unit/integration tests;
- unit, shader/geometry, integration, and browser gates in §7 pass, with raw functional evidence retained;
- telemetry is schema-versioned and exposes the fields needed by the frozen validation protocol without claiming results; and
- README/demo documentation states that real-provider selection, the fixed corpus, reference-device runs, benchmark conclusions, and optional-feature adoption remain incomplete.

This milestone is an implementation checkpoint, not completion of the MVP acceptance milestone. It MUST NOT be described as meeting any performance, visual-quality, real-device, model-accuracy, or production-readiness target.
