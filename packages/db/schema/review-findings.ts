import { pgTable, uuid, text, integer, real, timestamp, index } from "drizzle-orm/pg-core";
import { reviews } from "./reviews";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CATEGORIES = ["security", "bug", "performance", "maintainability", "style"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];

/**
 * One issue found in a review.
 *
 * A REAL foreign key this time: our own code writes the review row first, so
 * insert order is known, and ON DELETE CASCADE removes findings with their review.
 */
export const reviewFindings = pgTable(
  "review_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    file: text("file"), // null = PR-level finding
    line: integer("line"),
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    category: text("category", { enum: CATEGORIES }).notNull(),
    message: text("message").notNull(),
    suggestion: text("suggestion"),
    source: text("source").notNull().default("ai"), // "ai" | "eslint"
    confidence: real("confidence"), // 0–1, filled by the Day 3 verifier
    status: text("status", { enum: ["open", "resolved", "dismissed"] })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("review_findings_review_idx").on(t.reviewId)],
);

export type ReviewFinding = typeof reviewFindings.$inferSelect;
export type NewReviewFinding = typeof reviewFindings.$inferInsert;
