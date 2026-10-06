import { bigint, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
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

/** Lifecycle of a finding after it is reported. */
export const findingStatusEnum = pgEnum("finding_status", ["open", "resolved", "dismissed"]);

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
  /** Pipeline stage that produced it: quality, security, testing, align… */
  source: text("source"),
  /** 0..1 — how likely the finding is real. */
  confidence: real("confidence"),
  ruleId: text("rule_id"),
  status: findingStatusEnum("status").default("open").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /** Clerk user id of whoever resolved or dismissed it. */
  resolvedBy: text("resolved_by"),
  resolutionNote: text("resolution_note"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("review_comments_review_idx").on(table.reviewId)]);

export type ReviewComment = typeof reviewComments.$inferSelect;
export type NewReviewComment = typeof reviewComments.$inferInsert;
