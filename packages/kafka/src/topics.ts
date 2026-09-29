/**
 * Canonical Kafka topic names for CodeGuard AI.
 *
 * ALL producers and consumers MUST import from here.
 * Never hard-code topic strings outside this file.
 */
export const TOPICS = {
  /**
   * Published by: Next.js API route (POST /api/webhooks/github)
   * Consumed by:  webhookProcessor worker
   *
   * Payload: raw GitHub webhook body + event type header
   */
  WEBHOOK_RECEIVED: "codeguard.webhook.received",

  /**
   * Published by: webhookProcessor (after filtering PR events)
   *              Next.js API route (POST /api/github/review) for sync fallback
   * Consumed by:  reviewProcessor worker
   *
   * Payload: { owner, repo, pullNumber, userId, triggeredBy }
   */
  REVIEW_REQUESTED: "codeguard.review.requested",

  /**
   * Published by: reviewProcessor worker (after AI review completes)
   * Consumed by:  future notification worker, analytics, etc.
   *
   * Payload: { reviewId, prNumber, score, issueCount, userId }
   */
  REVIEW_COMPLETED: "codeguard.review.completed",

  /**
   * Published by: webhookProcessor (on push events to indexed repos)
   * Consumed by:  incrementalIndexer worker
   *
   * Payload: { owner, repo, repositoryId, changedFiles, headSha, pusher }
   */
  INDEX_INCREMENTAL: "codeguard.index.incremental",

  /**
   * Dead-letter topics. A message lands here (with the error attached) when
   * it cannot be parsed or keeps failing after retries, instead of being
   * silently dropped or blocking its partition.
   */
  WEBHOOK_RECEIVED_DLQ: "codeguard.webhook.received.dlq",
  REVIEW_REQUESTED_DLQ: "codeguard.review.requested.dlq",
  INDEX_INCREMENTAL_DLQ: "codeguard.index.incremental.dlq",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];
