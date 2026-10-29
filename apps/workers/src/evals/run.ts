/**
 * Review eval: `pnpm eval` (or `pnpm --filter workers eval -- --help`).
 *
 * Runs every case in evals/cases through the review stages with the model
 * from .env (LLM_PROVIDER / LLM_MODEL), scores the findings against the
 * planted bugs, and writes evals/results/<time>-<provider>-<model>.json.
 * With a baseline (evals/baseline.json) it exits 1 when precision or recall
 * drops by more than the allowed amount, so prompt changes can be gated in CI.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StructuredLLM, createLLMProvider } from "@codeguard/review-engine";
import type { LLMUsage } from "@codeguard/review-engine";
import { logger } from "../lib/logger.js";
import type { Logger } from "../lib/logger.js";
import { runCase } from "./harness.js";
import type { CaseRun } from "./harness.js";
import { DEFAULT_LINE_TOLERANCE, DEFAULT_REGRESSION_LIMITS, EvalCaseSchema, aggregateMetrics, findRegressions } from "./scoring.js";
import type { EvalCase, Metrics } from "./scoring.js";

const EVALS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../evals");

const HELP = `Usage: pnpm eval [options]

  --case <id>           Run only these cases (repeatable)
  --tag <tag>           Run only cases with this tag (repeatable)
  --concurrency <n>     Cases run at the same time (default 1: free-tier rate limits)
  --pause <seconds>     Wait between cases, to stay under a tokens-per-minute limit (default 0)
  --tolerance <n>       Lines a finding may be off and still count (default ${DEFAULT_LINE_TOLERANCE})
  --baseline <file>     Compare against this result (default evals/baseline.json, if it exists)
  --update-baseline     Save this run as the new baseline
  --max-drop <n>        Allowed precision/recall drop, 0..1 (default ${DEFAULT_REGRESSION_LIMITS.maxPrecisionDrop})
  --verbose             Show pipeline warnings
  --help`;

export interface EvalResult {
  createdAt: string;
  provider: string;
  model: string;
  tolerance: number;
  metrics: Metrics;
  metricsBeforeVerify: Metrics;
  /** Cases left out of the metrics because a model call failed. */
  degraded: string[];
  usage: LLMUsage;
  llmCalls: number;
  durationMs: number;
  cases: Array<Omit<CaseRun, "trace" | "usage"> & { failedNodes: string[] }>;
}

export function loadCases(dir: string): EvalCase[] {
  const cases = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const parsed = EvalCaseSchema.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      return parsed.data;
    });
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id "${c.id}"`);
    ids.add(c.id);
  }
  return cases;
}

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quietLogger,
};

async function mapLimit<T, R>(items: T[], limit: number, pauseMs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

const pct = (n: number | null) => (n === null ? "  n/a" : `${(n * 100).toFixed(1).padStart(5)}%`);

function printReport(r: EvalResult, baseline: EvalResult | null) {
  console.log(`\nCodeGuard review eval · ${r.provider} / ${r.model} · ${r.cases.length} cases · line tolerance ±${r.tolerance}\n`);
  console.log("case                          TP  FP  FN  dup  verifier            ");
  for (const c of r.cases) {
    const v = c.verification;
    const verifier = c.error
      ? `ERROR ${c.error.slice(0, 40)}`
      : c.modelErrors.length > 0
        ? `DEGRADED (${c.modelErrors.length} model call(s) failed, not counted)`
        : v.status === "verified"
          ? `${v.confirmed}✓ ${v.uncertain}? ${v.rejected.length}✗`
          : v.status;
    console.log(
      `${c.caseId.padEnd(30)}${String(c.final.truePositives).padStart(2)}  ${String(c.final.falsePositives).padStart(2)}  ${String(c.final.falseNegatives).padStart(2)}  ${String(c.final.duplicates).padStart(3)}  ${verifier}`
    );
    if (c.modelErrors.length > 0) console.log(`    model    ${c.modelErrors[0]}`);
    for (const m of c.final.missed) console.log(`    missed   ${m.file}:${m.lines.join("-")}${m.note ? `  (${m.note})` : ""}`);
    for (const f of c.final.falsePositiveFindings) console.log(`    false +  ${f.file}:${f.line ?? "?"} [${f.severity}/${f.source}] ${f.message.slice(0, 90)}`);
  }
  const m = r.metrics;
  const b = r.metricsBeforeVerify;
  console.log(`
scored ${m.cases} of ${r.cases.length} cases${r.degraded.length ? ` (left out: ${r.degraded.join(", ")})` : ""}

                     before verify    final
precision            ${pct(b.precision)}           ${pct(m.precision)}
recall               ${pct(b.recall)}           ${pct(m.recall)}
F1                   ${pct(b.f1)}           ${pct(m.f1)}
false positives/PR   ${b.falsePositivesPerCase.toFixed(2).padStart(6)}           ${m.falsePositivesPerCase.toFixed(2).padStart(6)}
blocking false pos.  ${String(b.blockingFalsePositives).padStart(6)}           ${String(m.blockingFalsePositives).padStart(6)}
clean PRs passed     ${pct(b.cleanCasePassRate)}           ${pct(m.cleanCasePassRate)}
category agreement                    ${pct(m.categoryAgreement)}

tokens ${r.usage.totalTokens} (${r.usage.promptTokens} in / ${r.usage.completionTokens} out) · ${r.llmCalls} LLM calls · ${(r.durationMs / 1000).toFixed(1)} s`);
  if (baseline) {
    const d = (now: number | null, then: number | null) => (now === null || then === null ? "n/a" : `${now >= then ? "+" : ""}${((now - then) * 100).toFixed(1)} pts`);
    console.log(`vs baseline (${baseline.model}, ${baseline.createdAt.slice(0, 10)}): precision ${d(m.precision, baseline.metrics.precision)}, recall ${d(m.recall, baseline.metrics.recall)}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      case: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
      concurrency: { type: "string", default: "1" },
      pause: { type: "string", default: "0" },
      tolerance: { type: "string", default: String(DEFAULT_LINE_TOLERANCE) },
      baseline: { type: "string" },
      "update-baseline": { type: "boolean", default: false },
      "max-drop": { type: "string", default: String(DEFAULT_REGRESSION_LIMITS.maxPrecisionDrop) },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  let cases = loadCases(join(EVALS_DIR, "cases"));
  if (values.case?.length) cases = cases.filter((c) => values.case!.includes(c.id));
  if (values.tag?.length) cases = cases.filter((c) => c.tags.some((t) => values.tag!.includes(t)));
  if (cases.length === 0) throw new Error("no cases selected");

  const tolerance = Number(values.tolerance);
  const provider = createLLMProvider();
  const log = values.verbose ? logger.child({ job: "eval" }) : quietLogger;
  const started = Date.now();

  const runs = await mapLimit(cases, Number(values.concurrency), Number(values.pause) * 1000, async (c) => {
    // One client per case, so usage and call counts are per case.
    const run = await runCase(c, new StructuredLLM(provider, values.verbose ? console : { warn: () => {} }), log.child({ case: c.id }), tolerance);
    process.stderr.write(run.error ? "E" : run.modelErrors.length > 0 ? "D" : ".");
    return run;
  });
  process.stderr.write("\n");

  const expectedCounts = new Map(cases.map((c) => [c.id, c.expected.length]));
  // A case whose model calls failed measures the outage, not the reviewer.
  const counted = runs.filter((r) => !r.error && r.modelErrors.length === 0);
  const usage = runs.reduce<LLMUsage>(
    (u, r) => ({
      promptTokens: u.promptTokens + (r.usage?.promptTokens ?? 0),
      completionTokens: u.completionTokens + (r.usage?.completionTokens ?? 0),
      totalTokens: u.totalTokens + (r.usage?.totalTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  );
  const result: EvalResult = {
    createdAt: new Date().toISOString(),
    provider: provider.name,
    model: provider.model,
    tolerance,
    metrics: aggregateMetrics(counted.map((r) => r.final), expectedCounts),
    metricsBeforeVerify: aggregateMetrics(counted.map((r) => r.beforeVerify), expectedCounts),
    degraded: runs.filter((r) => !counted.includes(r)).map((r) => r.caseId),
    usage,
    llmCalls: runs.reduce((n, r) => n + r.llmCalls, 0),
    durationMs: Date.now() - started,
    cases: runs.map(({ trace, usage: _usage, ...rest }) => ({ ...rest, failedNodes: trace.filter((t) => t.status === "failed").map((t) => `${t.name}: ${t.error ?? ""}`) })),
  };

  const baselinePath = values.baseline ? resolve(values.baseline) : join(EVALS_DIR, "baseline.json");
  const baseline: EvalResult | null = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  printReport(result, baseline);

  const resultsDir = join(EVALS_DIR, "results");
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${result.createdAt.replace(/[:.]/g, "-")}-${result.provider}-${result.model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nSaved ${file}`);

  if (values["update-baseline"]) {
    if (result.degraded.length > 0) {
      console.error(`Baseline NOT updated: ${result.degraded.length} case(s) had failed model calls. Rerun (try --pause 15) until every case completes.`);
    } else {
      writeFileSync(join(EVALS_DIR, "baseline.json"), JSON.stringify(result, null, 2));
      console.log("Baseline updated.");
    }
  }

  const errors = runs.filter((r) => r.error || r.modelErrors.length > 0);
  const maxDrop = Number(values["max-drop"]);
  const regressions = baseline && !values["update-baseline"] ? findRegressions(result.metrics, baseline.metrics, { maxPrecisionDrop: maxDrop, maxRecallDrop: maxDrop }) : [];
  if (errors.length > 0) console.error(`\n${errors.length} case(s) failed or had failed model calls; they are not in the totals.`);
  for (const r of regressions) console.error(`REGRESSION: ${r}`);
  if (errors.length > 0 || regressions.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
