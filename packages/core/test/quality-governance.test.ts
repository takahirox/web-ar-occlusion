import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAiQualitySummary,
  createComparisonPolicy,
  createCorpusManifest,
  createRunManifest,
  evaluateSafety,
  compareWithPolicy,
  validateCorpusManifest,
  validateRunManifest,
  validateSafetyReport,
  type SafetyObservation,
} from "../src/quality-governance.ts";
import { evaluateQuality, getQualityMetric, sha256Canonical, sha256Text, type QualityEvaluationInput } from "../src/quality.ts";

const D = (value: string) => sha256Text(value);
const source = { id: "source-1", digest: D("source"), metadata: { fixed: true } };
const corpus = () => createCorpusManifest({
  schemaVersion: 1,
  kind: "quality-corpus-manifest",
  id: "corpus-1",
  provenance: "synthetic",
  sources: [source],
  samples: [{ id: "sample-1", sourceId: source.id, scenario: "static-edge", artifactDigests: [D("rgb")] }],
});
function input(mask = [1, 0]): QualityEvaluationInput {
  return {
    schemaVersion: 1,
    kind: "web-ar-occlusion-quality-input",
    provenance: {
      evaluatedAt: "2026-09-02T00:00:00.000Z",
      sourceKind: "synthetic-fixture",
      sourceId: "corpus-1",
      sourceDigest: D("source"),
      implementationId: "candidate",
      implementationDigest: D("candidate"),
      configDigest: D("config"),
      evaluatorVersion: "v1",
    },
    depthScale: "metric",
    frames: [{
      id: "frame-1", timestampMs: 1, width: 2, height: 1,
      predictedMask: mask, referenceMask: [1, 0],
      predictedDepth: [1, 2], referenceDepth: [1, 2], confidence: [1, 1],
    }],
  };
}
function run(evaluationDigest: string) {
  const c = corpus();
  return createRunManifest({
    schemaVersion: 1,
    kind: "quality-run-manifest",
    id: `run-${evaluationDigest.slice(0, 6)}`,
    provenance: "synthetic",
    corpusDigest: c.digest,
    repositoryRevision: "abc123",
    candidateDigest: D("candidate"),
    configDigest: D("config"),
    evaluatorDigest: D("evaluator"),
    evaluationDigest,
    environment: { browser: "none" },
    associations: [{ sampleId: "sample-1", sourceId: source.id, sourceDigest: source.digest, sourceFrameId: "frame-1", captureTimestampMs: 1 }],
  }, c);
}
const safeObservation = (): SafetyObservation => ({
  sampleId: "sample-1",
  expectedSourceFrameId: "frame-1",
  actualSourceFrameId: "frame-1",
  depthAgeMs: 10,
  maximumDepthAgeMs: 250,
  calibrationState: "calibrated",
  occlusion: [0, 1],
});

test("corpus and run manifests bind provenance, sources, associations, and digests", () => {
  const c = corpus();
  assert.doesNotThrow(() => validateCorpusManifest(c));
  const artifact = evaluateQuality(input());
  const manifest = run(artifact.digest);
  assert.doesNotThrow(() => validateRunManifest(manifest, c));
  assert.throws(() => validateRunManifest({ ...manifest, corpusDigest: D("tampered") }, c), /corpus digest mismatch|digest mismatch/);
  const { digest: _digest, ...unsigned } = manifest;
  unsigned.associations[0] = { ...unsigned.associations[0]!, sourceDigest: D("tampered") };
  assert.throws(() => createRunManifest(unsigned, c), /source digest mismatch/);
});

test("each unsafe condition is explicit and forbidden nonzero occlusion fails", () => {
  const cases: Array<[Partial<SafetyObservation>, keyof ReturnType<typeof evaluateSafety>["counts"]]> = [
    [{ actualSourceFrameId: "wrong" }, "sourceMismatch"],
    [{ depthAgeMs: 251 }, "staleDepth"],
    [{ calibrationState: "lost" }, "calibrationInvalid"],
  ];
  for (const [change, counter] of cases) {
    const report = evaluateSafety([{ ...safeObservation(), ...change }]);
    assert.equal(report.status, "fail");
    assert.equal(report.counts[counter], 1);
    assert.equal(report.counts.forbiddenNonzeroOcclusion, 1);
    assert.doesNotThrow(() => validateSafetyReport(report));
  }
  assert.equal(evaluateSafety([safeObservation()]).status, "pass");
  assert.equal(evaluateSafety([]).status, "unknown");
});

test("duplicate sources and internally inconsistent safety reports fail closed", () => {
  const c = corpus();
  const { digest: _digest, ...unsigned } = c;
  assert.throws(() => createCorpusManifest({ ...unsigned, sources: [source, source] }), /source IDs must be unique/);
  const safety = evaluateSafety([safeObservation()]);
  const tampered = { ...safety, counts: { ...safety.counts, staleDepth: 1 } };
  const { digest: _safetyDigest, ...tamperedUnsigned } = tampered;
  assert.throws(() => validateSafetyReport({ ...tamperedUnsigned, digest: sha256Canonical(tamperedUnsigned) }), /counts do not match/);
});

test("zero occlusion remains safe when evidence is invalid", () => {
  const report = evaluateSafety([{ ...safeObservation(), calibrationState: "relative-only", occlusion: [0, 0] }]);
  assert.equal(report.counts.calibrationInvalid, 1);
  assert.equal(report.counts.forbiddenNonzeroOcclusion, 0);
});

test("versioned policy gate passes, rejects safety, and refuses synthetic benchmark claims", () => {
  const baseline = evaluateQuality(input([0, 0]));
  const candidate = evaluateQuality(input());
  const policy = createComparisonPolicy({
    schemaVersion: 1,
    kind: "quality-comparison-policy",
    id: "development-policy",
    purpose: "development",
    allowedProvenance: ["synthetic"],
    requiredMetrics: ["mask.iou"],
    objectives: [{ metric: "mask.iou", direction: "max" }],
  });
  const passed = compareWithPolicy(baseline, candidate, run(baseline.digest), run(candidate.digest), evaluateSafety([safeObservation()]), policy);
  assert.equal(passed.status, "pass");
  const failed = compareWithPolicy(baseline, candidate, run(baseline.digest), run(candidate.digest), evaluateSafety([{ ...safeObservation(), depthAgeMs: 999 }]), policy);
  assert.equal(failed.status, "fail");
  const { digest: _digest, ...policyUnsigned } = policy;
  const benchmark = createComparisonPolicy({ ...policyUnsigned, id: "benchmark", purpose: "benchmark" });
  assert.equal(compareWithPolicy(baseline, candidate, run(baseline.digest), run(candidate.digest), evaluateSafety([safeObservation()]), benchmark).status, "fail");
});

test("required unknown metrics and multi-objective tradeoffs cannot pass", () => {
  const baseline = evaluateQuality(input());
  const candidate = structuredClone(baseline);
  const boundary = getQualityMetric(candidate, "boundary.f1");
  delete boundary.value;
  boundary.status = "unknown";
  boundary.reason = "unresolved";
  const { digest: _digest, ...unsigned } = candidate;
  candidate.digest = sha256Canonical(unsigned);
  const policy = createComparisonPolicy({
    schemaVersion: 1, kind: "quality-comparison-policy", id: "required",
    purpose: "development", allowedProvenance: ["synthetic"],
    requiredMetrics: ["boundary.f1"], objectives: [{ metric: "boundary.f1", direction: "max" }],
  });
  assert.notEqual(compareWithPolicy(baseline, candidate, run(baseline.digest), run(candidate.digest), evaluateSafety([safeObservation()]), policy).status, "pass");
});

test("AI summary is bounded, digest-bound, review-only, and cannot promote", () => {
  const baseline = evaluateQuality(input([0, 0]));
  const candidate = evaluateQuality(input());
  const safety = evaluateSafety([safeObservation()]);
  const policy = createComparisonPolicy({
    schemaVersion: 1, kind: "quality-comparison-policy", id: "summary",
    purpose: "development", allowedProvenance: ["synthetic"], requiredMetrics: [],
    objectives: [{ metric: "mask.iou", direction: "max" }],
  });
  const decision = compareWithPolicy(baseline, candidate, run(baseline.digest), run(candidate.digest), safety, policy);
  const summary = createAiQualitySummary(decision, baseline, candidate, safety, [D("review")], ["static-edge/frame-1"], 2);
  assert.equal(summary.reviewOnly, true);
  assert.equal(summary.promotionAllowed, false);
  assert.equal(summary.decisionDigest, decision.digest);
  assert.ok(summary.metricDeltas.length <= 2);
  const { digest: summaryDigest, ...unsignedSummary } = summary;
  assert.equal(summaryDigest, sha256Canonical(unsignedSummary));
  assert.throws(() => createAiQualitySummary(decision, candidate, baseline, safety, [D("review")], [], 2), /decision baseline digest mismatch/);
});

test("governance CLI paths emit canonical verified artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quality-governance-cli-"));
  try {
    const cli = fileURLToPath(new URL("../src/quality-cli.ts", import.meta.url));
    const baseline = evaluateQuality(input([0, 0]));
    const candidate = evaluateQuality(input());
    const baselineRun = run(baseline.digest);
    const candidateRun = run(candidate.digest);
    const safety = evaluateSafety([safeObservation()]);
    const policy = createComparisonPolicy({
      schemaVersion: 1, kind: "quality-comparison-policy", id: "cli-policy",
      purpose: "development", allowedProvenance: ["synthetic"], requiredMetrics: ["mask.iou"],
      objectives: [{ metric: "mask.iou", direction: "max" }],
    });
    const decision = compareWithPolicy(baseline, candidate, baselineRun, candidateRun, safety, policy);
    const values: Record<string, unknown> = {
      corpus: corpus(), baseline, candidate, baselineRun, candidateRun, safety, policy, decision,
      observations: [safeObservation()], reviews: [D("review")], scenarios: ["static-edge/frame-1"],
    };
    const paths: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      paths[name] = join(directory, `${name}.json`);
      await writeFile(paths[name]!, JSON.stringify(value), "utf8");
    }
    const execute = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    const commands = [
      ["verify-corpus", paths.corpus!],
      ["verify-run", paths.candidateRun!, paths.corpus!],
      ["safety", paths.observations!],
      ["gate", paths.baseline!, paths.candidate!, paths.baselineRun!, paths.candidateRun!, paths.safety!, paths.policy!],
      ["ai-summary", paths.decision!, paths.baseline!, paths.candidate!, paths.safety!, paths.reviews!, paths.scenarios!, "4"],
    ];
    for (const command of commands) {
      const result = execute(command);
      assert.equal(result.status, 0, `${command[0]}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(result.stdout.trim(), JSON.stringify(parsed));
    }
    assert.equal(JSON.parse(execute(commands[3]!).stdout).status, "pass");
    assert.equal(JSON.parse(execute(commands[4]!).stdout).promotionAllowed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
