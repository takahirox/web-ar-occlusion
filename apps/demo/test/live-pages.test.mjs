import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDemo } from '../../../scripts/build-demo.mjs';
import { verifyPages } from '../../../scripts/verify-pages.mjs';

test('live Pages verification requires every published file to match the build', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'live-pages-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await buildDemo(output);
  const base = 'https://example.github.io/web-ar-occlusion/';
  const published = async (url) => {
    const asset = url.pathname.split('/').at(-1) || 'index.html';
    const mime = asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'application/javascript';
    return new Response(await readFile(join(output, asset)), { headers: { 'content-type': `${mime}; charset=utf-8` } });
  };
  const result = await verifyPages(base, output, published);
  assert.equal(result.assets.length, 8);
  assert.ok(result.assets.every((asset) => asset.sha256.length === 64 && asset.status === 200));
  for (const [name, replacement, diagnostic] of [
    ['missing module', new Response('Missing', { status: 404 }), /HTTP 404/],
    ['HTML error served as JS', new Response('<html>Error</html>', { headers: { 'content-type': 'text/html' } }), /unexpected MIME/],
    ['stale deployed module', new Response('export {};', { headers: { 'content-type': 'text/javascript' } }), /content differs/]
  ]) {
    await t.test(name, async () => {
      await assert.rejects(verifyPages(base, output, (url) => url.pathname.endsWith('depth-webgpu.js')
        ? replacement : published(url)), diagnostic);
    });
  }
  await assert.rejects(verifyPages(base.replace('https:', 'http:'), output, published), /requires HTTPS/);
  await assert.rejects(verifyPages(base.slice(0, -1), output, published), /trailing slash/);
  for (const [redirectUrl, diagnostic] of [
    ['https://example.com/', /redirected away/],
    ['https://example.github.io/index.html', /escaped the project path/]
  ]) {
    const response = await published(new URL(base));
    Object.defineProperty(response, 'url', { value: redirectUrl });
    await assert.rejects(verifyPages(base, output, async () => response), diagnostic);
  }
});
