import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { createCorpusManifest } from "./quality-governance.ts";
import { canonicalJson, sha256Canonical, type EvaluationFrame, type QualityEvaluationInput, type ReviewItem } from "./quality.ts";

const MAX_FRAMES = 10;
const MAX_SIDE = 4096;
const MAX_FRAME_PIXELS = 4_194_304;
const MAX_TOTAL_PIXELS = 16_777_216;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ASSOCIATION_BYTES = 4 * 1024 * 1024;
const MAX_PREDICTION_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const DEPTH_FACTOR = 5000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type TimestampEntry = { timestamp: number; path: string };
export type TimestampPair = { rgb: TimestampEntry; depth: TimestampEntry; deltaSeconds: number };
type Options = { dataset: string; output: string; maximumDeltaMs: number; frameCount: number; quantile: number; predictions?: string };
type PreparedFrame = {
  id: string;
  pair: TimestampPair;
  width: number;
  height: number;
  depth: Uint16Array;
  rgbBytes: Buffer;
  depthBytes: Buffer;
  rgbExtension: "png" | "jpg";
  rgbDigest: string;
  depthDigest: string;
};
type PredictionFrame = { id: string; width: number; height: number; inverseDepth: Array<number | null> };
type PredictionDocument = {
  schemaVersion: 1;
  kind: "web-ar-occlusion-relative-inverse-depth";
  evaluatedAt: string;
  implementationId: string;
  frames: PredictionFrame[];
};
type OutputFile = { path: string; bytes: Buffer };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function safeRelativePath(value: string, label: string): string {
  invariant(value.length > 0 && !isAbsolute(value) && !value.includes("\\"), `${label} must be a repository-relative POSIX path`);
  const parts = value.split("/");
  invariant(parts.every((part) => part.length > 0 && part !== "." && part !== ".."), `${label} contains an unsafe path component`);
  return parts.join("/");
}

function numberOption(value: string | undefined, label: string): number {
  invariant(value !== undefined && value.trim() !== "", `${label} is required`);
  const parsed = Number(value);
  invariant(Number.isFinite(parsed), `${label} must be finite`);
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  const allowed = new Set(["--dataset", "--output", "--max-delta-ms", "--frames", "--occlusion-quantile", "--predictions"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(key !== undefined && allowed.has(key) && value !== undefined, "usage: recorded-rgbd-cli.ts --dataset DIR --output REPOSITORY_RELATIVE_DIR --max-delta-ms N --frames N --occlusion-quantile Q [--predictions FILE]");
    invariant(!values.has(key), `duplicate option ${key}`);
    values.set(key, value);
  }
  const dataset = values.get("--dataset");
  const output = values.get("--output");
  invariant(dataset !== undefined && dataset.length > 0, "--dataset is required");
  invariant(output !== undefined, "--output is required");
  const maximumDeltaMs = numberOption(values.get("--max-delta-ms"), "--max-delta-ms");
  const frameCount = numberOption(values.get("--frames"), "--frames");
  const quantile = numberOption(values.get("--occlusion-quantile"), "--occlusion-quantile");
  invariant(maximumDeltaMs >= 0 && maximumDeltaMs <= 1000, "--max-delta-ms must be in [0,1000]");
  invariant(Number.isInteger(frameCount) && frameCount >= 1 && frameCount <= MAX_FRAMES, `--frames must be an integer in [1,${MAX_FRAMES}]`);
  invariant(quantile > 0 && quantile < 1, "--occlusion-quantile must be in (0,1)");
  const predictions = values.get("--predictions");
  return { dataset, output: safeRelativePath(output, "--output"), maximumDeltaMs, frameCount, quantile, ...(predictions === undefined ? {} : { predictions }) };
}

function compareEntry(left: TimestampEntry, right: TimestampEntry): number {
  return left.timestamp - right.timestamp || left.path.localeCompare(right.path, "en");
}

function parseTimestampFile(text: string, label: string): TimestampEntry[] {
  const entries: TimestampEntry[] = [];
  for (const [lineIndex, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    invariant(fields.length === 2, `${label}:${lineIndex + 1} must contain exactly a timestamp and path`);
    const timestamp = Number(fields[0]);
    invariant(Number.isFinite(timestamp) && timestamp >= 0, `${label}:${lineIndex + 1} has an invalid timestamp`);
    entries.push({ timestamp, path: safeRelativePath(fields[1]!, `${label}:${lineIndex + 1} path`) });
  }
  invariant(entries.length > 0, `${label} contains no entries`);
  invariant(new Set(entries.map((entry) => entry.path)).size === entries.length, `${label} contains duplicate paths`);
  return entries.sort(compareEntry);
}

export function associateTimestamps(rgb: TimestampEntry[], depth: TimestampEntry[], maximumDeltaSeconds: number): TimestampPair[] {
  invariant(Number.isFinite(maximumDeltaSeconds) && maximumDeltaSeconds >= 0, "maximum association delta must be non-negative");
  const candidates: TimestampPair[] = [];
  for (const rgbEntry of rgb) {
    for (const depthEntry of depth) {
      const deltaSeconds = Math.abs(rgbEntry.timestamp - depthEntry.timestamp);
      if (deltaSeconds <= maximumDeltaSeconds) candidates.push({ rgb: rgbEntry, depth: depthEntry, deltaSeconds });
    }
  }
  candidates.sort((left, right) => left.deltaSeconds - right.deltaSeconds || compareEntry(left.rgb, right.rgb) || compareEntry(left.depth, right.depth));
  const usedRgb = new Set<string>();
  const usedDepth = new Set<string>();
  const selected: TimestampPair[] = [];
  for (const candidate of candidates) {
    if (usedRgb.has(candidate.rgb.path) || usedDepth.has(candidate.depth.path)) continue;
    usedRgb.add(candidate.rgb.path);
    usedDepth.add(candidate.depth.path);
    selected.push(candidate);
  }
  return selected.sort((left, right) => compareEntry(left.rgb, right.rgb) || compareEntry(left.depth, right.depth));
}

export function evenlySpacedIndices(total: number, requested: number): number[] {
  invariant(Number.isInteger(total) && total > 0, "total must be a positive integer");
  invariant(Number.isInteger(requested) && requested > 0, "requested must be a positive integer");
  const count = Math.min(total, requested);
  if (count === total) return Array.from({ length: total }, (_, index) => index);
  if (count === 1) return [Math.floor((total - 1) / 2)];
  return Array.from({ length: count }, (_, index) => Math.round(index * (total - 1) / (count - 1)));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const result = relative(root, candidate);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

async function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const info = await lstat(path);
  invariant(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  invariant(info.size <= maximumBytes, `${label} exceeds ${maximumBytes} bytes`);
  return readFile(path);
}

async function readDatasetFile(root: string, canonicalRoot: string, relativePath: string, maximumBytes: number, label: string): Promise<Buffer> {
  const parts = safeRelativePath(relativePath, label).split("/");
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    const info = await lstat(current);
    invariant(!info.isSymbolicLink(), `${label} contains a symbolic link`);
  }
  const canonical = await realpath(current);
  invariant(isWithin(canonicalRoot, canonical), `${label} escapes the dataset directory`);
  return readBoundedRegularFile(canonical, maximumBytes, label);
}

async function validateOutputTarget(repositoryRoot: string, output: string): Promise<string> {
  const target = resolve(repositoryRoot, ...output.split("/"));
  invariant(isWithin(repositoryRoot, target) && target !== repositoryRoot, "--output escapes the repository");
  let current = repositoryRoot;
  for (const part of output.split("/")) {
    current = resolve(current, part);
    const info = await lstatOrNull(current);
    if (info === null) break;
    invariant(!info.isSymbolicLink(), "--output contains a symbolic link");
    invariant(info.isDirectory(), "--output has a non-directory parent");
  }
  invariant(await lstatOrNull(target) === null, "--output already exists");
  return target;
}

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

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function decodeTumDepthPng(bytes: Buffer): { width: number; height: number; samples: Uint16Array } {
  invariant(bytes.subarray(0, 8).equals(PNG_SIGNATURE), "depth file is not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    invariant(offset + 12 <= bytes.length, "truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    invariant(dataEnd + 4 <= bytes.length, "truncated PNG chunk data");
    const type = bytes.toString("ascii", typeStart, dataStart);
    invariant(crc32(bytes.subarray(typeStart, dataEnd)) === bytes.readUInt32BE(dataEnd), `PNG ${type} CRC mismatch`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      invariant(!sawHeader && length === 13 && compressed.length === 0, "invalid PNG IHDR ordering");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      invariant(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_FRAME_PIXELS, "depth PNG dimensions exceed bounds");
      invariant(data[8] === 16 && data[9] === 0, "depth PNG must be 16-bit grayscale, not colorized depth");
      invariant(data[10] === 0 && data[11] === 0 && data[12] === 0, "depth PNG must use standard compression/filtering and be non-interlaced");
      sawHeader = true;
    } else if (type === "IDAT") {
      invariant(sawHeader && !sawEnd, "invalid PNG IDAT ordering");
      compressed.push(data);
    } else if (type === "IEND") {
      invariant(length === 0 && sawHeader && compressed.length > 0, "invalid PNG IEND");
      sawEnd = true;
      offset = dataEnd + 4;
      break;
    } else if ((bytes[typeStart]! & 0x20) === 0) {
      throw new TypeError(`unsupported critical PNG chunk ${type}`);
    }
    offset = dataEnd + 4;
  }
  invariant(sawEnd && offset === bytes.length, "PNG is missing IEND or has trailing bytes");
  const rowBytes = width * 2;
  const expected = (rowBytes + 1) * height;
  const inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  invariant(inflated.length === expected, "depth PNG decompressed size mismatch");
  const reconstructed = Buffer.alloc(rowBytes * height);
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[source++]!;
    invariant(filter <= 4, "unsupported PNG row filter");
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = inflated[source++]!;
      const left = column >= 2 ? reconstructed[rowOffset + column - 2]! : 0;
      const above = row > 0 ? reconstructed[rowOffset - rowBytes + column]! : 0;
      const upperLeft = row > 0 && column >= 2 ? reconstructed[rowOffset - rowBytes + column - 2]! : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      reconstructed[rowOffset + column] = (raw + prediction) & 0xff;
    }
  }
  const samples = new Uint16Array(width * height);
  for (let index = 0; index < samples.length; index += 1) samples[index] = reconstructed.readUInt16BE(index * 2);
  return { width, height, samples };
}

function rgbDimensions(bytes: Buffer): { width: number; height: number; extension: "png" | "jpg" } {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    invariant(bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR", "RGB PNG has an invalid header");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    invariant(width > 0 && height > 0, "RGB PNG has invalid dimensions");
    return { width, height, extension: "png" };
  }
  invariant(bytes[0] === 0xff && bytes[1] === 0xd8, "RGB source must be PNG or JPEG");
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 <= bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    invariant(offset + 2 <= bytes.length, "truncated JPEG marker");
    const length = bytes.readUInt16BE(offset);
    invariant(length >= 2 && offset + length <= bytes.length, "invalid JPEG marker length");
    if (sof.has(marker)) {
      invariant(length >= 8, "invalid JPEG frame header");
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), extension: "jpg" };
    }
    offset += length;
  }
  throw new TypeError("JPEG has no supported frame header");
}

function pgm(width: number, height: number, pixels: Uint8Array): Buffer {
  invariant(pixels.length === width * height, "PGM pixel length mismatch");
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii"), Buffer.from(pixels)]);
}

function depthVisualization(depth: Uint16Array): Uint8Array {
  const output = new Uint8Array(depth.length);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of depth) {
    if (value > 0) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  }
  if (!Number.isFinite(minimum)) return output;
  for (let index = 0; index < depth.length; index += 1) {
    const value = depth[index]!;
    if (value > 0) output[index] = minimum === maximum ? 255 : Math.round(255 * (maximum - value) / (maximum - minimum));
  }
  return output;
}

function parsePredictions(value: unknown, prepared: PreparedFrame[]): PredictionDocument {
  record(value, "predictions");
  invariant(value.schemaVersion === 1 && value.kind === "web-ar-occlusion-relative-inverse-depth", "unsupported predictions document");
  invariant(typeof value.evaluatedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.evaluatedAt) && Number.isFinite(Date.parse(value.evaluatedAt)), "predictions.evaluatedAt must be a UTC ISO timestamp");
  invariant(typeof value.implementationId === "string" && value.implementationId.length > 0, "predictions.implementationId must be non-empty");
  invariant(Array.isArray(value.frames) && value.frames.length === prepared.length, "predictions must contain exactly one frame per selected corpus sample");
  const expected = new Map(prepared.map((frame) => [frame.id, frame]));
  const frames: PredictionFrame[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.frames.entries()) {
    record(item, `predictions.frames[${index}]`);
    invariant(typeof item.id === "string" && expected.has(item.id) && !ids.has(item.id), `predictions.frames[${index}].id is unknown or duplicated`);
    ids.add(item.id);
    const source = expected.get(item.id)!;
    invariant(item.width === source.width && item.height === source.height, `prediction ${item.id} dimensions do not match TUM depth`);
    invariant(Array.isArray(item.inverseDepth) && item.inverseDepth.length === source.width * source.height, `prediction ${item.id} inverseDepth length mismatch`);
    const inverseDepth = item.inverseDepth.map((sample, sampleIndex) => {
      if (sample === null) return null;
      invariant(typeof sample === "number" && Number.isFinite(sample), `prediction ${item.id} inverseDepth[${sampleIndex}] must be null or finite raw inverse depth`);
      return sample;
    });
    frames.push({ id: item.id, width: source.width, height: source.height, inverseDepth });
  }
  frames.sort((left, right) => prepared.findIndex((item) => item.id === left.id) - prepared.findIndex((item) => item.id === right.id));
  return { schemaVersion: 1, kind: "web-ar-occlusion-relative-inverse-depth", evaluatedAt: value.evaluatedAt, implementationId: value.implementationId, frames };
}

function reviewItem(id: string, uri: string, bytes: Buffer, frameId: string): ReviewItem {
  return { id, kind: "image", uri, sha256: sha256Bytes(bytes), frameId };
}

function addReview(outputs: OutputFile[], reviews: ReviewItem[], outputRoot: string, frame: PreparedFrame, relativePath: string, bytes: Buffer, suffix: string): void {
  outputs.push({ path: relativePath, bytes });
  reviews.push(reviewItem(`${frame.id}-${suffix}`, `${outputRoot}/${relativePath}`, bytes, frame.id));
}

async function writeOutputs(root: string, files: OutputFile[]): Promise<void> {
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  invariant(total <= MAX_OUTPUT_BYTES, `bundle exceeds ${MAX_OUTPUT_BYTES} bytes`);
  invariant(new Set(files.map((file) => file.path)).size === files.length, "bundle contains duplicate output paths");
  await mkdir(root, { recursive: true });
  for (const file of files) {
    safeRelativePath(file.path, "generated output path");
    const destination = resolve(root, ...file.path.split("/"));
    invariant(isWithin(root, destination), "generated output escapes bundle");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.bytes, { flag: "wx" });
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  const repositoryRoot = await realpath(process.cwd());
  const outputTarget = await validateOutputTarget(repositoryRoot, options.output);
  const datasetInfo = await lstat(options.dataset);
  invariant(datasetInfo.isDirectory() && !datasetInfo.isSymbolicLink(), "--dataset must be a non-symlink directory");
  const datasetRoot = resolve(options.dataset);
  const canonicalDatasetRoot = await realpath(datasetRoot);
  const rgbTextBytes = await readDatasetFile(datasetRoot, canonicalDatasetRoot, "rgb.txt", MAX_ASSOCIATION_BYTES, "rgb.txt");
  const depthTextBytes = await readDatasetFile(datasetRoot, canonicalDatasetRoot, "depth.txt", MAX_ASSOCIATION_BYTES, "depth.txt");
  const pairs = associateTimestamps(parseTimestampFile(rgbTextBytes.toString("utf8"), "rgb.txt"), parseTimestampFile(depthTextBytes.toString("utf8"), "depth.txt"), options.maximumDeltaMs / 1000);
  invariant(pairs.length > 0, "no RGB/depth pairs are within --max-delta-ms");
  const selected = evenlySpacedIndices(pairs.length, options.frameCount).map((index) => pairs[index]!);
  const prepared: PreparedFrame[] = [];
  let totalPixels = 0;
  for (const [index, pair] of selected.entries()) {
    const rgbBytes = await readDatasetFile(datasetRoot, canonicalDatasetRoot, pair.rgb.path, MAX_SOURCE_BYTES, `RGB ${pair.rgb.path}`);
    const depthBytes = await readDatasetFile(datasetRoot, canonicalDatasetRoot, pair.depth.path, MAX_SOURCE_BYTES, `depth ${pair.depth.path}`);
    const decoded = decodeTumDepthPng(depthBytes);
    const rgb = rgbDimensions(rgbBytes);
    invariant(rgb.width === decoded.width && rgb.height === decoded.height, `RGB/depth dimensions differ for selected pair ${index}`);
    totalPixels += decoded.width * decoded.height;
    invariant(totalPixels <= MAX_TOTAL_PIXELS, "selected depth pixels exceed the total bound");
    prepared.push({ id: `frame-${index.toString().padStart(4, "0")}`, pair, width: decoded.width, height: decoded.height, depth: decoded.samples, rgbBytes, depthBytes, rgbExtension: rgb.extension, rgbDigest: sha256Bytes(rgbBytes), depthDigest: sha256Bytes(depthBytes) });
  }

  const outputs: OutputFile[] = [];
  const sources = prepared.map((frame) => {
    const rgbPath = `sources/rgb/${frame.id}.${frame.rgbExtension}`;
    const depthPath = `sources/depth/${frame.id}.png`;
    outputs.push({ path: rgbPath, bytes: frame.rgbBytes }, { path: depthPath, bytes: frame.depthBytes });
    const sourcePayload = { rgbTimestamp: frame.pair.rgb.timestamp, depthTimestamp: frame.pair.depth.timestamp, associationDeltaMs: frame.pair.deltaSeconds * 1000, rgbOriginalPath: frame.pair.rgb.path, depthOriginalPath: frame.pair.depth.path, rgbDigest: frame.rgbDigest, depthDigest: frame.depthDigest };
    return { id: `${frame.id}-source`, digest: sha256Canonical(sourcePayload), metadata: { ...sourcePayload, rgbPath, depthPath, depthEncoding: "TUM uint16 PNG; zero unknown; metres=value/5000", license: "TUM RGB-D dataset, CC BY 4.0", developmentOnly: true } };
  });
  const config = { schemaVersion: 1, association: "globally-greedy-smallest-absolute-delta; ties by RGB timestamp/path then depth timestamp/path", maximumDeltaMs: options.maximumDeltaMs, selection: "all when available<=requested; midpoint for one; otherwise round(i*(N-1)/(count-1))", requestedFrameCount: options.frameCount, selectedFrameCount: prepared.length, occlusionRule: "k=ceil(q*validOverlap); reference plane=kth-smallest metric depth and mask depth<=plane; predicted plane=kth-largest relative inverse depth and mask inverseDepth>=plane", occlusionQuantile: options.quantile, depthFactor: DEPTH_FACTOR, validity: "joint nonzero TUM depth and non-null predicted inverse depth" };
  const datasetDigest = sha256Canonical({ rgbTextDigest: sha256Bytes(rgbTextBytes), depthTextDigest: sha256Bytes(depthTextBytes), sourceDigests: sources.map((source) => source.digest), config });
  const corpus = createCorpusManifest({ schemaVersion: 1, kind: "quality-corpus-manifest", id: `tum-rgbd-${datasetDigest.slice(0, 16)}`, provenance: "recorded-rgbd", sources, samples: prepared.map((frame, index) => ({ id: frame.id, sourceId: sources[index]!.id, scenario: "recorded-rgbd-occlusion-plane", artifactDigests: [frame.rgbDigest, frame.depthDigest] })) });
  outputs.push({ path: "corpus.json", bytes: Buffer.from(`${canonicalJson(corpus)}\n`, "utf8") });

  let qualityInputPath: string | null = null;
  if (options.predictions !== undefined) {
    const predictionBytes = await readBoundedRegularFile(options.predictions, MAX_PREDICTION_BYTES, "--predictions");
    const predictionValue: unknown = JSON.parse(predictionBytes.toString("utf8"));
    const predictions = parsePredictions(predictionValue, prepared);
    const predictionDigest = sha256Canonical(predictions);
    const reviews: ReviewItem[] = [];
    const frames: EvaluationFrame[] = [];
    for (const [frameIndex, frame] of prepared.entries()) {
      const prediction = predictions.frames[frameIndex]!;
      const validIndices: number[] = [];
      for (let index = 0; index < frame.depth.length; index += 1) if (frame.depth[index]! > 0 && prediction.inverseDepth[index] !== null) validIndices.push(index);
      invariant(validIndices.length > 0, `prediction ${frame.id} has no overlap with valid TUM depth`);
      const count = Math.ceil(options.quantile * validIndices.length);
      const referencePlane = validIndices.map((index) => frame.depth[index]! / DEPTH_FACTOR).sort((left, right) => left - right)[count - 1]!;
      const predictedPlane = validIndices.map((index) => prediction.inverseDepth[index]!).sort((left, right) => left - right)[validIndices.length - count]!;
      const validityMask = new Array<number>(frame.depth.length).fill(0);
      const predictedMask = new Array<number>(frame.depth.length).fill(0);
      const referenceMask = new Array<number>(frame.depth.length).fill(0);
      const difference = new Uint8Array(frame.depth.length);
      for (let index = 0; index < frame.depth.length; index += 1) {
        const inverse = prediction.inverseDepth[index];
        if (frame.depth[index]! === 0 || inverse === null) {
          difference[index] = 64;
          continue;
        }
        validityMask[index] = 1;
        predictedMask[index] = inverse >= predictedPlane ? 1 : 0;
        referenceMask[index] = frame.depth[index]! / DEPTH_FACTOR <= referencePlane ? 1 : 0;
        difference[index] = predictedMask[index] === referenceMask[index] ? 0 : 255;
      }
      frames.push({ id: frame.id, timestampMs: frame.pair.rgb.timestamp * 1000, width: frame.width, height: frame.height, predictedMask, referenceMask, validityMask });
      reviews.push(reviewItem(`${frame.id}-rgb`, `${options.output}/sources/rgb/${frame.id}.${frame.rgbExtension}`, frame.rgbBytes, frame.id));
      addReview(outputs, reviews, options.output, frame, `review/${frame.id}-reference-depth.pgm`, pgm(frame.width, frame.height, depthVisualization(frame.depth)), "reference-depth");
      addReview(outputs, reviews, options.output, frame, `review/${frame.id}-predicted-mask.pgm`, pgm(frame.width, frame.height, Uint8Array.from(predictedMask, (value) => value * 255)), "predicted-mask");
      addReview(outputs, reviews, options.output, frame, `review/${frame.id}-reference-mask.pgm`, pgm(frame.width, frame.height, Uint8Array.from(referenceMask, (value) => value * 255)), "reference-mask");
      addReview(outputs, reviews, options.output, frame, `review/${frame.id}-diff.pgm`, pgm(frame.width, frame.height, difference), "diff");
    }
    const input: QualityEvaluationInput = { schemaVersion: 1, kind: "web-ar-occlusion-quality-input", provenance: { evaluatedAt: predictions.evaluatedAt, sourceKind: "fixed-corpus", sourceId: corpus.id, sourceDigest: corpus.digest, implementationId: predictions.implementationId, implementationDigest: predictionDigest, configDigest: sha256Canonical(config), evaluatorVersion: "quality-v1/recorded-rgbd-phase1-v1" }, depthScale: "unavailable", frames, reviewItems: reviews };
    qualityInputPath = `${options.output}/quality-input.json`;
    outputs.push({ path: "quality-input.json", bytes: Buffer.from(`${canonicalJson(input)}\n`, "utf8") });
  }

  await writeOutputs(outputTarget, outputs);
  process.stdout.write(`${canonicalJson({ corpus: `${options.output}/corpus.json`, corpusDigest: corpus.digest, qualityInput: qualityInputPath, selectedFrames: prepared.length, scoresProduced: false })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
