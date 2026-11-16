import { db, reviews, reviewFindings, and, eq, ne, desc, sql } from "@codeguard/db";
import { getEnv } from "@codeguard/config";
import type { ReviewRequested } from "@codeguard/kafka";
import {
  addedLines,
  commentableLines,
  isReviewable,
  lintFiles,
  LINTABLE,
  runStagedReview,
  type DiffFile,
  type Embedder,
  type LLMProvider,
} from "@codeguard/review-engine";
import { completeCheckRun, fetchDiffFiles, isNotFound, publishReview, startCheckRun } from "@codeguard/review-engine/github";
import { buildReviewContext } from "../context";
import { installationOctokit } from "../github";
import { setProgress } from "../progress";

/**
 * Step 1 of every review: the CLAIM.
 *
 * INSERT … ON CONFLICT (repo, pr, sha) DO UPDATE … WHERE status IN ('pending','failed')
 *   - no row yet               → we insert it and own it
 *   - 'pending' (manual click, or reset by the stuck-review sweeper) → we take it over
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

export function createReviewJob(deps: { provider: LLMProvider; verifierProvider?: LLMProvider; embedder: Embedder }) {
  return async function onReviewRequested(e: ReviewRequested): Promise<void> {
    const reviewId = await claimReview(e);
    if (!reviewId) {
      console.info(`[review] skip ${e.repoFullName}#${e.prNumber} @ ${e.headSha.slice(0, 7)}: already claimed or done`);
      return;
    }
    console.info(`[review] start ${reviewId} ${e.repoFullName}#${e.prNumber} @ ${e.headSha.slice(0, 7)}`);

    try {
      await runPipeline(reviewId, e, deps);
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

async function runPipeline(
  reviewId: string,
  e: ReviewRequested,
  deps: { provider: LLMProvider; verifierProvider?: LLMProvider; embedder: Embedder },
): Promise<void> {
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
    .where(and(eq(reviews.repoFullName, e.repoFullName), eq(reviews.prNumber, e.prNumber), eq(reviews.status, "completed"), ne(reviews.headSha, e.headSha)))
    .orderBy(desc(reviews.completedAt))
    .limit(1);

  let allFiles: DiffFile[];
  let reviewedFromSha: string | null = null;
  try {
    allFiles = await fetchDiffFiles(octokit, owner, repo, prev?.sha ?? pr.base.sha, e.headSha);
    reviewedFromSha = prev?.sha ?? null;
  } catch (err) {
    // A force-push can delete the old commit: fall back to the full PR diff.
    if (!prev || !isNotFound(err)) throw err;
    allFiles = await fetchDiffFiles(octokit, owner, repo, pr.base.sha, e.headSha);
  }

  const checkRunId = await startCheckRun(octokit, { owner, repo, headSha: e.headSha, detailsUrl });
  await setProgress(reviewId, "snapshot_repository", {
    prTitle: pr.title,
    baseSha: pr.base.sha,
    reviewedFromSha,
    checkRunId,
    pullRequest: {
      owner, repo, number: pr.number, title: pr.title, htmlUrl: pr.html_url,
      headBranch: pr.head.ref, baseBranch: pr.base.ref, authorLogin: pr.user?.login ?? null,
      additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changed_files,
    },
  });

  // ── Context beyond the diff: policy, graph, callers, RAG, risk ─────────────
  await setProgress(reviewId, "build_context_packs");
  const { context, files } = await buildReviewContext({
    octokit, embedder: deps.embedder, owner, repo,
    repoFullName: e.repoFullName, installationId: e.installationId,
    baseSha: pr.base.sha, headSha: e.headSha, files: allFiles,
  });
  await setProgress(reviewId, "build_software_graph");

  // ── Deterministic tools first: ESLint on changed JS/TS (contents already fetched) ─
  const lint = await lintFiles(
    files
      .filter((f) => isReviewable(f) && LINTABLE.test(f.filename) && context.headContents.has(f.filename))
      .slice(0, 20)
      .map((f) => ({ path: f.filename, content: context.headContents.get(f.filename)!, addedLines: addedLines(f.patch) })),
  );

  // ── The staged review (stages report their own progress) ───────────────────
  const result = await runStagedReview({
    provider: deps.provider,
    verifierProvider: deps.verifierProvider,
    title: pr.title,
    body: pr.body,
    files,
    lint,
    context,
    maxDiffTokens: env.REVIEW_MAX_DIFF_TOKENS,
    onProgress: (node) => setProgress(reviewId, node),
  });

  // ── Save (one transaction: findings + results together, or neither) ────────
  await db.transaction(async (tx) => {
    await tx.delete(reviewFindings).where(eq(reviewFindings.reviewId, reviewId)); // a retry replaces, never duplicates
    if (result.findings.length) {
      await tx.insert(reviewFindings).values(
        result.findings.map((f) => ({
          reviewId, file: f.file, line: f.line, severity: f.severity, category: f.category,
          message: f.message, suggestion: f.suggestion, source: f.source, confidence: f.confidence,
        })),
      );
    }
    await tx
      .update(reviews)
      .set({
        score: result.score,
        summary: result.summary,
        assurance: result.assurance as unknown as Record<string, unknown>,
        model: `${deps.provider.name}/${result.model}`,
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
    ({ htmlUrl: githubReviewUrl } = await publishReview(octokit, {
      owner, repo, prNumber: e.prNumber, headSha: e.headSha,
      score: result.score,
      summary: `${result.summary}\n\n**Decision:** ${result.decision.headline}`,
      findings: result.findings,
      commentable: new Map(files.map((f) => [f.filename, commentableLines(f.patch)])),
      detailsUrl,
    }));
  } catch (err) {
    publishError = `Could not post to GitHub: ${(err as Error).message}`.slice(0, 500);
    console.warn(`[review] ${reviewId} ${publishError}`);
  }

  if (checkRunId) {
    // The TEAM'S POLICY decides the check, not the model.
    // Mark "CodeGuard AI" as a required check in branch protection to block merges on failure.
    await completeCheckRun(octokit, {
      owner, repo, checkRunId,
      conclusion: result.decision.conclusion,
      title: result.decision.headline,
      summary: [
        result.summary,
        "",
        ...result.decision.policies.map((p) => `- **${p.status.toUpperCase()}** ${p.id}: ${p.message}`),
        "",
        `Risk: **${context.risk.level}** (${context.risk.score}/100): ${context.risk.factors.join("; ")}`,
      ].join("\n"),
    }).catch((err) => console.warn(`[review] ${reviewId} check run not completed:`, (err as Error).message));
  }

  await setProgress(reviewId, "done", {
    status: "completed",
    githubReviewUrl,
    error: publishError,
    durationMs: Date.now() - started,
    completedAt: new Date(),
  });
  console.info(`[review] done ${reviewId}: score ${result.score}, ${result.findings.length} finding(s), ${result.decision.verdict}, ${result.tokens} tokens`);
}
