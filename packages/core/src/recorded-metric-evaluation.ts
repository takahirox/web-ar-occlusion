import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface RecordedMetricFrame { readonly id: string; readonly predictedLinearZ: readonly (number | null)[]; readonly referenceLinearZ: readonly (number | null)[]; }
export interface RecordedMetricEvaluationInput { readonly schemaVersion: 1; readonly kind: "web-ar-occlusion-recorded-metric-input"; readonly virtualZThresholds: readonly number[]; readonly frames: readonly RecordedMetricFrame[]; }
export interface CrossingMeasurement { readonly virtualZ: number; readonly trueForeground: number; readonly falseForeground: number; readonly trueBackground: number; readonly falseBackground: number; readonly accuracy: number; readonly sampleCount: number; }
export interface RecordedMetricEvaluation { readonly schemaVersion: 1; readonly kind: "web-ar-occlusion-recorded-metric-evaluation"; readonly metric: { readonly maeMeters: number; readonly rmseMeters: number; readonly absRel: number; readonly sampleCount: number }; readonly crossings: readonly CrossingMeasurement[]; }

function validDepth(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function evaluateRecordedMetricDepth(value: RecordedMetricEvaluationInput): RecordedMetricEvaluation {
  if (value?.schemaVersion !== 1 || value.kind !== "web-ar-occlusion-recorded-metric-input" || !Array.isArray(value.frames) || value.frames.length === 0) throw new TypeError("invalid recorded metric input");
  if (!Array.isArray(value.virtualZThresholds) || value.virtualZThresholds.length < 2 || value.virtualZThresholds.some((threshold) => !Number.isFinite(threshold) || threshold <= 0) || new Set(value.virtualZThresholds).size !== value.virtualZThresholds.length) throw new TypeError("at least two unique positive virtual Z thresholds are required");
  const pairs: Array<readonly [number, number]> = [];
  for (const frame of value.frames) {
    if (!frame.id || frame.predictedLinearZ.length !== frame.referenceLinearZ.length) throw new TypeError("recorded metric frame is malformed");
    for (let index = 0; index < frame.predictedLinearZ.length; index += 1) {
      const predicted = frame.predictedLinearZ[index]!;
      const reference = frame.referenceLinearZ[index]!;
      if (validDepth(predicted) && validDepth(reference)) pairs.push([predicted, reference]);
    }
  }
  if (pairs.length === 0) throw new TypeError("recorded metric input has no jointly valid positive depth samples");
  const errors = pairs.map(([predicted, reference]) => predicted - reference);
  const crossings = [...value.virtualZThresholds].sort((left, right) => left - right).map((virtualZ) => {
    let trueForeground = 0, falseForeground = 0, trueBackground = 0, falseBackground = 0;
    for (const [predicted, reference] of pairs) {
      const predictedForeground = predicted < virtualZ;
      const referenceForeground = reference < virtualZ;
      if (predictedForeground && referenceForeground) trueForeground += 1;
      else if (predictedForeground) falseForeground += 1;
      else if (referenceForeground) falseBackground += 1;
      else trueBackground += 1;
    }
    return Object.freeze({ virtualZ, trueForeground, falseForeground, trueBackground, falseBackground, accuracy: (trueForeground + trueBackground) / pairs.length, sampleCount: pairs.length });
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "web-ar-occlusion-recorded-metric-evaluation",
    metric: Object.freeze({
      maeMeters: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
      rmseMeters: Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length),
      absRel: pairs.reduce((sum, [predicted, reference]) => sum + Math.abs(predicted - reference) / reference, 0) / pairs.length,
      sampleCount: pairs.length,
    }),
    crossings: Object.freeze(crossings),
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 1) throw new TypeError("usage: recorded-metric-evaluation.ts INPUT.json");
  const parsed: unknown = JSON.parse(await readFile(argv[0]!, "utf8"));
  process.stdout.write(`${JSON.stringify(evaluateRecordedMetricDepth(parsed as RecordedMetricEvaluationInput))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
