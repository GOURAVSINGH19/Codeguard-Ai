import { TOPICS, IndexIncrementalEventSchema } from "@codeguard/kafka";
import type { IndexIncrementalEvent } from "@codeguard/kafka";
import { db, repositories, codeChunks, eq, and } from "@codeguard/db";
import { EmbeddingService } from "../ai/EmbeddingService.js";
import { RAGService } from "../rag/RAGService.js";
import { runConsumer } from "../queue/consumer.js";
import { getRepoOctokit } from "../github/octokit.js";
import { logger } from "../lib/logger.js";

const CONSUMER_GROUP = "codeguard-incremental-indexer";

/**
 * incrementalIndexer
 *
 * Consumes: codeguard.index.incremental
 *
 * Responsibilities:
 *  1. Validate the incremental index event
 *  2. Fetch changed file contents from GitHub
 *  3. Re-embed and update only the changed files in the vector DB
 *  4. Update the commit SHA for those files in code_chunks
 */
export async function startIncrementalIndexer(): Promise<void> {
  await runConsumer({
    name: "incrementalIndexer",
    groupId: CONSUMER_GROUP,
    topic: TOPICS.INDEX_INCREMENTAL,
    schema: IndexIncrementalEventSchema,
    handler: processIncrementalIndex,
  });
}

export async function processIncrementalIndex(event: IndexIncrementalEvent): Promise<void> {
  const log = logger.child({ repo: `${event.owner}/${event.repo}`, headSha: event.headSha });
  const filesToIndex = event.changedFiles.filter((f) => shouldIndexFile(f));
  if (filesToIndex.length === 0) {
    log.info("no indexable files in push");
    return;
  }

  const octokit = await getRepoOctokit(event.owner, event.repo, event.installationId);
  const ragService = new RAGService(EmbeddingService.fromEnv());

  // Resolve each path to its BLOB sha at the pushed commit. (Previously the
  // commit sha was passed to git.getBlob, which fails for every file.)
  const { data: tree } = await octokit.rest.git.getTree({
    owner: event.owner,
    repo: event.repo,
    tree_sha: event.headSha,
    recursive: "1",
  });
  const blobShaByPath = new Map(
    (tree.tree ?? []).filter((t) => t.type === "blob" && t.path && t.sha).map((t) => [t.path!, t.sha!])
  );

  let filesIndexed = 0;
  let chunksCreated = 0;
  let filesRemoved = 0;
  let skippedFiles = 0;

  for (const filePath of filesToIndex) {
    const blobSha = blobShaByPath.get(filePath);
    try {
      if (!blobSha) {
        // Deleted or renamed away — drop its stale chunks.
        await db
          .delete(codeChunks)
          .where(and(eq(codeChunks.repositoryId, event.repositoryId), eq(codeChunks.filePath, filePath)));
        filesRemoved++;
        continue;
      }
      const created = await ragService.indexFile(event.repositoryId, event.owner, event.repo, filePath, blobSha, octokit);
      if (created > 0) {
        filesIndexed++;
        chunksCreated += created;
      } else {
        skippedFiles++;
      }
    } catch (err) {
      log.warn("file not indexed", { filePath, error: (err as Error).message });
      skippedFiles++;
    }
  }

  await db
    .update(repositories)
    .set({ updatedAt: new Date() })
    .where(eq(repositories.id, event.repositoryId));

  log.info("incremental index done", { filesIndexed, chunksCreated, filesRemoved, skippedFiles });
}

function shouldIndexFile(filePath: string): boolean {
  // Skip known noisy paths
  const SKIP_PATTERNS = [
    "node_modules", ".git", "dist", "build", ".next", ".nuxt",
    "coverage", "__pycache__", ".venv", "vendor",
    "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
    ".min.js", ".min.css", ".map",
  ];

  if (SKIP_PATTERNS.some((p) => filePath.includes(p))) return false;

  // Check extension
  const INDEXABLE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".kt", ".swift",
    ".c", ".cpp", ".h", ".hpp", ".cs",
    ".rb", ".php", ".vue", ".svelte",
    ".sql", ".graphql", ".gql",
    ".sh", ".bash", ".zsh",
    ".yaml", ".yml", ".json", ".toml", ".env.example",
    ".md", ".mdx",
  ]);

  const ext = filePath.slice(filePath.lastIndexOf("."));
  return INDEXABLE_EXTENSIONS.has(ext);
}