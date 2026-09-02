# Issue #3: calibrated monocular metric depth

The implementation selects Approach B: preserve the pinned model's stable raw near-is-larger output and fit explicit known-distance evidence to `1/z = a·d + b`.

## Approaches considered

| Approach | Scale source | Advantages | Limitations |
| --- | --- | --- | --- |
| A. Metric-trained monocular model | Learned training prior | No user calibration step | Requires changing/downloading a model, may still have scale bias, and is outside Issue #3 constraints |
| B. Raw inverse depth plus known planes | User-supplied distances in the current camera source | Auditable, deterministic, dependency-free, and compatible with the pinned model | Requires careful anchors and can drift when the scene, optics, or model response changes |
| C. Hardware or multi-view metric depth | WebXR depth, depth sensor, pose, or geometry | Can provide a physical scale source | Requires forbidden hardware/APIs or a materially broader tracking system |

Approach B is the smallest option that supplies an explicit physical scale without changing the pinned model or claiming that monocular inference inherently knows meters.

## Calibration contract

Relative diagnostic mode alone may use per-frame min/max normalization. Metric calibration never consumes that normalized texture. It consumes the separately preserved finite raw near-is-larger signal.

Each known-plane anchor records its camera-source ID, source-frame ID, capture timestamp, raw inverse-depth sample, and user-entered distance in meters. At least two anchors with distinct raw values are required. The deterministic ordinary least-squares fit is rejected for duplicate IDs, invalid or mixed sources, stale timestamps, insufficient raw range, non-positive slope, excessive inverse-depth residual, or fitted depths outside the configured range.

The calibrated state exposes canonical positive linear camera-space Z in meters. Application checks the camera source and calibration age again. Invalid pixels carry a zero validity marker, not a guessed depth. A source mismatch or expired calibration enters `lost`; fewer than two anchors is `relative-only`. Neither state permits metric occlusion or confidence fabrication.

## Crossing and hysteresis

Metric occlusion uses the strict crossing rule `realZ < virtualZ`. Entry and exit margins are independently tunable. A background pixel enters occlusion only below `virtualZ - entry`; an occluded pixel remains occluded until it reaches `virtualZ + exit`. Invalid evidence immediately clears the temporal state and disables occlusion.

## Recorded evaluation

The recorded metric evaluator reports MAE in meters, RMSE in meters, and AbsRel separately. It also emits a full foreground/background confusion breakdown and accuracy for every supplied virtual-Z threshold. At least two unique thresholds are mandatory, and results are not collapsed into a composite score.

Example:

```sh
npm run quality:evaluate-metric -- recorded-metric-input.json
```

The input contains source-associated recorded frames with positive predicted and reference linear Z values (or `null` for unavailable samples) plus explicit virtual-Z thresholds.

## Limitations and claims

Calibration assumes that the pinned model's raw response remains sufficiently stable over the calibration lifetime. It does not correct spatially varying bias, motion blur, reflective or transparent surfaces, occlusion-boundary errors, camera intrinsics changes, or domain shift. Known-plane accuracy and sampling directly limit metric accuracy.

No benchmark claim is made. Deterministic fixture tests verify the arithmetic and rejection paths, but real accuracy, latency, responsiveness, and visual quality require an approved recorded corpus and live reference-device runs.
