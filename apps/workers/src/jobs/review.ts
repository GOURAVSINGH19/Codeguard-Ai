import { db, reviews, reviewFindings, and, eq, ne, desc, sql } from "@codeguard/db";
import { getEnv } from "@codeguard/config";
import type { ReviewRequested } from "@codeguard/kafka";
import {
  addedLines,
  commentableLines,
  isReviewable,
  lintFiles,
  LINTABLE,
  runReview,
  type DiffFile,
  type LLMProvider,
} from "@codeguard/review-engine";
import {
  completeCheckRun,
  fetchDiffFiles,
  fetchFileAtRef,
  isNotFound,
  publishReview,
  startCheckRun,
} from "@codeguard/review-engine/github";
import { installationOctokit } from "../github";
import { setProgress } from "../progress";

const MAX_LINT_FILES = 20;

/**
 * Step 1 of every review: the CLAIM.
 *
 * INSERT … ON CONFLICT (repo, pr, sha) DO UPDATE … WHERE status IN ('pending','failed')
 *   - no row yet               → we insert it and own it
 *   - 'pending' (manual click) → we take it over
 *   - 'failed' (a retry)       → we take it over again
 *   - 'in_progress'/'completed'→ nothing returned: another worker has it, or it's done → skip
 * One atomic statement, so two workers can never both win.
 */
export async function claimReview(e: ReviewRequested): Promise<string | null> {
  const now = new Date();
  const [claimed] = await db
    .insert(reviews)
    .values({
      repoFullName: e.repoFullName,
      prNumber: e.prNumber,
      headSha: e.headSha,
      installationId: e.installationId,
      trigger: e.trigger,
      status: "in_progress",
      progress: "initialize_run",
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviews.repoFullName, reviews.prNumber, reviews.headSha],
      set: { status: "in_progress", progress: "initialize_run", error: null, installationId: e.installationId, startedAt: now, updatedAt: now },
      setWhere: sql`${reviews.status} in ('pending', 'failed')`,
    })
    .returning({ id: reviews.id });
  return claimed?.id ?? null;
}

export function createReviewJob(provider: LLMProvider) {
  return async function onReviewRequested(e: ReviewRequested): Promise<void> {
    const reviewId = await claimReview(e);
    if (!reviewId) {
      console.info(`[review] skip ${e.repoFullName}#${e.prNumber} @ ${e.headSha.slice(0, 7)}: already claimed or done`);
      return;
    }
    console.info(`[review] start ${reviewId} ${e.repoFullName}#${e.prNumber} @ ${e.headSha.slice(0, 7)}`);

    try {
      await runPipeline(reviewId, e, provider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(reviews)
        .set({ status: "failed", error: message.slice(0, 1000), progress: null, updatedAt: new Date() })
        .where(eq(reviews.id, reviewId));
      throw err; // consume() retries (the claim takes 'failed' rows back), then sends to the DLQ
    }
  };
}

async function runPipeline(reviewId: string, e: ReviewRequested, provider: LLMProvider): Promise<void> {
  const env = getEnv();
  const started = Date.now();
  const [owner, repo] = e.repoFullName.split("/");
  const octokit = await installationOctokit(e.installationId);
  const detailsUrl = env.APP_URL ? `${env.APP_URL.replace(/\/$/, "")}/reviews/${reviewId}` : null;

  // ── Collect the PR ─────────────────────────────────────────────────────────
  await setProgress(reviewId, "collect_pr_context");
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: e.prNumber });

  // Incremental review: only what changed since the last COMPLETED review of this PR.
  const [prev] = await db
    .select({ sha: reviews.headSha })
    .from(reviews)
    .where(
      and(
        eq(reviews.repoFullName, e.repoFullName),
        eq(reviews.prNumber, e.prNumber),
        eq(reviews.status, "completed"),
        ne(reviews.headSha, e.headSha),
      ),
    )
    .orderBy(desc(reviews.completedAt))
    .limit(1);

  let files: DiffFile[];
  let reviewedFromSha: string | null = null;
  try {
    files = await fetchDiffFiles(octokit, owner, repo, prev?.sha ?? pr.base.sha, e.headSha);
    reviewedFromSha = prev?.sha ?? null;
  } catch (err) {
    // A force-push can delete the old commit: fall back to the full PR diff.
    if (!prev || !isNotFound(err)) throw err;
    files = await fetchDiffFiles(octokit, owner, repo, pr.base.sha, e.headSha);
  }

  const checkRunId = await startCheckRun(octokit, { owner, repo, headSha: e.headSha, detailsUrl });
  await setProgress(reviewId, "build_context_packs", {
    prTitle: pr.title,
    baseSha: pr.base.sha,
    reviewedFromSha,
    checkRunId,
    pullRequest: {
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      authorLogin: pr.user?.login ?? null,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
    },
  });

  // ── Deterministic tools first: ESLint on the HEAD version of changed JS/TS ─
  const lintable = files.filter((f) => isReviewable(f) && LINTABLE.test(f.filename)).slice(0, MAX_LINT_FILES);
  const lintInputs = (
    await Promise.all(
      lintable.map(async (f) => {
        const content = await fetchFileAtRef(octokit, owner, repo, f.filename, e.headSha);
        return content === null ? null : { path: f.filename, content, addedLines: addedLines(f.patch) };
      }),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null);
  const lint = await lintFiles(lintInputs);

  // ── The model ─────────────────────────────────────────────────────────────
  await setProgress(reviewId, "quality");
  const result = await runReview({
    provider,
    title: pr.title,
    body: pr.body,
    files,
    lint,
    maxDiffTokens: env.REVIEW_MAX_DIFF_TOKENS,
  });

  // ── Save (one transaction: findings + scores together, or neither) ─────────
  await setProgress(reviewId, "aggregate_findings");
  await db.transaction(async (tx) => {
    await tx.delete(reviewFindings).where(eq(reviewFindings.reviewId, reviewId)); // a retry replaces, never duplicates
    if (result.findings.length) {
      await tx.insert(reviewFindings).values(
        result.findings.map((f) => ({
          reviewId,
          file: f.file,
          line: f.line,
          severity: f.severity,
          category: f.category,
          message: f.message,
          suggestion: f.suggestion,
          source: f.source,
        })),
      );
    }
    await tx
      .update(reviews)
      .set({
        score: result.score,
        summary: result.summary,
        model: `${provider.name}/${result.model}`,
        tokens: result.tokens,
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, reviewId));
  });

  // ── Publish. A GitHub failure doesn't lose the review: it can be re-posted from the UI. ─
  await setProgress(reviewId, "publish_report");
  let githubReviewUrl: string | null = null;
  let publishError: string | null = null;
  try {
    const commentable = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]));
    ({ htmlUrl: githubReviewUrl } = await publishReview(octokit, {
      owner,
      repo,
      prNumber: e.prNumber,
      headSha: e.headSha,
      score: result.score,
      summary: result.summary,
      findings: result.findings,
      commentable,
      detailsUrl,
    }));
  } catch (err) {
    publishError = `Could not post to GitHub: ${(err as Error).message}`.slice(0, 500);
    console.warn(`[review] ${reviewId} ${publishError}`);
  }

  if (checkRunId) {
    // Day 2 rule: any critical finding fails the check. Day 3 replaces this with the team's .codeguard.yml policy.
    const critical = result.findings.filter((f) => f.severity === "critical").length;
    await completeCheckRun(octokit, {
      owner,
      repo,
      checkRunId,
      conclusion: critical > 0 ? "failure" : "success",
      title: critical > 0 ? `${critical} critical issue(s) · score ${result.score}/100` : `Score ${result.score}/100`,
      summary: result.summary,
    }).catch((err) => console.warn(`[review] ${reviewId} check run not completed:`, (err as Error).message));
  }

  await setProgress(reviewId, "done", {
    status: "completed",
    githubReviewUrl,
    error: publishError,
    durationMs: Date.now() - started,
    completedAt: new Date(),
  });
  console.info(`[review] done ${reviewId}: score ${result.score}, ${result.findings.length} finding(s), ${result.tokens} tokens`);
}
