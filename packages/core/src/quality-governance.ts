import {
  canonicalJson,
  compareQualityArtifacts,
  getQualityMetric,
  QUALITY_METRIC_NAMES,
  sha256Canonical,
  verifyQualityArtifact,
  type ComparisonObjective,
  type ComparisonResult,
  type QualityArtifact,
  type QualityMetricName,
} from "./quality.ts";

export const EVIDENCE_PROVENANCE = Object.freeze([
  "synthetic",
  "recorded-rgbd",
  "real-camera",
  "reference-device",
] as const);
export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCE)[number];

type DigestRecord = { digest: string };
type SourceRecord = { id: string; digest: string; metadata: Record<string, unknown> };
type SampleRecord = {
  id: string;
  sourceId: string;
  scenario: string;
  artifactDigests: string[];
};

export interface CorpusManifest extends DigestRecord {
  schemaVersion: 1;
  kind: "quality-corpus-manifest";
  id: string;
  provenance: EvidenceProvenance;
  sources: SourceRecord[];
  samples: SampleRecord[];
}

export interface RunAssociation {
  sampleId: string;
  sourceId: string;
  sourceDigest: string;
  sourceFrameId: string;
  captureTimestampMs: number;
}

export interface RunManifest extends DigestRecord {
  schemaVersion: 1;
  kind: "quality-run-manifest";
  id: string;
  provenance: EvidenceProvenance;
  corpusDigest: string;
  repositoryRevision: string;
  candidateDigest: string;
  configDigest: string;
  evaluatorDigest: string;
  evaluationDigest: string;
  environment: Record<string, unknown>;
  associations: RunAssociation[];
}

export interface SafetyObservation {
  sampleId: string;
  expectedSourceFrameId: string;
  actualSourceFrameId: string;
  depthAgeMs: number;
  maximumDepthAgeMs: number;
  calibrationState: "calibrated" | "relative-only" | "lost";
  occlusion: number[];
}

export interface SafetyViolation {
  sampleId: string;
  kind:
    | "source-mismatch"
    | "stale-depth"
    | "calibration-invalid"
    | "forbidden-nonzero-occlusion";
}

export interface SafetyReport extends DigestRecord {
  schemaVersion: 1;
  kind: "quality-safety-report";
  status: "pass" | "fail" | "unknown";
  evaluatedSamples: number;
  counts: {
    sourceMismatch: number;
    staleDepth: number;
    calibrationInvalid: number;
    forbiddenNonzeroOcclusion: number;
  };
  violations: SafetyViolation[];
  missingReason: string | null;
}

export interface ComparisonPolicy extends DigestRecord {
  schemaVersion: 1;
  kind: "quality-comparison-policy";
  id: string;
  purpose: "development" | "benchmark" | "device-promotion";
  allowedProvenance: EvidenceProvenance[];
  requiredMetrics: QualityMetricName[];
  objectives: ComparisonObjective[];
}

export interface GateDecision extends DigestRecord {
  schemaVersion: 1;
  kind: "quality-gate-decision";
  status: "pass" | "fail" | "unknown";
  reasons: string[];
  baselineDigest: string;
  candidateDigest: string;
  policyDigest: string;
  comparison: ComparisonResult;
  safetyDigest: string;
  promotionAuthority: "trust-kernel-only";
}

export interface AiQualitySummary extends DigestRecord {
  schemaVersion: 1;
  kind: "quality-ai-summary";
  reviewOnly: true;
  gateStatus: GateDecision["status"];
  decisionDigest: string;
  metricDeltas: Array<{
    metric: QualityMetricName;
    baseline: number;
    candidate: number;
    delta: number;
  }>;
  safetyViolations: SafetyViolation[];
  missingEvidence: string[];
  worstScenarioRefs: string[];
  reviewManifestDigests: string[];
  promotionAllowed: false;
}

const DIGEST = /^[0-9a-f]{64}$/;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function string(value: unknown, label: string): asserts value is string {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
}

function digest(value: unknown, label: string): asserts value is string {
  invariant(typeof value === "string" && DIGEST.test(value), `${label} must be a SHA-256 digest`);
}

function finite(value: unknown, label: string): asserts value is number {
  invariant(typeof value === "number" && Number.isFinite(value), `${label} must be finite`);
}

function unique(values: string[], label: string): void {
  invariant(new Set(values).size === values.length, `${label} must be unique`);
}

function signed<T extends object>(value: T): T & DigestRecord {
  return { ...value, digest: sha256Canonical(value) };
}

function verifyOwnDigest(value: DigestRecord, label: string): void {
  digest(value.digest, `${label}.digest`);
  const { digest: _digest, ...unsigned } = value;
  invariant(sha256Canonical(unsigned) === value.digest, `${label} digest mismatch`);
}

export function createCorpusManifest(
  value: Omit<CorpusManifest, "digest">,
): CorpusManifest {
  const manifest = signed(value);
  validateCorpusManifest(manifest);
  return manifest;
}

export function validateCorpusManifest(value: unknown): asserts value is CorpusManifest {
  record(value, "corpus");
  invariant(value.schemaVersion === 1 && value.kind === "quality-corpus-manifest", "unsupported corpus manifest");
  string(value.id, "corpus.id");
  invariant(EVIDENCE_PROVENANCE.includes(value.provenance as EvidenceProvenance), "invalid corpus provenance");
  invariant(Array.isArray(value.sources) && value.sources.length > 0, "corpus.sources must be non-empty");
  invariant(Array.isArray(value.samples) && value.samples.length > 0, "corpus.samples must be non-empty");
  const sources = new Map<string, SourceRecord>();
  const sourceIds: string[] = [];
  for (const [index, item] of value.sources.entries()) {
    record(item, `corpus.sources[${index}]`);
    string(item.id, `corpus.sources[${index}].id`);
    digest(item.digest, `corpus.sources[${index}].digest`);
    record(item.metadata, `corpus.sources[${index}].metadata`);
    sourceIds.push(item.id);
    sources.set(item.id, item as SourceRecord);
  }
  unique(sourceIds, "corpus source IDs");
  const sampleIds: string[] = [];
  for (const [index, item] of value.samples.entries()) {
    record(item, `corpus.samples[${index}]`);
    string(item.id, `corpus.samples[${index}].id`);
    string(item.sourceId, `corpus.samples[${index}].sourceId`);
    string(item.scenario, `corpus.samples[${index}].scenario`);
    invariant(sources.has(item.sourceId), "sample references an unknown source");
    invariant(Array.isArray(item.artifactDigests), "sample artifactDigests must be an array");
    item.artifactDigests.forEach((entry, digestIndex) => digest(entry, `sample artifactDigests[${digestIndex}]`));
    sampleIds.push(item.id);
  }
  unique(sampleIds, "corpus sample IDs");
  verifyOwnDigest(value as unknown as CorpusManifest, "corpus");
}

export function createRunManifest(
  value: Omit<RunManifest, "digest">,
  corpus: CorpusManifest,
): RunManifest {
  const manifest = signed(value);
  validateRunManifest(manifest, corpus);
  return manifest;
}

export function validateRunManifest(value: unknown, corpus?: CorpusManifest): asserts value is RunManifest {
  record(value, "run");
  invariant(value.schemaVersion === 1 && value.kind === "quality-run-manifest", "unsupported run manifest");
  string(value.id, "run.id");
  invariant(EVIDENCE_PROVENANCE.includes(value.provenance as EvidenceProvenance), "invalid run provenance");
  for (const field of ["corpusDigest", "candidateDigest", "configDigest", "evaluatorDigest", "evaluationDigest"] as const) {
    digest(value[field], `run.${field}`);
  }
  string(value.repositoryRevision, "run.repositoryRevision");
  record(value.environment, "run.environment");
  invariant(Array.isArray(value.associations) && value.associations.length > 0, "run associations must be non-empty");
  const associationIds: string[] = [];
  for (const [index, item] of value.associations.entries()) {
    record(item, `run.associations[${index}]`);
    string(item.sampleId, "association.sampleId");
    string(item.sourceId, "association.sourceId");
    digest(item.sourceDigest, "association.sourceDigest");
    string(item.sourceFrameId, "association.sourceFrameId");
    finite(item.captureTimestampMs, "association.captureTimestampMs");
    associationIds.push(item.sampleId);
  }
  unique(associationIds, "run association sample IDs");
  if (corpus) {
    validateCorpusManifest(corpus);
    invariant(value.corpusDigest === corpus.digest, "run corpus digest mismatch");
    invariant(value.provenance === corpus.provenance, "run/corpus provenance mismatch");
    invariant(value.associations.length === corpus.samples.length, "run must associate every corpus sample");
    const samples = new Map(corpus.samples.map((sample) => [sample.id, sample]));
    const sources = new Map(corpus.sources.map((source) => [source.id, source]));
    for (const association of value.associations as unknown as RunAssociation[]) {
      const sample = samples.get(association.sampleId);
      invariant(sample?.sourceId === association.sourceId, "association source mismatch");
      invariant(sources.get(association.sourceId)?.digest === association.sourceDigest, "association source digest mismatch");
    }
  }
  verifyOwnDigest(value as unknown as RunManifest, "run");
}

export function evaluateSafety(observations: SafetyObservation[]): SafetyReport {
  if (observations.length === 0) {
    return signed({
      schemaVersion: 1 as const,
      kind: "quality-safety-report" as const,
      status: "unknown" as const,
      evaluatedSamples: 0,
      counts: { sourceMismatch: 0, staleDepth: 0, calibrationInvalid: 0, forbiddenNonzeroOcclusion: 0 },
      violations: [],
      missingReason: "no-safety-observations",
    });
  }
  const violations: SafetyViolation[] = [];
  for (const observation of observations) {
    string(observation.sampleId, "safety.sampleId");
    finite(observation.depthAgeMs, "safety.depthAgeMs");
    finite(observation.maximumDepthAgeMs, "safety.maximumDepthAgeMs");
    invariant(observation.depthAgeMs >= 0 && observation.maximumDepthAgeMs >= 0, "depth ages must be non-negative");
    invariant(Array.isArray(observation.occlusion), "safety.occlusion must be an array");
    observation.occlusion.forEach((sample) => {
      finite(sample, "safety.occlusion sample");
      invariant(sample >= 0 && sample <= 1, "occlusion samples must be in [0,1]");
    });
    const sourceMismatch = observation.expectedSourceFrameId !== observation.actualSourceFrameId;
    const stale = observation.depthAgeMs > observation.maximumDepthAgeMs;
    const calibrationInvalid = observation.calibrationState !== "calibrated";
    if (sourceMismatch) violations.push({ sampleId: observation.sampleId, kind: "source-mismatch" });
    if (stale) violations.push({ sampleId: observation.sampleId, kind: "stale-depth" });
    if (calibrationInvalid) violations.push({ sampleId: observation.sampleId, kind: "calibration-invalid" });
    if ((sourceMismatch || stale || calibrationInvalid) && observation.occlusion.some((sample) => sample > 0)) {
      violations.push({ sampleId: observation.sampleId, kind: "forbidden-nonzero-occlusion" });
    }
  }
  const count = (kind: SafetyViolation["kind"]) => violations.filter((item) => item.kind === kind).length;
  return signed({
    schemaVersion: 1 as const,
    kind: "quality-safety-report" as const,
    status: violations.length ? "fail" as const : "pass" as const,
    evaluatedSamples: observations.length,
    counts: {
      sourceMismatch: count("source-mismatch"),
      staleDepth: count("stale-depth"),
      calibrationInvalid: count("calibration-invalid"),
      forbiddenNonzeroOcclusion: count("forbidden-nonzero-occlusion"),
    },
    violations,
    missingReason: null,
  });
}

export function validateSafetyReport(value: unknown): asserts value is SafetyReport {
  record(value, "safety");
  invariant(value.schemaVersion === 1 && value.kind === "quality-safety-report", "unsupported safety report");
  invariant(["pass", "fail", "unknown"].includes(value.status as string), "invalid safety status");
  invariant(Number.isInteger(value.evaluatedSamples) && (value.evaluatedSamples as number) >= 0, "invalid evaluatedSamples");
  record(value.counts, "safety.counts");
  const countFields = ["sourceMismatch", "staleDepth", "calibrationInvalid", "forbiddenNonzeroOcclusion"] as const;
  for (const field of countFields) invariant(Number.isInteger(value.counts[field]) && (value.counts[field] as number) >= 0, `invalid safety count ${field}`);
  invariant(Array.isArray(value.violations), "safety violations must be an array");
  const kinds = ["source-mismatch", "stale-depth", "calibration-invalid", "forbidden-nonzero-occlusion"] as const;
  const expected = { sourceMismatch: 0, staleDepth: 0, calibrationInvalid: 0, forbiddenNonzeroOcclusion: 0 };
  for (const [index, item] of value.violations.entries()) {
    record(item, `safety.violations[${index}]`);
    string(item.sampleId, `safety.violations[${index}].sampleId`);
    invariant(kinds.includes(item.kind as typeof kinds[number]), "invalid safety violation kind");
    if (item.kind === "source-mismatch") expected.sourceMismatch += 1;
    if (item.kind === "stale-depth") expected.staleDepth += 1;
    if (item.kind === "calibration-invalid") expected.calibrationInvalid += 1;
    if (item.kind === "forbidden-nonzero-occlusion") expected.forbiddenNonzeroOcclusion += 1;
  }
  invariant(canonicalJson(expected) === canonicalJson(value.counts), "safety counts do not match violations");
  invariant((value.status === "pass") === (value.evaluatedSamples > 0 && value.violations.length === 0), "safety pass status is inconsistent");
  invariant((value.status === "unknown") === (value.evaluatedSamples === 0), "safety unknown status is inconsistent");
  invariant(value.missingReason === null || typeof value.missingReason === "string", "invalid safety missingReason");
  verifyOwnDigest(value as unknown as SafetyReport, "safety");
}

export function createComparisonPolicy(value: Omit<ComparisonPolicy, "digest">): ComparisonPolicy {
  const policy = signed(value);
  validateComparisonPolicy(policy);
  return policy;
}

export function validateComparisonPolicy(value: unknown): asserts value is ComparisonPolicy {
  record(value, "policy");
  invariant(value.schemaVersion === 1 && value.kind === "quality-comparison-policy", "unsupported comparison policy");
  string(value.id, "policy.id");
  invariant(["development", "benchmark", "device-promotion"].includes(value.purpose as string), "invalid policy purpose");
  invariant(Array.isArray(value.allowedProvenance) && value.allowedProvenance.length > 0, "allowedProvenance must be non-empty");
  value.allowedProvenance.forEach((entry) => invariant(EVIDENCE_PROVENANCE.includes(entry as EvidenceProvenance), "invalid allowed provenance"));
  invariant(Array.isArray(value.requiredMetrics), "requiredMetrics must be an array");
  invariant(Array.isArray(value.objectives), "objectives must be an array");
  unique(value.requiredMetrics as string[], "required metrics");
  for (const metric of value.requiredMetrics) invariant((QUALITY_METRIC_NAMES as readonly string[]).includes(metric as string), `invalid required metric ${String(metric)}`);
  for (const [index, objective] of value.objectives.entries()) {
    record(objective, `policy.objectives[${index}]`);
    invariant((QUALITY_METRIC_NAMES as readonly string[]).includes(objective.metric as string), "invalid objective metric");
    invariant(objective.direction === "min" || objective.direction === "max", "invalid objective direction");
    invariant(objective.tolerance === undefined || (typeof objective.tolerance === "number" && Number.isFinite(objective.tolerance) && objective.tolerance >= 0), "invalid objective tolerance");
  }
  verifyOwnDigest(value as unknown as ComparisonPolicy, "policy");
}

export function compareWithPolicy(
  baseline: QualityArtifact,
  candidate: QualityArtifact,
  baselineRun: RunManifest,
  candidateRun: RunManifest,
  candidateSafety: SafetyReport,
  policy: ComparisonPolicy,
): GateDecision {
  validateRunManifest(baselineRun);
  validateRunManifest(candidateRun);
  validateComparisonPolicy(policy);
  validateSafetyReport(candidateSafety);
  const reasons: string[] = [];
  if (!verifyQualityArtifact(baseline).valid) reasons.push("baseline-artifact-invalid");
  if (!verifyQualityArtifact(candidate).valid) reasons.push("candidate-artifact-invalid");
  if (baselineRun.evaluationDigest !== baseline.digest) reasons.push("baseline-run-evaluation-mismatch");
  if (candidateRun.evaluationDigest !== candidate.digest) reasons.push("candidate-run-evaluation-mismatch");
  if (baselineRun.corpusDigest !== candidateRun.corpusDigest) reasons.push("corpus-digest-mismatch");
  if (baselineRun.evaluatorDigest !== candidateRun.evaluatorDigest) reasons.push("evaluator-digest-mismatch");
  if (!policy.allowedProvenance.includes(candidateRun.provenance)) reasons.push("candidate-provenance-not-allowed");
  if (policy.purpose === "benchmark" && candidateRun.provenance === "synthetic") reasons.push("synthetic-is-not-benchmark-evidence");
  if (policy.purpose === "device-promotion" && candidateRun.provenance !== "reference-device") reasons.push("reference-device-evidence-required");
  const missing = policy.requiredMetrics.filter((name) => getQualityMetric(candidate, name).status !== "known");
  reasons.push(...missing.map((name) => `required-metric-unknown:${name}`));
  if (candidateSafety.status === "fail") reasons.push("safety-violation");
  if (candidateSafety.status === "unknown") reasons.push("safety-evidence-unknown");
  const comparison = compareQualityArtifacts(baseline, candidate, policy.objectives);
  reasons.push(...comparison.reasons.map((reason) => `comparison:${reason}`));
  let status: GateDecision["status"] = "pass";
  if (reasons.some((reason) => reason.includes("unknown"))) status = "unknown";
  if (reasons.some((reason) => !reason.includes("unknown")) || comparison.verdict === "worse" || comparison.verdict === "tradeoff") status = "fail";
  if (comparison.verdict === "incomparable") status = "unknown";
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "quality-gate-decision" as const,
    status,
    reasons: [...new Set(reasons)].sort(),
    baselineDigest: baseline.digest,
    candidateDigest: candidate.digest,
    policyDigest: policy.digest,
    comparison,
    safetyDigest: candidateSafety.digest,
    promotionAuthority: "trust-kernel-only" as const,
  };
  return signed(unsigned);
}

export function createAiQualitySummary(
  decision: GateDecision,
  baseline: QualityArtifact,
  candidate: QualityArtifact,
  safety: SafetyReport,
  reviewManifestDigests: string[],
  worstScenarioRefs: string[],
  maximumItems = 20,
): AiQualitySummary {
  verifyOwnDigest(decision, "decision");
  validateSafetyReport(safety);
  invariant(verifyQualityArtifact(baseline).valid, "baseline artifact is invalid");
  invariant(verifyQualityArtifact(candidate).valid, "candidate artifact is invalid");
  invariant(decision.baselineDigest === baseline.digest, "decision baseline digest mismatch");
  invariant(decision.candidateDigest === candidate.digest, "decision candidate digest mismatch");
  invariant(decision.safetyDigest === safety.digest, "decision safety digest mismatch");
  invariant(maximumItems >= 1 && maximumItems <= 100 && Number.isInteger(maximumItems), "maximumItems must be in [1,100]");
  reviewManifestDigests.forEach((entry) => digest(entry, "review manifest digest"));
  worstScenarioRefs.forEach((entry) => string(entry, "worst scenario reference"));
  const metricDeltas = candidate.metrics
    .filter((metric) => metric.status === "known" && getQualityMetric(baseline, metric.name).status === "known")
    .map((metric) => {
      const before = getQualityMetric(baseline, metric.name).value!;
      return { metric: metric.name, baseline: before, candidate: metric.value!, delta: metric.value! - before };
    })
    .slice(0, maximumItems);
  const missingEvidence = candidate.metrics
    .filter((metric) => metric.status !== "known")
    .map((metric) => `${metric.name}:${metric.status}:${metric.reason}`)
    .slice(0, maximumItems);
  return signed({
    schemaVersion: 1 as const,
    kind: "quality-ai-summary" as const,
    reviewOnly: true as const,
    gateStatus: decision.status,
    decisionDigest: decision.digest,
    metricDeltas,
    safetyViolations: safety.violations.slice(0, maximumItems),
    missingEvidence,
    worstScenarioRefs: worstScenarioRefs.slice(0, maximumItems),
    reviewManifestDigests: reviewManifestDigests.slice(0, maximumItems),
    promotionAllowed: false as const,
  });
}

export function canonicalEvidence(value: unknown): string {
  return canonicalJson(value);
}
