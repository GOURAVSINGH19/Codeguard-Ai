import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * The OUTBOX. Every verified GitHub webhook is saved here BEFORE anything else.
 *
 * - delivery_id is UNIQUE: GitHub may deliver the same event twice (or you click
 *   "Redeliver"); the second insert becomes a no-op.
 * - status lets a sweeper (Day 3) republish rows Kafka never received.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryId: text("delivery_id").notNull().unique(), // X-GitHub-Delivery
    eventType: text("event_type").notNull(), // X-GitHub-Event
    action: text("action"),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ["received", "published", "failed"] })
      .notNull()
      .default("received"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  // The sweeper asks "which rows are still 'received' and older than N seconds?"
  (t) => [index("webhook_events_status_received_idx").on(t.status, t.receivedAt)],
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
