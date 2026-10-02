import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDemo } from '../../../scripts/build-demo.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

test('static build serves its complete asset/module graph under root and Pages project paths', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'occlusion-pages-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const output = join(temporaryRoot, 'site');
  await buildDemo(output);
  // Rebuilds must not publish files left behind by an earlier build.
  await writeFile(join(output, 'stale.js'), 'throw new Error("stale artifact")');
  await buildDemo(output);
  assert.deepEqual((await readdir(output)).sort(), [
    'depth-webgpu.js', 'index.html', 'main.js', 'metric-calibration.js',
    'metric-distance-state.js', 'metric-scale-shift-refiner.js', 'occlusion.js', 'style.css'
  ]);

  for (const prefix of ['/', '/web-ar-occlusion/']) {
    // Plain static hosting: no TypeScript transforms or special module routes.
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const filename = pathname.slice(prefix.length) || 'index.html';
      try {
        const body = await readFile(join(output, filename));
        response.writeHead(200, { 'Content-Type': mimeTypes[extname(filename)] }).end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const base = new URL(`http://127.0.0.1:${server.address().port}${prefix}`);
      const pending = [base];
      const visited = new Set();
      while (pending.length) {
        const url = pending.pop();
        if (visited.has(url.href)) continue;
        visited.add(url.href);
        assert.ok(url.pathname.startsWith(prefix), `${url} escaped the deployment subpath`);
        const response = await fetch(url);
        assert.equal(response.status, 200, `missing deployed asset: ${url}`);
        const body = await response.text();
        const extension = extname(url.pathname) || '.html';
        assert.equal(response.headers.get('content-type'), mimeTypes[extension]);
        let references = [];
        if (extension === '.html') {
          references = [...body.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
        } else if (extension === '.css') {
          references = [...body.matchAll(/url\(\s*['"]?([^'"\s)]+)/g)].map((match) => match[1]);
        } else if (extension === '.js') {
          const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: body, encoding: 'utf8' });
          assert.equal(syntax.status, 0, `${url}: ${syntax.stderr}`);
          assert.doesNotMatch(body, /(?:file:\/\/|sourceURL=|export (?:type|interface)\b)/);
          references = [...body.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/g)].map((match) => match[1]);
          // Resolve all named imports as real JavaScript exports as well.
          for (const match of body.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
            const exports = await import(pathToFileURL(join(output, match[2])).href);
            for (const binding of match[1].split(',')) {
              const name = binding.trim().split(/\s+as\s+/)[0];
              if (name) assert.ok(name in exports, `${match[2]} does not export ${name}`);
            }
          }
        }
        for (const reference of references) {
          if (/^(?:https?:|data:)/.test(reference)) continue;
          assert.ok(reference.startsWith('./') || reference.startsWith('../'), `non-relative deployment path: ${reference}`);
          pending.push(new URL(reference, url));
        }
      }
      assert.equal(visited.size, 8, 'HTML reaches every required static asset and module');
      if (prefix !== '/') {
        assert.equal((await fetch(new URL('/depth-webgpu.js', base))).status, 404);
      }
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
});

test('published provider preserves runtime/model pins and the existing module implementations', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'occlusion-pages-modules-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const output = await buildDemo(join(temporaryRoot, 'site'));
  for (const [asset, sourcePath] of [
    ['depth-webgpu.js', 'packages/depth-webgpu/src/index.ts'],
    ['metric-calibration.js', 'packages/core/src/metric-calibration.ts'],
    ['metric-distance-state.js', 'packages/core/src/metric-distance-state.ts'],
    ['metric-scale-shift-refiner.js', 'packages/core/src/metric-scale-shift-refiner.ts']
  ]) {
    const source = await readFile(resolve(repositoryRoot, sourcePath), 'utf8');
    assert.equal(await readFile(join(output, asset), 'utf8'), stripTypeScriptTypes(source, { mode: 'strip' }));
  }
  for (const asset of ['index.html', 'main.js', 'style.css', 'occlusion.js']) {
    assert.deepEqual(await readFile(join(output, asset)), await readFile(resolve(repositoryRoot, 'apps/demo', asset)));
  }
  const built = await import(pathToFileURL(join(output, 'depth-webgpu.js')).href);
  const source = await import(pathToFileURL(resolve(repositoryRoot, 'packages/depth-webgpu/src/index.ts')).href);
  for (const name of [
    'ONNX_RUNTIME_WEBGPU_ESM_URL', 'TRANSFORMERS_JS_ESM_URL', 'METRIC_DEPTH_MODEL_URL',
    'METRIC_DEPTH_MODEL_SHA256', 'METRIC_DEPTH_MODEL_REVISION', 'DEPTH_MODEL_ID', 'DEPTH_MODEL_REVISION', 'DEPTH_MODEL_DTYPE'
  ]) {
    assert.ok(source[name], `missing dependency pin ${name}`);
    assert.equal(built[name], source[name]);
  }
});
