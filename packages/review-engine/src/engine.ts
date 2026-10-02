import type { z } from "zod";
import { ReviewOutputSchema } from "@codeguard/types";
import type { ReviewIssue, ReviewOutput } from "@codeguard/types";
import { OpenAICompatibleProvider } from "./llm";
import type { ChatMessage, LLMProvider, LLMUsage } from "./llm";
import { buildDiffContext, DEFAULT_DIFF_BUDGET_CHARS } from "./diff";
import type { PRFileInput } from "./diff";
import { buildPRMessages, buildSnippetMessages } from "./prompts";
import { createIgnoreMatcher, DEFAULT_REPO_CONFIG, severityAtLeast } from "./repo-config";
import type { RepoConfig } from "./repo-config";
import { applyVerdicts, buildVerifyMessages, VerificationOutputSchema } from "./verify";
import type { VerifiedIssues } from "./verify";

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
  verification: VerificationSummary;
}

export interface VerificationSummary {
  /** "skipped": disabled or nothing to verify. "failed": verifier errored, findings kept unverified. */
  status: "verified" | "skipped" | "failed";
  confirmed: number;
  uncertain: number;
  rejected: VerifiedIssues["rejected"];
  error?: string;
}

export interface ReviewEngineOptions {
  diffBudgetChars?: number;
  /** Extra LLM calls when the model returns invalid JSON / schema. */
  maxRepairAttempts?: number;
  /** Run the verifier stage on PR findings (default true). */
  verifyFindings?: boolean;
  logger?: Pick<Console, "info" | "warn">;
}

/**
 * ReviewEngine — the ONLY place review prompts are built, the LLM is called
 * and its output is validated. Used by both apps/web and apps/workers.
 */
export class ReviewEngine {
  private readonly budget: number;
  private readonly maxRepairAttempts: number;
  private readonly verifyFindings: boolean;
  private readonly logger: Pick<Console, "info" | "warn">;

  constructor(private readonly llm: LLMProvider, opts: ReviewEngineOptions = {}) {
    this.budget = opts.diffBudgetChars ?? DEFAULT_DIFF_BUDGET_CHARS;
    this.maxRepairAttempts = opts.maxRepairAttempts ?? 1;
    this.verifyFindings = opts.verifyFindings ?? true;
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
    const started = Date.now();
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
        verification: SKIPPED_VERIFICATION,
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
    const found = normalized.filter((i) => severityAtLeast(i.severity, config.min_severity));

    // Stage 2: verify only what would be posted. Uncertain findings come back
    // one severity lower, so filter by min_severity again afterwards.
    const checked = await this.verify(found, diff.text, input.relatedCode);
    const kept = checked.issues.filter((i) => severityAtLeast(i.severity, config.min_severity));

    return {
      ...run,
      usage: addUsage(run.usage, checked.usage),
      durationMs: Date.now() - started,
      issues: kept,
      includedFiles: diff.includedFiles,
      excludedFiles: diff.excludedFiles,
      ignoredFiles,
      noPatchFiles: diff.noPatchFiles,
      commentable: diff.commentable,
      filteredIssueCount: normalized.length - kept.length - checked.summary.rejected.length,
      verification: checked.summary,
    };
  }

  private async verify(
    issues: ReviewIssue[],
    diff: string,
    relatedCode: string | undefined
  ): Promise<{ issues: ReviewIssue[]; summary: VerificationSummary; usage: LLMUsage | null }> {
    if (!this.verifyFindings || issues.length === 0) return { issues, summary: SKIPPED_VERIFICATION, usage: null };
    try {
      const { value, usage } = await this.completeValidated(buildVerifyMessages({ diff, relatedCode, issues }), parseVerificationOutput);
      const result = applyVerdicts(issues, value);
      this.logger.info(
        `[review-engine] verified ${issues.length} finding(s): ${result.confirmed} confirmed, ${result.uncertain} uncertain, ${result.rejected.length} rejected`
      );
      return {
        issues: result.issues,
        summary: { status: "verified", confirmed: result.confirmed, uncertain: result.uncertain, rejected: result.rejected },
        usage,
      };
    } catch (err) {
      // Verification raises precision; it must never cost the author their review.
      const error = (err as Error).message;
      this.logger.warn(`[review-engine] verification failed, keeping unverified findings: ${error}`);
      return { issues, summary: { ...SKIPPED_VERIFICATION, status: "failed", error: error.slice(0, 300) }, usage: null };
    }
  }

  private async run(messages: ChatMessage[]): Promise<ReviewRun> {
    const started = Date.now();
    const { value, usage } = await this.completeValidated(messages, parseReviewOutput);
    return { ...value, model: this.llm.model, provider: this.llm.name, usage, durationMs: Date.now() - started };
  }

  /** Call the model and validate its JSON, with up to `maxRepairAttempts` repair turns. */
  private async completeValidated<T>(messages: ChatMessage[], parse: (raw: string) => T): Promise<{ value: T; usage: LLMUsage | null }> {
    let conversation = messages;
    let lastError: ReviewValidationError | null = null;
    let usage: LLMUsage | null = null;

    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      const result = await this.llm.completeJSON(conversation);
      usage = addUsage(usage, result.usage);
      try {
        return { value: parse(result.content), usage };
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

const SKIPPED_VERIFICATION: VerificationSummary = { status: "skipped", confirmed: 0, uncertain: 0, rejected: [] };

function addUsage(a: LLMUsage | null, b: LLMUsage | null): LLMUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Parse + validate model output. Tolerates ```json fences and leading prose. */
export function parseReviewOutput(raw: string): ReviewOutput {
  return validateJSON(raw, ReviewOutputSchema);
}

export function parseVerificationOutput(raw: string) {
  return validateJSON(raw, VerificationOutputSchema);
}

function validateJSON<S extends z.ZodTypeAny>(raw: string, schema: S): z.infer<S> {
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
  const parsed = schema.safeParse(json);
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
