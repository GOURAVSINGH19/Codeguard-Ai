/** Topic names: one place, so web and workers can't drift apart. */
export const TOPICS = {
  webhookReceived: "codeguard.webhook.received",
  reviewRequested: "codeguard.review.requested",
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

/** Dead-letter topic: where a message goes after it keeps failing. */
export const dlq = (topic: string) => `${topic}.dlq`;

export const ALL_TOPICS: string[] = Object.values(TOPICS).flatMap((t) => [t, dlq(t)]);

/**
 * Partition key for everything about one PR.
 * Same key → same partition → events for PR #7 are processed in order,
 * while different PRs run in parallel.
 */
export const prKey = (repoFullName: string, prNumber: number) => `${repoFullName.toLowerCase()}#${prNumber}`;
