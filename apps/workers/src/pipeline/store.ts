import {
  db,
  reviews,
  reviewComments,
  repositories,
  pullRequests,
  eq,
  and,
  ne,
  or,
  lt,
  desc,
  isNull,
  isNotNull,
  count,
  sql,
} from "@codeguard/db";
import type { Finding } from "@codeguard/review-engine";
import type { PullRequestData, ReviewRunState } from "./state.js";

/**
 * A review whose row has not been touched for this long is considered dead
 * (worker crashed or was redeployed mid-run). Every pipeline node refreshes
 * `updated_at`, so a live run never looks stale.
 */
export const STALE_REVIEW_MS = 15 * 60_000;

export async function upsertRepository(pr: PullRequestData, owner: string, repo: string): Promise<{ id: string }> {
  const [row] = await db
    .insert(repositories)
    .values({
      githubRepoId: pr.base.repo.id,
      fullName: `${owner}/${repo}`,
      owner,
      name: repo,
      defaultBranch: pr.base.repo.default_branch ?? "main",
      isPrivate: pr.base.repo.private ?? false,
      language: pr.base.repo.language ?? null,
      cloneUrl: pr.base.repo.clone_url ?? null,
      htmlUrl: pr.base.repo.html_url ?? null,
    })
    .onConflictDoUpdate({
      target: repositories.githubRepoId,
      set: { fullName: `${owner}/${repo}`, defaultBranch: pr.base.repo.default_branch ?? "main", updatedAt: new Date() },
    })
    .returning({ id: repositories.id });
  return row;
}

export async function upsertPullRequest(pr: PullRequestData, repositoryId: string): Promise<{ id: string }> {
  const values = {
    repositoryId,
    githubPrId: pr.id,
    prNumber: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.merged_at ? ("merged" as const) : pr.state === "closed" ? ("closed" as const) : pr.draft ? ("draft" as const) : ("open" as const),
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    authorLogin: pr.user?.login ?? "unknown",
    authorGithubId: pr.user?.id ? String(pr.user.id) : null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    labels: (pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
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
        labels: values.labels,
        updatedAt: new Date(),
      },
    })
    .returning({ id: pullRequests.id });
  return row;
}

/**
 * Claim the (PR, head SHA, requester) slot. Returns the review id, or null
 * when another live run owns it.
 *
 * Fixes the "stuck forever" bug: if the existing row is `pending` (recovered)
 * or `in_progress` but not touched for STALE_REVIEW_MS, this run takes it over.
 */
export async function claimReview(input: { pullRequestId: string; headSha: string; userId: string | null; title: string; codeSnippet: string; language: string }): Promise<string | null> {
  const now = new Date();
  const [created] = await db
    .insert(reviews)
    .values({
      userId: input.userId,
      pullRequestId: input.pullRequestId,
      headSha: input.headSha,
      title: input.title,
      codeSnippet: input.codeSnippet,
      language: input.language,
      status: "in_progress",
      reviewType: "automated",
      startedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: reviews.id });
  if (created) return created.id;

  const [taken] = await db
    .update(reviews)
    .set({ status: "in_progress", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(reviews.pullRequestId, input.pullRequestId),
        eq(reviews.headSha, input.headSha),
        input.userId === null ? isNull(reviews.userId) : eq(reviews.userId, input.userId),
        or(eq(reviews.status, "pending"), and(eq(reviews.status, "in_progress"), lt(reviews.updatedAt, new Date(now.getTime() - STALE_REVIEW_MS))))
      )
    )
    .returning({ id: reviews.id });
  return taken?.id ?? null;
}

/** Take a specific row (dashboard request / recovery) if it is pending or stale. */
export async function takeReview(reviewId: string): Promise<{ id: string; headSha: string | null; pullRequestId: string | null } | null> {
  const now = new Date();
  const [row] = await db
    .update(reviews)
    .set({ status: "in_progress", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(reviews.id, reviewId),
        or(eq(reviews.status, "pending"), and(eq(reviews.status, "in_progress"), lt(reviews.updatedAt, new Date(now.getTime() - STALE_REVIEW_MS))))
      )
    )
    .returning({ id: reviews.id, headSha: reviews.headSha, pullRequestId: reviews.pullRequestId });
  return row ?? null;
}

/** Head SHA of the newest completed review of this PR on a different commit. */
export async function lastCompletedReviewSha(pullRequestId: string, currentSha: string): Promise<string | null> {
  const [row] = await db
    .select({ headSha: reviews.headSha })
    .from(reviews)
    .where(and(eq(reviews.pullRequestId, pullRequestId), eq(reviews.status, "completed"), isNotNull(reviews.headSha), ne(reviews.headSha, currentSha)))
    .orderBy(desc(reviews.completedAt))
    .limit(1);
  return row?.headSha ?? null;
}

export async function countPriorPRs(repositoryId: string, authorLogin: string, prNumber: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.authorLogin, authorLogin), ne(pullRequests.prNumber, prNumber)));
  return Number(row?.n ?? 0);
}

/** Merge into `metadata` and refresh `updated_at` (the liveness heartbeat). */
export async function patchReviewMetadata(reviewId: string, patch: Record<string, unknown>): Promise<void> {
  await db
    .update(reviews)
    .set({ metadata: sql`coalesce(${reviews.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(reviews.id, reviewId));
}

export async function failReview(reviewId: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db
    .update(reviews)
    .set({
      status: "failed",
      updatedAt: new Date(),
      metadata: sql`coalesce(${reviews.metadata}, '{}'::jsonb) || ${JSON.stringify({ error: message.slice(0, 500), ...extra })}::jsonb`,
    })
    .where(eq(reviews.id, reviewId));
}

/** Store the final result. Idempotent for a given review id (comments are replaced). */
export async function saveCompletedReview(state: ReviewRunState, metadata: Record<string, unknown>): Promise<void> {
  const reviewId = state.reviewId!;
  const score = state.scorecard?.overall ?? 10;
  await db.transaction(async (tx) => {
    await tx.delete(reviewComments).where(eq(reviewComments.reviewId, reviewId));
    if (state.findings.length > 0) {
      await tx.insert(reviewComments).values(state.findings.map((f) => commentRow(reviewId, f)));
    }
    await tx
      .update(reviews)
      .set({
        status: "completed",
        score,
        overallScore: `${score.toFixed(1)}/10`,
        summary: state.insights?.summary ?? null,
        model: state.llm?.model ?? null,
        completedAt: new Date(),
        updatedAt: new Date(),
        metadata: sql`coalesce(${reviews.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
      })
      .where(eq(reviews.id, reviewId));
  });
}

function commentRow(reviewId: string, f: Finding) {
  return {
    reviewId,
    filePath: f.file ?? "PR",
    lineNumber: f.line ?? undefined,
    lineStart: f.line ?? undefined,
    lineEnd: f.line ?? undefined,
    body: f.message,
    comment: f.message,
    suggestion: f.suggestion ?? undefined,
    severity: f.severity,
    category: f.category,
    source: f.source,
    confidence: f.confidence,
    ruleId: f.ruleId,
    metadata: { findingId: f.id, verification: f.verification ?? null, alsoReportedBy: f.alsoReportedBy ?? [], deterministic: f.deterministic },
  };
}
