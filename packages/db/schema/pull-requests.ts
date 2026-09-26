import { bigint, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { repositories } from "./repositories";

export const prStatusEnum = pgEnum("pr_status", [
  "open",
  "closed",
  "merged",
  "draft",
]);

export const pullRequests = pgTable("pull_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  githubPrId: bigint("github_pr_id", { mode: "number" }).notNull(),
  prNumber: integer("pr_number").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  state: prStatusEnum("state").default("open").notNull(),
  headBranch: text("head_branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  headSha: text("head_sha").notNull(),
  baseSha: text("base_sha").notNull(),
  authorGithubId: text("author_github_id"),
  authorLogin: text("author_login"),
  additions: integer("additions").default(0),
  deletions: integer("deletions").default(0),
  changedFiles: integer("changed_files").default(0),
  labels: jsonb("labels"),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  githubCreatedAt: timestamp("github_created_at", { withTimezone: true }),
  githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // One row per PR — lets concurrent writers upsert instead of racing.
  uniqueIndex("pull_requests_repo_pr_number_uq").on(table.repositoryId, table.prNumber),
]);

export type PullRequest = typeof pullRequests.$inferSelect;
export type NewPullRequest = typeof pullRequests.$inferInsert;
