import { doublePrecision, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
});

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
