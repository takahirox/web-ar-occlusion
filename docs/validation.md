# MVP validation protocol

Status: final protocol; execution and evidence collection are future work.

Every numeric value in this document—including durations, rates, thresholds, percentiles, percentages, frame counts, pixel counts, resolutions, and device-number identifiers where interpreted numerically—is an initial hypothesis until real-device evidence exists. This protocol contains no benchmark results.

## 1. Reference matrix

The reference matrix is exactly:

| Device |
| --- |
| iPhone 15 Pro |
| Google Pixel 8 |

No substitute device satisfies the reference matrix. Additional devices may be reported separately but do not replace either row.

Every device report MUST record:

- exact device model;
- exact OS build;
- exact browser build;
- display rate;
- thermal state;
- power state;
- depth provider and provider version/identifier; and
- active/requested quality profile and all adaptive profile changes.

Missing metadata invalidates the run for acceptance reporting.

## 2. Inputs, warm-up, and run duration

Validation MUST use a versioned, immutable set of fixed clips and fixed annotations. Each report MUST identify the exact clip and annotation versions or content digests. Clip capture and annotation production remain future work; this specification does not invent their content or replacement values.

Each scenario MUST:

1. load its fixed clip and annotations;
2. warm up before measurement;
3. run for exactly `60 seconds` after warm-up; and
4. retain raw samples and the computed summary.

Warm-up is outside the `60-second` measurement interval. Its duration MUST be recorded rather than supplied by an invented value. Runs MUST use identical input when comparing a baseline with an optional feature.

The fixed corpus MUST contain annotated evidence sufficient to measure:

- existing-surface reprojected edge lag;
- new foreground appearance/correction;
- ghost removal after motion or disocclusion;
- static foreground-edge jitter;
- real/virtual front/back ordering;
- fast motion and disocclusion for the optical-flow gate; and
- hand/person boundaries and ordering for the segmentation gate.

## 3. Required scenarios and measurements

For every applicable fixed scenario, capture display timestamps, displayed and dropped frames, total GPU frame time, occlusion GPU time, source-frame association, depth completion time, keyframe age, calibration state, confidence/validity, disocclusion state, active profile, and profile-change events.

Measures are defined as follows:

- **Displayed FPS:** displayed frames divided by the measured post-warm-up interval.
- **Dropped frames:** dropped-frame count divided by expected display opportunities for the recorded display rate.
- **Occlusion GPU p95:** the `95th` percentile of GPU time attributable to the occlusion pipeline during the measured interval.
- **Existing-surface reprojected edge lag p95:** the `95th` percentile display-frame distance between the annotated current edge and the displayed reprojected edge for already-observed surfaces.
- **New foreground correction p95:** the `95th` percentile elapsed time from annotated first visibility of a new foreground region to correct displayed occlusion.
- **Ghost removal p95:** the `95th` percentile elapsed time from annotated exposure/disocclusion to removal of stale occlusion.
- **Static edge jitter p95:** the `95th` percentile output-pixel displacement of the displayed edge from its stable annotated location in static-edge intervals.
- **Front/back ordering error:** incorrectly ordered annotated samples divided by all evaluated ordering samples.

The annotation coordinate system and sampling method MUST be versioned with the corpus and applied identically across devices, profiles, baseline runs, and optional-feature comparisons.

## 4. Acceptance hypotheses

A run satisfies the frozen hypotheses only when all applicable measures meet:

| Measure | Acceptance hypothesis |
| --- | ---: |
| Displayed FPS | at least `55` |
| Dropped frames | below `5 percent` |
| Occlusion GPU p95 | at most `5ms` |
| Existing-surface reprojected edge lag p95 | at most `2 display frames` |
| New foreground correction p95 | at most `150ms` |
| Ghost removal p95 | at most `150ms` |
| Static edge jitter p95 | at most `2 output pixels` |
| Front/back ordering error | at most `5 percent` |

Results MUST be reported per device, exact environment, provider, profile, scenario, and run. Results MUST NOT be generalized beyond recorded evidence.

## 5. Async and calibration conformance

Instrumented validation MUST confirm:

- update and render never await inference;
- only the latest completed, known-source-associated keyframe is used;
- over-age frames do not contribute occlusion;
- `balanced` confidence decay begins at `100ms` and is zero at `250ms`;
- disocclusion holes begin at zero confidence;
- any hole fill is spatial and edge-aware, never stale temporal history;
- `relative-only` and `lost` produce zero confidence and no occlusion;
- no metric mapping is guessed; and
- rendering and telemetry continue when occlusion is unavailable.

Provider conformance MUST also verify required `GPUTexture` depth and confidence, confidence in `[0,1]`, representation, scale/unit pairing, invalid-value handling, source association, UV transform, dimensions, and documented range/axis/UV conventions.

## 6. Quality and adaptive-control conformance

For each profile, verify the exact inference rate, depth resolution, maximum age, edge-refinement setting, optical-flow setting, and segmentation setting in the MVP specification.

Controlled traces MUST verify:

- downgrade from `quality` to `balanced` to `performance` when total GPU frame-time p95 exceeds `14ms` for `2 seconds` or dropped frames exceed `5 percent`;
- one-level recovery only when total GPU frame-time p95 is below `10ms` and dropped frames are below `1 percent` for `10 seconds`; and
- a `10-second` cooldown after every profile change.

The trace MUST demonstrate boundary behavior without claiming that a synthetic control trace is a device benchmark.

## 7. Optical-flow adoption gate

Optical flow remains off unless a report contains all of:

1. an identified baseline fast-motion lag or disocclusion failure;
2. baseline and optical-flow runs using identical input and annotations;
3. at least `20 percent` improvement in the failed measure;
4. displayed FPS of at least `55`; and
5. occlusion GPU p95 of at most `5ms`.

Failure or absence of any item means optical flow is not adopted.

## 8. Segmentation adoption gate

Segmentation remains off unless a report contains all of:

1. an identified baseline hand/person boundary or ordering failure;
2. baseline and segmentation runs using identical input and annotations;
3. at least `20 percent` improvement in the failed measure;
4. new foreground correction p95 of at most `150ms`;
5. displayed FPS of at least `55`; and
6. occlusion GPU p95 of at most `5ms`.

Failure or absence of any item means segmentation is not adopted.

## 9. Reporting status

Until both reference devices have complete reports, every target remains an unvalidated initial hypothesis. A report MUST distinguish observed samples, computed results, failed or missing evidence, and conclusions. It MUST never convert a configured value or synthetic input into a claimed real-device result.
