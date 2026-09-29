import { TOPICS, ReviewRequestedEventSchema, prMessageKey } from "@codeguard/kafka";
import type { ReviewCompletedEvent, ReviewRequestedEvent } from "@codeguard/kafka";
import type { Octokit } from "octokit";
import {
  db,
  reviews,
  reviewComments,
  repositories,
  pullRequests,
  codeChunks,
  eq,
  and,
  or,
  inArray,
  ilike,
} from "@codeguard/db";
import {
  ReviewEngine,
  annotatePatch,
  createCheckRun,
  decideConclusion,
  parseRepoConfig,
  postReview,
  CONFIG_FILE_PATH,
} from "@codeguard/review-engine";
import type { PRFileInput, RepoConfig } from "@codeguard/review-engine";
import { EmbeddingService } from "../ai/EmbeddingService.js";
import { RAGService } from "../rag/RAGService.js";
import { PRDiffSelector } from "../analyzers/PRDiffSelector.js";
import { getWorkerProducer } from "../queue/kafkaClient.js";
import { runConsumer, PermanentError } from "../queue/consumer.js";
import { getRepoOctokit } from "../github/octokit.js";
import { logger } from "../lib/logger.js";

const CONSUMER_GROUP = "codeguard-review-processor";
/** GitHub caps `pulls.listFiles` at 3,000 files. */
const MAX_PR_FILES = 3_000;
/** Upper bound on code chunks loaded for the dependency graph. */
const MAX_GRAPH_CHUNKS = 2_000;

/**
 * reviewProcessor
 *
 * Consumes: codeguard.review.requested
 * Publishes: codeguard.review.completed
 *
 * 1. Mint an installation token for the repo (GitHub App)
 * 2. Claim the review for (PR, head SHA) — duplicates are skipped
 * 3. Collect files (only new commits on `synchronize`), repo config and context
 * 4. Run the shared ReviewEngine
 * 5. Persist, post inline review + Check Run, publish review.completed
 *
 * Failures are retried by `runConsumer` and end in the DLQ; the claimed review
 * row is marked `failed`, which frees the (PR, SHA) slot for the retry.
 */
export async function startReviewProcessor(): Promise<void> {
  await runConsumer({
    name: "reviewProcessor",
    groupId: CONSUMER_GROUP,
    topic: TOPICS.REVIEW_REQUESTED,
    schema: ReviewRequestedEventSchema,
    handler: processReviewRequest,
  });
}

export async function processReviewRequest(event: ReviewRequestedEvent): Promise<void> {
  const { owner, repo, pullNumber } = event;
  const log = logger.child({ pr: `${owner}/${repo}#${pullNumber}`, deliveryId: event.deliveryId });

  const octokit = await getRepoOctokit(owner, repo, event.installationId);
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });

  if (pr.state !== "open") {
    log.info("skipped: PR is not open");
    return;
  }
  const headSha = event.headSha ?? pr.head.sha;
  if (event.headSha && pr.head.sha !== event.headSha) {
    // A newer push already exists; its own event will review the latest commit.
    log.info("skipped: newer commit exists", { eventSha: event.headSha, currentSha: pr.head.sha });
    return;
  }

  const repoRecord = await upsertRepository(pr, owner, repo);
  const prRecord = await upsertPullRequest(pr, repoRecord.id, pullNumber);

  // ── Claim (PR, head SHA). The partial unique index makes this atomic. ──
  const [claimed] = await db
    .insert(reviews)
    .values({
      userId: event.userId,
      pullRequestId: prRecord.id,
      headSha,
      title: `PR #${pullNumber}: ${pr.title}`,
      codeSnippet: `PR #${pullNumber} diff (${pr.changed_files} files, +${pr.additions} -${pr.deletions})`,
      language: pr.base.repo.language ?? "code",
      status: "in_progress",
      reviewType: "automated",
      startedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: reviews.id });

  if (!claimed) {
    log.info("skipped: review already exists for this commit", { headSha });
    return;
  }
  const reviewId = claimed.id;
  const rlog = log.child({ reviewId });

  try {
    const [prFiles, repoConfig] = await Promise.all([
      listAllPRFiles(octokit, owner, repo, pullNumber),
      loadRepoConfig(octokit, owner, repo, pr.base.sha, rlog),
    ]);

    // Inline comments must target lines in the PR diff, whatever subset we review.
    const commentable = new Map(prFiles.map((f) => [f.filename, f.patch ? annotatePatch(f.patch).commentableLines : new Set<number>()]));

    // ── Incremental re-review: only files changed since the last reviewed commit ──
    let filesToReview = prFiles;
    let incremental = false;
    if (event.previousHeadSha) {
      const changedSince = await filesChangedSince(octokit, owner, repo, event.previousHeadSha, headSha);
      if (changedSince) {
        const prByName = new Map(prFiles.map((f) => [f.filename, f]));
        filesToReview = changedSince.filter((f) => prByName.has(f.filename));
        incremental = true;
        rlog.info("incremental review", { files: filesToReview.length, since: event.previousHeadSha });
      }
    }

    // ── Dependency-graph ranking with only the chunks we need (A4) ──
    const graphContents = await loadGraphContents(repoRecord.id, filesToReview.map((f) => f.filename));
    const ranking = new PRDiffSelector().rank(filesToReview, graphContents);

    const relatedCode = await loadRelatedCode(repoRecord.id, filesToReview, rlog);

    const notes: string[] = [];
    if (incremental) notes.push(`Only commits pushed since ${event.previousHeadSha!.slice(0, 7)} are shown; earlier changes were reviewed before.`);
    if (ranking.transitiveRiskFiles.length > 0) {
      notes.push(`Files that import the changed code and may be affected: ${ranking.transitiveRiskFiles.slice(0, 8).join(", ")}`);
    }

    const engine = ReviewEngine.fromEnv({ logger: { info: (m) => rlog.info(m), warn: (m) => rlog.warn(m) } });
    const result = await engine.reviewPullRequest({
      title: pr.title,
      body: pr.body,
      files: filesToReview,
      priorityOrder: ranking.rankedFiles,
      relatedCode,
      repoConfig,
      notes,
    });

    // ── Persist ──
    await db
      .update(reviews)
      .set({
        status: "completed",
        score: result.score,
        overallScore: `${result.score.toFixed(1)}/10`,
        summary: result.summary,
        model: result.model,
        completedAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          provider: result.provider,
          usage: result.usage,
          durationMs: result.durationMs,
          incremental,
          includedFiles: result.includedFiles,
          excludedFiles: result.excludedFiles,
          ignoredFiles: result.ignoredFiles,
          filteredIssueCount: result.filteredIssueCount,
        },
      })
      .where(eq(reviews.id, reviewId));

    if (result.issues.length > 0) {
      await db.insert(reviewComments).values(
        result.issues.map((issue) => ({
          reviewId,
          filePath: issue.file ?? "PR",
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

    // ── Publish to GitHub ──
    const posted = await postReview(octokit, {
      owner,
      repo,
      pullNumber,
      commitId: headSha,
      score: result.score,
      summary: result.summary,
      issues: result.issues,
      commentable,
      notes: scopeNotes(result, incremental),
      footer: "CodeGuard AI · automated review",
    });

    const conclusion = decideConclusion(result.issues, repoConfig);
    await createCheckRun(octokit, {
      owner,
      repo,
      headSha,
      conclusion,
      score: result.score,
      issues: result.issues,
      failOn: repoConfig.fail_on,
    }).catch((err) => rlog.warn("check run not created (needs checks:write permission)", { error: (err as Error).message }));

    await db
      .update(reviews)
      .set({ metadata: { ...(await currentMetadata(reviewId)), github: { reviewId: posted.id, url: posted.htmlUrl, mode: posted.mode, inlineCount: posted.inlineCount }, conclusion } })
      .where(eq(reviews.id, reviewId));

    const completed: ReviewCompletedEvent = {
      reviewId,
      prNumber: pullNumber,
      owner,
      repo,
      score: result.score,
      issueCount: result.issues.length,
      userId: event.userId,
      completedAt: new Date().toISOString(),
    };
    const producer = await getWorkerProducer();
    await producer.send({
      topic: TOPICS.REVIEW_COMPLETED,
      messages: [{ key: prMessageKey(owner, repo, pullNumber), value: JSON.stringify(completed) }],
    });

    rlog.info("review completed", {
      score: result.score,
      issues: result.issues.length,
      inline: posted.inlineCount,
      conclusion,
      tokens: result.usage?.totalTokens,
      durationMs: result.durationMs,
    });
  } catch (err) {
    await db
      .update(reviews)
      .set({ status: "failed", updatedAt: new Date(), metadata: { error: (err as Error).message.slice(0, 500) } })
      .where(eq(reviews.id, reviewId))
      .catch(() => {});
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type PR = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];

async function upsertRepository(pr: PR, owner: string, repo: string) {
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

async function upsertPullRequest(pr: PR, repositoryId: string, pullNumber: number) {
  const values = {
    repositoryId,
    githubPrId: pr.id,
    prNumber: pullNumber,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.draft ? ("draft" as const) : ("open" as const),
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    authorLogin: pr.user?.login ?? "unknown",
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
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
    .returning({ id: pullRequests.id });
  return row;
}

async function listAllPRFiles(octokit: Octokit, owner: string, repo: string, pullNumber: number): Promise<PRFileInput[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 });
  return files.slice(0, MAX_PR_FILES).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
  }));
}

/** Files changed between two commits, or null when history was rewritten. */
async function filesChangedSince(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<PRFileInput[] | null> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}` });
    if (data.status !== "ahead" || !data.files) return null; // force-push / rebase → full review
    return data.files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    }));
  } catch {
    return null;
  }
}

/**
 * `.codeguard.yml` is read from the BASE commit, so a PR can't weaken its own
 * review (e.g. by adding `ignore: ["**"]`).
 */
async function loadRepoConfig(octokit: Octokit, owner: string, repo: string, baseSha: string, log: typeof logger): Promise<RepoConfig> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: CONFIG_FILE_PATH, ref: baseSha });
    const content = !Array.isArray(data) && data.type === "file" ? Buffer.from(data.content, "base64").toString("utf8") : null;
    const { config, warning } = parseRepoConfig(content);
    if (warning) log.warn(warning);
    return config;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) log.warn("could not read repo config", { error: (err as Error).message });
    return parseRepoConfig(null).config;
  }
}

/**
 * Load only the chunks the dependency graph needs: the changed files plus files
 * whose code mentions a changed module's name (likely importers). The filter
 * runs in Postgres, so memory no longer grows with repository size.
 */
async function loadGraphContents(repositoryId: string, changedFiles: string[]): Promise<Map<string, string>> {
  if (changedFiles.length === 0) return new Map();
  const moduleNames = [
    ...new Set(
      changedFiles
        .map((f) => f.split("/").pop()!.replace(/\.[^.]+$/, ""))
        .filter((n) => n.length >= 3 && n !== "index")
    ),
  ].slice(0, 50);

  const mentions = moduleNames.map((n) => ilike(codeChunks.content, `%${escapeLike(n)}%`));
  const rows = await db
    .select({ filePath: codeChunks.filePath, content: codeChunks.content, startLine: codeChunks.startLine })
    .from(codeChunks)
    .where(and(eq(codeChunks.repositoryId, repositoryId), or(inArray(codeChunks.filePath, changedFiles), ...mentions)))
    .orderBy(codeChunks.filePath, codeChunks.startLine)
    .limit(MAX_GRAPH_CHUNKS);

  const byFile = new Map<string, string[]>();
  for (const row of rows) {
    const parts = byFile.get(row.filePath) ?? [];
    parts.push(row.content);
    byFile.set(row.filePath, parts);
  }
  return new Map([...byFile].map(([path, parts]) => [path, parts.join("\n")]));
}

async function loadRelatedCode(repositoryId: string, files: PRFileInput[], log: typeof logger): Promise<string | undefined> {
  try {
    const query = files
      .filter((f) => f.patch)
      .map((f) => `${f.filename}\n${f.patch}`)
      .join("\n")
      .slice(0, 2_000);
    if (!query) return undefined;
    const rag = new RAGService(EmbeddingService.fromEnv());
    const changed = new Set(files.map((f) => f.filename));
    const chunks = (await rag.getSimilarChunks(query, repositoryId, 8)).filter((c) => !changed.has(c.filePath)).slice(0, 5);
    return rag.formatContextForPrompt(chunks) || undefined;
  } catch (err) {
    // RAG is best-effort — never block a review on embeddings.
    log.warn("related-code lookup skipped", { error: (err as Error).message });
    return undefined;
  }
}

function scopeNotes(result: { includedFiles: string[]; excludedFiles: string[]; ignoredFiles: string[]; noPatchFiles: string[] }, incremental: boolean): string[] {
  const notes = [`Reviewed ${result.includedFiles.length} file(s)${incremental ? " changed since the last review" : ""}.`];
  if (result.excludedFiles.length) notes.push(`Skipped for size: ${result.excludedFiles.join(", ")}`);
  if (result.ignoredFiles.length) notes.push(`Ignored by config: ${result.ignoredFiles.length} file(s)`);
  if (result.noPatchFiles.length) notes.push(`No diff available: ${result.noPatchFiles.join(", ")}`);
  return notes;
}

async function currentMetadata(reviewId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ metadata: reviews.metadata }).from(reviews).where(eq(reviews.id, reviewId)).limit(1);
  return (row?.metadata as Record<string, unknown>) ?? {};
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export { PermanentError };
