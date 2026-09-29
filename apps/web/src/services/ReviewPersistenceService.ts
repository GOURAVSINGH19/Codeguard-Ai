import {
  db,
  reviews,
  reviewComments,
  repositories,
  pullRequests,
  eq,
  and,
  desc,
  gte,
  inArray,
  count,
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
}

export interface ReviewDetail extends ReviewListItem {
  codeSnippet: string | null;
  overallScore: string | null;
  summary: string | null;
  model: string | null;
  headSha: string | null;
  pullRequest: { owner: string; repo: string; number: number; title: string } | null;
  /** Safe subset of metadata for the UI (never raw errors). */
  details: { tokens: number | null; durationMs: number | null; githubUrl: string | null } | null;
}

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
  async claimPRReview(userId: string, pullRequestId: string, pr: GitHubPRDetail) {
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

    if (created) return { review: created, created: true as const };

    const [existing] = await db
      .select({ id: reviews.id, status: reviews.status, createdAt: reviews.createdAt })
      .from(reviews)
      .where(and(eq(reviews.pullRequestId, pullRequestId), eq(reviews.headSha, pr.headSha), eq(reviews.userId, userId), inArray(reviews.status, ["pending", "in_progress", "completed"])))
      .orderBy(desc(reviews.createdAt))
      .limit(1);
    return { review: existing, created: false as const };
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
      .where(and(eq(reviews.userId, userId), gte(reviews.createdAt, since)));
    return Number(row?.n ?? 0);
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  /** Last 20 reviews for a user, with issues — two queries, not 1 + N. */
  async getUserReviews(userId: string): Promise<ReviewListItem[]> {
    const rows = await db
      .select()
      .from(reviews)
      .where(eq(reviews.userId, userId))
      .orderBy(desc(reviews.createdAt))
      .limit(20);
    if (rows.length === 0) return [];

    const comments = await db
      .select()
      .from(reviewComments)
      .where(inArray(reviewComments.reviewId, rows.map((r) => r.id)));
    const byReview = new Map<string, typeof comments>();
    for (const c of comments) {
      const list = byReview.get(c.reviewId) ?? [];
      list.push(c);
      byReview.set(c.reviewId, list);
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      language: r.language,
      score: r.score,
      status: r.status,
      reviewType: r.reviewType,
      createdAt: r.createdAt,
      issues: (byReview.get(r.id) ?? []).map(toIssueItem),
    }));
  }

  /** A single review scoped to its owner; null if missing or someone else's. */
  async getReviewById(reviewId: string, userId: string): Promise<ReviewDetail | null> {
    const [row] = await db
      .select({
        review: reviews,
        prNumber: pullRequests.prNumber,
        prTitle: pullRequests.title,
        repoOwner: repositories.owner,
        repoName: repositories.name,
      })
      .from(reviews)
      .leftJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
      .leftJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
      .where(and(eq(reviews.id, reviewId), eq(reviews.userId, userId)))
      .limit(1);
    if (!row) return null;

    const r = row.review;
    const comments = await db.select().from(reviewComments).where(eq(reviewComments.reviewId, r.id));
    const meta = (r.metadata ?? {}) as { usage?: { totalTokens?: number }; durationMs?: number; github?: { url?: string } };

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
      pullRequest:
        row.prNumber != null && row.repoOwner && row.repoName
          ? { owner: row.repoOwner, repo: row.repoName, number: row.prNumber, title: row.prTitle ?? "" }
          : null,
      details: {
        tokens: meta.usage?.totalTokens ?? null,
        durationMs: meta.durationMs ?? null,
        githubUrl: meta.github?.url ?? null,
      },
    };
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
  };
}
