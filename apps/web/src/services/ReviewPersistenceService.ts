import {
  db,
  reviews,
  reviewComments,
  repositories,
  pullRequests,
  githubInstallations,
  eq,
  and,
  desc,
  gte,
  inArray,
  count,
  or,
  lt,
  isNull,
  ilike,
  type SQL,
} from "@codeguard/db";
import type { ReviewIssue } from "@codeguard/types";
import type { ReviewRun } from "@codeguard/review-engine";
import type { GitHubPRDetail } from "./GitHubService";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewIssueItem {
  id?: string;
  severity: string;
  category: string;
  file: string | null;
  line: number | null;
  message: string;
  suggestion: string | null;
  /** open | resolved | dismissed */
  status?: string;
  /** Pipeline stage that reported it (quality, security, testing, align…). */
  source?: string | null;
  confidence?: number | null;
  ruleId?: string | null;
}

/** Dashboard buckets: completed reviews scoring below 5 need attention. */
export const REVIEW_GROUPS = ["attention", "working", "completed", "failed"] as const;
export type ReviewGroup = (typeof REVIEW_GROUPS)[number];

const ATTENTION_SCORE = 5;

function groupCondition(group: ReviewGroup): SQL | undefined {
  switch (group) {
    case "attention":
      return and(eq(reviews.status, "completed"), lt(reviews.score, ATTENTION_SCORE));
    case "working":
      return inArray(reviews.status, ["pending", "in_progress"]);
    case "completed":
      return and(eq(reviews.status, "completed"), or(gte(reviews.score, ATTENTION_SCORE), isNull(reviews.score)));
    case "failed":
      return eq(reviews.status, "failed");
  }
}

/**
 * Reviews a user may see: the ones they requested, plus automated reviews
 * (user_id NULL) of pull requests in repositories their installation covers.
 */
function visibleTo(userId: string): SQL {
  const ownedPRs = db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
    .innerJoin(githubInstallations, eq(repositories.installationId, githubInstallations.id))
    .where(eq(githubInstallations.userId, userId));
  return or(eq(reviews.userId, userId), and(isNull(reviews.userId), inArray(reviews.pullRequestId, ownedPRs)))!;
}

/** Escape LIKE wildcards so a search for "100%" matches literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface ReviewListItem {
  id: string;
  title: string | null;
  language: string | null;
  score: number | null;
  status: string;
  reviewType: string;
  createdAt: Date;
  issues: ReviewIssueItem[];
  /** "owner/name" for PR reviews. */
  repo: string | null;
  prNumber: number | null;
}

export interface ReviewDetail extends ReviewListItem {
  codeSnippet: string | null;
  overallScore: string | null;
  summary: string | null;
  model: string | null;
  headSha: string | null;
  pullRequest: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    htmlUrl: string;
    headBranch: string;
    baseBranch: string;
    authorLogin: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
  } | null;
  /** Safe subset of metadata for the UI (never raw errors). */
  details: { tokens: number | null; durationMs: number | null; githubUrl: string | null } | null;
  /** Staged-pipeline results (null for snippet and legacy reviews). */
  assurance: ReviewAssurance | null;
  /** Pipeline node currently running, while the review is in progress. */
  progress: string | null;
  error: string | null;
}

export interface ReviewAssurance {
  decision: { verdict: string; conclusion: string; headline: string; reasons: string[] } | null;
  scorecard: { overall: number; dimensions: Array<{ id: string; label: string; score: number | null; note: string }> } | null;
  policies: Array<{ id: string; status: string; message: string }>;
  risk: { score: number; level: string; factors: string[] } | null;
  intent: { summary: string; changeType: string; stated: boolean } | null;
  alignment: { alignment: string; score: number; summary: string } | null;
  recommendations: string[];
  skills: string[];
  verification: { status: string; confirmed: number; uncertain: number; rejected: unknown[] } | null;
  trace: Array<{ name: string; status: string; durationMs: number; error?: string }>;
}

export const FINDING_STATUSES = ["open", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Placeholder file path for snippet reviews / PR issues without a file. */
const SNIPPET_PATH = "snippet";
const NO_FILE_PATH = "PR";

/**
 * ReviewPersistenceService — every DB read/write for the review lifecycle in
 * apps/web. Status only moves forward: pending → completed | failed.
 */
export class ReviewPersistenceService {
  // ─── Snippet reviews ─────────────────────────────────────────────────────

  async createPendingSnippetReview(input: { userId: string; code: string; language: string; title?: string }) {
    const [row] = await db
      .insert(reviews)
      .values({
        userId: input.userId,
        title: input.title || `${input.language.toUpperCase()} Code Review`,
        codeSnippet: input.code,
        language: input.language,
        status: "pending",
        reviewType: "paste_code",
        startedAt: new Date(),
      })
      .returning({ id: reviews.id, createdAt: reviews.createdAt });
    return row;
  }

  // ─── PR reviews ──────────────────────────────────────────────────────────

  async ensureRepository(pr: GitHubPRDetail) {
    const [owner, name] = pr.repoFullName.split("/");
    const [row] = await db
      .insert(repositories)
      .values({
        githubRepoId: pr.repoId,
        fullName: pr.repoFullName,
        owner,
        name,
        defaultBranch: pr.repoDefaultBranch,
        isPrivate: pr.repoIsPrivate,
        language: pr.repoLanguage,
        cloneUrl: pr.repoCloneUrl,
        htmlUrl: pr.repoHtmlUrl,
      })
      .onConflictDoUpdate({
        target: repositories.githubRepoId,
        set: { fullName: pr.repoFullName, defaultBranch: pr.repoDefaultBranch, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async ensurePullRequest(pr: GitHubPRDetail, repositoryId: string) {
    const values = {
      repositoryId,
      githubPrId: pr.id,
      prNumber: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      state: pr.state === "open" ? ("open" as const) : ("closed" as const),
      headBranch: pr.headBranch,
      baseBranch: pr.baseBranch,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      authorLogin: pr.authorLogin,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
    };
    const [row] = await db
      .insert(pullRequests)
      .values(values)
      .onConflictDoUpdate({
        target: [pullRequests.repositoryId, pullRequests.prNumber],
        set: {
          title: values.title,
          body: values.body,
          state: values.state,
          headSha: values.headSha,
          baseSha: values.baseSha,
          additions: values.additions,
          deletions: values.deletions,
          changedFiles: values.changedFiles,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /**
   * Create the pending review for (PR, head SHA, user) — or return the one that
   * already exists, so a double click or a refresh doesn't pay for a second
   * LLM call. `created` tells the caller whether to start the work.
   */
  /** The caller's live (non-failed) review of this commit, if any. */
  async findActivePRReview(userId: string, pullRequestId: string, headSha: string) {
    const [existing] = await db
      .select({ id: reviews.id, status: reviews.status, createdAt: reviews.createdAt })
      .from(reviews)
      .where(and(eq(reviews.pullRequestId, pullRequestId), eq(reviews.headSha, headSha), eq(reviews.userId, userId), inArray(reviews.status, ["pending", "in_progress", "completed"])))
      .orderBy(desc(reviews.createdAt))
      .limit(1);
    return existing ?? null;
  }

  /**
   * Create the pending review for (PR, head SHA, user). Returns null when a
   * concurrent request created it first (the unique index decides).
   */
  async createPendingPRReview(userId: string, pullRequestId: string, pr: GitHubPRDetail) {
    const [created] = await db
      .insert(reviews)
      .values({
        userId,
        pullRequestId,
        headSha: pr.headSha,
        title: `PR #${pr.number}: ${pr.title}`,
        codeSnippet: `PR #${pr.number} diff (${pr.changedFiles} files changed, +${pr.additions} -${pr.deletions})`,
        language: pr.repoLanguage ?? "code",
        status: "pending",
        reviewType: "ai_suggested",
        startedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: reviews.id, status: reviews.status, createdAt: reviews.createdAt });
    return created ?? null;
  }

  // ─── Completion ──────────────────────────────────────────────────────────

  async completeReview(
    reviewId: string,
    run: ReviewRun,
    opts: { kind: "snippet" | "pr"; metadata?: Record<string, unknown> }
  ) {
    await db
      .update(reviews)
      .set({
        status: "completed",
        score: run.score,
        overallScore: `${run.score.toFixed(1)}/10`,
        summary: run.summary,
        model: run.model,
        completedAt: new Date(),
        updatedAt: new Date(),
        metadata: { provider: run.provider, usage: run.usage, durationMs: run.durationMs, ...opts.metadata },
      })
      .where(eq(reviews.id, reviewId));

    await this.insertIssues(reviewId, run.issues, opts.kind === "snippet" ? SNIPPET_PATH : NO_FILE_PATH);
  }

  async failReview(reviewId: string, error?: unknown) {
    await db
      .update(reviews)
      .set({
        status: "failed",
        updatedAt: new Date(),
        metadata: error ? { error: String((error as Error)?.message ?? error).slice(0, 500) } : undefined,
      })
      .where(eq(reviews.id, reviewId));
  }

  async mergeMetadata(reviewId: string, patch: Record<string, unknown>) {
    const [row] = await db.select({ metadata: reviews.metadata }).from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    await db
      .update(reviews)
      .set({ metadata: { ...((row?.metadata as Record<string, unknown>) ?? {}), ...patch }, updatedAt: new Date() })
      .where(eq(reviews.id, reviewId));
  }

  // ─── Rate limiting ───────────────────────────────────────────────────────

  async countReviewsSince(userId: string, since: Date): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(reviews)
      // Failed attempts (including rejected ones) never count against the limit.
      .where(and(eq(reviews.userId, userId), gte(reviews.createdAt, since), inArray(reviews.status, ["pending", "in_progress", "completed"])));
    return Number(row?.n ?? 0);
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  /** Last 20 reviews for a user, with issues — two queries, not 1 + N. */
  async getUserReviews(
    userId: string,
    {
      limit = 20,
      offset = 0,
      group,
      q,
    }: { limit?: number; offset?: number; group?: ReviewGroup; q?: string } = {}
  ): Promise<{ items: ReviewListItem[]; total: number }> {
    const where = and(
      visibleTo(userId),
      group ? groupCondition(group) : undefined,
      q ? or(ilike(reviews.title, likePattern(q)), ilike(repositories.fullName, likePattern(q))) : undefined
    );
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({ review: reviews, repo: repositories.fullName, prNumber: pullRequests.prNumber })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
        .leftJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .where(where)
        // id breaks createdAt ties so pages never overlap or skip rows.
        .orderBy(desc(reviews.createdAt), desc(reviews.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(reviews)
        .leftJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
        .leftJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
        .where(where),
    ]);
    if (rows.length === 0) return { items: [], total: Number(total) };

    const comments = await db
      .select()
      .from(reviewComments)
      .where(inArray(reviewComments.reviewId, rows.map((r) => r.review.id)));
    const byReview = new Map<string, typeof comments>();
    for (const c of comments) {
      const list = byReview.get(c.reviewId) ?? [];
      list.push(c);
      byReview.set(c.reviewId, list);
    }

    const items = rows.map(({ review: r, repo, prNumber }) => ({
      id: r.id,
      title: r.title,
      language: r.language,
      score: r.score,
      status: r.status,
      reviewType: r.reviewType,
      createdAt: r.createdAt,
      issues: (byReview.get(r.id) ?? []).map(toIssueItem),
      repo,
      prNumber,
    }));
    return { items, total: Number(total) };
  }

  /** A single review scoped to its owner; null if missing or someone else's. */
  async getReviewById(reviewId: string, userId: string): Promise<ReviewDetail | null> {
    const [row] = await db
      .select({
        review: reviews,
        pr: pullRequests,
        repoOwner: repositories.owner,
        repoName: repositories.name,
        repoFullName: repositories.fullName,
        repoHtmlUrl: repositories.htmlUrl,
      })
      .from(reviews)
      .leftJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
      .leftJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
      .where(and(eq(reviews.id, reviewId), visibleTo(userId)))
      .limit(1);
    if (!row) return null;

    const r = row.review;
    const comments = await db.select().from(reviewComments).where(eq(reviewComments.reviewId, r.id));
    const meta = (r.metadata ?? {}) as StoredMetadata;

    return {
      id: r.id,
      title: r.title,
      codeSnippet: r.codeSnippet,
      language: r.language,
      score: r.score,
      overallScore: r.overallScore,
      summary: r.summary,
      status: r.status,
      reviewType: r.reviewType,
      model: r.model,
      headSha: r.headSha,
      createdAt: r.createdAt,
      issues: comments.map(toIssueItem),
      repo: row.repoFullName,
      prNumber: row.pr?.prNumber ?? null,
      pullRequest:
        row.pr && row.repoOwner && row.repoName
          ? {
              owner: row.repoOwner,
              repo: row.repoName,
              number: row.pr.prNumber,
              title: row.pr.title,
              htmlUrl: `${row.repoHtmlUrl ?? `https://github.com/${row.repoFullName}`}/pull/${row.pr.prNumber}`,
              headBranch: row.pr.headBranch,
              baseBranch: row.pr.baseBranch,
              authorLogin: row.pr.authorLogin,
              additions: row.pr.additions ?? 0,
              deletions: row.pr.deletions ?? 0,
              changedFiles: row.pr.changedFiles ?? 0,
            }
          : null,
      details: {
        tokens: meta.usage?.totalTokens ?? null,
        durationMs: meta.durationMs ?? null,
        githubUrl: meta.github?.url ?? null,
      },
      assurance: toAssurance(meta),
      progress: r.status === "pending" || r.status === "in_progress" ? (meta.progress?.node ?? null) : null,
      // `error` may hold upstream error text — only the curated userMessage reaches the browser.
      error: r.status === "failed" ? String(meta.userMessage ?? "The review failed. Please try again.").slice(0, 300) : null,
    };
  }

  /** Status + current pipeline node, for the SSE progress stream. */
  async getReviewStatus(reviewId: string, userId: string): Promise<{ status: string; progress: string | null; score: number | null } | null> {
    const [row] = await db
      .select({ status: reviews.status, score: reviews.score, metadata: reviews.metadata })
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), visibleTo(userId)))
      .limit(1);
    if (!row) return null;
    const meta = (row.metadata ?? {}) as { progress?: { node?: string } };
    return { status: row.status, progress: meta.progress?.node ?? null, score: row.score };
  }

  /** Resolve / dismiss / reopen a finding on a review the caller can see. */
  async updateFindingStatus(input: { reviewId: string; findingId: string; userId: string; status: FindingStatus; note?: string }): Promise<ReviewIssueItem | null> {
    const [visible] = await db.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.id, input.reviewId), visibleTo(input.userId))).limit(1);
    if (!visible) return null;
    const open = input.status === "open";
    const [row] = await db
      .update(reviewComments)
      .set({
        status: input.status,
        resolvedAt: open ? null : new Date(),
        resolvedBy: open ? null : input.userId,
        resolutionNote: open ? null : (input.note?.slice(0, 500) ?? null),
        updatedAt: new Date(),
      })
      .where(and(eq(reviewComments.id, input.findingId), eq(reviewComments.reviewId, input.reviewId)))
      .returning();
    return row ? toIssueItem(row) : null;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async insertIssues(reviewId: string, issues: ReviewIssue[], fallbackPath: string) {
    if (issues.length === 0) return;
    await db.insert(reviewComments).values(
      issues.map((issue) => ({
        reviewId,
        // Each issue keeps its own file (previously every issue was saved
        // against the first changed file).
        filePath: issue.file ?? fallbackPath,
        lineNumber: issue.line ?? undefined,
        lineStart: issue.line ?? undefined,
        lineEnd: issue.line ?? undefined,
        body: issue.message,
        comment: issue.message,
        suggestion: issue.suggestion ?? undefined,
        severity: issue.severity,
        category: issue.category,
      }))
    );
  }
}

function toIssueItem(c: typeof reviewComments.$inferSelect): ReviewIssueItem {
  const file = c.filePath && c.filePath !== SNIPPET_PATH && c.filePath !== NO_FILE_PATH ? c.filePath : null;
  return {
    id: c.id,
    severity: c.severity,
    category: c.category,
    file,
    line: c.lineNumber ?? null,
    message: c.body || c.comment || "",
    suggestion: c.suggestion ?? null,
    status: c.status,
    source: c.source ?? null,
    confidence: c.confidence ?? null,
    ruleId: c.ruleId ?? null,
  };
}

/** Shape of `reviews.metadata` as written by the workers' pipeline (all optional: older rows lack most of it). */
interface StoredMetadata {
  pipelineVersion?: number;
  usage?: { totalTokens?: number };
  durationMs?: number;
  github?: { url?: string };
  progress?: { node?: string };
  userMessage?: string;
  decision?: ReviewAssurance["decision"];
  scorecard?: ReviewAssurance["scorecard"];
  policies?: ReviewAssurance["policies"];
  risk?: { score: number; level: string; factors?: string[] };
  intent?: { summary: string; changeType: string; stated: boolean };
  alignment?: { alignment: string; score: number; summary: string };
  recommendations?: string[];
  skills?: string[];
  verification?: ReviewAssurance["verification"];
  trace?: Array<{ name: string; status: string; durationMs: number }>;
}

function toAssurance(meta: StoredMetadata): ReviewAssurance | null {
  if (meta.pipelineVersion !== 2) return null;
  return {
    decision: meta.decision ?? null,
    scorecard: meta.scorecard ?? null,
    policies: Array.isArray(meta.policies) ? meta.policies : [],
    risk: meta.risk ? { score: meta.risk.score, level: meta.risk.level, factors: meta.risk.factors ?? [] } : null,
    intent: meta.intent ? { summary: meta.intent.summary, changeType: meta.intent.changeType, stated: meta.intent.stated } : null,
    alignment: meta.alignment ? { alignment: meta.alignment.alignment, score: meta.alignment.score, summary: meta.alignment.summary } : null,
    recommendations: Array.isArray(meta.recommendations) ? meta.recommendations : [],
    skills: Array.isArray(meta.skills) ? meta.skills : [],
    verification: meta.verification ?? null,
    // Stage errors stay server-side; the UI only learns that a stage failed.
    trace: Array.isArray(meta.trace) ? meta.trace.map((t) => ({ name: t.name, status: t.status, durationMs: t.durationMs, error: t.status === "failed" ? "stage failed" : undefined })) : [],
  };
}
