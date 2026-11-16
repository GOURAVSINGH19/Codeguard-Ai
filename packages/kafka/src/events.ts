import { z } from "zod";

/**
 * The CONTRACT between the web app and the workers.
 * Both import these schemas, so changing an event's shape breaks both sides
 * at compile time instead of in production.
 *
 * Messages stay small: they point at rows in Postgres (the source of truth)
 * instead of carrying whole payloads.
 */

export const WebhookReceived = z.object({
  type: z.literal("webhook.received"),
  webhookEventId: z.uuid(), // row in webhook_events: the worker reads the payload from Postgres
  deliveryId: z.string().min(1),
  eventType: z.string().min(1),
  action: z.string().nullable(),
});

export const ReviewRequested = z.object({
  type: z.literal("review.requested"),
  installationId: z.number().int().positive(),
  repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/name"),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-char commit sha"),
  trigger: z.enum(["webhook", "manual"]),
  requestedBy: z.string().nullable(), // Clerk user id for manual reviews
});

/**
 * Bring a repo's code index (code_chunks + code_files) up to date with a commit
 * of its default branch. Idempotent: unchanged files (same git blob sha) are skipped,
 * so a full index and an incremental one are the same job.
 */
export const RepoIndexRequested = z.object({
  type: z.literal("repo.index.requested"),
  repositoryId: z.uuid(),
  installationId: z.number().int().positive(),
  ref: z.string().nullable(), // commit sha; null = current tip of the default branch
  reason: z.enum(["installed", "push", "review", "manual"]),
});

export type WebhookReceived = z.infer<typeof WebhookReceived>;
export type RepoIndexRequested = z.infer<typeof RepoIndexRequested>;
export type ReviewRequested = z.infer<typeof ReviewRequested>;
