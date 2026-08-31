# Web AR Occlusion

This repository contains the final MVP specification and the initial package workspace for a WebGPU-based web AR occlusion engine. It does not yet contain runtime behavior or benchmark results.

## Implementation status

Backlog item I-01 is implemented: the private npm workspace, strict root TypeScript configuration, and six frozen package shells are present. The package entries are intentionally side-effect-free and contain no runtime behavior.

The contracts, architecture, defaults, control rules, validation protocol, and acceptance hypotheses required by GitHub Issue #1 remain finalized for implementation:

- [MVP specification](docs/mvp-spec.md)
- [Validation protocol](docs/validation.md)
- [Issue #1 completion addendum](docs/issue-1-completion.md)
- [Issue and checklist traceability](docs/traceability.md)
- [Normative implementation plan](docs/implementation-plan.md)

Runtime implementation and real-device measurement remain future work. Every numeric value in these documents is an initial hypothesis until evidence from the reference devices exists; no value is presented as a measured result.

## MVP direction

The MVP keeps depth and motion providers model-agnostic, transports depth as `GPUTexture`, reprojects the latest usable source-associated keyframe on the GPU at display rate, stabilizes it with motion awareness and hysteresis, refines edges, and performs confidence-aware soft compositing. Rendering continues without occlusion when usable depth is unavailable.

Optical flow and segmentation are off by default and may be adopted only through the evidence gates in the validation protocol.

## Scope

The documentation freezes the implementation target. The workspace scaffold adds no runtime behavior, model choice, dependency, invented metric calibration, benchmark claim, or production API beyond the contracts in the specification.
