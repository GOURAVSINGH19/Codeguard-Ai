import { TOPICS, IndexFullEventSchema } from "@codeguard/kafka";
import type { IndexFullEvent } from "@codeguard/kafka";
import { db, repositories, codeChunks, eq } from "@codeguard/db";
import { EmbeddingService } from "../ai/EmbeddingService.js";
import { RAGService } from "../rag/RAGService.js";
import { runConsumer } from "../queue/consumer.js";
import { getRepoOctokit } from "../github/octokit.js";
import { logger } from "../lib/logger.js";

const CONSUMER_GROUP = "codeguard-full-indexer";

/**
 * fullIndexer
 *
 * Consumes: codeguard.index.full
 *
 * Chunks and embeds every source file of a repository's default branch so RAG
 * and the dependency graph have data. Messages are keyed by repository, so
 * requests for one repo run one after another on one partition: a repeated
 * request finds the chunks written by the first one and is skipped.
 * Later pushes are kept current by incrementalIndexer.
 */
export async function startFullIndexer(): Promise<void> {
  await runConsumer({
    name: "fullIndexer",
    groupId: CONSUMER_GROUP,
    topic: TOPICS.INDEX_FULL,
    schema: IndexFullEventSchema,
    handler: processFullIndex,
  });
}

export async function processFullIndex(event: IndexFullEvent): Promise<void> {
  const log = logger.child({ repo: `${event.owner}/${event.repo}`, reason: event.reason });

  const [repoRecord] = await db
    .select({ defaultBranch: repositories.defaultBranch, status: repositories.status })
    .from(repositories)
    .where(eq(repositories.id, event.repositoryId))
    .limit(1);
  if (!repoRecord || repoRecord.status !== "active") {
    log.info("skipped: repository not connected");
    return;
  }

  if (await hasChunks(event.repositoryId)) {
    log.info("skipped: repository already indexed");
    return;
  }

  const octokit = await getRepoOctokit(event.owner, event.repo, event.installationId);
  const rag = new RAGService(EmbeddingService.fromEnv());
  const started = Date.now();
  const result = await rag.indexRepository(event.repositoryId, event.owner, event.repo, octokit, repoRecord.defaultBranch);

  log.info("full index done", {
    filesIndexed: result.filesIndexed,
    chunksCreated: result.chunksCreated,
    skippedFiles: result.skippedFiles,
    durationMs: Date.now() - started,
  });
}

export async function hasChunks(repositoryId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: codeChunks.id })
    .from(codeChunks)
    .where(eq(codeChunks.repositoryId, repositoryId))
    .limit(1);
  return Boolean(row);
}
