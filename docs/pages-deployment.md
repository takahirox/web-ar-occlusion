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
   above, including the trailing slash.
4. Complete the automated local and required live-origin checks below before
   claiming Issue #7 is resolved. An artifact build alone does not establish a
   public deployment. Physical-device testing is optional additional evidence
   and does not block Issue completion.

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

## Required live-origin verification

These checks must be executable by an agent. Use the public HTTPS URL directly,
rather than an embedded preview, and record actual results with the deployed
commit SHA and successful deployment workflow run. A successful PR build with
deployment skipped is insufficient.

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

Status at implementation time, 2026-10-02:

- GitHub Issue #7 was read from the repository, including its comments (none).
- Read-only GitHub checks report `has_pages: false`; the Pages API and public
  demo URL return HTTP 404. No deployment of this checkpoint has occurred.
- Local Node.js 24.12.0 validation passed: `npm run check`, 118 core/provider
  tests (`npm test`), 14 demo tests including the two deployment tests
  (`npm run demo:test`), static build, and the standalone deployment check.
  Workflow YAML parsed successfully and `git diff --check` passed.
- A local desktop headless Chrome 154.0.0.0 smoke check loaded all eight static
  files from the loopback `/web-ar-occlusion/` path with the camera off. Real
  cross-origin imports of the pinned ONNX Runtime and Transformers bundles
  succeeded; a browser HEAD request for the metric model returned HTTP 200 and
  the pinned 98,941,181-byte length. The model was not downloaded for inference,
  and this does not establish that an ONNX session initializes on a mobile GPU.
- Local headless checks with missing `VideoFrame` and missing WebGPU produced
  the existing unsupported-capability messages, `Depth valid: false`, and no
  camera stream. These simulated failures are not physical-device results.
- Required live-origin deployment, asset/dependency, and camera/diagnostic wiring
  checks are **pending**. Physical-mobile permission and runtime/model session
  observations are optional and have not been performed. No tested mobile
  device or browser is claimed.
- This execution node permits a local checkpoint commit but prohibits pushing,
  opening a pull request, merging, or commenting. Publication of this new
  workflow therefore requires a later authorized repository step.

After deployment, record the required agent-executable checks with actual evidence:

| Field | Observed value |
| --- | --- |
| Date, deployed commit SHA, successful deployment workflow run, HTTPS URL | Pending |
| Public HTTPS response and browser secure context | Pending |
| Eight static assets/modules: status, MIME, paths, build comparison | Pending |
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

Issue #7 remains incomplete until the public deployment and required automated/
live-origin verification are recorded. Physical-mobile evidence is optional and
does not block completion; device-specific performance, depth quality, and broader
compatibility validation should be tracked separately.
