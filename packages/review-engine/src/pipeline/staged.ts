import { z } from "zod";
import type { AffectedFile } from "../context/graph";
import { CRITICAL_PATH, type Risk } from "../context/risk";
import type { CallerSnippet } from "../context/symbols";
import { buildDiffContext, estimateTokens, type DiffFile } from "../diff";
import type { LintFinding } from "../lint";
import type { LLMProvider } from "../llm/types";
import { decide, instructionsFor, type Decision, type Policy } from "../policy";
import { buildReviewUserPrompt } from "../prompt";
import { groundFindings } from "../review";
import { ReviewerOutput, type Finding } from "../schema";
import { dedupeFindings } from "./dedupe";
import { completeJson } from "./llm-json";
import { INTENT_SYSTEM, REVIEWER_SYSTEMS, type ReviewerName } from "./prompts";
import { dimensions, overallScore } from "./scorecard";
import { verifyFindings, type Rejected, type VerifiedFinding } from "./verifier";

/**
 * Day 3: the staged review.
 *
 *   Stage 1  committer          what changed? does it match the description?   (1 small model call)
 *   Stage 2  risk_assessment    how risky? (computed by code, see context/risk.ts)
 *   Stage 3  quality ∥ security ∥ testing                                    (3 model calls in parallel)
 *   Merge    aggregate + dedupe
 *   Verify   independent_verify                                             (1 call per 8 findings)
 *   Decide   scorecard → policy_evaluation → assurance_decision             (code)
 *
 * It's a fixed PIPELINE, not an agent: same steps every time, so it's predictable,
 * cheap, testable, and every run leaves a trace you can debug.
 */

export interface RelatedChunk {
  path: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ReviewContext {
  policy: Policy;
  policyWarnings: string[];
  related: RelatedChunk[];
  callers: CallerSnippet[];
  affected: AffectedFile[];
  risk: Risk;
  /** HEAD version of changed files (verifier code windows). */
  headContents: Map<string, string>;
}

/** Matches the Assurance interface in apps/web/src/app/reviews/[id]/page.tsx. */
export interface Assurance {
  decision: { verdict: string; conclusion: string; headline: string; reasons: string[] } | null;
  scorecard: { overall: number; dimensions: Array<{ id: string; label: string; score: number | null; note: string }> } | null;
  policies: Array<{ id: string; status: string; message: string }>;
  risk: { score: number; level: string; factors: string[] } | null;
  intent: { summary: string; changeType: string; stated: boolean } | null;
  alignment: { alignment: string; score: number; summary: string } | null;
  recommendations: string[];
  skills: string[];
  verification: { status: string; confirmed: number; uncertain: number; rejected: Rejected[] } | null;
  trace: Array<{ name: string; status: string; durationMs: number }>;
}

export interface StagedInput {
  provider: LLMProvider;
  /** Ideally a different (stronger) model than the reviewers; defaults to `provider`. */
  verifierProvider?: LLMProvider;
  title: string;
  body: string | null;
  files: DiffFile[];
  lint: LintFinding[];
  context: ReviewContext;
  maxDiffTokens?: number;
  maxContextTokens?: number;
  onProgress?: (node: string) => unknown;
}

export interface StagedResult {
  summary: string;
  score: number; // 0–100
  findings: VerifiedFinding[];
  tokens: number;
  model: string;
  assurance: Assurance;
  decision: Decision;
  reviewedFiles: string[];
  skippedFiles: Array<{ filename: string; reason: string }>;
}

const Intent = z.object({
  summary: z.string().min(1).max(600),
  changeType: z.string().min(1).max(30),
  stated: z.boolean(),
  alignment: z.enum(["aligned", "partial", "misaligned", "unknown"]),
  alignmentScore: z.coerce.number().min(0).max(10),
  alignmentSummary: z.string().max(400).default(""),
});

const fence = (s: string) => s.replace(/<\/?\s*(untrusted|related_code|callers|affected_files|team_rules|diff|file|tool_findings)[^>]*>/gi, "[tag removed]");

/**
 * Context sections in order of value, added until the budget runs out:
 * team rules → callers → affected files → related code (RAG).
 * The security reviewer sees sensitive-path chunks first.
 */
export function renderContext(ctx: ReviewContext, changedPaths: string[], budgetTokens: number, reviewer?: ReviewerName): string {
  const parts: string[] = [];
  let used = 0;
  const add = (block: string) => {
    const cost = estimateTokens(block);
    if (used + cost > budgetTokens) return false;
    parts.push(block);
    used += cost;
    return true;
  };

  const rules = instructionsFor(changedPaths, ctx.policy);
  if (rules.length) add(`<team_rules>\n${rules.map((r) => `- ${r.path} (applies to ${r.files.join(", ")}): ${r.instructions}`).join("\n")}\n</team_rules>`);

  for (const c of ctx.callers) add(`<callers of="${c.symbol}" path="${c.path}" line="${c.line}">\n${fence(c.snippet)}\n</callers>`);

  if (ctx.affected.length) {
    add(`<affected_files count="${ctx.affected.length}">\n${ctx.affected.slice(0, 40).map((a) => `${a.path} (distance ${a.distance}, via ${a.via})`).join("\n")}\n</affected_files>`);
  }

  const related = reviewer === "security"
    ? [...ctx.related].sort((a, b) => Number(CRITICAL_PATH.test(b.path)) - Number(CRITICAL_PATH.test(a.path)))
    : ctx.related;
  for (const r of related) {
    if (!add(`<related_code path="${r.path}" lines="${r.startLine}-${r.endLine}"${r.symbol ? ` symbol="${r.symbol}"` : ""}>\n${fence(r.content.slice(0, 3000))}\n</related_code>`)) break;
  }
  return parts.join("\n\n");
}

export async function runStagedReview(input: StagedInput): Promise<StagedResult> {
  const trace: Assurance["trace"] = [];
  let tokens = 0;
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    await input.onProgress?.(name);
    const t = Date.now();
    try {
      const out = await fn();
      trace.push({ name, status: "ok", durationMs: Date.now() - t });
      return out;
    } catch (err) {
      trace.push({ name, status: "failed", durationMs: Date.now() - t });
      throw err;
    }
  };

  const { context: ctx, policy } = { context: input.context, policy: input.context.policy };
  const diff = buildDiffContext(input.files, input.maxDiffTokens ?? 12_000);
  const changedPaths = diff.included.map((f) => f.filename);

  if (diff.included.length === 0) {
    const decision = decide({ policy, findings: [], score: 100, warnings: ctx.policyWarnings });
    return {
      summary: "No reviewable code changes (only deleted, binary, generated, ignored or lock files).",
      score: 100,
      findings: [],
      tokens: 0,
      model: input.provider.model,
      decision,
      assurance: emptyAssurance(decision, ctx.risk, trace),
      reviewedFiles: [],
      skippedFiles: diff.skipped,
    };
  }

  // ── Stage 1: what changed? ────────────────────────────────────────────────
  const intentPrompt = buildReviewUserPrompt({
    title: input.title, body: input.body, lint: [], skipped: diff.skipped,
    diffText: buildDiffContext(diff.included, 4_000).text,
  });
  const intent = await step("committer", async () => {
    try {
      const r = await completeJson(input.provider, INTENT_SYSTEM, intentPrompt, Intent, { maxTokens: 600 });
      tokens += r.tokens;
      return r.data;
    } catch (err) {
      console.warn("[staged] intent step failed (continuing):", (err as Error).message);
      return null; // nice-to-have: never fails the review
    }
  });

  // ── Stage 2: risk (already computed from the graph by the caller) ──────────
  await step("blast_radius", () => undefined);
  await step("risk_assessment", () => undefined);

  // ── Stage 3: three focused reviewers in parallel ───────────────────────────
  const reviewers: ReviewerName[] = ["quality", "security", "testing"];
  const results = await step("quality", () =>
    Promise.allSettled(
      reviewers.map(async (name) => {
        const contextText = renderContext(ctx, changedPaths, input.maxContextTokens ?? 6_000, name);
        const lint = name === "quality" ? input.lint : [];
        const user = `${contextText}\n\n${buildReviewUserPrompt({ title: input.title, body: input.body, diffText: diff.text, lint, skipped: diff.skipped })}`;
        const r = await completeJson(input.provider, REVIEWER_SYSTEMS[name], user, ReviewerOutput);
        tokens += r.tokens;
        return groundFindings(r.data, diff.included, lint).map((f): Finding => ({ ...f, reviewer: f.source === "eslint" ? "eslint" : name }));
      }),
    ),
  );
  const failedReviewers = reviewers.filter((_, i) => results[i].status === "rejected");
  results.forEach((r, i) => r.status === "rejected" && console.warn(`[staged] ${reviewers[i]} reviewer failed:`, (r.reason as Error)?.message));
  if (failedReviewers.length === reviewers.length) {
    throw new Error(`all reviewers failed: ${(results[0] as PromiseRejectedResult).reason?.message ?? "unknown error"}`);
  }

  // ── Merge ─────────────────────────────────────────────────────────────────
  const merged = await step("aggregate_findings", () =>
    results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
  );
  const unique = await step("deduplicate_findings", () => dedupeFindings(merged));

  // ── Verify ────────────────────────────────────────────────────────────────
  const teamRules = instructionsFor(changedPaths, policy).map((r) => `- ${r.path}: ${r.instructions}`).join("\n");
  const verification = await step("independent_verify", () =>
    verifyFindings({
      provider: input.verifierProvider ?? input.provider,
      findings: unique,
      files: diff.included,
      headContents: ctx.headContents,
      teamRules: teamRules || undefined,
    }),
  );
  tokens += verification.tokens;
  const findings = verification.kept;

  // ── Decide (code, not AI) ─────────────────────────────────────────────────
  const score = await step("scorecard", () => overallScore(findings));
  const decision = await step("policy_evaluation", () => decide({ policy, findings, score, warnings: ctx.policyWarnings }));
  await step("assurance_decision", () => undefined);

  const counts = (["critical", "high", "medium", "low"] as const)
    .map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  const summary = [
    intent?.summary ?? `Reviewed ${diff.included.length} file(s).`,
    `Risk: ${ctx.risk.level} (${ctx.risk.factors[0]}).`,
    findings.length ? `Found ${findings.length} issue(s): ${counts.join(", ")}.` : "No issues found.",
    verification.rejected.length ? `${verification.rejected.length} possible issue(s) were checked and rejected.` : "",
  ].filter(Boolean).join(" ");

  const recommendations = [
    ...(decision.verdict === "request_changes" ? [`Fix before merging: ${decision.reasons.slice(0, 3).join("; ")}`] : []),
    ...(ctx.risk.level === "high" || ctx.risk.level === "critical"
      ? [`High-impact change (${ctx.risk.factors.slice(0, 2).join("; ")}): ask a second human reviewer.`]
      : []),
    ...(failedReviewers.length ? [`Re-run the review: the ${failedReviewers.join(" and ")} reviewer(s) failed.`] : []),
    ...(intent && intent.alignment === "misaligned" ? ["The code doesn't match the PR description; update one of them."] : []),
  ];

  return {
    summary,
    score,
    findings,
    tokens,
    model: input.provider.model,
    decision,
    reviewedFiles: changedPaths,
    skippedFiles: diff.skipped,
    assurance: {
      decision: { verdict: decision.verdict, conclusion: decision.conclusion, headline: decision.headline, reasons: decision.reasons },
      scorecard: { overall: score / 10, dimensions: dimensions(findings, failedReviewers) },
      policies: decision.policies,
      risk: ctx.risk,
      intent: intent ? { summary: intent.summary, changeType: intent.changeType, stated: intent.stated } : null,
      alignment: intent ? { alignment: intent.alignment, score: intent.alignmentScore, summary: intent.alignmentSummary } : null,
      recommendations,
      skills: reviewers.filter((r) => !failedReviewers.includes(r)),
      verification: {
        status: verification.failedBatches ? "partial" : "complete",
        confirmed: findings.filter((f) => f.verdict === "confirmed").length,
        uncertain: findings.filter((f) => f.verdict === "uncertain").length,
        rejected: verification.rejected,
      },
      trace,
    },
  };
}

function emptyAssurance(decision: Decision, risk: Risk, trace: Assurance["trace"]): Assurance {
  return {
    decision: { verdict: decision.verdict, conclusion: decision.conclusion, headline: decision.headline, reasons: decision.reasons },
    scorecard: null,
    policies: decision.policies,
    risk,
    intent: null,
    alignment: null,
    recommendations: [],
    skills: [],
    verification: null,
    trace,
  };
}
