import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDemoServer } from '../../../scripts/serve-demo.mjs';
import {
  DIAGNOSTIC_RELATIVE_DEPTH_CEILING,
  DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM,
  isDiagnosticSphereFragmentOccluded,
  mapSphereRelativeDepthForDiagnosticOcclusion,
  sampleMetricDepthProbe,
  updateMetricCrossing,
  updateMetricCrossingMask
} from '../occlusion.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const providerSource = resolve(root, '../../packages/depth-webgpu/src/index.ts');

function fetchLocal(port, path, method = 'GET') {
  return new Promise((resolveResponse, reject) => {
    const call = request({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveResponse({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    call.on('error', reject);
    call.end();
  });
}

async function withServer(run) {
  const server = createDemoServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

test('serves demo assets with correct MIME and no-store headers', async () => {
  await withServer(async (port) => {
    for (const [path, mime] of [['/', 'text/html'], ['/style.css', 'text/css'], ['/main.js', 'text/javascript'], ['/occlusion.js', 'text/javascript'], ['/depth-webgpu.js', 'text/javascript'], ['/metric-calibration.js', 'text/javascript']]) {
      const response = await fetchLocal(port, path);
      assert.equal(response.status, 200);
      assert.match(response.headers['content-type'], new RegExp(`^${mime}`));
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
  });
});

test('serves only the exact depth provider route through the standard TypeScript stripper', async () => {
  const source = await readFile(providerSource, 'utf8');
  const expected = stripTypeScriptTypes(source, {
    mode: 'strip',
    sourceUrl: pathToFileURL(providerSource).href
  });
  await withServer(async (port) => {
    const transformed = await fetchLocal(port, '/depth-webgpu.js');
    assert.equal(transformed.status, 200);
    assert.equal(transformed.body, expected);
    assert.match(transformed.body, /export class WebGPUMonocularDepthProvider/);
    assert.match(transformed.body, /onnx-community\/depth-anything-v2-small/);
    assert.doesNotMatch(transformed.body, /export (?:type|interface)\b/);

    const head = await fetchLocal(port, '/depth-webgpu.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    for (const path of ['/packages/depth-webgpu/src/index.ts', '/depth-webgpu.js/index.ts']) {
      assert.equal((await fetchLocal(port, path)).status, 404);
    }
  });
});

test('supports HEAD and rejects methods, missing files, and traversal', async () => {
  await withServer(async (port) => {
    const head = await fetchLocal(port, '/main.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await fetchLocal(port, '/missing')).status, 404);
    assert.equal((await fetchLocal(port, '/', 'POST')).status, 405);
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%5c..%5cpackage.json']) {
      const response = await fetchLocal(port, path);
      assert.ok(response.status === 400 || response.status === 404);
      assert.doesNotMatch(response.body, /web-ar-occlusion/);
    }
  });
});

test('UI states explicit consent, aligned horizontal correction, real relative depth, and fail-closed telemetry', async () => {
  const [html, script, style] = await Promise.all([
    readFile(resolve(root, 'index.html'), 'utf8'),
    readFile(resolve(root, 'main.js'), 'utf8'),
    readFile(resolve(root, 'style.css'), 'utf8')
  ]);
  assert.match(html, /id="start"[^>]*>Start camera/);
  assert.match(html, /id="stop"/);
  assert.match(html, /Occlusion/);
  assert.match(html, /No occlusion/);
  assert.match(html, /Depth view/);
  assert.match(html, /class="stage flip-x" id="stage"/);
  assert.match(html, /id="orientationControls"/);
  assert.match(html, /data-flip="true" aria-pressed="true">Corrected/);
  assert.match(html, /8 Hz · 320×192 · max age 250 ms/);
  assert.match(html, /12 Hz · 384×224 · max age 250 ms/);
  assert.match(html, /18 Hz · 480×270 · max age 200 ms/);
  assert.match(html, /Relative diagnostic/);
  assert.match(html, /Metric calibrated/);
  assert.match(html, /never calibrates normalized depth/);
  assert.match(html, /Camera pixels stay on this device/);
  for (const id of ['modeControls', 'anchorDistance', 'captureAnchor', 'clearCalibration', 'virtualZ', 'entryHysteresis', 'exitHysteresis', 'probeOverlay', 'probeControls', 'clearProbes', 'probeStatus', 'depthMode', 'calibrationStatus', 'provider', 'backend', 'model', 'profiles', 'fps', 'inference', 'depthAge', 'depthValid', 'cameraSize', 'viewMode', 'lifecycle']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(script, /from '\/depth-webgpu\.js'/);
  assert.match(script, /new WebGPUMonocularDepthProvider/);
  assert.match(script, /await state\.provider\.initialize\(\)/);
  assert.match(script, /new VideoFrame\(elements\.camera, \{ timestamp \}\)/);
  assert.match(script, /void provider\.infer\(videoFrame\)/);
  assert.doesNotMatch(script, /await\s+provider\.infer/);
  assert.match(script, /result\.sourceFrameId !== sourceFrameId/);
  assert.match(script, /requestId <= state\.acceptedRequest/);
  assert.match(script, /result\.depth\.destroy\(\)/);
  assert.match(script, /provider\?\.dispose\(\)/);
  assert.match(script, /uniformBuffer\?\.destroy\(\)/);
  assert.match(script, /placeholderDepth\?\.destroy\(\)/);

  assert.match(script, /format: 'r32float'/);
  assert.match(script, /var depthTexture: texture_2d<f32>/);
  assert.match(script, /textureLoad\(depthTexture/);
  assert.match(script, /values\.depthValid < \.5/);
  assert.match(script, /values\.view < \.5 && values\.depthValid > \.5/);
  assert.match(script, /fail-closed-no-depth/);
  assert.match(script, /new Float32Array\(\[0\]\)/);
  assert.match(script, /age <= profiles\[state\.active\]\.maxDepthAgeMs/);

  assert.match(script, /from '\.\/occlusion\.js'/);
  assert.match(script, /from '\/metric-calibration\.js'/);
  assert.match(script, /captureKnownPlaneAnchor\(/);
  assert.match(script, /fitKnownPlaneCalibration\(/);
  assert.match(script, /applyKnownPlaneCalibration\(/);
  assert.match(script, /updateMetricCrossingMask\(/);
  assert.match(script, /rawInverseDepth: result\.rawInverseDepth/);
  assert.match(script, /camera-track:\$\{videoTrack\.id\}/);
  assert.match(script, /expectedSourceFrameId: result\.sourceFrameId/);
  assert.match(script, /expectedCaptureTimestamp: result\.captureTimestamp/);
  assert.match(script, /radius: 2/);
  assert.match(script, /distinctDistances < 2 \|\| distinctRaw < 2/);
  assert.match(script, /format: 'r8unorm'/);
  assert.match(script, /bytesPerRow = Math\.ceil\(width \/ 256\) \* 256/);
  assert.match(script, /queue\.writeTexture\(\{ texture \}, padded/);
  assert.match(script, /state\.metricTexture\?\.destroy\(\)/);
  assert.match(script, /clearMetricCalibration\('profile changed'\)/);
  assert.match(script, /clearMetricCalibration\('stopped'\)/);
  assert.match(script, /button\.disabled \|\| button\.dataset\.mode === state\.mode/);
  assert.match(script, /application\.representation !== 'linear-z'/);
  assert.match(script, /values\.metricMode > \.5 && relativeDepthAt\(uv\) > \.5/);
  assert.match(script, /values\.metricMode < \.5 && relativeDepthAt\(uv\) > virtualRelativeDepth/);
  assert.match(script, /sampleMetricDepthProbe\(/);
  assert.match(script, /state\.previewFlipped \? 1 - probe\.x : probe\.x/);
  assert.match(script, /metricLinearZ: application\.linearZ/);
  assert.match(script, /metricSourceFrameId === state\.depthFrame\?\.sourceFrameId/);
  assert.match(style, /\.probe-label/);
  assert.match(style, /\.controls \{[^}]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/s);
  assert.match(style, /grid-template-areas: "view view view view depth depth depth depth orientation orientation orientation orientation"/);
  assert.match(style, /@media \(max-width: 700px\)[\s\S]*grid-template-areas: "view" "depth" "calibration" "virtual" "profile" "orientation" "probes" "stop"/);
  assert.match(style, /\.control-card input \{[^}]*width: 100%;[^}]*min-width: 0;/s);
  assert.match(style, /white-space: normal; overflow-wrap: anywhere/);
  assert.match(script, /const diagnosticRelativeDepthHeadroom: f32 = \$\{DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM\}/);
  assert.match(script, /const diagnosticRelativeDepthCeiling: f32 = \$\{DIAGNOSTIC_RELATIVE_DEPTH_CEILING\}/);
  assert.match(script, /mix\(\s*diagnosticRelativeDepthHeadroom,\s*diagnosticRelativeDepthCeiling,/);
  assert.doesNotMatch(script, /relativeDepthAt\(uv\) >= virtualRelativeDepth/);

  assert.match(script, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(script, /getContext\('webgpu'\)/);
  assert.match(script, /requestAnimationFrame\(render\)/);
  assert.match(script, /stage\.classList\.toggle\('flip-x', state\.previewFlipped\)/);
  assert.match(style, /\.stage\.flip-x video, \.stage\.flip-x canvas \{ transform: scaleX\(-1\); \}/);
  assert.match(script, /device\.lost/);
  assert.match(script, /model-loading/);
  assert.match(script, /device-lost/);
  assert.match(script, /visibilitychange/);
  assert.doesNotMatch(script, /state\.boundary|fakeMetricDepth|synthetic/i);
  assert.doesNotMatch(script, /activationMs/);
});

test('diagnostic mapping leaves endpoint headroom at the sphere center and rim', () => {
  assert.equal(DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM, 0.05);
  assert.equal(DIAGNOSTIC_RELATIVE_DEPTH_CEILING, 0.95);
  const fragments = [
    { name: 'rim', sphereRelativeDepth: 0, mappedDepth: DIAGNOSTIC_RELATIVE_DEPTH_HEADROOM },
    { name: 'center', sphereRelativeDepth: 1, mappedDepth: DIAGNOSTIC_RELATIVE_DEPTH_CEILING }
  ];

  for (const fragment of fragments) {
    assert.ok(
      Math.abs(mapSphereRelativeDepthForDiagnosticOcclusion(fragment.sphereRelativeDepth) - fragment.mappedDepth) < 1e-12,
      `${fragment.name} maps to its documented diagnostic endpoint`
    );
    assert.equal(
      isDiagnosticSphereFragmentOccluded(1, fragment.sphereRelativeDepth, true),
      true,
      `nearest valid depth occludes the ${fragment.name}`
    );
    assert.equal(
      isDiagnosticSphereFragmentOccluded(0, fragment.sphereRelativeDepth, true),
      false,
      `far background does not occlude the ${fragment.name}`
    );
  }
});

test('diagnostic comparison preserves partial ordering and fails closed for invalid depth', () => {
  assert.equal(isDiagnosticSphereFragmentOccluded(0.5, 0, true), true);
  assert.equal(isDiagnosticSphereFragmentOccluded(0.5, 1, true), false);
  for (const sphereRelativeDepth of [0, 1]) {
    assert.equal(isDiagnosticSphereFragmentOccluded(1, sphereRelativeDepth, false), false);
  }
  assert.equal(isDiagnosticSphereFragmentOccluded(Number.NaN, 0, true), false);
});

test('metric crossing uses strict realZ < virtualZ with temporal entry and exit hysteresis', () => {
  assert.equal(updateMetricCrossing(false, 1.46, 1.5, 0.05, 0.1, true), false);
  assert.equal(updateMetricCrossing(false, 1.44, 1.5, 0.05, 0.1, true), true);
  assert.equal(updateMetricCrossing(true, 1.55, 1.5, 0.05, 0.1, true), true);
  assert.equal(updateMetricCrossing(true, 1.61, 1.5, 0.05, 0.1, true), false);
  assert.equal(updateMetricCrossing(true, 1, 1.5, 0.05, 0.1, false), false);
});

test('metric crossing mask preserves per-pixel temporal state and fails closed', () => {
  const entered = updateMetricCrossingMask(null, new Float32Array([1, 2, 1]), new Uint8Array([1, 1, 0]), 1.5, 0.05, 0.1);
  assert.deepEqual([...entered], [255, 0, 0]);
  const retained = updateMetricCrossingMask(entered, new Float32Array([1.55, 1, 1]), new Uint8Array([1, 1, 0]), 1.5, 0.05, 0.1);
  assert.deepEqual([...retained], [255, 255, 0]);
  assert.deepEqual([...updateMetricCrossingMask(retained, new Float32Array([2, 2, 2]), new Uint8Array([0, 0, 0]), 1.5, 0.05, 0.1)], [0, 0, 0]);
});

test('metric distance probes use a validity-aware ROI median and fail closed', () => {
  const linearZ = new Float32Array([1, 9, 3, 8, 5, 2, 7, 4, 6]);
  const validity = new Uint8Array(9).fill(1);
  const center = sampleMetricDepthProbe(linearZ, validity, 3, 3, 0.5, 0.5, 1);
  assert.deepEqual(center, { valid: true, centerX: 1, centerY: 1, sampleCount: 9, depthMeters: 5 });
  assert.deepEqual(sampleMetricDepthProbe(linearZ, validity, 3, 3, 1, 1, 0), { valid: true, centerX: 2, centerY: 2, sampleCount: 1, depthMeters: 6 });
  assert.deepEqual(sampleMetricDepthProbe(linearZ, new Uint8Array(9), 3, 3, 0.5, 0.5), { valid: false, centerX: 1, centerY: 1, sampleCount: 0 });
  assert.throws(() => sampleMetricDepthProbe(linearZ, validity, 2, 2, 0.5, 0.5), /buffers/);
  assert.throws(() => sampleMetricDepthProbe(linearZ, validity, 3, 3, -0.1, 0.5), /normalized/);
});
