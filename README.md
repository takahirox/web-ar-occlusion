# Web AR Occlusion

This repository currently contains the final pre-implementation MVP specification for a WebGPU-based web AR occlusion engine. It does not contain a runtime implementation or benchmark results.

## Specification status

The contracts, architecture, defaults, control rules, validation protocol, and acceptance hypotheses required by GitHub Issue #1 are finalized for implementation:

- [MVP specification](docs/mvp-spec.md)
- [Validation protocol](docs/validation.md)
- [Issue #1 completion addendum](docs/issue-1-completion.md)
- [Issue and checklist traceability](docs/traceability.md)

Implementation and real-device measurement remain future work. Every numeric value in these documents is an initial hypothesis until evidence from the reference devices exists; no value is presented as a measured result.

## MVP direction

The MVP keeps depth and motion providers model-agnostic, transports depth as `GPUTexture`, reprojects the latest usable source-associated keyframe on the GPU at display rate, stabilizes it with motion awareness and hysteresis, refines edges, and performs confidence-aware soft compositing. Rendering continues without occlusion when usable depth is unavailable.

Optical flow and segmentation are off by default and may be adopted only through the evidence gates in the validation protocol.

## Scope

This documentation freezes the implementation target. It intentionally adds no application code, model choice, dependency, invented metric calibration, benchmark claim, or production API beyond the contracts in the specification.
