import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = resolve(repositoryRoot, 'apps/demo');
const defaultOutput = resolve(repositoryRoot, 'dist/demo');

// Publish only the demo and the four modules exposed by the local demo server.
const modules = [
  ['depth-webgpu.js', 'packages/depth-webgpu/src/index.ts'],
  ['metric-calibration.js', 'packages/core/src/metric-calibration.ts'],
  ['metric-distance-state.js', 'packages/core/src/metric-distance-state.ts'],
  ['metric-scale-shift-refiner.js', 'packages/core/src/metric-scale-shift-refiner.ts']
];

export async function buildDemo(outputDirectory = defaultOutput) {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const asset of ['index.html', 'style.css', 'main.js', 'occlusion.js']) {
    await copyFile(resolve(demoRoot, asset), resolve(outputDirectory, asset));
  }
  for (const [filename, sourcePath] of modules) {
    const source = await readFile(resolve(repositoryRoot, sourcePath), 'utf8');
    // No sourceURL: do not publish local filesystem paths in the artifact.
    const javascript = stripTypeScriptTypes(source, { mode: 'strip' });
    await writeFile(resolve(outputDirectory, filename), javascript);
  }
  return outputDirectory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildDemo();
  console.log('Static demo built in dist/demo');
}
