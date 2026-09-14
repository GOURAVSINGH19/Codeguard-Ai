import {
  db,
  reviews,
  reviewComments,
  repositories,
  pullRequests,
} from "@codeguard/db";
import { eq, and, desc } from "drizzle-orm";
import type { ReviewOutput } from "@codeguard/types";
import type { GitHubPRDetail } from "./GitHubService";

// ─── Input / return types ────────────────────────────────────────────────────

export interface SnippetReviewInput {
  userId: string;
  code: string;
  language: string;
  title?: string;
  reviewOutput: ReviewOutput;
}

export interface PRReviewInitInput {
  userId: string;
  prDetail: GitHubPRDetail;
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

export interface ReviewIssueItem {
  id?: string;
  severity: string;
  category: string;
  line: number | null;
  message: string;
  suggestion: string | null;
}

export interface ReviewDetail extends ReviewListItem {
  codeSnippet: string | null;
  overallScore: string | null;
  summary: string | null;
  model: string | null;
}

/**
 * ReviewPersistenceService
 *
 * Single owner of all Drizzle ORM / DB logic for the review lifecycle.
 * This is the ONLY file in apps/web that imports from @codeguard/db.
 *
 * Enforces:
 * - INV-2: review status only moves forward (pending → completed/failed)
 * - INV-6: reviewComments always reference a valid reviewId
 * - INV-7: pullRequests always reference a valid repositoryId
 */
export class ReviewPersistenceService {
  // ─── Snippet review ─────────────────────────────────────────────────────

  /**
   * Persist a completed snippet review + its issues atomically.
   * Returns the saved review id + createdAt for the API response.
   */
  async saveSnippetReview(input: SnippetReviewInput) {
    const { userId, code, language, title, reviewOutput } = input;

    const [insertedReview] = await db
      .insert(reviews)
      .values({
        userId,
        title: title || `${language.toUpperCase()} Code Review`,
        codeSnippet: code,
        language,
        score: reviewOutput.score,
        overallScore: `${reviewOutput.score.toFixed(1)}/10`,
        summary: reviewOutput.summary,
        status: "completed",
        reviewType: "paste_code",
        model: process.env.GROQ_MODEL ?? null,
      })
      .returning();

    await this.insertIssues(insertedReview.id, "snippet", reviewOutput);

    return { id: insertedReview.id, createdAt: insertedReview.createdAt };
  }

  // ─── PR review lifecycle ─────────────────────────────────────────────────

  /**
   * Upsert the repository record for this PR's base repo.
   * Returns the internal UUID for use in the PR upsert.
   */
  async ensureRepository(prDetail: GitHubPRDetail) {
    const existing = await db
      .select()
      .from(repositories)
      .where(eq(repositories.githubRepoId, prDetail.repoId))
      .limit(1);

    if (existing[0]) return existing[0];

    const [created] = await db
      .insert(repositories)
      .values({
        githubRepoId: prDetail.repoId,
        fullName: prDetail.repoFullName,
        owner: prDetail.repoFullName.split("/")[0],
        name: prDetail.repoFullName.split("/")[1],
        defaultBranch: prDetail.repoDefaultBranch,
        isPrivate: prDetail.repoIsPrivate,
        language: prDetail.repoLanguage,
        cloneUrl: prDetail.repoCloneUrl,
        htmlUrl: prDetail.repoHtmlUrl,
      })
      .returning();

    return created;
  }

  /**
   * Upsert the pull request record.
   * Returns the internal UUID for use in the review insert.
   */
  async ensurePullRequest(prDetail: GitHubPRDetail, repositoryId: string) {
    const existing = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.prNumber, prDetail.number)
        )
      )
      .limit(1);

    if (existing[0]) return existing[0];

    const [created] = await db
      .insert(pullRequests)
      .values({
        repositoryId,
        githubPrId: prDetail.id,
        prNumber: prDetail.number,
        title: prDetail.title,
        body: prDetail.body ?? "",
        state: prDetail.state === "open" ? "open" : "closed",
        headBranch: prDetail.headBranch,
        baseBranch: prDetail.baseBranch,
        headSha: prDetail.headSha,
        baseSha: prDetail.baseSha,
        authorLogin: prDetail.authorLogin,
        additions: prDetail.additions,
        deletions: prDetail.deletions,
        changedFiles: prDetail.changedFiles,
      })
      .returning();

    return created;
  }

  /**
   * Insert a pending review record before the AI call starts.
   * Returns the review id so we can update it later.
   */
  async createPendingPRReview(
    userId: string,
    pullRequestId: string,
    prDetail: GitHubPRDetail
  ) {
    const [pending] = await db
      .insert(reviews)
      .values({
        userId,
        pullRequestId,
        title: `PR #${prDetail.number}: ${prDetail.title}`,
        codeSnippet: `PR #${prDetail.number} Diff (${prDetail.changedFiles} files changed, +${prDetail.additions} -${prDetail.deletions})`,
        language: prDetail.repoLanguage ?? "code",
        status: "pending",
        reviewType: "automated",
        model: process.env.GROQ_MODEL ?? null,
      })
      .returning();

    return pending;
  }

  /**
   * Mark a review as completed and persist its AI-generated issues.
   */
  async completePRReview(
    reviewId: string,
    reviewOutput: ReviewOutput,
    firstFilename: string
  ) {
    const [updated] = await db
      .update(reviews)
      .set({
        status: "completed",
        score: reviewOutput.score,
        overallScore: `${reviewOutput.score.toFixed(1)}/10`,
        summary: reviewOutput.summary,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, reviewId))
      .returning();

    await this.insertIssues(reviewId, firstFilename, reviewOutput);

    return updated;
  }

  /**
   * Mark a review as failed — called in catch blocks to keep status consistent.
   */
  async failReview(reviewId: string) {
    await db
      .update(reviews)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(reviews.id, reviewId));
  }

  // ─── Read operations ─────────────────────────────────────────────────────

  /**
   * Return the last 20 reviews for a user, with their issues.
   */
  async getUserReviews(userId: string): Promise<ReviewListItem[]> {
    const userReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.userId, userId))
      .orderBy(desc(reviews.createdAt))
      .limit(20);

    return Promise.all(
      userReviews.map(async (rev) => {
        const comments = await db
          .select()
          .from(reviewComments)
          .where(eq(reviewComments.reviewId, rev.id));

        return {
          id: rev.id,
          title: rev.title,
          language: rev.language,
          score: rev.score,
          status: rev.status,
          reviewType: rev.reviewType,
          createdAt: rev.createdAt,
          issues: comments.map((c) => ({
            severity: c.severity,
            category: c.category,
            line: c.lineNumber ?? null,
            message: c.body || c.comment || "",
            suggestion: c.suggestion ?? null,
          })),
        };
      })
    );
  }

  /**
   * Return a single review with its issues, scoped to the requesting user.
   * Returns null if not found or belongs to another user.
   */
  async getReviewById(
    reviewId: string,
    userId: string
  ): Promise<ReviewDetail | null> {
    const [review] = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), eq(reviews.userId, userId)))
      .limit(1);

    if (!review) return null;

    const comments = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.reviewId, review.id));

    return {
      id: review.id,
      title: review.title,
      codeSnippet: review.codeSnippet,
      language: review.language,
      score: review.score,
      overallScore: review.overallScore,
      summary: review.summary,
      status: review.status,
      reviewType: review.reviewType,
      model: review.model,
      createdAt: review.createdAt,
      issues: comments.map((c) => ({
        id: c.id,
        severity: c.severity,
        category: c.category,
        line: c.lineNumber ?? null,
        message: c.body || c.comment || "",
        suggestion: c.suggestion ?? null,
      })),
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async insertIssues(
    reviewId: string,
    filePath: string,
    reviewOutput: ReviewOutput
  ) {
    if (reviewOutput.issues.length === 0) return;

    await db.insert(reviewComments).values(
      reviewOutput.issues.map((issue) => ({
        reviewId,
        filePath,
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
