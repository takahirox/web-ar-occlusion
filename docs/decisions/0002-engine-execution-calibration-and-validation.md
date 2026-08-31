# ADR 0002: Engine execution, calibration, development, and validation

Status: accepted for implementation planning.

This decision does not select a model or claim benchmark, accuracy, browser, or device evidence.

## Decision 1: Async initialization and synchronous update

**Chosen option.** Initialize the engine asynchronously, then expose a synchronous non-blocking display update. Use explicit lifecycle states and require new-engine construction after fatal initialization failure or device loss.

**Rationale.** WebGPU/provider setup is asynchronous, while the frozen render contract forbids awaiting inference. Explicit states make pre-ready, stopped, and failed behavior testable.

**Rejected alternatives.** An async per-frame update invites render-loop awaits. Lazy hidden initialization makes first-frame behavior nondeterministic. In-place recovery after device loss greatly expands resource and provider state handling.

**Consequences.** Callers await readiness once and handle zero-occlusion frames outside `ready`. Fatal recovery is coarse-grained but deterministic.

**Reversibility.** Initialization ergonomics are reversible before API publication. Making update asynchronous later would be a breaking semantic change.

## Decision 2: One in flight, latest pending

**Chosen option.** Permit one in-flight inference per provider and one replaceable pending capture. Publish only the newest completed, valid, known-source-associated keyframe through an atomic snapshot exchange.

**Rationale.** This provides bounded memory and latency, implements backpressure, and prevents an inference backlog from making every result stale.

**Rejected alternatives.** An unbounded FIFO conflicts with latest-usable semantics. Dropping every frame while busy wastes the freshest available capture. Parallel inference can reorder completions and consume device resources without evidence of benefit.

**Consequences.** Intermediate camera frames are intentionally dropped from inference, not display. Providers that internally queue work must document and disable that queue where possible.

**Reversibility.** The concurrency limit may be revisited only through a bounded experiment: use identical fixed inputs and provider version; compare completion age, failure rate, displayed FPS, and frozen GPU/visual measures; adopt a value above one only if it lowers keyframe-age p95 without causing any frozen hypothesis or conformance failure; otherwise retain one.

## Decision 3: Generation-token cancellation and fail-open rendering

**Chosen option.** Cancellation invalidates an engine generation and suppresses late publication rather than changing the frozen provider signatures. Recoverable failures produce zero occlusion and telemetry; device loss or initialization failure requires recreation.

**Rationale.** Promises and GPU submissions cannot be assumed abortable. Generation checks contain late results without pretending cancellation succeeded and preserve continued rendering.

**Rejected alternatives.** Adding `AbortSignal` to frozen provider methods changes their exact minimum contract. Waiting for outstanding inference blocks shutdown. Reusing stale depth after failure violates age, confidence, and calibration rules.

**Consequences.** Providers may continue brief work after disposal, but their result is released and cannot mutate engine state. Cleanup and promise rejection handling need explicit tests.

**Reversibility.** An optional abort-capable extension could be added later without changing baseline semantics; fail-open behavior is frozen and not reversible here.

## Decision 4: Calibration belongs to core, conventions to adapters

**Chosen option.** Provider adapters normalize and document their conventions; core alone decides calibration state and produces canonical metric depth from explicit permitted evidence.

**Rationale.** This separates contract conformance from metric validity and prevents a provider/model from silently guessing scale.

**Rejected alternatives.** Provider-owned implicit calibration cannot be audited uniformly. Adding calibration fields to `DepthFrame` changes its exact frozen shape. Single-frame normalization and learned constants are expressly forbidden.

**Consequences.** Relative providers are useful for conformance and experimentation but produce no occlusion until an evidence source and revocation policy are implemented. Calibration loss invalidates keyframes and history immediately.

**Reversibility.** Internal fitting algorithms are reversible behind conformance tests. Ownership and no-guessed-scale semantics are not reversible without a specification change.

## Decision 5: Fake-first development

**Chosen option.** Build deterministic GPU fake providers and synthetic geometry fixtures before choosing a real model/provider.

**Rationale.** Scheduling, texture, calibration, reprojection, and failure behavior can be verified independently of model availability and nondeterminism.

**Rejected alternatives.** Selecting a model first couples engine progress to unmeasured provider behavior. CPU fixtures would fail to exercise the required public GPU path. Live-camera-only tests are not reproducible.

**Consequences.** Fixture tooling is milestone work, and synthetic success cannot be presented as accuracy or device evidence. Real-provider selection remains the bounded experiment in the implementation plan.

**Reversibility.** Fully reversible as test infrastructure, although deterministic fixtures remain valuable after provider adoption.

## Decision 6: Minimal raw-WebGPU demo composition

**Chosen option.** The first demo uses browser camera input, core, fake providers, raw WebGPU composition, and one virtual sphere. Renderer adapters and optional WebXR remain later independent work.

**Rationale.** This exercises the complete frozen camera-to-mask path with the fewest unrelated dependencies and isolates core correctness from renderer integration behavior.

**Rejected alternatives.** Starting with Three.js or Babylon.js makes a peer renderer part of the critical path. Requiring WebXR violates the baseline boundary. Multiple scenes or objects add no contract coverage to the first slice.

**Consequences.** A small sphere-depth pass must be implemented for the demo, then renderer adapters must independently prove equivalent texture semantics.

**Reversibility.** The demo renderer is replaceable; the core remains renderer-agnostic.

## Decision 7: Layered tests and evidence separation

**Chosen option.** Separate unit, shader/geometry, integration, browser, and exact real-device validation. Store raw telemetry separately from summaries, and reserve acceptance claims for the frozen protocol.

**Rationale.** Each layer detects different failures, while strict evidence separation prevents synthetic fixtures or configured values from becoming benchmark claims.

**Rejected alternatives.** Browser end-to-end tests alone poorly isolate scheduling and shader errors. Unit tests alone cannot verify GPU semantics. Desktop results cannot substitute for either exact reference device.

**Consequences.** The repository needs deterministic GPU test fixtures, browser automation plus manual camera checks, and later a validation runner/corpus. Some browser/device checks remain unavailable in ordinary CI and must be explicitly reported as missing rather than assumed.

**Reversibility.** Test tools may change while preserving layer coverage and evidence semantics. The frozen device protocol and gates are not changed by this decision.

## Decision 8: Core-owned versioned telemetry

**Chosen option.** Core emits versioned raw lifecycle, scheduling, calibration, profile, GPU, confidence, and failure events; validation tooling computes summaries and conclusions.

**Rationale.** A single schema makes cross-provider and cross-integration evidence comparable without allowing implementations to redefine measures.

**Rejected alternatives.** Provider-owned telemetry fragments core measures. Logging strings are not machine-verifiable. Computing only rolling summaries discards evidence required by the validation protocol.

**Consequences.** Schema fixtures and migration notes are required. Unsupported measurements must carry availability reasons, and raw sample retention belongs to the recorder rather than the engine.

**Reversibility.** Fields can be added through schema versions. Reinterpreting an existing field requires a new version and migration documentation.
