# GitHub Issue #1 traceability

Status: specification work is finalized; implementation and measurement work are future.

Every numeric value referenced through this traceability document is an initial hypothesis until real-device evidence exists. No row records or implies a benchmark result.

## Issue-section traceability

The issue body and its authoritative follow-up refinement are represented by the following normative sections. Where the follow-up is more specific, the cited normative text uses the follow-up value or rule.

| Issue #1 section or concern | Normative specification | Status |
| --- | --- | --- |
| Problem, goal, and MVP outcome | `mvp-spec.md` §§1, 13–14 | Specification finalized; prototype implementation future |
| Prototype milestone | `mvp-spec.md` §1 | Milestone definition finalized; delivery and measurement future |
| WebGPU public API and texture design | `mvp-spec.md` §2 | Contract finalized; implementation future |
| Model-agnostic depth contract | `mvp-spec.md` §3 | Contract finalized; provider implementation/documentation future |
| Canonical depth conventions and invalid data | `mvp-spec.md` §3 | Semantics finalized; conformance evidence future |
| Calibration behavior | `mvp-spec.md` §4 | State behavior finalized; implementation future |
| Architecture and package direction | `mvp-spec.md` §5 | Direction finalized; packages future |
| Asynchronous inference and latest-frame policy | `mvp-spec.md` §6 | Invariants finalized; implementation/evidence future |
| Reprojection at display rate | `mvp-spec.md` §§5, 9 | Design finalized; implementation/evidence future |
| Motion-aware temporal stabilization and hysteresis | `mvp-spec.md` §§5, 9 | Design finalized; implementation/evidence future |
| Disocclusion and stale-history policy | `mvp-spec.md` §§6, 9 | Rules finalized; implementation/evidence future |
| Edge refinement and confidence-aware soft compositing | `mvp-spec.md` §§5, 9 | Design finalized; implementation/evidence future |
| Quality profiles | `mvp-spec.md` §7 | Defaults finalized as initial hypotheses; evidence future |
| Adaptive quality control | `mvp-spec.md` §8 | Thresholds and state transitions finalized as initial hypotheses; evidence future |
| Telemetry and graceful degradation | `mvp-spec.md` §10 | Requirements finalized; implementation future |
| Performance and visual-quality targets | `mvp-spec.md` §11; `validation.md` §§3–4 | Acceptance hypotheses finalized; measurements future |
| Reference devices and reproducible reports | `validation.md` §§1–3 | Matrix/protocol finalized; reports future |
| Optical-flow experiment/adoption rule | `mvp-spec.md` §12; `validation.md` §7 | Gate finalized; experiment future |
| Segmentation experiment/adoption rule | `mvp-spec.md` §12; `validation.md` §8 | Gate finalized; experiment future |
| Explicit non-goals | `mvp-spec.md` §13 | Scope finalized |
| Evidence status and no benchmark claims | `mvp-spec.md` §§11, 14; `validation.md` §9 | Status finalized; real-device evidence future |
| Target platforms, provider interfaces, calibration forms, exact output, packages, full non-goals, prototype, and five named scenarios | `issue-1-completion.md` §§1–10 | Omitted Issue-body details finalized; implementation/evidence future |

## Pre-implementation checklist traceability

All six pre-implementation checklist items are closed as specification work only. Closing these items does not assert that runtime or measurement work is complete.

| Checklist item | Normative resolution | Specification status | Future work |
| --- | --- | --- | --- |
| 1. Freeze the engine API and `DepthFrame` contract | `mvp-spec.md` §§2–3 | Finalized | Implement and run provider/API conformance checks |
| 2. Freeze canonical depth and calibration behavior | `mvp-spec.md` §§3–4 | Finalized | Implement calibration and validate invalid/relative/lost paths |
| 3. Freeze asynchronous, reprojection, temporal, disocclusion, and compositing invariants | `mvp-spec.md` §§5–6, 9–10 | Finalized | Implement and collect instrumented evidence |
| 4. Freeze quality defaults and adaptive-control rules | `mvp-spec.md` §§7–8 | Finalized as initial hypotheses | Implement control traces and real-device tests |
| 5. Freeze devices, scenarios, measures, and acceptance hypotheses | `validation.md` §§1–6 | Finalized as initial hypotheses | Produce fixed clips/annotations and execute reference reports |
| 6. Freeze conditional optical-flow and segmentation adoption gates | `mvp-spec.md` §12; `validation.md` §§7–8 | Finalized as initial hypotheses | Run only after the specified baseline failure exists |

## Contract-to-validation traceability

| Normative contract | Validation evidence required |
| --- | --- |
| Engine remains non-blocking | `validation.md` §5 instrumentation |
| `DepthFrame` and provider conventions | `validation.md` §5 provider conformance |
| Calibration never guesses metric scale | `validation.md` §5 state-path evidence |
| Age, confidence decay, and disocclusion rules | `validation.md` §5 instrumented scenarios |
| Exact profile defaults and adaptive control | `validation.md` §6 profile checks and controlled traces |
| Display/GPU/visual hypotheses | `validation.md` §§2–4 fixed scenarios on the exact reference matrix |
| Optional optical flow | `validation.md` §7 identical-input baseline comparison |
| Optional segmentation | `validation.md` §8 identical-input baseline comparison |

## Completion boundary

This documentation completes only the pre-implementation specification requested by Issue #1. The following remain explicitly future: runtime code, package creation, provider selection, model integration, fixed-clip and annotation artifacts, device execution, benchmark evidence, optional-feature adoption, and any revision prompted by measured results.
