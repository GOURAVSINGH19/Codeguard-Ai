import { pgTable, uuid, text, integer, bigint, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/** Snapshot of the PR at review time, so the review page doesn't need a GitHub call. */
export interface PullRequestSnapshot {
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  authorLogin: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

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
    // Which installation token the worker uses for GitHub calls.
    installationId: bigint("installation_id", { mode: "number" }),
    status: text("status", { enum: ["pending", "in_progress", "completed", "failed"] })
      .notNull()
      .default("pending"),
    // Current pipeline node; the UI maps these names to labels (src/lib/poll-review.ts).
    progress: text("progress"),
    trigger: text("trigger", { enum: ["webhook", "manual"] }).notNull().default("webhook"),
    reviewType: text("review_type").notNull().default("pr"),
    prTitle: text("pr_title"),
    pullRequest: jsonb("pull_request").$type<PullRequestSnapshot>(),
    // What the diff was computed against: the PR base, or the last reviewed commit (incremental).
    baseSha: text("base_sha"),
    reviewedFromSha: text("reviewed_from_sha"),
    score: integer("score"),
    summary: text("summary"),
    error: text("error"),
    model: text("model"),
    tokens: integer("tokens"),
    durationMs: integer("duration_ms"),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    githubReviewUrl: text("github_review_url"),
    // Day 3: decision, scorecard, risk, verification… read whole by the review page.
    assurance: jsonb("assurance").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reviews_repo_pr_sha_uq").on(t.repoFullName, t.prNumber, t.headSha),
    index("reviews_created_at_idx").on(t.createdAt),
    index("reviews_status_idx").on(t.status),
  ],
);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
