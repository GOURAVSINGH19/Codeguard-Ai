import { sql } from "drizzle-orm";
import { doublePrecision, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pullRequests } from "./pull-requests";

export const reviewStatusEnum = pgEnum("review_status", [
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

export const reviewTypeEnum = pgEnum("review_type", [
  "automated",
  "ai_suggested",
  "paste_code",
]);

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id"),
  pullRequestId: uuid("pull_request_id")
    .references(() => pullRequests.id, { onDelete: "cascade" }),
  /** Commit the review ran against — with pullRequestId, the idempotency key. */
  headSha: text("head_sha"),
  title: text("title"),
  codeSnippet: text("code_snippet"),
  language: text("language"),
  score: doublePrecision("score"),
  status: reviewStatusEnum("status").default("pending").notNull(),
  reviewType: reviewTypeEnum("review_type").default("automated").notNull(),
  model: text("model"),
  summary: text("summary"),
  overallScore: text("overall_score"),
  metadata: jsonb("metadata"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // At most one live (non-failed) review per PR commit per requester (NULL =
  // automated): webhook redeliveries, double clicks and concurrent workers
  // all collapse onto the same row.
  uniqueIndex("reviews_pr_head_sha_active_uq")
    .on(table.pullRequestId, table.headSha, sql`coalesce(${table.userId}, '')`)
    .where(sql`${table.headSha} IS NOT NULL AND ${table.status} <> 'failed'`),
  // Rate limiting and "my reviews" lookups.
  index("reviews_user_created_idx").on(table.userId, table.createdAt),
]);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
