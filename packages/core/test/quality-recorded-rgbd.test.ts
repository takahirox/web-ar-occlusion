import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { validateCorpusManifest } from "../src/quality-governance.ts";
import { evaluateQuality, getQualityMetric } from "../src/quality.ts";
import { associateTimestamps, decodeTumDepthPng, evenlySpacedIndices } from "../src/recorded-rgbd-cli.ts";

const CLI = fileURLToPath(new URL("../src/recorded-rgbd-cli.ts", import.meta.url));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    table[value] = current >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(width: number, height: number, bitDepth: number, colorType: number, rows: Buffer, interlace = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  header[12] = interlace;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function depthPng(values: number[], interlace = 0): Buffer {
  const rows = Buffer.alloc(2 * (1 + values.length));
  rows[0] = 0;
  rows[5] = 0;
  for (let index = 0; index < values.length; index += 1) rows.writeUInt16BE(values[index]!, (index < 2 ? 1 : 2) + index * 2);
  return png(2, 2, 16, 0, rows, interlace);
}

function rgbPng(): Buffer {
  const rows = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  return png(2, 2, 8, 2, rows);
}

async function fixture(root: string, badDepth = false): Promise<string> {
  const dataset = join(root, badDepth ? "bad-dataset" : "dataset");
  await mkdir(join(dataset, "rgb"), { recursive: true });
  await mkdir(join(dataset, "depth"), { recursive: true });
  await writeFile(join(dataset, "rgb.txt"), "0.000 rgb/0.png\n1.000 rgb/1.png\n2.000 rgb/2.png\n");
  await writeFile(join(dataset, "depth.txt"), "0.010 depth/0.png\n0.990 depth/1.png\n2.040 depth/2.png\n");
  for (let index = 0; index < 3; index += 1) {
    await writeFile(join(dataset, "rgb", `${index}.png`), rgbPng());
    await writeFile(join(dataset, "depth", `${index}.png`), depthPng([5000 + index * 1000, 10000 + index * 1000, index === 0 ? 0 : 15000, 20000], badDepth));
  }
  return dataset;
}

function run(cwd: string, dataset: string, output: string, predictions?: string) {
  const args = [CLI, "--dataset", dataset, "--output", output, "--max-delta-ms", "50", "--frames", "2", "--occlusion-quantile", "0.5"];
  if (predictions !== undefined) args.push("--predictions", predictions);
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}

test("nearest association and evenly spaced selection are deterministic", () => {
  const pairs = associateTimestamps(
    [{ timestamp: 1, path: "rgb.png" }],
    [{ timestamp: 1.25, path: "later.png" }, { timestamp: 0.75, path: "earlier.png" }],
    0.25,
  );
  assert.equal(pairs[0]!.depth.path, "earlier.png");
  assert.deepEqual(evenlySpacedIndices(7, 3), [0, 3, 6]);
  assert.deepEqual(evenlySpacedIndices(6, 1), [2]);
});

test("16-bit grayscale PNG decoding preserves TUM zero-unknown samples and rejects interlacing", () => {
  assert.deepEqual([...decodeTumDepthPng(depthPng([5000, 0, 1234, 65535])).samples], [5000, 0, 1234, 65535]);
  assert.throws(() => decodeTumDepthPng(depthPng([1, 2, 3, 4], 1)), /non-interlaced/);
  const colorized = png(1, 1, 8, 2, Buffer.from([0, 1, 2, 3]));
  assert.throws(() => decodeTumDepthPng(colorized), /16-bit grayscale/);
});

test("CLI emits a verified corpus and validity-aware quality input with digest-bound review files", async () => {
  const root = await mkdtemp(join(tmpdir(), "recorded-rgbd-"));
  try {
    const dataset = await fixture(root);
    const predictions = join(root, "predictions.json");
    await writeFile(predictions, JSON.stringify({
      schemaVersion: 1,
      kind: "web-ar-occlusion-relative-inverse-depth",
      evaluatedAt: "2026-09-02T00:00:00.000Z",
      implementationId: "fixture-relative-depth",
      frames: [
        { id: "frame-0000", width: 2, height: 2, inverseDepth: [4, 2, null, 1] },
        { id: "frame-0001", width: 2, height: 2, inverseDepth: [4, 3, 2, 1] },
      ],
    }));
    const result = run(root, dataset, "bundle", predictions);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.scoresProduced, false);
    const corpus = JSON.parse(await readFile(join(root, "bundle", "corpus.json"), "utf8"));
    assert.doesNotThrow(() => validateCorpusManifest(corpus));
    assert.equal(corpus.provenance, "recorded-rgbd");
    const input = JSON.parse(await readFile(join(root, "bundle", "quality-input.json"), "utf8"));
    assert.equal(input.depthScale, "relative");
    assert.deepEqual(input.frames[0].validityMask, [1, 1, 0, 1]);
    assert.equal(input.frames[0].referenceDepth[2], null);
    assert.equal(input.reviewItems.length, 10);
    const artifact = evaluateQuality(input);
    assert.equal(artifact.claims.benchmark, false);
    assert.equal(getQualityMetric(artifact, "depth.mae.m").status, "missing");
    assert.equal(getQualityMetric(artifact, "depth.abs-relative").status, "known");
    for (const item of input.reviewItems) {
      assert.equal(item.uri.startsWith("bundle/"), true);
      const bytes = await readFile(join(root, item.uri));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preparation without predictions emits no evaluation input or fabricated score", async () => {
  const root = await mkdtemp(join(tmpdir(), "recorded-rgbd-manifest-"));
  try {
    const dataset = await fixture(root);
    const result = run(root, dataset, "manifest-only");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).qualityInput, null);
    await access(join(root, "manifest-only", "corpus.json"));
    await assert.rejects(access(join(root, "manifest-only", "quality-input.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rejects unsupported depth representations and traversal before creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "recorded-rgbd-reject-"));
  try {
    const dataset = await fixture(root, true);
    const interlaced = run(root, dataset, "bad-output");
    assert.notEqual(interlaced.status, 0);
    await assert.rejects(access(join(root, "bad-output")));
    await writeFile(join(dataset, "depth.txt"), "0.010 ../outside.png\n");
    const traversal = run(root, dataset, "traversal-output");
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /unsafe path component/);
    await assert.rejects(access(join(root, "traversal-output")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
