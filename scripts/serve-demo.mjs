import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = resolve(repositoryRoot, 'apps/demo');
const depthModuleRoute = '/depth-webgpu.js';
const depthModuleSource = resolve(repositoryRoot, 'packages/depth-webgpu/src/index.ts');
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

function send(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function requestedPath(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawUrl.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  if (pathname.split('/').includes('..')) return null;
  return pathname;
}

function requestedFile(pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = resolve(demoRoot, `.${pathname}`);
  return file.startsWith(`${demoRoot}${sep}`) ? file : null;
}

async function transformedDepthModule() {
  const source = await readFile(depthModuleSource, 'utf8');
  return stripTypeScriptTypes(source, {
    mode: 'strip',
    sourceUrl: pathToFileURL(depthModuleSource).href
  });
}

export function createDemoServer() {
  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(response, 405, 'Method not allowed');
      return;
    }

    const pathname = requestedPath(request.url || '/');
    if (pathname === null) {
      send(response, 400, 'Invalid path');
      return;
    }

    if (pathname === depthModuleRoute) {
      try {
        const body = request.method === 'HEAD' ? undefined : await transformedDepthModule();
        send(response, 200, body, 'text/javascript; charset=utf-8');
      } catch {
        send(response, 500, 'Depth module transform failed');
      }
      return;
    }

    const file = requestedFile(pathname);
    if (!file) {
      send(response, 400, 'Invalid path');
      return;
    }

    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file');
      const body = request.method === 'HEAD' ? undefined : await readFile(file);
      send(response, 200, body, mimeTypes.get(extname(file).toLowerCase()) || 'application/octet-stream');
    } catch {
      send(response, 404, 'Not found');
    }
  });
}

function parsePort(argv, environment) {
  let value = environment.PORT ?? '4173';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') {
      value = argv[index + 1];
      index += 1;
    } else if (argv[index].startsWith('--port=')) {
      value = argv[index].slice(7);
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`Invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  let port;
  try {
    port = parsePort(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }

  if (port) {
    const server = createDemoServer();
    server.on('error', (error) => {
      console.error(`Demo server error: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Real relative-depth WebGPU demo: http://127.0.0.1:${port}/`);
    });

    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      server.close((error) => {
        if (error) {
          console.error(`Shutdown error: ${error.message}`);
          process.exitCode = 1;
        }
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
