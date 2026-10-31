# Development Flow

This document defines the default development flow for web-ar-occlusion, with particular emphasis on AI-assisted development.

## 1. Start with an Issue

Work should begin with an Issue.

The Issue should clearly state:

- the problem
- the expected outcome
- relevant context

The Issue defines the scope of the work. If the scope is unclear, clarify the Issue before implementation instead of inventing requirements during the change.

By default, completion criteria should be executable and verifiable by an AI agent. Require human checks, such as physical-device testing, subjective evaluation, or external approval, only when there is a necessary reason to do so.

When human work is required, state why it is necessary and what result is expected. Distinguish optional additional validation from mandatory completion criteria.

Use the [Issue template](../.github/ISSUE_TEMPLATE/issue.md) to separate **pre-merge acceptance criteria** from **required post-merge verification**. Mandatory pre-merge criteria must be achievable and verifiable before merge. Checks possible only after merge must not be prerequisites for pre-merge PR approval. Record required post-merge checks separately, including the expected result and where evidence will be recorded, and report them as **pending** until performed.

For example, when merge triggers deployment, implement and review the deployment code/configuration, validate the local build, and run applicable automated tests before merge. After merge, verify successful publication and the newly published site against the merged commit, following the [Pages verification procedure](pages-deployment.md#post-merge-live-origin-verification). A successful local build does not establish publication. This timing distinction does not waive implementation requirements or applicable pre-merge tests.

## 2. Create a Pull Request for the Issue

Implementation should be proposed through a Pull Request associated with the Issue.

The Pull Request should explain:

- what changed
- what outcome the change produces
- how the change was validated
- which Issue it addresses

Use validation appropriate to the change and report what actually ran, including missing or unperformed checks. The existing [MVP specification](mvp-spec.md), [implementation plan](implementation-plan.md), and [validation protocol](validation.md) remain authoritative; required reference-device evidence cannot be replaced by synthetic tests or treated as passed without execution.

Choose checks using the [test and CI principles](#test-and-ci-principles) below.

Report pre-merge validation results and pending required post-merge verification separately in the Pull Request. Pending checks that depend on merge do not prevent approval when implementation and pre-merge acceptance are complete; they remain required follow-up and must not be reported as passed or as full verification of the outcome.

A Pull Request should only claim to close an Issue when it fully addresses that Issue.

If the Pull Request intentionally implements only part of the Issue, it should state that clearly and should not present the Issue as fully resolved.

### Test and CI principles

**Detect the required failures at the lightest appropriate layer, without redundant execution.** Preserve required correctness, regressions, and meaningful integration coverage when redistributing checks. Follow the existing [layered-test and evidence decision](decisions/0002-engine-execution-calibration-and-validation.md#decision-7-layered-tests-and-evidence-separation).

The [package scripts](../package.json) use Node's built-in tools: `check` checks syntax, `test` covers core/providers, and `demo:test` covers demo/server and static deployment. `quality:test` is a subset of `test`; `demo:test` includes the test files in `demo:check-build`, which also checks build/verifier script syntax. These deterministic checks do not execute a real model or establish browser/GPU/device performance.

1. **Prefer the lightest meaningful layer.** Test calibration arithmetic, quality calculations, state transitions, and broad input combinations with deterministic unit/component checks. Reserve browser, WebGPU/renderer, real-model, and end-to-end runs for boundaries that need those environments, such as camera permissions, GPU semantics, and inference integration. Each test should catch a concrete defect rather than mirror the implementation.
2. **Choose combinations deliberately.** Cover distinct native-metric and relative-fallback paths, invalid/stale evidence, and root/Pages asset paths with representative cases. Do not automatically multiply every model, profile, renderer, browser, and deployment path. Use exhaustive combinations where interactions require them; preserve required regressions and the validation protocol's exact reference-device matrix.
3. **Match validation to the change.** Use the scope guidance below for mandatory pre-merge evidence, retaining applicable Issue criteria. Focused checks give fast feedback; applicable regression suites provide broader confidence before merge. Report optional validation separately. Merge-dependent publication/live-origin checks belong in [post-merge verification](pages-deployment.md#post-merge-live-origin-verification), with results or pending status. Do not defer checks that can run before merge for convenience.

   | Change | Relevant pre-merge validation |
   | --- | --- |
   | Documentation only | Markdown structure, links/anchors, consistency, and `git diff --check`; application builds and device runs are unnecessary solely for prose changes. |
   | Demo UI/server | `npm run check`, `npm run demo:test`, and browser checks for changed interactions that Node checks cannot establish. |
   | Core/provider/runtime | `npm run check`, `npm test`, and affected demo/integration checks; preserve required GPU and reference-device evidence for claims that need it. |
   | CI/static build | Workflow/configuration review, existing regression checks, and `npm run demo:build`; use `npm run demo:check-build` for focused deployment validation without needlessly repeating shared tests. |

4. **Reuse work and avoid duplicate execution.** The [Pages workflow](../.github/workflows/pages.yml) checks/builds on PRs, pushes to `main`, and manual runs; only non-PR runs on `main` deploy and verify live assets. It rebuilds for verification and queues runs without cancellation. Future CI work should avoid equivalent push/PR execution, safely cancel superseded runs while preserving deployment ordering, and reuse builds, prepared fixtures, and downloads with appropriate cache keys and isolation. Measure resource use before adding parallel workers; Node checks need no dependency install or model download.
5. **Review value and cost together.** Identify the additional defect detected, assurance already supplied by existing coverage, and added execution/maintenance cost. Watch repeated browser/renderer/compiler initialization, large model/corpus fixtures, long processing loops, and Cartesian-product growth. Reducing runtime must retain meaningful assertions and required coverage.
6. **Maintain an execution-time budget.** Normal-CI timing has no documented measured baseline or target. Establish these during test/CI performance work, monitor growth, and investigate overruns by revisiting test structure, setup, and duplication. Record elapsed feedback time, total runner/computation time, and queue time separately. This is maintenance work, not a new benchmark or merge gate; product frame-time hypotheses in the validation protocol are not CI budgets.

Configured CI still runs its checks for documentation PRs. Changes to CI or test implementations belong in separately scoped implementation work.

## 3. Review Before Merge

Every Pull Request should be reviewed before merge.

A central review question is:

> Does this Pull Request address the Issue completely, without adding changes that are not justified by the Issue?

Review must check both directions:

- **No missing scope:** the Pull Request should not leave required parts of the Issue unresolved while claiming completion.
- **No unnecessary scope:** the Pull Request should not introduce unrelated abstractions, frameworks, policies, or complexity beyond what is needed to solve the Issue.

This is especially important for AI-generated changes. AI agents may produce broader or more elaborate designs than the task requires. Prefer the smallest change that fully satisfies the Issue.

Apply the [review guidelines](review-guidelines.md#check-pre-merge-acceptance-and-post-merge-verification): require complete implementation and applicable pre-merge evidence, and confirm required post-merge checks are recorded as pending without making them approval prerequisites.

## 4. Revise Until Review Passes

If review finds missing requirements, unnecessary scope, correctness problems, or insufficient validation, update the Pull Request and review it again.

The Pull Request should be merged only when the reviewed change is an appropriate and complete response to the Issue.

## 5. Merge

After review passes, merge the Pull Request.

## 6. Perform Required Post-Merge Verification

Once the merge-dependent deployment or other prerequisite completes, perform the recorded post-merge checks and update their evidence with actual results. Keep unperformed checks pending and report failures accurately; track any necessary follow-up work. PR approval or merge alone does not establish that these checks passed.

The normal flow is therefore:

```text
Issue
  ↓
Implementation
  ↓
Pull Request
  ↓
Review
  ↓
Revision if needed
  ↓
Merge
  ↓
Required post-merge verification (if any)
```
