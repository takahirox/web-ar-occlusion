# Web AR Occlusion

Issue #3's dependency-free raw inverse-depth calibration design, fail-closed metric contract, multi-threshold evaluation, and limitations are documented in [docs/issue-3-approach-b.md](docs/issue-3-approach-b.md).

This repository contains the final MVP specification and an in-progress WebGPU-based web AR occlusion engine. It includes an experimental real monocular-depth browser diagnostic, but it does not contain benchmark or reference-device results.

## Implementation status

Implemented foundations include:

- I-01: the private npm workspace, strict root TypeScript configuration, and six frozen package shells;
- I-02: the frozen public contracts, quality profiles, contract guards, and versioned telemetry schema;
- I-04 foundation: package-private latest-wins inference scheduling and deterministic lifecycle control with generation fencing;
- I-05 foundation: the package-private three-state calibration/evidence gate, including zero-confidence fallbacks and resource-release notifications;
- a deterministic quality evaluator with digest-bound corpus/run provenance, fail-closed comparison, and review-only experiment summaries;
- a dependency-free, development-only TUM recorded-RGBD corpus/evaluation-input preparer with deterministic timestamp association and explicit rank/quantile masks;
- `@web-ar-occlusion/depth-webgpu`, including a pinned real relative-depth provider; and
- a raw-WebGPU camera diagnostic that exercises that real provider outside the unfinished production engine.

The deterministic tests cover contracts, telemetry, scheduling and ownership, lifecycle races, calibration state paths, recorded-RGBD preparation, provider capture and normalization, and the demo server/UI. Run `npm test`, `npm run demo:test`, and `npm run quality:test` for these suites.

The contracts, architecture, defaults, control rules, validation protocol, and acceptance hypotheses required by GitHub Issue #1 remain documented here:

- [MVP specification](docs/mvp-spec.md)
- [Validation protocol](docs/validation.md)
- [Issue #1 completion addendum](docs/issue-1-completion.md)
- [Issue and checklist traceability](docs/traceability.md)
- [Normative implementation plan](docs/implementation-plan.md)
- [Deterministic quality evaluation](docs/quality-evaluation.md)

The quality evaluator and its fixtures are deterministic synthetic development evidence. They are separate from the live-camera demo and are not camera-model accuracy, device-performance, or benchmark evidence.

The recorded-RGBD preparer requires an already-downloaded TUM dataset and performs no downloads. Its outputs remain development-only, set no benchmark claim, and cannot substitute for reference-device promotion evidence. Exact commands, prediction format, quantile rule, bounds, and TUM CC BY 4.0 attribution obligations are in [Deterministic quality evaluation](docs/quality-evaluation.md#phase-1-recorded-tum-rgb-d-preparation).

Remaining production work includes deterministic WebGPU fixtures and fake-provider integration, full core/keyframe integration, reprojection and disocclusion, stabilization/refinement/compositing, adaptive integration, renderer adapters, and reference-device validation. The demo now includes explicit known-plane metric calibration, but its accuracy remains unvalidated. Optical flow and segmentation remain off by default and may be adopted only through the validation evidence gates. Every numeric target in the specification remains an unvalidated hypothesis until the required reference-device evidence exists.

## Real relative and calibrated-metric browser diagnostic

The browser demo uses a normal RGB camera; it does not require WebXR or a hardware depth camera. It creates WebCodecs `VideoFrame` objects from the camera video, copies their RGBA pixels locally, and submits them asynchronously to `@web-ar-occlusion/depth-webgpu`. Rendering continues on `requestAnimationFrame` without awaiting inference.

### Passive metric state and current zero-shot limitation

The demo evaluates source-associated metric samples with a deterministic five-state runtime: `starting`, `approximate`, `refining`, `stable`, and `unavailable`. Each tracked label uses an eight-observation median/MAD window, image-plane horizontal evidence, three consecutive qualifying windows before promotion to `stable`, and bounded display updates. Its percentage is **temporal repeatability**, not model accuracy or sensor confidence. Tracking loss, stale results, calibration loss, provider failure, source mismatch, or invalid samples clear the displayed distance immediately. Guidance first asks the user to keep the target framed, move slowly side to side, or hold steady.

No native zero-shot metric provider is enabled. The pinned Depth Anything V2 model remains relative and unitless. The screened DepthPro ONNX artifact is not used because direct-browser WebGPU feasibility, required focal-length postprocessing, output orientation, and camera-Z meter semantics have not all been verified for this runtime. Explicit known-plane calibration therefore remains the only meter-producing path and is labeled as an estimated manual fallback. Issue #4's RGB-only zero-interaction metric acceptance criterion remains blocked until a deployable model satisfies those checks; relative values are never relabeled as meters.

Deterministic evaluation covers time-to-state in observations, temporal dispersion, horizontal evidence, display-step bounds, fail-closed invalidation, and source association. Recorded metric evaluation continues to report camera-Z MAE/RMSE/AbsRel and crossing thresholds when reference metric data is supplied. Synthetic fixtures are test evidence, not benchmark claims.

The provider dynamically imports the browser ESM build of Transformers.js `4.2.0` from this pinned URL:

```text
https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm
```

The jsDelivr `+esm` entry is required for direct browser loading because it rewrites package-internal bare imports such as the ONNX Runtime WebGPU entry to browser-resolvable CDN module URLs. The package's raw `dist/transformers.web.min.js` file still contains bare module specifiers and is not used by this unbundled demo.

It runs `onnx-community/depth-anything-v2-small` at revision `4472b7362082ad9968fee890ca0f1e5aca36b93d` using q4 weights on the WebGPU backend. The model is Apache-2.0 according to its [pinned model card](https://huggingface.co/onnx-community/depth-anything-v2-small/blob/4472b7362082ad9968fee890ca0f1e5aca36b93d/README.md).

Each successful result retains its raw near-is-larger inverse-depth signal and separately creates a min/max-normalized `r32float` diagnostic texture (near is 1). Relative mode has `scale: "relative"`, `unit: null`, and no confidence texture. After at least two source-associated known-plane anchors at distinct distances, metric mode deterministically fits `1/z = a·d + b`, emits approximate linear camera-Z in meters, and fails closed when that calibration is unavailable, invalid, mismatched, or stale. It does not invent confidence.

Inference is asynchronous and latest-wins. A result is accepted only when its request generation, profile generation, provider identity, source frame ID, capture timestamp, representation, scale, and unit still match the current camera input. Before the first accepted result, after a profile change, when the page is hidden, when depth exceeds the active profile's maximum age, or on inference/provider/device failure, depth is invalidated. The renderer then binds a zero placeholder, disables occlusion, and shows a zero depth view; it never substitutes a stale or fabricated result. An inference failure also stops the camera and reports a failed state.

### Requirements

- A browser with WebGPU and a compatible GPU.
- WebCodecs `VideoFrame` capture support.
- A secure camera context and camera permission. Loopback `http://127.0.0.1` is a trustworthy context; use HTTPS when serving another device.
- Network access on first use to jsDelivr and Hugging Face.
- A Node.js release that provides `node:module`'s `stripTypeScriptTypes`, which the local server uses to serve the TypeScript provider as browser JavaScript.

First use downloads the pinned Transformers.js runtime from jsDelivr and model assets from Hugging Face. Subsequent reuse depends on the browser's cache implementation and cache state. Camera pixels remain on the device: the browser does not send them to jsDelivr, Hugging Face, or the repository's local server. The local server only serves repository files and the stripped provider module.

### Launch and controls

From the repository root, choose an unused port such as 5000:

```sh
npm run demo -- --port 5000
```

Open `http://127.0.0.1:5000/` and select **Start camera**. Camera permission is requested only after that click; model initialization follows camera startup. Use the profile buttons to select the inference cadence/resolution/maximum-age preset. Use **Occlusion**, **No occlusion**, and **Depth view** to compare behavior. To inspect approximate distance, capture the same center plane at two or more distinct known distances, enable **Metric distance debug → Track objects**, then click up to six recognizable objects. Each overlaid label follows a nearby compatible metric-depth surface, reports the validity-aware 5×5 ROI depth, an eight-observation median, and the recent observed range. This is lightweight depth-surface tracking, not semantic object detection. A missing or lost current metric sample is shown as unavailable rather than a stale or fabricated meter value. The telemetry panel reports lifecycle, provider state, calibration and tracking state, requested/active profile, display FPS, accepted inference count/rate, depth age/validity, camera size, and view mode. These values are diagnostics, not validated performance measurements.

Select **Stop camera** to release camera and GPU resources. Stop the server with `Ctrl-C`; it also shuts down on `SIGTERM`. Run the dependency-free demo checks with:

```sh
npm run demo:test
```

### Troubleshooting

- **Pinned model failed to load:** confirm that the browser can reach jsDelivr and Hugging Face, and that a content blocker, proxy, or content-security policy is not blocking module or model fetches. Clear the relevant browser cache if it contains an interrupted response, then retry.
- **`VideoFrame` unavailable:** use a current browser build with WebCodecs `VideoFrame` enabled. Camera access alone is insufficient.
- **WebGPU unavailable or no adapter:** use a WebGPU-capable browser/GPU, enable hardware acceleration, and check the browser's WebGPU diagnostics and blocklist status.
- **Camera unavailable or permission denied:** open the loopback URL (or HTTPS), allow camera permission for the origin, ensure another application is not exclusively using the camera, and retry.
- **`Depth valid` remains `false`:** this is the fail-closed state while awaiting the first result or after stale, hidden-page, profile-change, source-association, inference, or device invalidation. Check the lifecycle/status message, keep the page visible, and use **Try again** or restart the camera after resolving the reported cause.

## Evidence limits

The real-camera demo proves only that the implemented capture, pinned provider, source-associated calibration, metric probing, GPU texture upload, lifecycle, and visualization paths can be exercised in a compatible browser. No reference-device metric accuracy, FPS, latency, thermal, visual-quality, or benchmark evidence exists yet. The displayed distances are approximate calibrated estimates, not range-sensor measurements, and do not make the model/provider production-ready.
