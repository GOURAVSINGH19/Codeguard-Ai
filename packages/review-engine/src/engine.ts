import { ReviewOutputSchema } from "@codeguard/types";
import type { ReviewIssue, ReviewOutput } from "@codeguard/types";
import { OpenAICompatibleProvider } from "./llm";
import type { ChatMessage, LLMProvider, LLMUsage } from "./llm";
import { buildDiffContext, DEFAULT_DIFF_BUDGET_CHARS } from "./diff";
import type { PRFileInput } from "./diff";
import { buildPRMessages, buildSnippetMessages } from "./prompts";
import { createIgnoreMatcher, DEFAULT_REPO_CONFIG, severityAtLeast } from "./repo-config";
import type { RepoConfig } from "./repo-config";

export class ReviewValidationError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

export interface ReviewRun extends ReviewOutput {
  model: string;
  provider: string;
  usage: LLMUsage | null;
  durationMs: number;
}

export interface PRReviewInput {
  title: string;
  body: string | null;
  files: PRFileInput[];
  /** Filenames in review priority order (dependency-graph ranking). */
  priorityOrder?: string[];
  relatedCode?: string;
  repoConfig?: RepoConfig;
  /** Extra facts for the model, e.g. transitive-risk files. */
  notes?: string[];
}

export interface PRReviewRun extends ReviewRun {
  includedFiles: string[];
  excludedFiles: string[];
  ignoredFiles: string[];
  noPatchFiles: string[];
  /** New-file line numbers GitHub accepts inline comments on, per file. */
  commentable: Map<string, Set<number>>;
  /** Issues dropped by `min_severity`. */
  filteredIssueCount: number;
}

export interface ReviewEngineOptions {
  diffBudgetChars?: number;
  /** Extra LLM calls when the model returns invalid JSON / schema. */
  maxRepairAttempts?: number;
  logger?: Pick<Console, "info" | "warn">;
}

/**
 * ReviewEngine — the ONLY place review prompts are built, the LLM is called
 * and its output is validated. Used by both apps/web and apps/workers.
 */
export class ReviewEngine {
  private readonly budget: number;
  private readonly maxRepairAttempts: number;
  private readonly logger: Pick<Console, "info" | "warn">;

  constructor(private readonly llm: LLMProvider, opts: ReviewEngineOptions = {}) {
    this.budget = opts.diffBudgetChars ?? DEFAULT_DIFF_BUDGET_CHARS;
    this.maxRepairAttempts = opts.maxRepairAttempts ?? 1;
    this.logger = opts.logger ?? console;
  }

  static fromEnv(opts?: ReviewEngineOptions): ReviewEngine {
    return new ReviewEngine(OpenAICompatibleProvider.fromConfig(), opts);
  }

  get model(): string {
    return this.llm.model;
  }

  async reviewSnippet(code: string, language: string): Promise<ReviewRun> {
    const run = await this.run(buildSnippetMessages(code, language));
    return { ...run, issues: run.issues.map((i) => ({ ...i, file: null })) };
  }

  async reviewPullRequest(input: PRReviewInput): Promise<PRReviewRun> {
    const config = input.repoConfig ?? DEFAULT_REPO_CONFIG;
    const isIgnored = createIgnoreMatcher(config);
    const ignoredFiles = input.files.filter((f) => isIgnored(f.filename)).map((f) => f.filename);
    const reviewable = input.files.filter((f) => !isIgnored(f.filename));

    const diff = buildDiffContext(reviewable, { budgetChars: this.budget, priorityOrder: input.priorityOrder });

    const notes = [...(input.notes ?? [])];
    if (diff.excludedFiles.length > 0) {
      notes.push(`${diff.excludedFiles.length} changed file(s) were left out to fit the size budget: ${diff.excludedFiles.slice(0, 10).join(", ")}`);
      this.logger.info(`[review-engine] excluded by budget: ${diff.excludedFiles.join(", ")}`);
    }
    if (diff.noPatchFiles.length > 0) {
      notes.push(`No diff available (binary or too large): ${diff.noPatchFiles.slice(0, 10).join(", ")}`);
    }

    if (diff.includedFiles.length === 0) {
      return {
        score: 10,
        summary: "No reviewable source changes in this pull request (all files are ignored, binary or too large).",
        issues: [],
        model: this.llm.model,
        provider: this.llm.name,
        usage: null,
        durationMs: 0,
        includedFiles: [],
        excludedFiles: diff.excludedFiles,
        ignoredFiles,
        noPatchFiles: diff.noPatchFiles,
        commentable: diff.commentable,
        filteredIssueCount: 0,
      };
    }

    const run = await this.run(
      buildPRMessages({
        title: input.title,
        body: input.body,
        diff: diff.text,
        relatedCode: input.relatedCode,
        instructions: config.instructions,
        notes,
      })
    );

    const known = new Set(diff.includedFiles);
    const normalized = run.issues.map((issue) => normalizeIssueFile(issue, known));
    const kept = normalized.filter((i) => severityAtLeast(i.severity, config.min_severity));

    return {
      ...run,
      issues: kept,
      includedFiles: diff.includedFiles,
      excludedFiles: diff.excludedFiles,
      ignoredFiles,
      noPatchFiles: diff.noPatchFiles,
      commentable: diff.commentable,
      filteredIssueCount: normalized.length - kept.length,
    };
  }

  private async run(messages: ChatMessage[]): Promise<ReviewRun> {
    const started = Date.now();
    let conversation = messages;
    let lastError: ReviewValidationError | null = null;

    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      const result = await this.llm.completeJSON(conversation);
      try {
        const output = parseReviewOutput(result.content);
        return {
          ...output,
          model: this.llm.model,
          provider: this.llm.name,
          usage: result.usage,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        if (!(err instanceof ReviewValidationError)) throw err;
        lastError = err;
        this.logger.warn(`[review-engine] invalid model output (attempt ${attempt + 1}): ${err.message}`);
        conversation = [
          ...messages,
          { role: "assistant", content: result.content.slice(0, 8_000) },
          {
            role: "user",
            content: `Your previous answer was not valid: ${err.message}. Reply again with ONLY the JSON object in the required shape.`,
          },
        ];
      }
    }
    throw lastError!;
  }
}

/** Parse + validate model output. Tolerates ```json fences and leading prose. */
export function parseReviewOutput(raw: string): ReviewOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) throw new ReviewValidationError("response is not JSON", raw);
    try {
      json = JSON.parse(raw.slice(start, end + 1));
    } catch {
      throw new ReviewValidationError("response is not JSON", raw);
    }
  }
  const parsed = ReviewOutputSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ReviewValidationError(`schema mismatch — ${detail}`, raw);
  }
  return parsed.data;
}

/**
 * Keep `file` only when it names a file that was actually in the diff.
 * Accepts small variations such as a leading "./" or "a/"/"b/" prefix.
 */
function normalizeIssueFile(issue: ReviewIssue, known: Set<string>): ReviewIssue {
  if (!issue.file) return { ...issue, file: null, line: null };
  const candidate = issue.file.replace(/^\.\//, "").replace(/^[ab]\//, "");
  if (known.has(candidate)) return { ...issue, file: candidate };
  const suffixMatch = [...known].filter((k) => k.endsWith(`/${candidate}`));
  if (suffixMatch.length === 1) return { ...issue, file: suffixMatch[0] };
  return { ...issue, file: null, line: null };
}
