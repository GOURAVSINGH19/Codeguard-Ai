import {
  TOPICS,
  ReviewRequestedEventSchema,
  ReviewCompletedEventSchema,
} from "@codeguard/kafka";
import type { ReviewCompletedEvent } from "@codeguard/kafka";
import type { EachMessagePayload } from "kafkajs";
import { Octokit } from "octokit";
import { db, reviews, reviewComments, repositories, pullRequests, codeChunks } from "@codeguard/db";
import { eq, and } from "drizzle-orm";
import { EmbeddingService } from "../ai/EmbeddingService.js";
import { RAGService } from "../rag/RAGService.js";
import { PRDiffSelector } from "../analyzers/PRDiffSelector.js";
import type { PRFile } from "../analyzers/PRDiffSelector.js";
import { getWorkerConsumer, getWorkerProducer } from "../queue/kafkaClient.js";

const CONSUMER_GROUP = "codeguard-review-processor";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * reviewProcessor
 *
 * Consumes: codeguard.review.requested
 * Publishes: codeguard.review.completed
 *
 * Responsibilities:
 *  1. Fetch PR diff from GitHub using the App token (bot-triggered)
 *     or a service account token
 *  2. Call Groq AI to analyse the diff
 *  3. Persist the review + issues to DB via a direct DB call
 *  4. Post the review comment back to the GitHub PR
 *  5. Publish a review.completed event for downstream consumers
 *
 * Note: This processor runs INDEPENDENTLY of the Next.js API.
 * It replicates the same AI + DB logic using the same shared packages
 * (@codeguard/db, @codeguard/types) — no HTTP round-trip to the web app.
 */
export async function startReviewProcessor(): Promise<void> {
  const consumer = await getWorkerConsumer(CONSUMER_GROUP);
  const producer = await getWorkerProducer();

  await consumer.subscribe({
    topic: TOPICS.REVIEW_REQUESTED,
    fromBeginning: false,
  });

  console.log(
    `[reviewProcessor] Listening on topic: ${TOPICS.REVIEW_REQUESTED}`
  );

  await consumer.run({
    eachMessage: async ({ message, topic: _topic, partition: _partition }: EachMessagePayload) => {
      const raw = message.value?.toString();
      if (!raw) return;

      // ── 1. Validate event ──────────────────────────────────────────────
      const parsed = ReviewRequestedEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.warn(
          "[reviewProcessor] Invalid review.requested event:",
          parsed.error.issues
        );
        return;
      }

      const { owner, repo, pullNumber, userId, triggeredBy } = parsed.data;
      console.log(
        `[reviewProcessor] Processing PR review: ${owner}/${repo}#${pullNumber} (triggered by: ${triggeredBy})`
      );

      try {
        // ── 2. Fetch PR diff from GitHub ─────────────────────────────────
        const octokit = getOctokit();
        const [{ data: prData }, { data: filesData }] = await Promise.all([
          octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
          octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 50,
          }),
        ]);

        // ── 3. Graph-aware diff selection (replaces naive .slice()) ───────
        // Look up repo record first — needed for both graph and RAG
        const [repoRecord] = await db
          .select({ id: repositories.id, githubRepoId: repositories.githubRepoId })
          .from(repositories)
          .where(eq(repositories.githubRepoId, prData.base.repo.id))
          .limit(1);

        // Load stored code chunks to build the dependency graph.
        // These were created by indexRepository — content column has the source.
        // If chunks aren't indexed yet, graph falls back to lines-changed ranking.
        let repoFileContents = new Map<string, string>();
        if (repoRecord) {
          const chunks = await db
            .select({
              filePath: codeChunks.filePath,
              content: codeChunks.content,
            })
            .from(codeChunks)
            .where(eq(codeChunks.repositoryId, repoRecord.id));

          // Reconstruct per-file content by joining chunks in order
          const fileMap = new Map<string, string[]>();
          for (const chunk of chunks) {
            const existing = fileMap.get(chunk.filePath) ?? [];
            existing.push(chunk.content);
            fileMap.set(chunk.filePath, existing);
          }
          repoFileContents = new Map(
            Array.from(fileMap.entries()).map(([fp, parts]) => [fp, parts.join("\n")])
          );
        }

        // Run the graph-aware selector
        const prFiles: PRFile[] = filesData.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        }));

        const selector = new PRDiffSelector();
        const selected = selector.select(prFiles, repoFileContents);

        const diffContext = selected.diffContext;

        console.log(
          `[reviewProcessor] Diff selection: ${selected.includedFiles.length} files included, ` +
          `${selected.excludedFiles.length} excluded, ` +
          `${selected.transitiveRiskFiles.length} transitive risk files, ` +
          `graph used: ${selected.graphUsed}`
        );
        if (selected.excludedFiles.length > 0) {
          console.log(`[reviewProcessor] Excluded (budget): ${selected.excludedFiles.join(", ")}`);
        }
        if (selected.transitiveRiskFiles.length > 0) {
          console.log(`[reviewProcessor] Transitive risk: ${selected.transitiveRiskFiles.join(", ")}`);
        }

        // ── 4. Fetch RAG context (similar code from this repo) ───────────
        // repoRecord was already fetched in step 3 for the graph selector
        let ragContext = "";
        try {
          if (repoRecord) {
            const embeddingService = EmbeddingService.fromEnv();
            const ragService = new RAGService(embeddingService);
            // Use the first 2000 chars of the selected diff as the RAG query
            // (selected.diffContext already contains the highest-risk files first)
            const ragQuery = diffContext.slice(0, 2000);
            const similarChunks = await ragService.getSimilarChunks(
              ragQuery,
              repoRecord.id,
              5
            );
            ragContext = ragService.formatContextForPrompt(similarChunks);
            if (ragContext) {
              console.log(
                `[reviewProcessor] RAG: found ${similarChunks.length} similar chunks for context`
              );
            }
          }
        } catch (ragErr: any) {
          // RAG is best-effort — never block the review on embedding failures
          console.warn("[reviewProcessor] RAG context fetch failed (non-fatal):", ragErr.message);
        }

        // ── 5. Call AI (with graph-selected diff + RAG context) ──────────
        const reviewOutput = await callGroqForPRDiff(
          diffContext,
          prData.title,
          prData.body,
          ragContext
        );

        // ── 6. Persist review + issues to DB ────────────────────────────
        const reviewId = await persistReview({
          userId,
          owner,
          repo,
          pullNumber,
          prData,
          filesData,
          reviewOutput,
        });

        // ── 7. Post comment back to GitHub PR ────────────────────────────
        await postGitHubComment(
          octokit,
          owner,
          repo,
          pullNumber,
          reviewOutput.score,
          reviewOutput.summary,
          reviewOutput.issues
        );

        // ── 8. Publish review.completed ──────────────────────────────────
        const completedEvent: ReviewCompletedEvent = {
          reviewId,
          prNumber: pullNumber,
          owner,
          repo,
          score: reviewOutput.score,
          issueCount: reviewOutput.issues.length,
          userId,
          completedAt: new Date().toISOString(),
        };

        await producer.send({
          topic: TOPICS.REVIEW_COMPLETED,
          messages: [
            {
              key: `${owner}/${repo}/${pullNumber}`,
              value: JSON.stringify(completedEvent),
            },
          ],
        });

        console.log(
          `[reviewProcessor] ✓ Review completed for ${owner}/${repo}#${pullNumber} — score: ${reviewOutput.score}/10`
        );
      } catch (err: any) {
        console.error(
          `[reviewProcessor] ✗ Failed review for ${owner}/${repo}#${pullNumber}:`,
          err.message
        );
        // Message is committed so Kafka doesn't re-deliver infinitely.
        // A production system would send to a dead-letter topic here.
      }
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is required in workers .env for bot-triggered reviews"
    );
  }
  return new Octokit({ auth: token });
}

interface ReviewOutput {
  score: number;
  summary: string;
  issues: Array<{
    severity: "critical" | "high" | "medium" | "low";
    category: "security" | "bug" | "performance" | "maintainability" | "style";
    line: number | null;
    message: string;
    suggestion: string | null;
  }>;
}

async function callGroqForPRDiff(
  diffContext: string,
  prTitle: string,
  prBody: string | null,
  ragContext: string = ""
): Promise<ReviewOutput> {
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set in workers .env");

  const ragSection = ragContext
    ? `\n\n${ragContext}\n\n---\n`
    : "";

  const systemPrompt = `You are CodeGuard AI, an expert code reviewer analyzing a GitHub Pull Request diff.
Analyze the PR diff for security flaws, bugs, performance bottlenecks, maintainability issues, and style improvements.

PR Title: "${prTitle}"
PR Description: "${prBody ?? "No description provided"}"
${ragSection}
Constraints:
1. Provide an overall quality score from 0.0 (worst) to 10.0 (perfect).
2. Write a concise executive summary.
3. Issue severities MUST be one of: "critical", "high", "medium", "low".
4. Issue categories MUST be one of: "security", "bug", "performance", "maintainability", "style".
5. Set line to null when no specific line applies.
6. Always provide an actionable code suggestion.
7. If codebase context is provided above, use it to identify issues that conflict with existing patterns.

Return ONLY valid raw JSON:
{ "score": 7.5, "summary": "...", "issues": [{ "severity": "high", "category": "security", "line": null, "message": "...", "suggestion": "..." }] }`;

  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `PR Diff:\n\n${diffContext}` },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq API error (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from Groq");

  return JSON.parse(content) as ReviewOutput;
}

async function persistReview(opts: {
  userId: string | null;
  owner: string;
  repo: string;
  pullNumber: number;
  prData: any;
  filesData: any[];
  reviewOutput: ReviewOutput;
}): Promise<string> {
  const { userId, owner, repo, pullNumber, prData, filesData, reviewOutput } = opts;

  // Upsert repository
  let [repoRecord] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.githubRepoId, prData.base.repo.id))
    .limit(1);

  if (!repoRecord) {
    [repoRecord] = await db
      .insert(repositories)
      .values({
        githubRepoId: prData.base.repo.id,
        fullName: `${owner}/${repo}`,
        owner,
        name: repo,
        defaultBranch: prData.base.repo.default_branch ?? "main",
        isPrivate: prData.base.repo.private ?? false,
        language: prData.base.repo.language ?? null,
        cloneUrl: prData.base.repo.clone_url ?? null,
        htmlUrl: prData.base.repo.html_url ?? null,
      })
      .returning();
  }

  // Upsert pull request
  let [prRecord] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repoRecord.id),
        eq(pullRequests.prNumber, pullNumber)
      )
    )
    .limit(1);

  if (!prRecord) {
    [prRecord] = await db
      .insert(pullRequests)
      .values({
        repositoryId: repoRecord.id,
        githubPrId: prData.id,
        prNumber: pullNumber,
        title: prData.title,
        body: prData.body ?? "",
        state: prData.state === "open" ? "open" : "closed",
        headBranch: prData.head.ref,
        baseBranch: prData.base.ref,
        headSha: prData.head.sha,
        baseSha: prData.base.sha,
        authorLogin: prData.user?.login ?? "unknown",
        additions: prData.additions,
        deletions: prData.deletions,
        changedFiles: prData.changed_files,
      })
      .returning();
  }

  // Insert completed review
  const [review] = await db
    .insert(reviews)
    .values({
      userId,
      pullRequestId: prRecord.id,
      title: `PR #${pullNumber}: ${prData.title}`,
      codeSnippet: `PR #${pullNumber} Diff (${prData.changed_files} files changed)`,
      language: prData.base.repo.language ?? "code",
      score: reviewOutput.score,
      overallScore: `${reviewOutput.score.toFixed(1)}/10`,
      summary: reviewOutput.summary,
      status: "completed",
      reviewType: "automated",
      model: process.env.GROQ_MODEL ?? null,
      completedAt: new Date(),
    })
    .returning();

  // Insert issues
  if (reviewOutput.issues.length > 0) {
    await db.insert(reviewComments).values(
      reviewOutput.issues.map((issue) => ({
        reviewId: review.id,
        filePath: filesData[0]?.filename ?? "PR diff",
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

  return review.id;
}

async function postGitHubComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  score: number,
  summary: string,
  issues: ReviewOutput["issues"]
): Promise<void> {
  const formattedIssues = issues
    .map(
      (issue, idx) =>
        `### ${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.category}\n` +
        `**Message**: ${issue.message}\n` +
        (issue.line != null ? `**Line**: ${issue.line}\n` : "") +
        (issue.suggestion ? `\n\`\`\`suggestion\n${issue.suggestion}\n\`\`\`\n` : "")
    )
    .join("\n\n");

  const body = `## 🛡️ CodeGuard AI Review Summary

**Quality Score**: \`${score.toFixed(1)} / 10\`

### Executive Summary
${summary}

---

### Identified Issues (${issues.length})
${formattedIssues || "🎉 No major issues detected!"}

---
*Powered by CodeGuard AI — automated review via Kafka worker*`;

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "COMMENT",
      body,
    });
  } catch {
    // Fallback to issue comment if createReview fails (e.g. self-PR restriction)
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }
}
