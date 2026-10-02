---
name: Issue
about: Report a problem or propose a change
title: ""
labels: ""
assignees: ""
---

## Problem

Describe the problem.

## Expected outcome

Describe what should be true when the issue is resolved.

Default to completion criteria an AI agent can execute and verify. Require human checks only when necessary; explain why and the expected result, and distinguish optional validation from mandatory criteria. See the [development guidance](https://github.com/takahirox/web-ar-occlusion/blob/main/docs/development-flow.md#1-start-with-an-issue).

### Pre-merge acceptance criteria

List the implementation requirements and mandatory checks for PR approval. These criteria must be achievable and verifiable before merge. Checks possible only after merge must not be prerequisites for pre-merge PR approval. See the [review guidelines](https://github.com/takahirox/web-ar-occlusion/blob/main/docs/review-guidelines.md#check-pre-merge-acceptance-and-post-merge-verification).

For a merge-triggered deployment, review the code/configuration, validate the local build, and run applicable automated tests before merge. Implementing the deployment and its verification remains required; verifying the newly published site follows merge.

### Required post-merge verification

List required checks possible only after merge separately, with the expected result and where evidence will be recorded, or state that none are required. Report each as **pending** until performed; never claim an unperformed check passed.

For example, after a merge-triggered deployment, verify successful publication and the newly published site against the merged commit, then record the actual results. See the [Pages verification procedure](https://github.com/takahirox/web-ar-occlusion/blob/main/docs/pages-deployment.md#post-merge-live-origin-verification).

## Context

Add any relevant context, examples, logs, or related issues.
