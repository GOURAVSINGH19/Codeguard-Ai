import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/**
 * One AI review of one commit of one PR.
 *
 * UNIQUE (repo, pr, head_sha): the same commit can be requested many times
 * (redelivery, double click, Kafka redelivery). The database refuses the second
 * row, so two workers can never review the same commit twice.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status", { enum: ["pending", "in_progress", "completed", "failed"] })
      .notNull()
      .default("pending"),
    score: integer("score"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reviews_repo_pr_sha_uq").on(t.repoFullName, t.prNumber, t.headSha),
    index("reviews_created_at_idx").on(t.createdAt),
  ],
);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
