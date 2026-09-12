import { bigint, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { reviews } from "./reviews";

export const commentSeverityEnum = pgEnum("comment_severity", [
  "critical",
  "high",
  "medium",
  "low",
  "major",
  "minor",
  "suggestion",
  "info",
]);

export const commentCategoryEnum = pgEnum("comment_category", [
  "security",
  "bug",
  "performance",
  "maintainability",
  "style",
  "correctness",
  "test_coverage",
  "documentation",
  "other",
]);

export const reviewComments = pgTable("review_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id")
    .notNull()
    .references(() => reviews.id, { onDelete: "cascade" }),
  filePath: text("file_path").default("snippet"),
  lineNumber: integer("line_number"),
  lineStart: integer("line_start"),
  lineEnd: integer("line_end"),
  side: text("side").default("RIGHT"),
  comment: text("comment"),
  body: text("body").notNull(),
  suggestion: text("suggestion"),
  severity: commentSeverityEnum("severity").default("low").notNull(),
  category: commentCategoryEnum("category").default("other").notNull(),
  githubCommentId: bigint("github_comment_id", { mode: "number" }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ReviewComment = typeof reviewComments.$inferSelect;
export type NewReviewComment = typeof reviewComments.$inferInsert;
