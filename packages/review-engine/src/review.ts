import { addedLines, buildDiffContext, commentableLines, type DiffFile } from "./diff";
import type { LintFinding } from "./lint";
import type { LLMProvider } from "./llm/types";
import { completeJson, extractJson } from "./pipeline/llm-json";
import { REVIEW_SYSTEM_PROMPT, buildReviewUserPrompt } from "./prompt";
import { ModelReview, type Finding, type ModelFinding } from "./schema";

export interface ReviewInput {
  provider: LLMProvider;
  title: string;
  body: string | null;
  files: DiffFile[];
  lint?: LintFinding[];
  maxDiffTokens?: number;
}

export interface ReviewResult {
  summary: string;
  score: number;
  findings: Finding[];
  tokens: number;
  model: string;
  reviewedFiles: string[];
  skippedFiles: Array<{ filename: string; reason: string }>;
}

export { extractJson };

const normalizePath = (p: string) => p.trim().replace(/^(\.\/|a\/|b\/)/, "");

/**
 * Our own checks on the model's findings. The model can invent files and lines;
 * we only keep what we can verify against the real diff.
 */
export function groundFindings(review: { findings: ModelFinding[] }, files: DiffFile[], lint: LintFinding[]): Finding[] {
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const commentable = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]));
  const seen = new Set<string>();
  const out: Finding[] = [];

  for (const f of review.findings) {
    const file = normalizePath(f.file);
    if (!byPath.has(file)) continue; // hallucinated or not-in-diff file → drop
    const key = `${file}:${f.line}:${f.message.slice(0, 60).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...f, file, source: "ai", inline: commentable.get(file)!.has(f.line) });
  }

  // ESLint errors the model didn't already cover on the same line.
  const aiLines = new Set(out.map((f) => `${f.file}:${f.line}`));
  for (const l of lint) {
    if (l.severity !== "error" || aiLines.has(`${l.file}:${l.line}`) || !byPath.has(l.file)) continue;
    out.push({
      file: l.file,
      line: l.line,
      severity: "medium",
      category: "bug",
      message: `${l.message} (ESLint: ${l.ruleId})`,
      suggestion: null,
      source: "eslint",
      inline: commentable.get(l.file)!.has(l.line),
      reviewer: "eslint",
    });
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 30);
}

/**
 * Day 2 reviewer: one model call over the numbered diff.
 * (Day 3's runStagedReview is the default now; this stays as a simple baseline for evals.)
 */
export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const lint = input.lint ?? [];
  const diff = buildDiffContext(input.files, input.maxDiffTokens ?? 12_000);

  if (diff.included.length === 0) {
    return {
      summary: "No reviewable code changes (only deleted, binary, generated or lock files).",
      score: 100,
      findings: [],
      tokens: 0,
      model: input.provider.model,
      reviewedFiles: [],
      skippedFiles: diff.skipped,
    };
  }

  const user = buildReviewUserPrompt({ title: input.title, body: input.body, diffText: diff.text, lint, skipped: diff.skipped });
  const { data, tokens } = await completeJson(input.provider, REVIEW_SYSTEM_PROMPT, user, ModelReview);
  return {
    summary: data.summary,
    score: data.score,
    findings: groundFindings(data, diff.included, lint),
    tokens,
    model: input.provider.model,
    reviewedFiles: diff.included.map((f) => f.filename),
    skippedFiles: diff.skipped,
  };
}

export { addedLines };
