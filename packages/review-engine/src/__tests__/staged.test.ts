import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, LLMRequest } from "../llm/types";
import { dedupeFindings } from "../pipeline/dedupe";
import { runStagedReview, renderContext, type ReviewContext } from "../pipeline/staged";
import { parsePolicy } from "../policy";
import type { Finding } from "../schema";

const PATCH = `@@ -1,3 +1,4 @@
 export function verifyToken(token, key) {
-  return jwt.verify(token, key, { algorithms: ["RS256"] });
+  const alg = process.env.JWT_ALG ?? "none";
+  return jwt.verify(token, key, { algorithms: [alg] });
 }`;
const files = [{ filename: "src/auth/jwt.ts", status: "modified", additions: 2, deletions: 1, patch: PATCH }];
const head = 'export function verifyToken(token, key) {\n  const alg = process.env.JWT_ALG ?? "none";\n  return jwt.verify(token, key, { algorithms: [alg] });\n}\n';

function context(yaml: string | null = null): ReviewContext {
  const { policy, warnings } = parsePolicy(yaml);
  return {
    policy,
    policyWarnings: warnings,
    related: [{ path: "src/api/login.ts", symbol: "login", startLine: 1, endLine: 3, content: "export function login() {}" }],
    callers: [{ symbol: "verifyToken", path: "src/middleware/auth.ts", line: 12, snippet: "   12 | const user = verifyToken(req.token, KEY);" }],
    affected: [{ path: "src/middleware/auth.ts", distance: 1, via: "src/auth/jwt.ts" }],
    risk: { score: 60, level: "high", factors: ["touches sensitive code: src/auth/jwt.ts"] },
    headContents: new Map([["src/auth/jwt.ts", head]]),
  };
}

const finding = (o: object) => ({ file: "src/auth/jwt.ts", line: 2, severity: "critical", category: "security", message: "Algorithm defaults to none, which disables signature verification.", suggestion: null, ...o });

/** A fake model that answers by looking at which prompt it got. */
function scriptedProvider(opts: { verdict?: "confirmed" | "rejected" | "uncertain"; failReviewer?: string } = {}) {
  const complete = vi.fn(async (req: LLMRequest) => {
    const s = req.system;
    let out: unknown;
    if (s.includes("summarise what a pull request does")) {
      out = { summary: "Makes the JWT algorithm configurable.", changeType: "feature", stated: true, alignment: "aligned", alignmentScore: 8, alignmentSummary: "Matches." };
    } else if (s.includes("independent verifier")) {
      const ids = [...req.messages[0].content.matchAll(/<finding id="(\d+)">/g)].map((m) => Number(m[1]));
      out = { verdicts: ids.map((id) => ({ id, verdict: opts.verdict ?? "confirmed", confidence: 0.9, reason: "visible in code" })) };
    } else if (s.includes("application security engineer")) {
      if (opts.failReviewer === "security") throw new Error("rate limited");
      out = { findings: [finding({})] };
    } else if (s.includes("CORRECTNESS and QUALITY")) {
      // Same problem, phrased differently, one line away → must be deduped
      out = { findings: [finding({ line: 3, severity: "high", category: "bug", message: "Algorithm none disables signature verification of the token." })] };
    } else {
      out = { findings: [] };
    }
    return { text: JSON.stringify(out), tokens: 10 };
  });
  return { name: "fake", model: "fake-1", complete } satisfies LLMProvider;
}

describe("runStagedReview", () => {
  it("runs every stage, dedupes, verifies, scores and decides by policy", async () => {
    const provider = scriptedProvider();
    const progress: string[] = [];
    const res = await runStagedReview({ provider, title: "Configurable alg", body: null, files, lint: [], context: context(), onProgress: (n) => void progress.push(n) });

    expect(progress).toEqual([
      "committer", "blast_radius", "risk_assessment", "quality",
      "aggregate_findings", "deduplicate_findings", "independent_verify",
      "scorecard", "policy_evaluation", "assurance_decision",
    ]);
    expect(res.findings).toHaveLength(1); // the two reviewers' duplicate collapsed into the more severe one
    expect(res.findings[0]).toMatchObject({ severity: "critical", verdict: "confirmed", reviewer: "security" });
    expect(res.score).toBe(70); // 100 − 30 (critical)
    expect(res.decision).toMatchObject({ verdict: "request_changes", conclusion: "failure" }); // default fail_on: [critical]
    expect(res.assurance.scorecard?.overall).toBe(7);
    expect(res.assurance.intent?.summary).toContain("JWT");
    expect(res.summary).toContain("Risk: high");
  });

  it("drops findings the verifier rejects and records them", async () => {
    const res = await runStagedReview({ provider: scriptedProvider({ verdict: "rejected" }), title: "t", body: null, files, lint: [], context: context() });
    expect(res.findings).toEqual([]);
    expect(res.score).toBe(100);
    expect(res.assurance.verification?.rejected).toHaveLength(1);
    expect(res.decision.verdict).toBe("approve");
  });

  it("uncertain findings are shown but cannot block the merge", async () => {
    const res = await runStagedReview({ provider: scriptedProvider({ verdict: "uncertain" }), title: "t", body: null, files, lint: [], context: context() });
    expect(res.findings[0].verdict).toBe("uncertain");
    expect(res.decision.conclusion).toBe("success");
    expect(res.score).toBe(85); // uncertain counts half
  });

  it("survives one reviewer failing and marks that dimension unscored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await runStagedReview({ provider: scriptedProvider({ failReviewer: "security" }), title: "t", body: null, files, lint: [], context: context() });
    expect(res.findings[0].reviewer).toBe("quality");
    expect(res.assurance.scorecard?.dimensions.find((d) => d.id === "security")?.score).toBeNull();
    expect(res.assurance.recommendations.join(" ")).toContain("security");
  });

  it("follows the team's policy file", async () => {
    const res = await runStagedReview({ provider: scriptedProvider(), title: "t", body: null, files, lint: [], context: context("fail_on: []") });
    expect(res.decision.conclusion).toBe("success");
  });
});

describe("renderContext", () => {
  it("puts team rules and callers before RAG chunks, and respects the budget", () => {
    const ctx = context('path_instructions:\n  - path: "src/auth/**"\n    instructions: "Pin algorithms."');
    const text = renderContext(ctx, ["src/auth/jwt.ts"], 10_000);
    expect(text.indexOf("<team_rules>")).toBeLessThan(text.indexOf("<callers"));
    expect(text.indexOf("<callers")).toBeLessThan(text.indexOf("<related_code"));
    expect(renderContext(ctx, ["src/auth/jwt.ts"], 40)).not.toContain("<related_code");
  });
});

describe("dedupeFindings", () => {
  const base: Finding = { file: "a.ts", line: 10, severity: "medium", category: "bug", message: "Missing await on save() call", suggestion: null, source: "ai", inline: true };
  it("keeps distinct problems on the same line", () => {
    expect(dedupeFindings([base, { ...base, category: "security", message: "User input is passed to eval" }])).toHaveLength(2);
  });
  it("merges the same problem reported under different categories on the same line (seen in evals)", () => {
    const a = { ...base, line: 7, severity: "high" as const, category: "bug" as const, message: "Removing the await on chargeCard makes the payment request fire-and-forget; the order is marked paid even if it fails." };
    const b = { ...base, line: 7, severity: "high" as const, category: "security" as const, message: "Removed the await before chargeCard, making the payment call fire-and-forget. Errors from the payment are ignored." };
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it("keeps the more severe of two duplicates", () => {
    const out = dedupeFindings([base, { ...base, line: 11, severity: "high", message: "save() call is missing an await" }]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
  });
});
