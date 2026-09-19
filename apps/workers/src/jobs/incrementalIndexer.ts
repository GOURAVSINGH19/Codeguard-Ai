import {
  TOPICS,
  IndexIncrementalEventSchema,
} from "@codeguard/kafka";
import type { IndexIncrementalEvent } from "@codeguard/kafka";
import type { EachMessagePayload } from "kafkajs";
import { Octokit } from "octokit";
import { db, repositories } from "@codeguard/db";
import { eq } from "drizzle-orm";
import { EmbeddingService } from "../ai/EmbeddingService.js";
import { RAGService } from "../rag/RAGService.js";
import { getWorkerConsumer } from "../queue/kafkaClient.js";

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
  const consumer = await getWorkerConsumer(CONSUMER_GROUP);

  await consumer.subscribe({
    topic: TOPICS.INDEX_INCREMENTAL,
    fromBeginning: false,
  });

  console.log(
    `[incrementalIndexer] Listening on topic: ${TOPICS.INDEX_INCREMENTAL}`
  );

  await consumer.run({
    eachMessage: async ({ message }: EachMessagePayload) => {
      const raw = message.value?.toString();
      if (!raw) return;

      // ── 1. Validate the incoming event ────────────────────────────────────
      const parsed = IndexIncrementalEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        console.warn(
          "[incrementalIndexer] Invalid event:",
          parsed.error.issues
        );
        return;
      }
      const event = parsed.data;

      console.log(
        `[incrementalIndexer] Processing incremental index for ${event.owner}/${event.repo} (${event.changedFiles.length} files)`
      );

      try {
        const githubToken = process.env.GITHUB_TOKEN;
        if (!githubToken) {
          throw new Error("GITHUB_TOKEN is required in workers .env");
        }

        const octokit = new Octokit({ auth: githubToken });
        const embeddingService = EmbeddingService.fromEnv();
        const ragService = new RAGService(embeddingService);

        // Fetch current commit SHA for each file to compare
        // We'll re-index all changed files regardless - simpler and safer
        const filesToIndex = event.changedFiles.filter((f: string) => shouldIndexFile(f));

        if (filesToIndex.length === 0) {
          console.log(`[incrementalIndexer] No indexable files in changed set`);
          return;
        }

        let filesIndexed = 0;
        let chunksCreated = 0;
        let skippedFiles = 0;

        // Process in small batches to respect rate limits
        const BATCH_SIZE = 5;
        for (let i = 0; i < filesToIndex.length; i += BATCH_SIZE) {
          const batch = filesToIndex.slice(i, i + BATCH_SIZE);

          for (const filePath of batch) {
            try {
              const created = await ragService.indexFile(
                event.repositoryId,
                event.owner,
                event.repo,
                filePath,
                event.headSha,
                octokit
              );
              if (created > 0) {
                filesIndexed++;
                chunksCreated += created;
              } else {
                skippedFiles++;
              }
            } catch (err: any) {
              console.warn(
                `[incrementalIndexer] Failed to index ${filePath}: ${err.message}`
              );
              skippedFiles++;
            }
          }
        }

        // Update repository's default branch commit SHA if this is the default branch
        const refBranch = event.ref.replace("refs/heads/", "");
        const [repoRecord] = await db
          .select({ defaultBranch: repositories.defaultBranch })
          .from(repositories)
          .where(eq(repositories.id, event.repositoryId))
          .limit(1);

        if (repoRecord && refBranch === repoRecord.defaultBranch) {
          await db
            .update(repositories)
            .set({ updatedAt: new Date() })
            .where(eq(repositories.id, event.repositoryId));
        }

        console.log(
          `[incrementalIndexer] ✓ Done ${event.owner}/${event.repo} — ` +
          `${filesIndexed} files, ${chunksCreated} chunks, ${skippedFiles} skipped`
        );
      } catch (err: any) {
        console.error(
          `[incrementalIndexer] ✗ Failed for ${event.owner}/${event.repo}:`,
          err.message
        );
        // Don't throw — let Kafka commit the offset. A production system
        // would send to a dead-letter topic here.
      }
    },
  });
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