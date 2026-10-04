# Browser demo deployment (Issue #7)

Public demo URL: **https://takahirox.github.io/web-ar-occlusion/**

The demo is a static site. Camera frames are processed locally using the existing
WebGPU/WebCodecs pipeline. There is no backend, analytics, or camera upload.
Native metric inference, passive refinement, metric distance debug, relative
fallback, and fail-closed diagnostics use the same code as the local demo.

## Publish

1. In this repository's **Settings → Pages → Build and deployment**, select
   **GitHub Actions** as the source. This is a one-time repository administration
   step; the workflow uses the normal `GITHUB_TOKEN` and requires no added secret.
2. Once the change is reviewed and reaches `main`, **Deploy browser demo to Pages**
   runs automatically. It can also be run manually from **Actions** on `main`.
   Pull requests run the same checks and build without deploying.
3. Confirm that both workflow jobs succeed. Open the URL reported by the
   `github-pages` environment and the deployment step. It should match the URL
   above, including the trailing slash. The deploy job rebuilds the same commit
   and checks all eight live files over HTTPS against that build, including MIME
   types and SHA-256. Its JSON log records the commit and workflow run URL. It
   retries at most 12 times, five seconds apart, for Pages/CDN propagation;
   missing, stale, or incorrectly served files fail the job.
4. After merge and deployment, perform the live-origin checks below and record
   actual results. These are post-merge follow-up and do not block Issue #7 or PR
   review completion. Code/configuration review, local/static-build checks, and
   existing tests are sufficient for this setup change. A local artifact build
   does not establish a public deployment. Physical-device testing is optional
   additional evidence.

The workflow uses Node.js 24 and only Node's built-in tools; no dependency install
is needed. `npm run demo:build` creates `dist/demo/` with the HTML, stylesheet,
JavaScript, and four TypeScript modules stripped to JavaScript. The workflow
uploads only that directory, not the repository or its evaluation data. The
generated modules omit filesystem source URLs. Pages serves the artifact directly,
without Jekyll, a local development server, or a new frontend framework.

All local imports and assets are relative to the document/module location, so they
resolve within `/web-ar-occlusion/` and at a domain root. Runtime and model URLs
remain the existing absolute, pinned HTTPS URLs; the deployment does not copy or
change model dependencies. First use needs network access to jsDelivr and Hugging
Face. The metric model is about 99 MB and is still checked against its byte count
and SHA-256 before use. Browser caching governs later downloads.

For workflow requirements, see GitHub's
[custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Automated local verification

From the repository root, with Node.js 24:

```sh
npm run check
npm test
npm run demo:test
npm run demo:build
npm run demo:check-build
```

`demo:test` includes the deployment checks; `demo:check-build` runs them alone.
They build in temporary directories, serve the complete output with a plain
static HTTP server at `/` and `/web-ar-occlusion/`, follow HTML/CSS/module
references, check response types and JavaScript syntax, and resolve named module
exports. They reject missing assets or paths escaping the project prefix,
verify rebuilds remove stale output, and check that providers, calibration,
refinement, UI, and dependency pins are preserved. They need no remote downloads.

These checks detect deployment path regressions. They do not verify permissions
on the live HTTPS origin, remote dependency availability, or a physical mobile
browser.

## Post-merge live-origin verification

After merge and deployment, these agent-executable checks can verify the
published demo. They are not required for Issue #7 or PR review completion. Use
the public HTTPS URL directly, rather than an embedded preview, and record actual
results with the deployed commit SHA and successful deployment workflow run.
A successful PR build with deployment skipped provides local/static-build
evidence only; it does not establish publication or live-origin behavior.

1. Fetch `https://takahirox.github.io/web-ar-occlusion/` and confirm an HTTP 200
   HTML response over HTTPS. Open it in an automated browser and confirm
   `window.isSecureContext === true`, rendered controls/styles, and no camera
   request before **Start camera**.
2. Follow the deployed HTML/CSS/module references and confirm all eight static
   files respond successfully with the expected MIME types under
   `/web-ar-occlusion/`. Compare their contents with `dist/demo/` built from the
   deployed commit using `npm run demo:build`; inspect console/network errors
   for missing files or broken module imports. The local graph tests above
   describe the expected asset graph but do not verify the public origin.
   To repeat the live asset comparison from a checkout of the deployed commit:

   ```sh
   npm run demo:build
   GITHUB_SHA="$(git rev-parse HEAD)" npm run demo:verify-pages
   ```

   This command makes one attempt by default. Its success establishes only the
   HTTPS asset/MIME/build comparison; perform the browser checks separately.
3. From the deployed browser origin, import the pinned ONNX Runtime Web and
   Transformers.js bundles and verify their runtime and model dependency URLs
   resolve without HTTP, MIME, or CORS errors. Verify the metric model's pinned
   length and SHA-256 on download, and the fallback model's immutable revision.
   A HEAD response only establishes reachability/length, not that a model
   download or inference session succeeds. Report which checks actually ran.
4. Inspect the deployed `main.js` and `index.html` for the **Start camera** click
   handler, secure-context and `getUserMedia` guards, stop/retry behavior, and
   WebGPU/`VideoFrame` diagnostics. Verify these match the tested source at the
   deployed commit. Automated camera permissions or fake capture can exercise
   this wiring; they do not establish a physical-device permission result.
5. Inspect the deployed provider and core modules for preserved native metric
   inference, passive refinement, metric debug, invalidation, and explicit
   relative/manual fallback and failure diagnostics. Run the existing tests
   at the deployed commit and compare the published modules to their build.
   Inspect the deployed JavaScript and network requests to verify there is no
   camera-frame upload/backend path; remote requests fetch runtime/model files.

Record failures and unperformed checks as such. Physical-device permission,
GPU session behavior, depth quality, performance, and broader compatibility
are additional validation, not gates for Issue #7 completion.

## Optional physical-device verification

If physical testing is performed, use the top-level HTTPS URL on a device with
working WebGPU and WebCodecs support. This checklist collects additional evidence
and is not required for Issue completion. Mobile emulation or an automated fake
camera must not be reported as a physical-device result.

1. Record the deployed commit/workflow run, date, exact device, OS version, and
   browser version. Start with a fresh origin permission and browser cache if
   possible. Confirm HTTPS and `window.isSecureContext === true`.
2. Before pressing **Start camera**, confirm the camera is off and the controls
   and stylesheet render. Confirm `main.js`, `occlusion.js`, and all four provider/
   core modules load under `/web-ar-occlusion/` without 404 or MIME errors.
3. Press **Start camera**. Confirm a camera permission prompt for
   `https://takahirox.github.io`, allow access, and confirm a live preview appears.
   Confirm **Stop camera** releases the camera; repeat with permission denied and
   verify a clear error and retry control. Camera permission is per origin,
   shared with other Pages projects on that origin, not per repository path.
4. Confirm the pinned ONNX Runtime Web `1.29.0` WebGPU bundle and its requested
   runtime files load from jsDelivr, and the immutable metric ONNX model loads
   from Hugging Face. Look for CORS, 404, integrity, shader, or session errors.
   Confirm provider telemetry reports the native metric path and a fresh valid
   result. Record download/session failures as failures, not a successful test.
5. Exercise **Occlusion**, **No occlusion**, **Depth view**, profiles, and
   **Metric distance debug → Track objects**. Observe passive refinement/status
   and stale/hidden-page invalidation; the view must not retain rejected depth.
   Do not infer metric accuracy or performance from the displayed estimates.
6. In a separate diagnostic run, block the metric model request and confirm the
   explicit relative/manual fallback message. Allow the pinned Transformers.js
   `4.2.0` bundle and relative model to load and confirm two-anchor calibration
   remains available. Block both providers and confirm a clear model failure.
7. Test a browser missing WebGPU or `VideoFrame` and confirm the existing clear
   unsupported-capability message. Inspect network requests to confirm camera
   frames are not uploaded; external requests should fetch runtime/model files.

Retain observations limited to this device/browser and run. A successful smoke
test establishes neither performance nor depth accuracy.

## Verification record

### Initial publication setup (2026-10-02)

This historical record predates the successful publication recorded below.

Recorded during the earlier review fixes, 2026-10-02 (GitHub state checked at approximately
10:53 UTC):

- Enabled Pages using `POST /repos/takahirox/web-ar-occlusion/pages` with
  `build_type: workflow`. The successful response and subsequent read-only
  checks report `has_pages: true`, `build_type: workflow`, `https_enforced: true`,
  and `html_url: https://takahirox.github.io/web-ar-occlusion/`. The generated
  `github-pages` environment permits deployments from `main`.
- The public URL still returns **HTTP 404**. Running `npm run demo:verify-pages`
  against the public origin failed with that response, as intended. Enabling
  Pages did not publish the demo; no deployed commit SHA is available.
- PR #8's existing head is `c51849eeac2ec45cedc46c6147c33dc7b2c5884f`.
  [Workflow run 36997326751](https://github.com/takahirox/web-ar-occlusion/actions/runs/36997326751)
  has a successful `build` job and a **skipped** `deploy` job. The repository has
  zero workflow artifacts. The workflow file is absent from remote `main`
  (the contents API returns 404), so there is no main-branch workflow/artifact
  available to dispatch/deploy from this node.
- Local Node.js 24.12.0 validation passed: syntax checks, 118 core/provider tests,
  18 demo tests including live-verifier failure cases, the static build, and
  `demo:check-build`. Workflow YAML parses and `git diff --check` passes.
  Verifier tests use simulated HTTP responses; they are not live-origin evidence.
- This checkpoint adds a post-deployment check that compares every public static
  asset's status, MIME, and SHA-256 with the deploying commit's rebuilt artifact.
  Successful verification logs will identify the deployed commit and run.
- Publication awaits the workflow reaching `main` after merge. Then record the
  successful deploy run/SHA and perform the post-merge browser checks above.
  This follow-up does not block Issue #7 or PR review completion.
  The Pages deployment API also requires a
  repository artifact and a GitHub Actions OIDC token; repository admin access
  alone does not supply these prerequisites.
- Post-merge live-origin browser secure-context, runtime/model downloads and
  integrity, camera wiring, diagnostic/fallback, and network/source inspection
  remain **unperformed** because the demo is not deployed. No physical-device
  permission or inference result is claimed. Unperformed live and physical-device
  checks do not block approval of this setup change.

References:
[Pages site/deployment API prerequisites](https://docs.github.com/en/rest/pages/pages)
and [manual workflow dispatch requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

### Issue #11 recovery (2026-10-04)

The reported 404 is resolved. The evidence is consistent with an unpublished
artifact caused by a stalled deployment, rather than an incorrect public URL or
static build. Run `37014975396` built and uploaded the Pages artifact, but its
deploy job had no assigned runner or executed steps. The exact cause of runner
nonassignment remains unknown. With `cancel-in-progress: false`, the subsequent
run could wait behind it; no workflow change is justified by the available evidence.

The repository owner [reported cancelling the stalled and pending runs](https://github.com/takahirox/web-ar-occlusion/issues/11#issuecomment-5981002436)
(`37014975396` and `37017808919`) and manually dispatching a fresh run on `main`.
Read-only GitHub checks confirm that
[run 37208880940](https://github.com/takahirox/web-ar-occlusion/actions/runs/37208880940)
completed successfully at `2026-10-04T14:20:57Z` for commit
`4110f8ed3efdf660438649242e08f18048267262`, including build, artifact upload,
deployment, and published HTTPS asset verification. No deployment approval was
pending, according to the owner's report.

Independent verification from this checkout, whose tracked files matched that
deployed commit before this documentation update:

- At `2026-10-04T14:27:06.541Z`, a direct HTTP GET of
  `https://takahirox.github.io/web-ar-occlusion/` returned **200**, without a
  redirect, with `text/html; charset=utf-8` and title
  **Native metric WebGPU occlusion**.
- `npm run demo:build` followed by
  `GITHUB_SHA=4110f8ed3efdf660438649242e08f18048267262 npm run demo:verify-pages -- https://takahirox.github.io/web-ar-occlusion/`
  passed at `2026-10-04T14:27:19.964Z`. All eight public files returned HTTP 200,
  had the expected MIME types, and matched the local build's SHA-256 hashes.
- Node.js 24.12.0: `npm run check`, `npm test` (118 tests), `npm run demo:test`
  (18 tests), `npm run demo:build`, and `npm run demo:check-build` (6 tests)
  passed. The existing graph regression tests cover both `/` and
  `/web-ar-occlusion/`; the live-verifier tests cover missing, stale, and
  incorrectly served assets. Workflow YAML parsed successfully, with the Pages
  artifact path `dist/demo` and deploy dependency on the build job confirmed.

Retain the existing implementation, workflow, and documented public URL. The
operational recovery has already been performed; this documentation change does
not require another deployment to establish Issue #11's availability outcome.
Browser secure-context, runtime/model, camera-function, and physical-device checks
were not performed for this page-availability fix. Their pending status below
does not imply that the demo still returns 404.

Current post-merge verification evidence:

| Field | Observed value |
| --- | --- |
| Date, deployed commit SHA, successful deployment workflow run, HTTPS URL | 2026-10-04; `4110f8ed3efdf660438649242e08f18048267262`; [run 37208880940](https://github.com/takahirox/web-ar-occlusion/actions/runs/37208880940); https://takahirox.github.io/web-ar-occlusion/ |
| Public HTTPS response and browser secure context | HTTP 200 without redirect at `2026-10-04T14:27:06.541Z`; browser secure-context check pending |
| Eight static assets/modules: status, MIME, paths, build comparison | Passed at `2026-10-04T14:27:19.964Z`: HTTP 200, expected MIME types and SHA-256 matching the deployed commit's build under `/web-ar-occlusion/` |
| Browser runtime imports and runtime/model dependency responses, CORS, integrity | Pending |
| User-initiated camera flow, secure-context guards, stop/retry wiring | Pending |
| Native metric/refinement/debug, fallback/failure/unsupported wiring and tests | Pending |
| Deployed source/network inspection: no frame upload/backend path | Pending |

If physical-device testing is performed, record optional observations separately:

| Field | Observed value |
| --- | --- |
| Date, commit, workflow run, demo URL | Not performed |
| Physical device, OS/version, browser/version | Not performed |
| HTTPS, static assets/modules, console/network errors | Not performed |
| Camera prompt, allowed/denied results, stop/restart | Not performed |
| ONNX Runtime/model requests and native session result | Not performed |
| Views, passive refinement, metric debug, invalidation | Not performed |
| Relative fallback, model failure, unsupported diagnostics | Not performed |
| Network inspection: frames stay local | Not performed |

Issue #7 and PR review can complete using code/configuration review,
local/static-build checks, and existing tests. Successful public deployment and
live-origin verification are post-merge follow-up, not completion gates. No
unperformed live check is claimed as passed. Physical-mobile evidence is optional;
device-specific performance, depth quality, and broader compatibility validation
should be tracked separately.
