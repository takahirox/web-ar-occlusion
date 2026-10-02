# Review Guidelines

The purpose of review is not only to check whether a change works. It is also to verify that the change is the right response to the Issue that motivated it.

These guidelines are particularly important when reviewing AI-generated changes.

## Review Against the Issue

Start by reading the source Issue.

Treat the Issue as the reference for the intended problem and expected outcome.

Ask:

> Is the Pull Request a complete and appropriately scoped solution to this Issue?

## Check for Missing Work

Verify that the Pull Request addresses all parts of the Issue that it claims to resolve.

Do not approve a Pull Request as closing an Issue when important requirements remain unimplemented.

If the change is intentionally partial, the Pull Request should say so and the Issue should remain open.

## Check for Unnecessary Work

Verify that the Pull Request does not go beyond what the Issue requires without a clear reason.

Watch for:

- unnecessary abstractions
- speculative extensibility
- unrelated refactoring
- new frameworks or subsystems that are not required
- additional policies or configuration with no demonstrated need

AI agents can over-engineer solutions. Do not treat additional complexity as automatically beneficial.

Prefer the smallest design that completely solves the stated problem.

## Check the Result

Also verify the ordinary quality of the change:

- behavior matches the expected outcome
- implementation is coherent with the existing architecture
- validation is sufficient for the change
- documentation is updated when the change affects documented behavior

For product changes, check required evidence against the [validation protocol](validation.md); synthetic checks do not replace required reference-device evidence. Never treat unperformed checks as passed.

## Check Pre-Merge Acceptance and Post-Merge Verification

Follow the [development flow](development-flow.md#1-start-with-an-issue) and [Issue template](../.github/ISSUE_TEMPLATE/issue.md) when reviewing acceptance criteria. Mandatory pre-merge criteria must be achievable and verifiable before merge. Checks possible only after merge must not be prerequisites for pre-merge PR approval.

For a merge-triggered deployment, require the deployment and verification implementation, code/configuration review, a validated local build, and applicable automated tests before approval. Verify successful publication and the newly published site against the merged commit after merge, using the [Pages verification procedure](pages-deployment.md#post-merge-live-origin-verification). Requiring that deployment to pass before approval would prevent the merge that triggers it.

Confirm required post-merge checks are recorded separately with their expected results and evidence destination, and reported as **pending** until performed. Pending merge-dependent verification does not represent missing implementation and does not block approval when all pre-merge acceptance criteria are met. It remains required follow-up; local builds, approval, and merge do not prove publication or successful post-merge verification.

This distinction does not excuse unimplemented requirements, waive applicable pre-merge tests, or allow checks that can run before merge to be deferred merely for convenience. Preserve the validation protocol's required evidence and report actual results, missing checks, and failures accurately.

## Review Outcome

A Pull Request is ready to merge when:

- it fully addresses the Issue it claims to resolve
- it does not introduce unjustified scope or complexity
- the implementation is correct and all mandatory pre-merge acceptance criteria are met
- required post-merge verification is recorded separately as pending until performed

If any of these conditions are not met, request changes and review again after revision.
