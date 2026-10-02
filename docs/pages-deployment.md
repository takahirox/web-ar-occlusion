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
4. Complete the live-origin and physical-device checks below before claiming
   Issue #7 is resolved. An artifact build alone does not meet those criteria.

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

## Verify the deployed origin

Use the top-level HTTPS URL directly, rather than an embedded preview. Test on
at least one physical mobile device with working WebGPU and WebCodecs support.
Mobile emulation or an automated fake camera cannot replace this required check:
direct mobile-browser camera testing is the purpose of this deployment.

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
- Live-origin camera permission, remote runtime/model session initialization,
  and physical-mobile validation are **pending**. No tested mobile device or
  browser is claimed.
- This execution node permits a local checkpoint commit but prohibits pushing,
  opening a pull request, merging, or commenting. Publication of this new
  workflow therefore requires a later authorized repository step.

After deployment, replace the pending record with actual evidence:

| Field | Observed value |
| --- | --- |
| Date, commit, workflow run, demo URL | Pending |
| Physical device, OS/version, browser/version | Pending |
| HTTPS, static assets/modules, console/network errors | Pending |
| Camera prompt, allowed/denied results, stop/restart | Pending |
| ONNX Runtime/model requests and native session result | Pending |
| Views, passive refinement, metric debug, invalidation | Pending |
| Relative fallback, model failure, unsupported diagnostics | Pending |
| Network inspection: frames stay local | Pending |

Issue #7 remains incomplete until the public deployment and required physical
mobile observations are recorded.
