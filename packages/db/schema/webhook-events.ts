import { bigint, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { githubInstallations } from "./github-installations";
import { repositories } from "./repositories";

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "received",
  "processing",
  "processed",
  "failed",
  "ignored",
]);

export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubDeliveryId: text("github_delivery_id").unique(), // X-GitHub-Delivery header
  installationId: uuid("installation_id").references(() => githubInstallations.id, {
    onDelete: "set null",
  }),
  repositoryId: uuid("repository_id").references(() => repositories.id, {
    onDelete: "set null",
  }),
  event: text("event").notNull(), // e.g. "pull_request", "push", "installation"
  action: text("action"), // e.g. "opened", "synchronize", "closed"
  payload: jsonb("payload").notNull(),
  status: webhookDeliveryStatusEnum("status").default("received").notNull(),
  error: text("error"), // error message if failed
  /** When this delivery was last put on Kafka (by the web app or the outbox sweeper). */
  lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
  /** How many times it was published; the sweeper gives up after a few. */
  publishAttempts: integer("publish_attempts").default(0).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
