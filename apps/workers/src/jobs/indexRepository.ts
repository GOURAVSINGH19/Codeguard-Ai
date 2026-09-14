import { Octokit } from "octokit";
import { db, repositories } from "@codeguard/db";
import { eq } from "drizzle-orm";
import { EmbeddingService } from "../ai/EmbeddingService.js";
import { RAGService } from "../rag/RAGService.js";

/**
 * indexRepository
 *
 * Triggered manually or via Kafka when a new repository is added.
 * Fetches all source files, chunks + embeds them, and stores in code_chunks.
 *
 * Usage from workers:
 *   await indexRepository({ owner: "acme", repo: "api", repositoryId: "uuid" });
 *
 * In a full production system this would also be triggered by push events
 * (only re-index changed files based on the commit's file list).
 */
export async function indexRepository(opts: {
  owner: string;
  repo: string;
  repositoryId: string;
}): Promise<void> {
  const { owner, repo, repositoryId } = opts;

  console.log(`[indexRepository] Starting for ${owner}/${repo} (id: ${repositoryId})`);

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required in workers .env to index repositories");
  }

  // Look up the default branch from our DB record
  const [repoRecord] = await db
    .select({ defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  const defaultBranch = repoRecord?.defaultBranch ?? "main";

  const octokit = new Octokit({ auth: githubToken });
  const embeddingService = EmbeddingService.fromEnv();
  const ragService = new RAGService(embeddingService);

  const result = await ragService.indexRepository(
    repositoryId,
    owner,
    repo,
    octokit,
    defaultBranch
  );

  console.log(
    `[indexRepository] Done — ` +
      `${result.filesIndexed} files, ${result.chunksCreated} chunks, ` +
      `${result.skippedFiles} skipped`
  );
}
