# Quality evaluation artifacts

This stage adds a dependency-free, deterministic quality evaluator. It defines evidence formats and calculations; it does not provide a corpus, device run, threshold, model result, or benchmark claim.

## Contracts and provenance

Evaluation inputs use `schemaVersion: 1` and kind `web-ar-occlusion-quality-input`. Output artifacts use `schemaVersion: 1` and kind `web-ar-occlusion-quality`.

Every artifact binds these provenance fields into its SHA-256 digest:

- evaluation timestamp;
- source kind, identifier, and content digest;
- implementation identifier and content digest;
- evaluation-configuration digest; and
- evaluator version.

The evaluation source kind distinguishes synthetic fixtures, fixed corpora, device captures, and other evidence. The governance layer additionally uses the claim-bearing provenance classes `synthetic`, `recorded-rgbd`, `real-camera`, and `reference-device`. Corpus manifests bind samples to source digests and scenarios. Run manifests bind every sample to its exact source, source frame, capture timestamp, repository revision, candidate/config/evaluator digests, environment metadata, and evaluation artifact. Synthetic fixtures test calculation correctness only. The contract fixes `claims.benchmark` to `false` so an artifact cannot represent configured values or fixtures as benchmark evidence.

Canonical JSON sorts object keys, preserves array order, normalizes negative zero, and rejects non-finite numbers, `undefined`, sparse arrays, cycles, and non-plain objects. An artifact digest is SHA-256 over the canonical artifact without its `digest` field. Verification validates the full contract before checking that digest.

Each metric is `known`, `missing`, or `unknown`. Known metrics carry a finite value. Missing metrics identify unavailable or inapplicable evidence. Unknown metrics identify evidence for which a defensible value cannot be concluded, such as an unresolved temporal transition. Missing and unknown values are never replaced with zero.

Frames may carry an optional binary `validityMask`. Pixels marked zero are excluded from per-pixel, boundary, thin-structure, depth, confidence, rendered, safety-leak, and temporal observations. This lets recorded sensors retain unknown pixels instead of relabelling them as background. Inputs without this field retain the original all-valid behavior.

## Measurements

Metric depth reports metre MAE and RMSE only when `depthScale` is `metric`. Relative depth reports median-scale-aligned absolute relative error and scale-invariant log RMSE. Null depth samples are excluded and counted honestly.

Confidence reports mean confidence, observed-pixel coverage, and calibration MAE against per-pixel mask correctness. Mask metrics report intersection-over-union, precision, and recall after a fixed `0.5` binary interpretation used only by the evaluator.

Boundary F1 matches predicted and reference boundary pixels within one pixel. Thin recall considers reference-foreground pixels with at most two four-connected foreground neighbours. These definitions are calculation rules, not acceptance thresholds.

Temporal jitter is the mean absolute error between predicted and reference mask changes on consecutive, equally sized frames. Delay is elapsed time from each reference transition until the prediction first reaches the new state. An unresolved transition makes delay unknown. Ghost rate counts removal transitions that retain predicted foreground. Over-smoothing counts reference transitions for which the prediction does not change.

Rendered disagreement is mean absolute alpha disagreement when rendered references are supplied. Foreground leak rate is the fraction of reference-foreground pixels classified as background; it is a safety diagnostic and not proof of safety.

The separate safety report evaluates exact source-frame association, maximum depth age, calibration state, and the required zero-occlusion response. Source mismatch, stale depth, and relative-only/lost calibration are individually counted. If any such invalid evidence contributes nonzero occlusion, `forbiddenNonzeroOcclusion` is recorded and the safety report fails. Missing safety observations produce `unknown`, never a passing zero count.

## Comparison

Comparison is fail-closed. Both digests must verify, provenance for source, configuration, and evaluator must match, objectives must be valid and unique, and every objective must be known in both artifacts. The result is `better`, `worse`, `equivalent`, `tradeoff`, or `incomparable`. A tradeoff is not collapsed into a score, so an improvement cannot hide a safety or quality regression.

Default objectives cover metric depth RMSE, mask IoU, boundary F1, temporal jitter and delay, ghost rate, rendered disagreement, and foreground leakage. Callers may supply explicit objective direction and tolerance; the library fabricates no acceptance tolerance.

The versioned comparison policy declares allowed provenance, required metrics, objectives, and whether the run is development, benchmark, or device-promotion evidence. Required unknown metrics cannot pass. Any safety failure blocks the gate, and unknown safety evidence prevents promotion. Synthetic provenance is rejected for benchmark claims, while device promotion requires `reference-device` provenance. Gate decisions are digest-bound and reserve promotion authority for the Trust Kernel.

## Review-only outputs

`createReviewSummary` emits deterministic digest-bound text with a caller-selected bound of 128–4000 characters. It is explicitly review-only, includes unavailable metrics, and disclaims benchmark conclusions. It neither calls a model nor grants an AI-generated conclusion authority.

Visual review manifests contain at most 50 digest-addressed image or video references. References must be repository-relative paths: absolute paths, parent traversal, and network URI schemes are rejected. Manifests contain no media bytes and are explicitly review-only.

`createAiQualitySummary` creates a bounded machine-readable projection of baseline/candidate deltas, safety violations, missing evidence, worst-scenario references, and visual-review manifest digests. It binds the deterministic decision digest, fixes `promotionAllowed` to false, and cannot replace the policy gate.

## Phase 1 recorded TUM RGB-D preparation

`quality:prepare-rgbd` consumes an already-downloaded TUM RGB-D directory containing `rgb.txt`, `depth.txt`, RGB PNG/JPEG files, and the original non-interlaced 16-bit grayscale depth PNG files. It performs no network access and never treats preview AVI/YUV files, RGB encodings, or colorized depth visualizations as numerical depth.

The maximum association delta is mandatory. Candidate RGB/depth edges within that delta are sorted by absolute timestamp difference, then RGB timestamp/path, then depth timestamp/path. The first edge whose RGB and depth entries are both unused is retained. Retained pairs are sorted by RGB time. If more pairs exist than requested, selection uses `round(i*(N-1)/(count-1))`; a one-frame request selects `floor((N-1)/2)`. Requests are bounded to 1–10 frames.

Preparation without predictions creates the selected, digest-bound local corpus bundle and `corpus.json`, but no `quality-input.json` and no scores:

```sh
npm run quality:prepare-rgbd -- \
  --dataset /absolute/path/to/rgbd_dataset_freiburg1_xyz \
  --output artifacts/tum-freiburg1-preview \
  --max-delta-ms 20 \
  --frames 10 \
  --occlusion-quantile 0.5
```

Prediction input is explicit relative inverse depth (larger values are nearer), with `null` preserving an unknown prediction:

```json
{
  "schemaVersion": 1,
  "kind": "web-ar-occlusion-relative-inverse-depth",
  "evaluatedAt": "2026-09-02T00:00:00.000Z",
  "implementationId": "candidate-name",
  "frames": [
    {
      "id": "frame-0000",
      "width": 640,
      "height": 480,
      "inverseDepth": [1.0, null]
    }
  ]
}
```

The example array is abbreviated; every selected frame and every pixel are required. The implementation digest is computed over the canonical complete predictions document rather than trusted from a caller-provided label. Re-run into a new, non-existing repository-relative output directory to add evaluation material:

```sh
npm run quality:prepare-rgbd -- \
  --dataset /absolute/path/to/rgbd_dataset_freiburg1_xyz \
  --output artifacts/tum-freiburg1-candidate-a \
  --max-delta-ms 20 \
  --frames 10 \
  --occlusion-quantile 0.5 \
  --predictions /absolute/path/to/candidate-a.json

npm run quality:evaluate -- artifacts/tum-freiburg1-candidate-a/quality-input.json \
  > artifacts/tum-freiburg1-candidate-a/quality-artifact.json
```

For each frame, only pixels with both nonzero TUM depth and non-null predicted inverse depth are valid. Let `k=ceil(q*n)` over that joint support. The reference occlusion plane is the kth-smallest TUM metric depth and reference foreground is `depth <= plane`. The predicted plane is the kth-largest relative inverse depth and predicted foreground is `inverseDepth >= plane`. Threshold ties are included. This is a deterministic rank/quantile comparison rule, not metric calibration. The input therefore declares `depthScale: "relative"`: scale-aligned relative-depth metrics may be known, while metre MAE/RMSE remain explicitly missing. TUM raw zero remains null/invalid.

Each predicted bundle contains repository-relative, SHA-256-bound review items for the original RGB PNG/JPEG, reference inverse-depth visualization, predicted mask, reference mask, and diff. Generated visualizations use binary Netpbm PGM (`P5`); diff value 64 means invalid/unknown, 255 means disagreement, and 0 means agreement. The CLI rejects parent traversal, absolute association paths, source or output symlinks, unsupported depth PNG modes, mismatched dimensions, existing output directories, excessive files/dimensions/pixels, and excessive total output.

### TUM attribution and evidence limits

TUM RGB-D data is licensed under CC BY 4.0. Anyone preparing, copying, publishing, or sharing a bundle must retain the dataset source, credit the TUM RGB-D Dataset authors, link the [dataset site](https://cvg.cit.tum.de/data/datasets/rgbd-dataset) and [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/), cite Jürgen Sturm et al., “A Benchmark for the Evaluation of RGB-D SLAM Systems,” IROS 2012, and indicate any changes or selected subsets. The generated corpus metadata records the license and selection provenance but does not discharge those attribution obligations.

These artifacts are development-only recorded-RGBD evidence with `claims.benchmark=false`. They do not claim browser, model, live-camera, device, latency, thermal, or production performance. In particular, they are not `reference-device` evidence and cannot satisfy or bypass the separate device-promotion policy.

## Direct Node CLI

Run the tools without an install or build step:

```sh
node packages/core/src/quality-cli.ts evaluate input.json
node packages/core/src/quality-cli.ts safety observations.json
node packages/core/src/quality-cli.ts verify artifact.json
node packages/core/src/quality-cli.ts verify-corpus corpus.json
node packages/core/src/quality-cli.ts verify-run run.json corpus.json
node packages/core/src/quality-cli.ts compare baseline.json candidate.json
node packages/core/src/quality-cli.ts gate baseline.json candidate.json baseline-run.json candidate-run.json safety.json policy.json
node packages/core/src/quality-cli.ts summary artifact.json 1200
node packages/core/src/quality-cli.ts ai-summary decision.json baseline.json candidate.json safety.json review-digests.json scenario-refs.json 20
node packages/core/src/quality-cli.ts review-manifest artifact.json 24
```

Equivalent package entry points include `npm run quality:prepare-rgbd --`, `quality:evaluate`, `quality:safety`, `quality:compare`, `quality:gate`, `quality:summary`, `quality:review`, and `quality:test`. External downloads, models, cameras, and device runs are outside these commands and require separate explicit approval.

Commands write one canonical JSON value to standard output. Invalid inputs, failed verification, provenance-incomparable comparisons, unsafe review references, and invalid bounds exit nonzero. No command performs network access.

The deterministic tests use seeded in-memory fixtures to verify calculations, defect detection, safety diagnostics, tamper rejection, unknown and missing handling, tradeoffs, CLI behavior, bounds, and repeatability. Their results establish implementation correctness only and must not be reported as model, corpus, browser, device, or production performance.
