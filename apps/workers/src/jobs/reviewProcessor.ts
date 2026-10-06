import { TOPICS, ReviewRequestedEventSchema } from "@codeguard/kafka";
import type { ReviewRequestedEvent } from "@codeguard/kafka";
import { runConsumer, PermanentError } from "../queue/consumer.js";
import { runReviewPipeline } from "../pipeline/reviewPipeline.js";
import { requestIndexIfMissing } from "../pipeline/indexing.js";

const CONSUMER_GROUP = "codeguard-review-processor";

/**
 * reviewProcessor
 *
 * Consumes: codeguard.review.requested (webhooks, dashboard requests, recovery sweeper)
 * Publishes: codeguard.review.completed, codeguard.index.full (backfill)
 *
 * The work itself is the staged review pipeline in ../pipeline. Failures are
 * retried by `runConsumer` and end in the DLQ; the review row is marked
 * `failed`, which frees the (PR, SHA) slot for the retry.
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
  const state = await runReviewPipeline(event);
  // Repos installed before automatic indexing have no chunks, so RAG and the
  // dependency graph found nothing this time; index them for the next review.
  if (state.repositoryId) await requestIndexIfMissing(state.repositoryId, event.owner, event.repo, event.installationId ?? null, state.log);
}

export { PermanentError };
