import { z } from "zod";

// ─── codeguard.webhook.received ──────────────────────────────────────────────

export const WebhookReceivedEventSchema = z.object({
  /** GitHub X-GitHub-Event header value e.g. "pull_request", "push" */
  githubEvent: z.string(),
  /** GitHub X-GitHub-Delivery header — unique delivery ID */
  deliveryId: z.string(),
  /** Raw JSON payload string from GitHub */
  payload: z.string(),
  /** ISO timestamp when the webhook was received */
  receivedAt: z.string().datetime(),
});

export type WebhookReceivedEvent = z.infer<typeof WebhookReceivedEventSchema>;

// ─── codeguard.review.requested ──────────────────────────────────────────────

export const ReviewRequestedEventSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pullNumber: z.number().int().positive(),
  /** Clerk userId of the person who triggered the review (null for bot-triggered) */
  userId: z.string().nullable(),
  /** How this review was triggered */
  triggeredBy: z.enum(["webhook", "manual", "api"]),
  /** ISO timestamp */
  requestedAt: z.string().datetime(),
});

export type ReviewRequestedEvent = z.infer<typeof ReviewRequestedEventSchema>;

// ─── codeguard.review.completed ──────────────────────────────────────────────

export const ReviewCompletedEventSchema = z.object({
  reviewId: z.string().uuid(),
  prNumber: z.number().int().positive(),
  owner: z.string(),
  repo: z.string(),
  score: z.number().min(0).max(10),
  issueCount: z.number().int().nonnegative(),
  userId: z.string().nullable(),
  completedAt: z.string().datetime(),
});

export type ReviewCompletedEvent = z.infer<typeof ReviewCompletedEventSchema>;

// ─── GitHub Push Event (raw webhook payload) ───────────────────────────────────

export const GitHubPushEventSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  repository: z.object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    owner: z.object({
      login: z.string(),
    }),
    clone_url: z.string(),
    default_branch: z.string(),
  }),
  pusher: z.object({
    name: z.string(),
    email: z.string().optional(),
  }),
  commits: z.array(z.object({
    id: z.string(),
    message: z.string(),
    timestamp: z.string(),
    author: z.object({
      name: z.string(),
      email: z.string(),
    }),
    added: z.array(z.string()).optional(),
    removed: z.array(z.string()).optional(),
    modified: z.array(z.string()).optional(),
  })).optional(),
});

export type GitHubPushEvent = z.infer<typeof GitHubPushEventSchema>;

// ─── codeguard.index.incremental ───────────────────────────────────────────────

export const IndexIncrementalEventSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  repositoryId: z.string().uuid(),
  /** Files that changed in the push (from commit file lists) */
  changedFiles: z.array(z.string()),
  /** Head commit SHA after the push */
  headSha: z.string(),
  /** Who pushed */
  pusher: z.string(),
  /** ISO timestamp */
  triggeredAt: z.string().datetime(),
});

export type IndexIncrementalEvent = z.infer<typeof IndexIncrementalEventSchema>;
