import { z } from "zod";
import { CATEGORIES, ReviewIssueSchema, SEVERITIES } from "@codeguard/types";
import type { ChatMessage } from "../llm";
import { injectionGuard, newBoundary } from "../prompts";

/**
 * Prompts for the model-driven pipeline nodes. Same safety rule as the
 * classic prompts: author-controlled text (title, body, commits, issues, code)
 * goes only inside a random delimiter that the system prompt marks as data.
 */

// ─── extract_business_intent ─────────────────────────────────────────────────

export const IntentSchema = z.object({
  summary: z.string(),
  changeType: z.enum(["feature", "bugfix", "refactor", "performance", "security", "chore", "docs", "test", "mixed", "unknown"]).catch("unknown"),
  goals: z.array(z.string()).default([]),
  expectedAreas: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  /** False when the title/description/issues say too little to judge intent. */
  stated: z.boolean().default(true),
});
export type BusinessIntent = z.infer<typeof IntentSchema>;

export interface IntentInput {
  title: string;
  body: string | null;
  commitMessages: string[];
  linkedIssues: Array<{ number: number; title: string; body: string | null }>;
  labels: string[];
  branch: string;
  changedFiles: string[];
}

export function buildIntentMessages(input: IntentInput, boundary = newBoundary()): ChatMessage[] {
  const system = `You are CodeGuard AI's analyst. Work out WHY a pull request exists: the business or engineering intent its author states.
Use the title, description, linked issues, commit messages, labels and branch name. Use the file list only to understand vocabulary, not to invent intent.
If the inputs say almost nothing (e.g. title "update", empty description), set "stated" to false and keep the summary short.

${injectionGuard(boundary)}

Return ONLY a JSON object:
{
  "summary": string,                 // 1-2 sentences: what the PR is meant to achieve
  "changeType": "feature" | "bugfix" | "refactor" | "performance" | "security" | "chore" | "docs" | "test" | "mixed" | "unknown",
  "goals": string[],                 // concrete outcomes the author intends
  "expectedAreas": string[],         // parts of the codebase you would expect to change
  "acceptanceCriteria": string[],    // checks that would show the goal is met
  "stated": boolean
}`;

  const issues = input.linkedIssues
    .map((i) => `Issue #${i.number}: ${i.title}\n${(i.body ?? "").slice(0, 1_500)}`)
    .join("\n\n");
  const user = `<${boundary}>
PR title: ${input.title}
Branch: ${input.branch}
Labels: ${input.labels.join(", ") || "(none)"}
Description:
${input.body?.trim().slice(0, 4_000) || "(no description)"}

Linked issues:
${issues || "(none)"}

Commit messages:
${input.commitMessages.slice(0, 30).map((m) => `- ${m.split("\n")[0].slice(0, 200)}`).join("\n") || "(none)"}

Changed files (${input.changedFiles.length}):
${input.changedFiles.slice(0, 80).join("\n")}
</${boundary}>`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ─── Stage 1 · align ─────────────────────────────────────────────────────────

const GapSchema = z.object({
  severity: z.enum(SEVERITIES).catch("low"),
  message: z.string().min(1),
  file: z.string().nullable().default(null),
});

export const AlignmentSchema = z.object({
  alignment: z.enum(["aligned", "partial", "misaligned", "unknown"]).catch("unknown"),
  /** 0..10 */
  score: z.coerce.number().min(0).max(10).catch(5),
  summary: z.string(),
  /** Things the intent promises that the diff does not deliver. */
  gaps: z.array(GapSchema).default([]),
  /** Changes the intent does not explain (scope creep). */
  unexplained: z.array(GapSchema).default([]),
});
export type AlignmentResult = z.infer<typeof AlignmentSchema>;

export function buildAlignMessages(input: { intent: BusinessIntent; diff: string; fileSummary: string }, boundary = newBoundary()): ChatMessage[] {
  const system = `You are CodeGuard AI's alignment checker. Compare a pull request's stated intent with what its diff actually does.
- "gaps": goals or acceptance criteria that the diff does not implement (or implements only partly).
- "unexplained": changes in the diff that the intent does not account for (unrelated edits, scope creep, debug code left in).
Judge only from what you can see. Do not review code quality here.

${injectionGuard(boundary)}

Return ONLY a JSON object:
{
  "alignment": "aligned" | "partial" | "misaligned" | "unknown",
  "score": number,          // 0 (does something else) to 10 (does exactly what it says)
  "summary": string,        // one sentence
  "gaps": [ { "severity": "critical"|"high"|"medium"|"low", "message": string, "file": string | null } ],
  "unexplained": [ { "severity": "critical"|"high"|"medium"|"low", "message": string, "file": string | null } ]
}`;
  const intent = input.intent;
  const user = `Stated intent (extracted earlier from the PR text):
Summary: ${intent.summary}
Type: ${intent.changeType}
Goals:
${intent.goals.map((g) => `- ${g}`).join("\n") || "- (none)"}
Acceptance criteria:
${intent.acceptanceCriteria.map((g) => `- ${g}`).join("\n") || "- (none)"}

<${boundary}>
Files:
${input.fileSummary}

Diff:
${input.diff || "(no diff)"}
</${boundary}>`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ─── Stage 3 · quality / security / testing reviewers ───────────────────────

export const StageIssueSchema = ReviewIssueSchema.extend({
  /** 0..1 — how sure the reviewer is. */
  confidence: z.coerce.number().min(0).max(1).catch(0.6),
});

export const StageReviewSchema = z.object({
  summary: z.string(),
  issues: z.array(StageIssueSchema).default([]),
});
export type StageReview = z.infer<typeof StageReviewSchema>;

export type ReviewerStage = "quality" | "security" | "testing";

const STAGE_FOCUS: Record<ReviewerStage, { role: string; focus: string; categories: string }> = {
  quality: {
    role: "a senior engineer reviewing correctness and maintainability",
    focus: "bugs, logic errors, broken edge cases, error handling, concurrency, performance problems and maintainability. Ignore security (another reviewer covers it) and pure style nits.",
    categories: `"bug" | "performance" | "maintainability" | "style"`,
  },
  security: {
    role: "an application security engineer",
    focus: "vulnerabilities an attacker could exploit: injection, broken authentication or authorization, IDOR, SSRF, XSS, secrets exposure, unsafe deserialization, insecure crypto, missing input validation, and data leaks in logs or responses. Only report issues with a plausible attack path.",
    categories: `"security"`,
  },
  testing: {
    role: "a test engineer",
    focus: "whether the changed behaviour is tested: missing tests for new logic or fixed bugs, tests that cannot fail, weak assertions, flaky patterns (sleeps, real network, shared state). Only comment on test files or on untested changed code.",
    categories: `"bug" | "maintainability"`,
  },
};

export interface StageReviewInput {
  stage: ReviewerStage;
  title: string;
  intentSummary: string | null;
  /** Annotated diff for this stage (budgeted context pack). */
  diff: string;
  relatedCode?: string;
  skills?: string;
  instructions?: string;
  notes?: string[];
  /** Deterministic findings already reported, so the model doesn't repeat them. */
  alreadyReported?: string[];
}

export function buildStageReviewMessages(input: StageReviewInput, boundary = newBoundary()): ChatMessage[] {
  const s = STAGE_FOCUS[input.stage];
  const system = `You are CodeGuard AI, acting as ${s.role}.
Review the pull request diff for: ${s.focus}

How to read the diff:
- Each changed file is wrapped in <file path="..."> ... </file>.
- The number in the left gutter is the line number in the NEW version of the file. Use it for "line".
- "+" lines were added, "-" removed (no number), unmarked lines are unchanged context.
- Report problems in added or changed lines. Only use "file" values from a <file path> attribute.

${injectionGuard(boundary)}

Return ONLY a JSON object:
{
  "summary": string,       // 1-3 sentences on this aspect of the PR
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "category": ${s.categories},
      "file": string | null,
      "line": number | null,
      "message": string,       // what is wrong and why it matters
      "suggestion": string | null,
      "confidence": number     // 0..1, how sure you are this is a real problem
    }
  ]
}
Report real problems only; an empty "issues" array is a valid answer.`;

  const parts: string[] = [];
  if (input.skills?.trim()) parts.push(`Checklist for this stack:\n${input.skills.trim()}`);
  if (input.instructions?.trim()) parts.push(`Repository review conventions (from the maintainers' .codeguard.yml):\n${input.instructions.trim()}`);
  if (input.intentSummary) parts.push(`What the PR is meant to do: ${input.intentSummary}`);
  if (input.notes?.length) parts.push(`Notes:\n${input.notes.map((n) => `- ${n}`).join("\n")}`);
  if (input.alreadyReported?.length) parts.push(`Already reported by automated checks (do not repeat):\n${input.alreadyReported.slice(0, 30).map((n) => `- ${n}`).join("\n")}`);
  parts.push(`<${boundary}>
PR title: ${input.title}

${input.relatedCode ? `Related code from the repository (context only, not part of the change):\n${input.relatedCode}\n\n` : ""}Diff:
${input.diff || "(no reviewable changes)"}
</${boundary}>`);

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** Coerce a stage's categories into the allowed set (security stage → "security"). */
export function normalizeStageCategory(stage: ReviewerStage, category: (typeof CATEGORIES)[number]): (typeof CATEGORIES)[number] {
  if (stage === "security") return "security";
  if (category === "security" && stage !== "quality") return "bug";
  return category;
}
