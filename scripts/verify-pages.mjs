import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicUrl = 'https://takahirox.github.io/web-ar-occlusion/';
const assets = [
  'index.html', 'style.css', 'main.js', 'occlusion.js', 'depth-webgpu.js',
  'metric-calibration.js', 'metric-distance-state.js', 'metric-scale-shift-refiner.js'
];
const sha256 = (body) => createHash('sha256').update(body).digest('hex');

// Compare the live site with a build of the commit being deployed. This checks
// publication and static paths, not browser permissions or inference sessions.
export async function verifyPages(baseUrl, outputDirectory, fetchResponse = fetch) {
  const base = new URL(baseUrl);
  assert.equal(base.protocol, 'https:', 'Pages verification requires HTTPS');
  assert.ok(base.pathname.endsWith('/'), 'Pages URL must include a trailing slash');
  const results = [];
  for (const asset of assets) {
    const url = new URL(asset === 'index.html' ? './' : asset, base);
    const expected = await readFile(resolve(outputDirectory, asset));
    const response = await fetchResponse(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
    const finalUrl = new URL(response.url || url);
    assert.equal(finalUrl.origin, base.origin, `${url}: redirected away from the Pages origin`);
    assert.ok(finalUrl.pathname.startsWith(base.pathname), `${url}: escaped the project path`);
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const expectedMimes = asset.endsWith('.html') ? ['text/html'] : asset.endsWith('.css')
      ? ['text/css'] : ['text/javascript', 'application/javascript'];
    assert.ok(expectedMimes.includes(mime), `${url}: unexpected MIME type ${mime}`);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(body), sha256(expected), `${url}: content differs from this commit's build`);
    results.push({ asset, status: response.status, mime, bytes: body.length, sha256: sha256(body) });
  }
  return { checkedAt: new Date().toISOString(), url: base.href, assets: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [baseUrl = publicUrl, outputDirectory = resolve(repositoryRoot, 'dist/demo')] = process.argv.slice(2);
  // Pages/CDN propagation can lag a successful deployment. CI opts into bounded
  // retries; a standalone check makes one attempt and reports failures directly.
  const attempts = Number(process.env.PAGES_VERIFY_ATTEMPTS ?? 1);
  assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= 12, 'PAGES_VERIFY_ATTEMPTS must be 1–12');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await verifyPages(baseUrl, outputDirectory);
      result.commitSha = process.env.GITHUB_SHA ?? null;
      result.workflowRunUrl = process.env.GITHUB_RUN_ID
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
      console.log(JSON.stringify(result, null, 2));
      break;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.error(`Pages verification attempt ${attempt}/${attempts}: ${error.message}`);
      await new Promise((done) => setTimeout(done, 5000));
    }
  }
}
