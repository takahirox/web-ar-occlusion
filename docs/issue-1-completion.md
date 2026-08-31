# Issue #1 completion addendum

Status: normative pre-implementation addendum completing details omitted from the Issue #1 specification set.

This addendum supplies the Issue-body details enumerated below. The fixed profiles, adaptive thresholds, acceptance values, reference devices, validation gates, WebGPU contracts, and no-benchmark status in `mvp-spec.md` and `validation.md` remain authoritative and unchanged. Where this addendum describes numeric behavior, it is an unvalidated initial hypothesis, not a benchmark result. This addendum adds no runtime or dependency.

## 1. Target browsers and WebXR boundary

The MVP targets Safari with WebGPU on iOS and iPadOS, Chrome with WebGPU on Android, and desktop Chrome and Safari for development and debugging. The baseline MUST use browser camera/video input and WebGPU without requiring a WebXR session. WebXR MUST NOT be a hard dependency. When WebXR Depth Sensing is available it MAY be selected as an optional depth provider or accelerator; lack of WebXR support MUST NOT prevent the baseline pipeline, provider substitution, fixed-clip validation, or continued rendering without occlusion.

Browser and OS versions used for evidence MUST be recorded exactly as required by `validation.md`; “current” is a targeting statement, not permission to omit version metadata or substitute reference devices.

## 2. Model-agnostic provider contracts and motion priority

`DepthProvider` and `MotionProvider` are replaceable and model-agnostic. The minimum contracts are:

```ts
interface DepthProvider {
  initialize(): Promise<void>;
  infer(frame: VideoFrame): Promise<DepthFrame>;
}

interface MotionProvider {
  update(
    previousFrame: VideoFrame,
    currentFrame: VideoFrame
  ): Promise<MotionEstimate>;
}

type MotionEstimate =
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
```

`DepthProvider.infer` MUST return the exact source-associated `DepthFrame` defined by `mvp-spec.md`. Neither provider may expose model-specific tensors through the public engine contract, own rendering, block display-rate `update`, or invent camera, UV, confidence, scale, unit, or frame-association conventions.

Motion-source priority is exactly:

1. caller-provided camera pose;
2. WebXR pose when optionally available;
3. lightweight visual motion estimation; and
4. image-space optical-flow fallback.

The MVP MUST NOT build full SLAM to fill a missing motion source. Lower-priority motion MUST NOT replace valid higher-priority evidence, and no motion source may revive invalid depth, zero confidence, disoccluded history, or an unusable keyframe. Unassociated, incomplete, superseded, or over-age motion is unusable and MUST NOT delay rendering.

## 3. Calibrated relative and inverse depth mapping

Providers MAY emit `relative` scale and either `linear-z` or `inverse-z` representation exactly as allowed by `DepthFrame`. Such values may affect occlusion only after a calibration step establishes a valid mapping to positive linear camera-space Z in metres and the state is `calibrated`.

An implementation MAY fit `z_real approximately equals a * D_ai + b`, or for inverse depth `1 / z_real approximately equals a * D_ai + b`. Permitted mapping evidence includes optional WebXR/native depth, known planes or anchors, and recorded scene-derived estimates. An inverse-depth representation MUST use its documented direction and range; it MUST NOT be treated as metric inverse metres merely because its representation is `inverse-z`.

Normal real-versus-virtual metric compositing remains forbidden until that mapping has entered the `calibrated` state. A separate ordinal comparison path MAY exist only when the caller explicitly supplies a compatible ordinal calibration; it is never selected implicitly.

Learned guesses, undocumented constants, a presumed camera height, an unmeasured object size, stale calibration retained after loss, and single-frame normalization are not calibration sources. If the mapping cannot be established or maintained, the state is `relative-only` or `lost`, with zero confidence and no occlusion as already required by `mvp-spec.md`.

## 4. Exact `OcclusionFrame` result

The exact primary output contract is:

```ts
interface OcclusionFrame {
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
```

`occlusionTexture` is a soft mask in `[0,1]`, where `0` contributes no real-scene occlusion and `1` contributes full real-scene occlusion. Intermediate values MUST be preserved for confidence-aware boundary compositing. `confidenceTexture`, when present, is normalized to `[0,1]`; `depthTexture`, when present, contains canonical positive linear camera-space Z in metres and never uncalibrated relative depth. When no usable evidence exists, the mask and confidence are zero, optional textures may be absent, quality telemetry still reports the state, and rendering continues.

## 5. Motion-aware smoothing and hysteresis hypotheses

Temporal smoothing MUST reproject valid history using the motion priority above before blending. It MUST reduce history weight as motion magnitude, keyframe age, disagreement, or uncertainty increases. It MUST reject history at invalid samples, disocclusions, zero confidence, calibration loss, unknown source association, and depth-order discontinuities.

The initial tunable hysteresis hypotheses are a foreground-entry threshold of `0.65` and a foreground-exit threshold of `0.35` applied to the confidence-weighted soft occlusion decision. A sample at or above `0.65` may enter foreground occlusion; a foreground sample remains in that state until its decision falls to or below `0.35`. Between the thresholds, valid motion-compensated history may retain the prior state. Both values MUST remain tunable and MUST be measured rather than described as validated. Neither threshold permits invalid or disoccluded history to persist.

## 6. Proposed package split

The proposed package direction is:

1. `@web-ar-occlusion/core` — model-agnostic and renderer-agnostic orchestration and public contracts;
2. `@web-ar-occlusion/depth-webgpu` — browser-side WebGPU depth provider;
3. `@web-ar-occlusion/depth-webxr` — optional native WebXR depth provider;
4. `@web-ar-occlusion/motion` — motion-provider contracts and implementations;
5. `@web-ar-occlusion/three` — optional Three.js integration; and
6. `@web-ar-occlusion/babylon` — optional Babylon.js integration.

These names describe the proposed implementation boundary; no package, dependency, runtime, or model is added by this documentation change. Dependency direction remains exactly as specified by `mvp-spec.md`.

## 7. Complete v0.1 non-goals

Version 0.1 explicitly excludes:

- full SLAM;
- world anchors;
- hit testing;
- plane tracking;
- semantic scene reconstruction;
- persistent scene meshes;
- cloud inference;
- neural rendering;
- perfect depth for glass, mirrors, or transparent surfaces;
- centimetre-level metric depth guarantees;
- choosing, bundling, downloading, or training a specific model;
- guessing metric scale from uncalibrated relative or inverse depth;
- requiring WebXR, WebXR Depth Sensing, LiDAR, or another platform depth API;
- blocking display-rate update or rendering on inference;
- using stale history to fill a disocclusion;
- requiring optical flow or semantic segmentation in the baseline;
- altering the fixed reference matrix, profiles, thresholds, acceptance hypotheses, or adoption gates;
- claiming benchmark success, cross-device generality, or production readiness; and
- adding runtime implementation or dependencies as part of Issue #1 documentation completion.

## 8. Edge refinement inputs

Edge refinement MUST combine low-resolution depth with full-resolution RGB edges, real-depth discontinuities, motion boundaries, normalized confidence, reprojected validity and disocclusion, and the virtual-depth boundary relevant to the comparison. It MAY consume a gated segmentation boundary only when segmentation has passed its unchanged adoption gate. Refinement MUST remain edge-aware, preserve soft mask values, avoid bleeding foreground across a supported boundary, and never convert zero-confidence or disoccluded history into valid temporal evidence.

## 9. First prototype pipeline and measurements

The first prototype pipeline is: camera → low-resolution depth → per-frame reprojection → temporal stabilization → edge-aware refinement → occlusion mask → a virtual sphere hidden by a real desk or table. AI inference remains outside the render critical path, while reprojection and compositing run at display rate.

On both exact reference devices, the prototype MUST measure inference latency, GPU time per stage, frame rate, boundary jitter, motion lag, and visible artifacts. It MUST also record the acceptance metrics in `validation.md`. The occlusion path targets less than `5ms` for reprojection, edge refinement, and compositing combined; this is an unvalidated engineering hypothesis, not a measured guarantee.

## 10. Five named acceptance scenarios

| Named scenario | Required pass behavior |
| --- | --- |
| **Desk test** | Place a virtual object behind a real desk or table and move laterally. The desk boundary has no persistent visible flicker and no obvious lagging occlusion edge. |
| **Foreground-object test** | Move a hand, book, or object in front of a virtual object. Foreground occlusion appears naturally within the correction hypothesis, and removal leaves no long-lived ghost mask. |
| **Fast camera rotation** | Rotate or pan quickly. Rendering remains approximately `55–60 FPS` where possible, inference causes no stalls, and occlusion does not visibly trail camera motion. |
| **Static scene** | Hold the camera still. Occlusion-boundary jitter is not noticeable in normal use and satisfies the frozen pixel hypothesis. |
| **Depth crossing** | Move a virtual object across the front/back boundary near a real surface. Visibility does not rapidly oscillate because of inference noise, and ordering error remains within the frozen hypothesis. |

Every scenario MUST run through the fixed-corpus, metadata, duration, per-device reporting, and applicable measurement rules in `validation.md`. Passing one behavior does not waive any other applicable acceptance hypothesis.

## 11. Traceability

| Issue-body completion item | Heading in this addendum |
| --- | --- |
| Target browsers and optional-only WebXR | §1, **Target browsers and WebXR boundary** |
| Model-agnostic `DepthProvider` and `MotionProvider`; motion priority | §2, **Model-agnostic provider contracts and motion priority** |
| Calibrated-only relative or inverse mapping sources | §3, **Calibrated relative and inverse depth mapping** |
| Exact `OcclusionFrame` texture and quality fields; soft `[0,1]` mask | §4, **Exact `OcclusionFrame` result** |
| Motion-aware smoothing and tunable `0.65`/`0.35` hysteresis | §5, **Motion-aware smoothing and hysteresis hypotheses** |
| Six proposed `@web-ar-occlusion` packages | §6, **Proposed package split** |
| Complete v0.1 non-goals | §7, **Complete v0.1 non-goals** |
| Edge-refinement inputs | §8, **Edge refinement inputs** |
| First prototype pipeline and measurements | §9, **First prototype pipeline and measurements** |
| Five named acceptance scenarios and pass behavior | §10, **Five named acceptance scenarios** |
| Existing authoritative values and unchanged status | Preamble and §12, **Authority and completion boundary** |

## 12. Authority and completion boundary

This addendum is normative only for the omitted Issue-body details it states. Existing `mvp-spec.md` and `validation.md` fixed profiles, adaptive thresholds, acceptance values, reference devices, gates, WebGPU contracts, and no-benchmark status remain authoritative and unchanged. Implementation, packages, dependencies, fixed-corpus production, device execution, measurement, and benchmark conclusions remain future work.
