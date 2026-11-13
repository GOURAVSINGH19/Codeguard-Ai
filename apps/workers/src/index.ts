import "./env"; // must be first: loads env before other modules read process.env

import { getEnv } from "@codeguard/config";
import { consume, disconnectProducer, ensureTopics, TOPICS, ReviewRequested, WebhookReceived } from "@codeguard/kafka";
import { createProvider } from "@codeguard/review-engine";
import { onWebhookReceived } from "./jobs/router";
import { createReviewJob } from "./jobs/review";

/**
 * CodeGuard workers: the slow part of the system.
 *
 *   codeguard.webhook.received ──▶ router  ──▶ codeguard.review.requested
 *   codeguard.review.requested ──▶ review  ──▶ DB + GitHub
 *
 * Each consumer group can be scaled by running more copies of this process;
 * Kafka splits the partitions between them.
 */
async function main() {
  const env = getEnv(); // fail fast on missing config
  const provider = createProvider(env); // fail fast on a missing model key

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
      handler: createReviewJob(provider),
      maxAttempts: 2, // a full retry re-runs the model; keep it to one
      partitionsConsumedConcurrently: 2, // at most 2 reviews at once per process (LLM rate limits)
    }),
  ]);

  // Leave the consumer groups cleanly so partitions are reassigned quickly.
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled(consumers.map((c) => c.disconnect()));
    await disconnectProducer();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((err) => {
  console.error("[workers] failed to start:", err);
  process.exit(1);
});
