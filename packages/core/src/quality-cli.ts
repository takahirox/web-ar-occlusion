import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { canonicalJson, compareQualityArtifacts, createReviewSummary, createVisualReviewManifest, evaluateQuality, verifyQualityArtifact } from "./quality.ts";
import {
  compareWithPolicy,
  createAiQualitySummary,
  evaluateSafety,
  validateComparisonPolicy,
  validateCorpusManifest,
  validateRunManifest,
  type ComparisonPolicy,
  type GateDecision,
  type RunManifest,
  type SafetyObservation,
  type SafetyReport,
} from "./quality-governance.ts";
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path,"utf8")); }
function write(value: unknown): void { process.stdout.write(`${canonicalJson(value)}\n`); }
function usage(): never { throw new Error("usage: quality-cli.ts <verify ARTIFACT | verify-corpus CORPUS | verify-run RUN [CORPUS] | evaluate INPUT | safety OBSERVATIONS | compare BASELINE CANDIDATE | gate BASELINE CANDIDATE BASELINE_RUN CANDIDATE_RUN SAFETY POLICY | summary ARTIFACT [MAX_CHARS] | ai-summary DECISION BASELINE CANDIDATE SAFETY REVIEW_DIGESTS SCENARIO_REFS [MAX_ITEMS] | review-manifest ARTIFACT [MAX_ITEMS]>"); }
export async function main(argv=process.argv.slice(2)): Promise<void> {
  const [command,...args]=argv;
  if(command==="verify"&&args.length===1){const artifact=await readJson(args[0]!);const result=verifyQualityArtifact(artifact);write(result);if(!result.valid)process.exitCode=1;return;}
  if(command==="verify-corpus"&&args.length===1){const manifest=await readJson(args[0]!);validateCorpusManifest(manifest);write({valid:true});return;}
  if(command==="verify-run"&&(args.length===1||args.length===2)){const manifest=await readJson(args[0]!);const corpus=args[1]===undefined?undefined:await readJson(args[1]);validateRunManifest(manifest,corpus as never);write({valid:true});return;}
  if(command==="evaluate"&&args.length===1){write(evaluateQuality(await readJson(args[0]!)));return;}
  if(command==="safety"&&args.length===1){write(evaluateSafety(await readJson(args[0]!) as SafetyObservation[]));return;}
  if(command==="compare"&&args.length===2){const result=compareQualityArtifacts(await readJson(args[0]!),await readJson(args[1]!));write(result);if(!result.comparable)process.exitCode=1;return;}
  if(command==="gate"&&args.length===6){
    const [baseline,candidate,baselineRun,candidateRun,safety,policy]=await Promise.all(args.map(readJson));
    validateComparisonPolicy(policy);
    const decision=compareWithPolicy(baseline as never,candidate as never,baselineRun as RunManifest,candidateRun as RunManifest,safety as SafetyReport,policy as ComparisonPolicy);
    write(decision);if(decision.status!=="pass")process.exitCode=1;return;
  }
  if(command==="summary"&&(args.length===1||args.length===2)){write(createReviewSummary(await readJson(args[0]!),args[1]===undefined?1200:Number(args[1])));return;}
  if(command==="ai-summary"&&(args.length===6||args.length===7)){
    const [decision,baseline,candidate,safety,reviews,scenarios]=await Promise.all(args.slice(0,6).map(readJson));
    write(createAiQualitySummary(decision as GateDecision,baseline as never,candidate as never,safety as SafetyReport,reviews as string[],scenarios as string[],args[6]===undefined?20:Number(args[6])));return;
  }
  if(command==="review-manifest"&&(args.length===1||args.length===2)){write(createVisualReviewManifest(await readJson(args[0]!),args[1]===undefined?24:Number(args[1])));return;}
  usage();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch((error)=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
