import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDemoServer } from '../../../scripts/serve-demo.mjs';

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
    for (const [path, mime] of [['/', 'text/html'], ['/style.css', 'text/css'], ['/main.js', 'text/javascript'], ['/depth-webgpu.js', 'text/javascript']]) {
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

test('UI states explicit consent, real relative depth, and fail-closed telemetry', async () => {
  const [html, script] = await Promise.all([
    readFile(resolve(root, 'index.html'), 'utf8'),
    readFile(resolve(root, 'main.js'), 'utf8')
  ]);
  assert.match(html, /id="start"[^>]*>Start camera/);
  assert.match(html, /id="stop"/);
  assert.match(html, /Occlusion/);
  assert.match(html, /No occlusion/);
  assert.match(html, /Depth view/);
  assert.match(html, /8 Hz · 320×192 · max age 250 ms/);
  assert.match(html, /12 Hz · 384×224 · max age 250 ms/);
  assert.match(html, /18 Hz · 480×270 · max age 200 ms/);
  assert.match(html, /Real relative depth/);
  assert.match(html, /not metric depth/i);
  assert.match(html, /Camera pixels stay on this device/);
  for (const id of ['provider', 'backend', 'model', 'profiles', 'fps', 'inference', 'depthAge', 'depthValid', 'cameraSize', 'viewMode', 'lifecycle']) {
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
  assert.match(script, /values\.depthValid > \.5 && relativeDepthAt\(uv\)/);
  assert.match(script, /fail-closed-no-depth/);
  assert.match(script, /new Float32Array\(\[0\]\)/);
  assert.match(script, /age <= profiles\[state\.active\]\.maxDepthAgeMs/);

  assert.match(script, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(script, /getContext\('webgpu'\)/);
  assert.match(script, /requestAnimationFrame\(render\)/);
  assert.match(script, /device\.lost/);
  assert.match(script, /model-loading/);
  assert.match(script, /device-lost/);
  assert.match(script, /visibilitychange/);
  assert.doesNotMatch(script, /state\.boundary|fakeMetricDepth|synthetic/i);
  assert.doesNotMatch(script, /activationMs/);
});
