import { addedLines, buildDiffContext, commentableLines, type DiffFile } from "./diff";
import type { LintFinding } from "./lint";
import type { LLMProvider } from "./llm/types";
import { REVIEW_SYSTEM_PROMPT, buildReviewUserPrompt } from "./prompt";
import { ModelReview, type Finding } from "./schema";

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

/** Pull the first {...} block out of a reply, in case the model wrapped it in text or ```fences```. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("no JSON object in the model's answer");
  }
}

const normalizePath = (p: string) => p.trim().replace(/^(\.\/|a\/|b\/)/, "");

/**
 * Our own checks on the model's findings. The model can invent files and lines;
 * we only keep what we can verify against the real diff.
 */
export function groundFindings(review: ModelReview, files: DiffFile[], lint: LintFinding[]): Finding[] {
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
    });
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 30);
}

/**
 * Day 2 reviewer: one model call over the numbered diff.
 *   prompt → model → parse JSON → Zod → (one repair retry) → ground findings
 * Pure: no GitHub, no database. That makes it easy to test and to run in evals.
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
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: user }];

  let tokens = 0;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await input.provider.complete({ system: REVIEW_SYSTEM_PROMPT, messages, json: true });
    tokens += res.tokens;
    try {
      const parsed = ModelReview.safeParse(extractJson(res.text));
      if (parsed.success) {
        return {
          summary: parsed.data.summary,
          score: parsed.data.score,
          findings: groundFindings(parsed.data, diff.included, lint),
          tokens,
          model: input.provider.model,
          reviewedFiles: diff.included.map((f) => f.filename),
          skippedFiles: diff.skipped,
        };
      }
      lastError = parsed.error.message;
    } catch (err) {
      lastError = (err as Error).message;
    }
    // Repair: show the model its own answer and exactly what was wrong.
    messages.push(
      { role: "assistant", content: res.text.slice(0, 8000) },
      { role: "user", content: `Your previous answer failed validation:\n${lastError.slice(0, 1500)}\nReturn the corrected JSON object only.` },
    );
  }
  throw new Error(`model output failed validation twice: ${lastError.slice(0, 300)}`);
}

export { addedLines };
