import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  bundleUrl,
  createPredictionDocument,
  nearestResample,
  validateCorpus,
  validateModelDepth,
} from '../main.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const serverPath = join(repositoryRoot, 'scripts/serve-recorded-eval.mjs');

async function startServer(bundle) {
  const child = spawn(process.execPath, [serverPath, '--bundle', bundle, '--port', '0'], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timed out: ${stderr}`)), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
    child.once('error', reject);
  });
  return { child, url };
}

function rawRequest(url, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({ hostname: target.hostname, port: target.port, method, path }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('server isolates routes and enforces MIME, HEAD, method, traversal, and symlink policy', async () => {
  const bundle = await mkdtemp(join(tmpdir(), 'recorded-eval-'));
  await mkdir(join(bundle, 'sources', 'rgb'), { recursive: true });
  await writeFile(join(bundle, 'corpus.json'), '{"schemaVersion":1}', 'utf8');
  await writeFile(join(bundle, 'sources', 'rgb', 'frame.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(bundle, 'unsupported.txt'), 'no');
  await symlink(join(repositoryRoot, 'package.json'), join(bundle, 'escape.json'));
  const { child, url } = await startServer(bundle);
  try {
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');

    const script = await fetch(`${url}/main.js`);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);
    const provider = await fetch(`${url}/depth-webgpu.js`);
    assert.equal(provider.status, 200);
    assert.match(provider.headers.get('content-type'), /^text\/javascript/);
    assert.doesNotMatch(await provider.text(), /export type /);

    const corpus = await fetch(`${url}/bundle/corpus.json`);
    assert.equal(corpus.status, 200);
    assert.match(corpus.headers.get('content-type'), /^application\/json/);
    const image = await fetch(`${url}/bundle/sources/rgb/frame.png`);
    assert.match(image.headers.get('content-type'), /^image\/png/);

    const head = await fetch(`${url}/bundle/corpus.json`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('{"schemaVersion":1}')));

    assert.equal((await fetch(`${url}/package.json`)).status, 404);
    assert.equal((await fetch(`${url}/bundle/sources/`)).status, 415);
    assert.equal((await fetch(`${url}/bundle/unsupported.txt`)).status, 415);
    assert.equal((await fetch(`${url}/bundle/escape.json`)).status, 403);
    assert.equal((await rawRequest(url, '/bundle/%2e%2e/package.json')).status, 403);
    const method = await rawRequest(url, '/bundle/corpus.json', 'POST');
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'GET, HEAD');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(bundle, { recursive: true, force: true });
  }
});

test('browser helpers preserve corpus association, dimensions, order, and exact source paths', () => {
  const corpus = validateCorpus({
    schemaVersion: 1,
    kind: 'quality-corpus-manifest',
    provenance: 'recorded-rgbd',
    sources: [
      { id: 'source-b', metadata: { rgbPath: 'sources/rgb/b.png' } },
      { id: 'source-a', metadata: { rgbPath: 'sources/rgb/a.jpg' } },
    ],
    samples: [
      { id: 'frame-b', sourceId: 'source-b' },
      { id: 'frame-a', sourceId: 'source-a' },
    ],
  });
  assert.deepEqual(corpus, [
    { sourceFrameId: 'frame-b', rgbPath: 'sources/rgb/b.png' },
    { sourceFrameId: 'frame-a', rgbPath: 'sources/rgb/a.jpg' },
  ]);
  assert.equal(bundleUrl(corpus[0].rgbPath), '/bundle/sources/rgb/b.png');
  assert.throws(() => bundleUrl('../outside.png'), /unsafe/);
  assert.throws(() => validateCorpus({ schemaVersion: 1, kind: 'quality-corpus-manifest', provenance: 'recorded-rgbd', sources: [], samples: [] }), /quality corpus/);
});

test('raw finite near-is-larger model values are nearest-resampled without confidence', () => {
  const raw = validateModelDepth({ data: [-1, 0], width: 2, height: 1, orientation: 'near-is-larger' });
  assert.deepEqual(Array.from(nearestResample(raw.values, 2, 1, 4, 2)), [-1, -1, 0, 0, -1, -1, 0, 0]);
  assert.throws(() => validateModelDepth({ data: [Number.NaN], width: 1, height: 1, orientation: 'near-is-larger' }), /finite values/);
  assert.throws(() => validateModelDepth({ data: [1], width: 1, height: 1, orientation: 'near-is-smaller' }), /metadata/);
  const output = createPredictionDocument([
    { sourceFrameId: 'frame-b', width: 2, height: 1, relativeInverseDepth: raw.values },
  ], 'pinned-runtime', '2026-01-01T00:00:00.000Z');
  assert.deepEqual(output.frames[0], { id: 'frame-b', width: 2, height: 1, inverseDepth: [-1, 0] });
  assert.equal('confidence' in output.frames[0], false);
  assert.equal(output.kind, 'web-ar-occlusion-relative-inverse-depth');
});

test('browser source pins the production runtime and exposes only completed automation output', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.js'), 'utf8');
  assert.match(source, /createTransformersDepthRuntime\(\)/);
  assert.match(source, /model: module\.DEPTH_MODEL_ID/);
  assert.match(source, /revision: module\.DEPTH_MODEL_REVISION/);
  assert.match(source, /device: 'webgpu'/);
  assert.match(source, /dtype: module\.DEPTH_MODEL_DTYPE/);
  assert.match(source, /globalThis\.__recordedEvalResult = result/);
  assert.match(source, /Development observation only; no benchmark result/);
});
