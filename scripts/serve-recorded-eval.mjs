import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_APP_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const APP_ROOT = fileURLToPath(new URL('../apps/recorded-eval/', import.meta.url));
const PROVIDER_PATH = fileURLToPath(new URL('../packages/depth-webgpu/src/index.ts', import.meta.url));
const BUNDLE_MIME = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseArguments(argv) {
  let bundle;
  let port;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (flag !== '--bundle' && flag !== '--port')) throw new Error('usage: serve-recorded-eval.mjs --bundle DIRECTORY --port PORT');
    if (flag === '--bundle') {
      if (bundle !== undefined) throw new Error('--bundle must be provided exactly once');
      bundle = value;
    } else {
      if (port !== undefined || !/^\d+$/.test(value)) throw new Error('--port must be provided exactly once as an integer');
      port = Number(value);
    }
  }
  if (!bundle || port === undefined || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('usage: serve-recorded-eval.mjs --bundle DIRECTORY --port PORT');
  }
  return { bundle: resolve(process.cwd(), bundle), port };
}

function commonHeaders(contentType, length) {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': String(length),
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src blob:; connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co https://*.huggingface.co https://*.cdn.hf.co; img-src 'self' blob:; style-src 'unsafe-inline'; base-uri 'none'; object-src 'none'",
  };
}

function send(response, requestMethod, status, contentType, body, extra = {}) {
  response.writeHead(status, { ...commonHeaders(contentType, body.byteLength), ...extra });
  response.end(requestMethod === 'HEAD' ? undefined : body);
}

function fail(response, requestMethod, status, message, extra = {}) {
  const body = Buffer.from(`${message}\n`, 'utf8');
  send(response, requestMethod, status, 'text/plain; charset=utf-8', body, extra);
}

function decodedPath(requestUrl) {
  const raw = (requestUrl ?? '/').split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw new HttpError(400, 'malformed URL'); }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(403, 'unsafe path');
  if (decoded.split('/').some((part) => part === '.' || part === '..')) throw new HttpError(403, 'unsafe path');
  return decoded;
}

async function readBounded(path, maximum) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new HttpError(404, 'not found');
  if (metadata.size > maximum) throw new HttpError(413, 'file too large');
  return readFile(path);
}

async function assertNoSymlinks(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new HttpError(403, 'symlinks are forbidden');
  }
}

async function readBundleFile(bundleRoot, requestedPath) {
  const relativePath = requestedPath.slice('/bundle/'.length);
  if (!relativePath) throw new HttpError(404, 'not found');
  const candidate = resolve(bundleRoot, relativePath);
  const fromRoot = relative(bundleRoot, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new HttpError(403, 'unsafe path');
  const contentType = BUNDLE_MIME.get(extname(candidate).toLowerCase());
  if (!contentType) throw new HttpError(415, 'unsupported media type');
  await assertNoSymlinks(bundleRoot, fromRoot);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new HttpError(404, 'not found');
    if (metadata.size > MAX_BUNDLE_BYTES) throw new HttpError(413, 'file too large');
    return { body: await handle.readFile(), contentType };
  } finally {
    await handle.close();
  }
}

async function appResponse(path) {
  if (path === '/' || path === '/index.html') {
    return { body: await readBounded(join(APP_ROOT, 'index.html'), MAX_APP_BYTES), contentType: 'text/html; charset=utf-8' };
  }
  if (path === '/main.js') {
    return { body: await readBounded(join(APP_ROOT, 'main.js'), MAX_APP_BYTES), contentType: 'text/javascript; charset=utf-8' };
  }
  if (path === '/depth-webgpu.js') {
    const source = (await readBounded(PROVIDER_PATH, MAX_APP_BYTES)).toString('utf8');
    const transformed = Buffer.from(stripTypeScriptTypes(source, { mode: 'strip' }), 'utf8');
    if (transformed.byteLength > MAX_APP_BYTES) throw new HttpError(413, 'transformed module too large');
    return { body: transformed, contentType: 'text/javascript; charset=utf-8' };
  }
  throw new HttpError(404, 'not found');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const bundleRoot = await realpath(options.bundle);
  if (!(await stat(bundleRoot)).isDirectory()) throw new Error('--bundle must name a directory');

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? '';
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      const path = decodedPath(request.url);
      const value = path.startsWith('/bundle/')
        ? await readBundleFile(bundleRoot, path)
        : await appResponse(path);
      send(response, method, 200, value.contentType, value.body);
    })().catch((error) => {
      if (response.headersSent) return response.destroy();
      const code = error?.code;
      const status = error instanceof HttpError ? error.status
        : code === 'ENOENT' || code === 'ENOTDIR' ? 404
          : code === 'ELOOP' ? 403 : 500;
      const extra = status === 405 ? { Allow: 'GET, HEAD' } : {};
      fail(response, request.method ?? 'GET', status, status === 500 ? 'internal server error' : error.message, extra);
    });
  });

  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  process.stdout.write(`recorded-eval http://127.0.0.1:${address.port}\n`);
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
