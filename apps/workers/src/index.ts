import "./env"; // must be first: loads env before other modules read process.env

import { getEnv } from "@codeguard/config";
import {
  consume,
  disconnectProducer,
  ensureTopics,
  TOPICS,
  RepoIndexRequested,
  ReviewRequested,
  WebhookReceived,
} from "@codeguard/kafka";
import { createProvider, localEmbedder } from "@codeguard/review-engine";
import { createIndexJob } from "./jobs/index-repo";
import { onWebhookReceived } from "./jobs/router";
import { createReviewJob } from "./jobs/review";
import { startSweepers } from "./sweepers";

/**
 * CodeGuard workers: the slow part of the system.
 *
 *   codeguard.webhook.received     ──▶ router ──▶ review.requested / repo.index.requested
 *   codeguard.review.requested     ──▶ review ──▶ DB + GitHub
 *   codeguard.repo.index.requested ──▶ index  ──▶ code_chunks + code_files
 *   + sweepers (outbox, stuck reviews)
 *
 * Each consumer group can be scaled by running more copies of this process;
 * Kafka splits the partitions between them.
 */
async function main() {
  const env = getEnv(); // fail fast on missing config
  const provider = createProvider(env); // fail fast on a missing model key
  const embedder = localEmbedder();

  await ensureTopics();

  const consumers = await Promise.all([
    consume({
      topic: TOPICS.webhookReceived,
      groupId: "codeguard-router",
      schema: WebhookReceived,
      handler: onWebhookReceived,
      partitionsConsumedConcurrently: 3,
    }),
    consume({
      topic: TOPICS.reviewRequested,
      groupId: "codeguard-review",
      schema: ReviewRequested,
      handler: createReviewJob({ provider, embedder }),
      maxAttempts: 2, // a full retry re-runs the model; keep it to one
      partitionsConsumedConcurrently: 2, // at most 2 reviews at once per process (LLM rate limits)
    }),
    consume({
      topic: TOPICS.repoIndexRequested,
      groupId: "codeguard-index",
      schema: RepoIndexRequested,
      handler: createIndexJob(embedder),
      maxAttempts: 3,
      partitionsConsumedConcurrently: 1, // embedding is CPU-heavy: one repo at a time
    }),
  ]);
  const stopSweepers = startSweepers();
  console.info(`[workers] ready · model ${provider.name}/${provider.model} · embeddings ${embedder.model}`);

  // Leave the consumer groups cleanly so partitions are reassigned quickly.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    stopSweepers();
    await Promise.allSettled(consumers.map((c) => c.disconnect()));
    await disconnectProducer();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err) => {
  console.error("[workers] failed to start:", err);
  process.exit(1);
});
