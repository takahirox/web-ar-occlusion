# Web AR Occlusion

This repository contains the final MVP specification and an in-progress implementation of a WebGPU-based web AR occlusion engine. It does not contain benchmark results.

## Implementation status

The dependency-free foundation currently includes:

- I-01: the private npm workspace, strict root TypeScript configuration, and six frozen package shells;
- I-02: the frozen public contracts, quality profiles, contract guards, and versioned telemetry schema;
- I-04 foundation: package-private latest-wins inference scheduling and deterministic lifecycle control with generation fencing; and
- I-05 foundation: the package-private three-state calibration/evidence gate, including zero-confidence fallbacks and resource-release notifications.

The core suite currently has 41 deterministic tests. These cover contract validation, telemetry, scheduling and ownership, lifecycle races, and calibration state paths. Full engine/keyframe integration and the GPU rendering path are not complete.

The contracts, architecture, defaults, control rules, validation protocol, and acceptance hypotheses required by GitHub Issue #1 remain finalized for implementation:

- [MVP specification](docs/mvp-spec.md)
- [Validation protocol](docs/validation.md)
- [Issue #1 completion addendum](docs/issue-1-completion.md)
- [Issue and checklist traceability](docs/traceability.md)
- [Normative implementation plan](docs/implementation-plan.md)

Remaining major work includes deterministic WebGPU fixtures and a fake provider, canonical GPU conversion, reprojection and disocclusion, stabilization/refinement/compositing, adaptive integration, the browser demo, renderer adapters, a real-provider experiment, and reference-device validation. Every numeric value in these documents is an initial hypothesis until evidence from the reference devices exists; no value is presented as a measured result.

## MVP direction

The MVP keeps depth and motion providers model-agnostic, transports depth as `GPUTexture`, reprojects the latest usable source-associated keyframe on the GPU at display rate, stabilizes it with motion awareness and hysteresis, refines edges, and performs confidence-aware soft compositing. Rendering continues without occlusion when usable depth is unavailable.

Optical flow and segmentation are off by default and may be adopted only through the evidence gates in the validation protocol.

## Scope

The documentation freezes the implementation target. The current foundation adds no model choice, external dependency, invented metric calibration, benchmark claim, or production API beyond the contracts in the specification.

## Synthetic browser diagnostic

The repository includes a dependency-free diagnostic vertical slice. It overlays a shaded WebGPU sphere on a live camera preview and applies a deterministic fake foreground-depth boundary. It is intentionally separate from the unfinished production engine.

Requirements:

- a current Chrome or Safari build with WebGPU enabled and a compatible GPU;
- camera permission; and
- a secure context. The default `http://127.0.0.1` loopback URL is treated as trustworthy by browsers. For another device, serve the demo through HTTPS rather than changing the server's loopback binding.

Run it from the repository root:

```sh
npm run demo
```

Open `http://127.0.0.1:4173/`, then select **Start camera**. Camera permission is not requested before that click. To choose another valid port, use `npm run demo -- --port 5000` or set `PORT=5000`.

Stop the server with `Ctrl-C`. The server also shuts down cleanly on `SIGTERM`. Stop the camera independently with the demo's **Stop camera** control.

Run its dependency-free tests with:

```sh
npm run demo:test
```

All camera frames stay in the browser. The demo has no CDN, remote assets, model downloads, service worker, or other network requests.

The displayed provider, depth boundary, inference cadence, and depth values are deterministic synthetic data. They do not exercise real depth inference, full core-engine integration, visual accuracy, or benchmark performance. Display FPS and synthetic update rate are simple diagnostic counters; the demo does not fabricate or report measured GPU timings or real depth.
