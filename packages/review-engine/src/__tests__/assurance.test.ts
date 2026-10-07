import { describe, it, expect, vi } from "vitest";
import {
  ImportResolver,
  aggregateFindings,
  analyzeBlastRadius,
  analyzeCohesion,
  analyzeCommitter,
  analyzeCriticality,
  analyzeTesting,
  analyzeVolume,
  applyFindingVerdicts,
  assessRisk,
  buildScorecard,
  decideAssurance,
  deduplicateFindings,
  detectTechnology,
  evaluatePolicies,
  filterForReport,
  makeFinding,
  planVerification,
  resolveSkills,
  runPipeline,
  scanRiskyPatterns,
  scanSecrets,
  PipelineError,
} from "../assurance";
import type { Finding, PipelineNode } from "../assurance";
import { AnthropicProvider } from "../anthropic";
import { LLMError } from "../llm";
import { addedLines } from "../diff";
import { parseRepoConfig, DEFAULT_REPO_CONFIG } from "../repo-config";

const file = (filename: string, added: string[], status = "modified") => ({
  filename,
  status,
  additions: added.length,
  deletions: 0,
  patch: `@@ -1,0 +10,${added.length} @@\n${added.map((l) => `+${l}`).join("\n")}`,
});

const finding = (over: Partial<Finding> = {}): Finding =>
  makeFinding({ source: "quality", severity: "medium", category: "bug", file: "a.ts", line: 10, message: "Null dereference of user object", confidence: 0.7, deterministic: false, ...over });

describe("addedLines", () => {
  it("numbers added lines on the new side", () => {
    expect(addedLines("@@ -1,2 +5,3 @@\n ctx\n+one\n-gone\n+two")).toEqual([
      { line: 6, text: "one" },
      { line: 7, text: "two" },
    ]);
  });
});

describe("security scan", () => {
  // Fake credentials are assembled at runtime so secret scanners (gitleaks in
  // CI) don't flag this file.
  const fakeAwsKey = "AKIA" + "ABCDEFGHIJKLMNOP";
  const fakeClientSecret = "q8Zr2xN7" + "vLp4Tk9Wm3Yb";

  it("finds provider tokens with high confidence and redacts them", () => {
    const [f] = scanSecrets([file("src/config.ts", [`const key = "${fakeAwsKey}";`])]);
    expect(f).toMatchObject({ ruleId: "secret/aws-access-key", severity: "critical", line: 10, deterministic: true });
    expect(f.confidence).toBeGreaterThanOrEqual(0.9);
    expect(f.message).not.toContain(fakeAwsKey);
  });

  it("treats secrets in tests as lower confidence and ignores placeholders", () => {
    const test = scanSecrets([file("src/__tests__/x.test.ts", ['const k = "ghp_' + "a".repeat(36) + '"'])]);
    expect(test[0].confidence).toBeLessThan(0.9);
    expect(scanSecrets([file("src/a.ts", ['password = "changeme"', 'api_key: "${API_KEY}"'])])).toEqual([]);
  });

  it("flags generic high-entropy assignments", () => {
    const [f] = scanSecrets([file("src/a.ts", [`const clientSecret = "${fakeClientSecret}";`])]);
    expect(f.ruleId).toBe("secret/generic-assignment");
  });

  it("flags risky patterns only in matching languages and not in comments", () => {
    const found = scanRiskyPatterns([
      file("src/run.ts", ["exec(`rm -rf ${dir}`)", "// eval(x) is bad"]),
      file("app/db.py", ["subprocess.run(cmd, shell=True)"]),
      file("README.md", ["eval(x)"]),
    ]);
    expect(found.map((f) => f.ruleId).sort()).toEqual(["rule/js-shell-exec", "rule/py-shell-true"]);
  });
});

describe("stage 1 analyzers", () => {
  it("classifies committer trust", () => {
    expect(analyzeCommitter({ login: "a", association: "MEMBER", isBot: false, priorPRs: 10, coAuthors: [] }).trust).toBe("maintainer");
    expect(analyzeCommitter({ login: "b", association: "FIRST_TIME_CONTRIBUTOR", isBot: false, priorPRs: 0, coAuthors: [] }).trust).toBe("newcomer");
    expect(analyzeCommitter({ login: "dependabot[bot]", association: "NONE", isBot: true, priorPRs: 3, coAuthors: [] }).trust).toBe("bot");
  });

  it("measures volume without lockfiles and flags oversized PRs", () => {
    const big = { filename: "src/a.ts", status: "modified", additions: 900, deletions: 100, patch: null };
    const lock = { filename: "pnpm-lock.yaml", status: "modified", additions: 5000, deletions: 0, patch: null };
    const { report, findings } = analyzeVolume([big, lock], 800);
    expect(report.meaningfulLines).toBe(1000);
    expect(report.size).toBe("XL");
    expect(findings[0].ruleId).toBe("volume/too-large");
    expect(analyzeVolume([lock], 800).findings).toEqual([]);
  });

  it("clusters related files and flags unrelated changes", () => {
    const related = analyzeCohesion(["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"], (a, b) => a === "src/b/z.ts" && b === "src/a/x.ts");
    expect(related.report.clusters).toHaveLength(1);
    const scattered = analyzeCohesion(["api/routes/u.ts", "web/ui/btn.tsx", "infra/k8s/x.ts"], () => false);
    expect(scattered.report.clusters).toHaveLength(3);
    expect(scattered.findings[0].ruleId).toBe("cohesion/unrelated-changes");
  });
});

describe("stage 2 analyzers", () => {
  const importers: Record<string, string[]> = { "lib/token.ts": ["lib/auth.ts"], "lib/auth.ts": ["api/users.ts", "api/admin.ts"] };

  it("walks reverse imports transitively", () => {
    const blast = analyzeBlastRadius(["lib/token.ts"], (p) => importers[p] ?? [], { graphAvailable: true });
    expect(blast.dependents).toEqual([
      { path: "lib/auth.ts", distance: 1 },
      { path: "api/admin.ts", distance: 2 },
      { path: "api/users.ts", distance: 2 },
    ]);
    expect(blast.directCount).toBe(1);
  });

  it("scores criticality from paths and custom globs", () => {
    const blast = analyzeBlastRadius([], () => [], { graphAvailable: false });
    const low = analyzeCriticality(["src/utils/format.ts"], [], blast);
    expect(low.report.level).toBe("low");
    const high = analyzeCriticality(["src/auth/session.ts", "migrations/0003.sql", "src/billing/x.ts"], ["src/billing/**"], blast);
    expect(["high", "critical"]).toContain(high.report.level);
    expect(high.findings[0].ruleId).toBe("criticality/critical-path");
  });

  it("combines factors into one risk level", () => {
    const blast = analyzeBlastRadius([], () => [], { graphAvailable: false });
    const volume = analyzeVolume([{ filename: "a.ts", status: "modified", additions: 5, deletions: 0, patch: null }], 800).report;
    const risk = assessRisk({
      volume,
      cohesion: { clusters: [["a.ts"]], areas: ["(root)"], score: 1 },
      committer: analyzeCommitter({ login: "a", association: "OWNER", isBot: false, priorPRs: 5, coAuthors: [] }),
      blast,
      criticality: analyzeCriticality(["a.ts"], [], blast).report,
    });
    expect(risk.level).toBe("low");
  });
});

describe("testing analyzer", () => {
  it("reports failing CI and source changes without tests", () => {
    const { report, findings } = analyzeTesting(
      [file("src/service.ts", ["x"])],
      [
        { name: "build", status: "completed", conclusion: "failure" },
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "e2e", status: "in_progress", conclusion: null },
      ],
      DEFAULT_REPO_CONFIG.policy
    );
    expect(findings.map((f) => f.ruleId)).toEqual(["ci/build", "testing/no-tests"]);
    expect(report.ci).toMatchObject({ passed: 1, failed: ["build"], pending: ["e2e"] });
    expect(report.untestedFiles).toEqual(["src/service.ts"]);
  });

  it("matches tests to sources by name", () => {
    const { report, findings } = analyzeTesting([file("src/service.ts", ["x"]), file("src/__tests__/service.test.ts", ["y"])], [], DEFAULT_REPO_CONFIG.policy);
    expect(report.untestedFiles).toEqual([]);
    expect(findings).toEqual([]);
  });
});

describe("findings pipeline", () => {
  it("drops unknown files to PR level during aggregation", () => {
    const [kept, moved] = aggregateFindings([[finding({ file: "./a.ts" }), finding({ file: "nope.ts" })]], new Set(["src/a.ts", "a.ts"]));
    expect(kept.file).toBe("a.ts");
    expect(moved).toMatchObject({ file: null, line: null });
  });

  it("merges duplicates across sources and raises confidence", () => {
    const a = finding({ source: "quality", severity: "medium", confidence: 0.6 });
    const b = finding({ source: "security", severity: "high", category: "security", line: 11, message: "Possible null dereference of the user object", confidence: 0.6 });
    const other = finding({ line: 40, message: "Loop never terminates when the list is empty" });
    const { findings, removed } = deduplicateFindings([a, b, other]);
    expect(removed).toBe(1);
    expect(findings[0]).toMatchObject({ severity: "high", alsoReportedBy: ["quality"] });
    expect(findings[0].confidence).toBeGreaterThan(0.6);
  });

  it("trusts deterministic findings and verifies model findings", () => {
    const secret = finding({ source: "security", deterministic: true, confidence: 0.95, ruleId: "secret/x" });
    const model = finding();
    const tiny = finding({ severity: "low" });
    const plan = planVerification([secret, model, tiny], { ...DEFAULT_REPO_CONFIG, min_severity: "medium" });
    expect(plan.trusted.map((f) => f.id)).toEqual([secret.id]);
    expect(plan.verify.map((f) => f.id)).toEqual([model.id]);
    expect(plan.dropped).toHaveLength(1);
  });

  it("applies verdicts: confirm, lower, reject", () => {
    const fs = [finding({ message: "a" }), finding({ message: "b", severity: "high" }), finding({ message: "c" })];
    const r = applyFindingVerdicts(fs, {
      verdicts: [
        { id: 0, verdict: "confirmed", reason: "" },
        { id: 1, verdict: "uncertain", reason: "" },
        { id: 2, verdict: "rejected", reason: "not in diff" },
      ],
    });
    expect(r.findings.map((f) => [f.message, f.severity, f.verification])).toEqual([
      ["a", "medium", "confirmed"],
      ["b", "medium", "uncertain"],
    ]);
    expect(r.rejected[0].reason).toBe("not in diff");
  });

  it("filters by min_confidence", () => {
    const { kept, filtered } = filterForReport([finding({ confidence: 0.3 }), finding({ confidence: 0.8, line: 50, message: "x" })], DEFAULT_REPO_CONFIG);
    expect(kept).toHaveLength(1);
    expect(filtered).toHaveLength(1);
  });
});

describe("scorecard, policy and decision", () => {
  const blast = analyzeBlastRadius([], () => [], { graphAvailable: false });
  const volume = analyzeVolume([file("src/a.ts", ["x"])], 800).report;
  const committer = analyzeCommitter({ login: "a", association: "OWNER", isBot: false, priorPRs: 3, coAuthors: [] });
  const criticality = analyzeCriticality(["src/a.ts"], [], blast).report;
  const cohesion = { clusters: [["src/a.ts"]], areas: ["src"], score: 1 };
  const risk = assessRisk({ volume, cohesion, committer, blast, criticality });
  const testing = analyzeTesting([file("src/a.ts", ["x"]), file("src/a.test.ts", ["y"])], [], DEFAULT_REPO_CONFIG.policy).report;

  const evaluate = (findings: Finding[], config = DEFAULT_REPO_CONFIG) => {
    const scorecard = buildScorecard({ findings, alignment: null, volume, cohesion, risk, testing });
    const policies = evaluatePolicies({ config, findings, scorecard, volume, testing, committer, criticality });
    return { scorecard, policies, decision: decideAssurance({ policies, findings, risk }) };
  };

  it("approves a clean, small change", () => {
    const { scorecard, decision } = evaluate([]);
    expect(scorecard.overall).toBeGreaterThanOrEqual(9);
    expect(scorecard.dimensions.find((d) => d.id === "intent")!.score).toBeNull();
    expect(decision).toMatchObject({ verdict: "approve", conclusion: "success" });
  });

  it("requests changes when a secret is found", () => {
    const secret = finding({ source: "security", category: "security", severity: "critical", ruleId: "secret/aws-access-key", deterministic: true, confidence: 0.95 });
    const { policies, decision } = evaluate([secret]);
    expect(policies.find((p) => p.id === "secrets")!.status).toBe("fail");
    expect(decision).toMatchObject({ verdict: "request_changes", conclusion: "failure" });
  });

  it("comments on medium findings and fails on min_score", () => {
    expect(evaluate([finding()]).decision.verdict).toBe("comment");
    const strict = parseRepoConfig("policy:\n  min_score: 9.9\n").config;
    expect(evaluate([finding()], strict).decision.verdict).toBe("request_changes");
  });
});

describe("technology, skills and import resolution", () => {
  const paths = ["package.json", "pnpm-workspace.yaml", "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/src/lib/api.ts", "apps/web/src/app/page.tsx", "packages/db/package.json", "packages/db/index.ts", "packages/db/schema/users.ts", "apps/workers/src/a.ts", "apps/workers/src/b.ts"];
  const manifests = {
    "package.json": JSON.stringify({ name: "root", packageManager: "pnpm@10.0.0" }),
    "apps/web/package.json": JSON.stringify({ name: "web", dependencies: { next: "16", react: "19", "drizzle-orm": "1" }, devDependencies: { vitest: "2" } }),
    "apps/web/tsconfig.json": '{ // comment\n "compilerOptions": { "paths": { "@/*": ["./src/*"] }, }, }',
    "packages/db/package.json": JSON.stringify({ name: "@codeguard/db" }),
  };
  const tech = detectTechnology(paths, manifests);

  it("detects frameworks, aliases and workspace packages", () => {
    expect(tech.frameworks).toEqual(expect.arrayContaining(["Next.js", "React", "Drizzle ORM"]));
    expect(tech.testFrameworks).toEqual(["Vitest"]);
    expect(tech.monorepo).toBe(true);
    expect(tech.pathAliases["@/*"]).toEqual(["apps/web/src/*"]);
    expect(tech.workspacePackages["@codeguard/db"]).toBe("packages/db");
  });

  it("resolves aliases, workspace packages, .js→.ts and relative imports to real files", () => {
    const r = new ImportResolver({ files: paths, pathAliases: tech.pathAliases, workspacePackages: tech.workspacePackages });
    expect(r.resolve("apps/web/src/app/page.tsx", "@/lib/api")).toBe("apps/web/src/lib/api.ts");
    expect(r.resolve("apps/web/src/app/page.tsx", "@codeguard/db")).toBe("packages/db/index.ts");
    expect(r.resolve("apps/web/src/app/page.tsx", "@codeguard/db/schema/users")).toBe("packages/db/schema/users.ts");
    expect(r.resolve("apps/workers/src/a.ts", "./b.js")).toBe("apps/workers/src/b.ts");
    expect(r.resolve("apps/workers/src/a.ts", "./missing")).toBeNull();
    expect(r.resolve("apps/workers/src/a.ts", "react")).toBeNull();
  });

  it("selects skills for the stack and honours config", () => {
    const skills = resolveSkills(tech, { enable: ["kafka-consumer"], disable: ["react"] });
    expect(skills.ids).toEqual(expect.arrayContaining(["nextjs", "sql-orm", "kafka-consumer", "secrets-hygiene"]));
    expect(skills.ids).not.toContain("react");
    expect(skills.ids).not.toContain("python");
  });
});

describe("runPipeline", () => {
  it("runs steps in order, groups in parallel with a join, and records the trace", async () => {
    const order: string[] = [];
    const step = (name: string, opts: { fail?: boolean; optional?: boolean } = {}) => ({
      name,
      optional: opts.optional,
      run: async () => {
        order.push(name);
        if (opts.fail) throw new Error(`${name} broke`);
      },
    });
    const nodes: PipelineNode<object>[] = [step("a"), { name: "g", parallel: [step("b"), step("c", { fail: true, optional: true })], join: step("join") }, step("d")];
    const { trace } = await runPipeline(nodes, {});
    expect(order).toEqual(["a", "b", "c", "join", "d"]);
    expect(trace.find((t) => t.name === "c")).toMatchObject({ status: "failed", group: "g", error: "c broke" });
  });

  it("fails on a required step and skips the rest after a stop", async () => {
    const failing: PipelineNode<object>[] = [{ name: "x", run: async () => { throw new Error("boom"); } }, { name: "y", run: vi.fn() }];
    await expect(runPipeline(failing, {})).rejects.toBeInstanceOf(PipelineError);

    const state = { stop: null as string | null };
    const later = vi.fn();
    const { trace, stoppedEarly } = await runPipeline<typeof state>(
      [{ name: "check", run: async (s) => { s.stop = "duplicate"; } }, { name: "work", run: later }],
      state,
      { stopReason: () => state.stop }
    );
    expect(later).not.toHaveBeenCalled();
    expect(stoppedEarly).toBe("duplicate");
    expect(trace.at(-1)).toMatchObject({ name: "work", status: "skipped" });
  });
});

describe("AnthropicProvider", () => {
  const client = (response: unknown) => ({ beta: { messages: { create: vi.fn(async (_params: Record<string, unknown>) => response) } } });

  it("sends system separately, enables fallbacks, and reads only text blocks", async () => {
    const c = client({
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":true}' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", effort: "high", client: c as never });
    const result = await provider.completeJSON([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(result).toEqual({ content: '{"ok":true}', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });
    const params = c.beta.messages.create.mock.calls[0][0];
    expect(params).toMatchObject({ model: "claude-opus-5-5", system: "sys", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "high" } });
    expect(params).not.toHaveProperty("temperature");
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("treats a refusal as permanent", async () => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "m", client: client({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [], usage: { input_tokens: 1, output_tokens: 0 } }) as never });
    const err = await provider.completeJSON([{ role: "user", content: "x" }]).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.retryable).toBe(false);
  });
});
