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
- `@web-ar-occlusion/depth-webgpu`, including a SHA-256-verified native metric ONNX WebGPU provider and an explicit relative-depth fallback;
- a bounded passive temporal scale/shift refiner with support, residual, convergence, and fail-closed diagnostics;
- a same-corpus three-arm evaluator for zero-shot, passive-refinement, and guided-fallback behavior; and
- a raw-WebGPU camera diagnostic that exercises the native metric provider outside the unfinished production engine.

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

Remaining production work includes full core/keyframe integration, pose-aware reprojection and disocclusion, segmentation, adaptive integration, renderer adapters, and reference-device validation. The demo now uses native metric inference by default and retains explicit known-plane calibration only as a fallback, but its absolute accuracy remains unvalidated. Every numeric target in the specification remains an unvalidated hypothesis until the required reference-device evidence exists.

## Native metric and relative-fallback browser diagnostic

The browser demo uses a normal RGB camera; it does not require WebXR or a hardware depth camera. It creates WebCodecs `VideoFrame` objects from the camera video, copies their RGBA pixels locally, and submits them asynchronously to `@web-ar-occlusion/depth-webgpu`. Rendering continues on `requestAnimationFrame` without awaiting inference.

### Native zero-shot metric depth and passive temporal refinement

The demo evaluates source-associated metric samples with a deterministic five-state runtime: `starting`, `approximate`, `refining`, `stable`, and `unavailable`. Each tracked label uses an eight-observation median/MAD window, image-plane horizontal evidence, three consecutive qualifying windows before promotion to `stable`, and bounded display updates. Its percentage is **temporal repeatability**, not model accuracy or sensor confidence. Low-repeatability valid samples remain visible with an `≈` qualifier and noisy/refining guidance; invalid, mismatched, stale, or lost evidence clears the current distance.

The default provider runs `77ukhtar/depth-anything-v2-metric-onnx` at immutable revision `a4259a3c45137b6eb32c84fcd95b86cd54c255b9`. The standalone `model.onnx` is 98,941,181 bytes with SHA-256 `badcaa28c923da4b0bfaa370ed709acfa00e9f743d295d5443e2149a383413c9`; both are checked before session creation. ONNX Runtime Web `1.29.0` is loaded from its pinned WebGPU ESM bundle and the session allows only the WebGPU execution provider. The model contract is RGB ImageNet-normalized float32 NCHW `[1,3,518,518]` to `predicted_depth` float32 `[1,518,518]`, with positive camera-space Z in meters. The model family is Depth Anything V2 Metric Hypersim Small and is Apache-2.0 according to its [model card](https://huggingface.co/77ukhtar/depth-anything-v2-metric-onnx).

After the immediate zero-shot frame, a bounded passive refiner searches sparse local depth-surface correspondences between consecutive frames, robustly fits an affine scale/shift correction, and limits the correction introduced by one accepted update to 0.10 m over that frame. Insufficient support, ambiguous fits, scene changes, source changes, or out-of-order frames use a copied unrefined native prior instead of carrying a stale correction. `stable` means temporal scale/shift convergence only; it does not mean ground-truth absolute accuracy.

If native metric initialization fails, the demo explicitly switches to the existing relative-depth provider and exposes two-anchor known-plane calibration as a manual fallback. That fallback dynamically imports Transformers.js `4.2.0` from:

```text
https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/+esm
```

The fallback runs `onnx-community/depth-anything-v2-small` at revision `4472b7362082ad9968fee890ca0f1e5aca36b93d` with q4 weights. Its output stays explicitly relative and unitless until source-associated manual anchors produce a valid fit.

Each native result contains immutable source-frame association, linear-Z meter values, a per-pixel validity mask, and reciprocal depth for the compatibility texture. Metric mode feeds refined-or-zero-shot linear Z directly into the crossing mask. Relative diagnostic mode remains available and explicitly unitless. The manual fallback fits `1/z = a·d + b` only after two distinct source-associated anchors. Neither path invents confidence.

Inference is asynchronous and latest-wins. A result is accepted only when its request generation, profile generation, provider identity, source frame ID, capture timestamp, representation, scale, and unit still match the current camera input. Before the first accepted result, after a profile change, when the page is hidden, when depth exceeds the active profile's maximum age, or on inference/provider/device failure, depth is invalidated. The renderer then binds a zero placeholder, disables occlusion, and shows a zero depth view; it never substitutes a stale or fabricated result. An inference failure also stops the camera and reports a failed state.

### Requirements

- A browser with WebGPU and a compatible GPU.
- WebCodecs `VideoFrame` capture support.
- A secure camera context and camera permission. Loopback `http://127.0.0.1` is a trustworthy context; use HTTPS when serving another device.
- Network access on first use to jsDelivr and Hugging Face.
- A Node.js release that provides `node:module`'s `stripTypeScriptTypes`, which the local server uses to serve the TypeScript provider as browser JavaScript.

First use downloads the pinned ONNX Runtime Web module from jsDelivr and the pinned metric model from Hugging Face. If native initialization fails and manual fallback is used, the browser also downloads pinned Transformers.js and its relative model. Subsequent reuse depends on browser cache state. Camera pixels remain on the device and are not uploaded.

### Launch and controls

From the repository root, choose an unused port such as 5000:

```sh
npm run demo -- --port 5000
```

Open `http://127.0.0.1:5000/` and select **Start camera**. Camera permission is the only normal setup interaction; rendering begins while native metric refinement continues asynchronously. Use **Occlusion**, **No occlusion**, and **Depth view** to compare behavior. To inspect approximate distance, enable **Metric distance debug → Track objects**, then click up to six recognizable objects. Each overlay reports a validity-aware 5×5 ROI median, temporal repeatability, refinement state, and guidance. If the native model cannot initialize, the UI loads the relative fallback and asks for two distinct center-plane anchor distances. This fallback is not used for rejected native evidence from an otherwise active native provider.

Run a same-corpus three-arm metric evaluation with:

```sh
npm run quality:evaluate-refinement -- INPUT.json
```

The input must contain exactly `zero-shot`, `passive-refinement`, and `guided-fallback` arms for every session with identical source associations and reference depths. The report includes MAE/RMSE/AbsRel, per-threshold crossing accuracy, scale/shift traces, time to first usable/stable output, guidance prompts, manual anchors, total interactions, and session fractions requiring guidance/manual calibration. Synthetic tests verify the evaluator mechanics but are not benchmark evidence.

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

The real-camera demo proves only that capture, pinned-model integrity, native WebGPU inference, source association, passive temporal alignment, metric probing, GPU texture upload, lifecycle, and visualization can execute in a compatible browser. It does not establish absolute metric accuracy. No reference-device accuracy, latency, thermal, visual-quality, or benchmark evidence exists yet. Displayed values are approximate monocular estimates, not range-sensor measurements.
