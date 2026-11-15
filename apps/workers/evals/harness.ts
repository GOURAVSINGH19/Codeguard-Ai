import "../src/env";

import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";
import {
  addedLines,
  assessRisk,
  createProvider,
  lintFiles,
  parsePolicy,
  runStagedReview,
  type DiffFile,
  type ProviderEnv,
} from "@codeguard/review-engine";

/**
 * Evals: does the reviewer still catch real bugs (recall) without crying wolf (precision)?
 *
 * Unit tests check LOGIC. Evals check review QUALITY, which changes whenever you
 * touch a prompt, the model, or the context. Run before and after every such
 * change:  pnpm eval            (compare with baseline.json)
 *          pnpm eval --update   (accept the current scores as the new baseline)
 *          pnpm eval --check    (exit 1 if recall or precision drops > 0.1; for CI)
 *
 * A finding "hits" an expected bug if it's in the same file within ±3 lines.
 */
interface Case {
  name: string;
  title: string;
  body: string;
  files: Array<{ path: string; before: string[]; after: string[] }>;
  expected: Array<{ file: string; line: number; category: string }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));

function toDiffFile(f: Case["files"][number]): { diff: DiffFile; head: string } {
  const before = f.before.join("\n") + "\n";
  const after = f.after.join("\n") + "\n";
  const full = createTwoFilesPatch(f.path, f.path, before, after, "", "", { context: 3 });
  const patch = full.slice(full.indexOf("@@")).trimEnd(); // GitHub's patch starts at the first hunk
  const additions = patch.split("\n").filter((l) => l.startsWith("+")).length;
  const deletions = patch.split("\n").filter((l) => l.startsWith("-")).length;
  return { diff: { filename: f.path, status: f.before.length ? "modified" : "added", additions, deletions, patch }, head: after };
}

async function main() {
  const provider = createProvider({
    LLM_PROVIDER: (process.env.LLM_PROVIDER as ProviderEnv["LLM_PROVIDER"]) ?? "groq",
    LLM_MODEL: process.env.LLM_MODEL,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });
  const cases: Case[] = readdirSync(path.join(here, "cases"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(here, "cases", f), "utf8")));

  console.log(`Running ${cases.length} eval case(s) with ${provider.name}/${provider.model}\n`);
  const rows = [];
  for (const c of cases) {
    const files = c.files.map(toDiffFile);
    const diffs = files.map((f) => f.diff);
    const headContents = new Map(files.map((f) => [f.diff.filename, f.head]));
    const lint = await lintFiles(files.map((f) => ({ path: f.diff.filename, content: f.head, addedLines: addedLines(f.diff.patch) })));
    const started = Date.now();
    try {
      const res = await runStagedReview({
        provider, title: c.title, body: c.body, files: diffs, lint,
        context: {
          ...(() => { const p = parsePolicy(null); return { policy: p.policy, policyWarnings: p.warnings }; })(),
          related: [], callers: [], affected: [], headContents,
          risk: assessRisk({ changedPaths: diffs.map((d) => d.filename), affectedCount: 0, maxFanIn: 0, linesChanged: 10, deletedTestFiles: 0 }),
        },
      });
      const hit = (e: Case["expected"][number]) => res.findings.some((f) => f.file === e.file && f.line !== null && Math.abs(f.line - e.line) <= 3);
      const relevant = (f: (typeof res.findings)[number]) => c.expected.some((e) => f.file === e.file && f.line !== null && Math.abs(f.line - e.line) <= 3);
      const found = c.expected.filter(hit).length;
      rows.push({
        case: c.name,
        expected: c.expected.length,
        found,
        findings: res.findings.length,
        falsePositives: res.findings.filter((f) => !relevant(f)).length,
        rejectedByVerifier: res.assurance.verification?.rejected.length ?? 0,
        verdict: res.decision.verdict,
        tokens: res.tokens,
        ms: Date.now() - started,
        error: null as string | null,
      });
      for (const f of res.findings) console.log(`  [${c.name}] ${f.severity}/${f.category} ${f.file}:${f.line} (${f.verdict}) ${f.message.slice(0, 90)}`);
    } catch (err) {
      rows.push({ case: c.name, expected: c.expected.length, found: 0, findings: 0, falsePositives: 0, rejectedByVerifier: 0, verdict: "error", tokens: 0, ms: Date.now() - started, error: (err as Error).message });
    }
  }

  const expected = rows.reduce((n, r) => n + r.expected, 0);
  const found = rows.reduce((n, r) => n + r.found, 0);
  const findings = rows.reduce((n, r) => n + r.findings, 0);
  const fps = rows.reduce((n, r) => n + r.falsePositives, 0);
  const summary = {
    model: `${provider.name}/${provider.model}`,
    recall: expected ? +(found / expected).toFixed(2) : 1,
    precision: findings ? +((findings - fps) / findings).toFixed(2) : 1,
    falsePositives: fps,
    errors: rows.filter((r) => r.error).length,
    tokens: rows.reduce((n, r) => n + r.tokens, 0),
  };

  console.log("");
  console.table(rows.map(({ error, ...r }) => ({ ...r, error: error?.slice(0, 40) ?? "" })));
  console.log(summary);

  const resultsDir = path.join(here, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ summary, rows }, null, 2));

  const baselinePath = path.join(here, "baseline.json");
  if (args.has("--update")) {
    writeFileSync(baselinePath, JSON.stringify(summary, null, 2) + "\n");
    console.log("baseline updated");
  } else if (existsSync(baselinePath)) {
    const base = JSON.parse(readFileSync(baselinePath, "utf8"));
    const dRecall = +(summary.recall - base.recall).toFixed(2);
    const dPrecision = +(summary.precision - base.precision).toFixed(2);
    console.log(`vs baseline (${base.model}): recall ${dRecall >= 0 ? "+" : ""}${dRecall}, precision ${dPrecision >= 0 ? "+" : ""}${dPrecision}`);
    if (args.has("--check") && (dRecall < -0.1 || dPrecision < -0.1)) {
      console.error("Quality dropped more than 0.1 vs baseline");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
