import { bigint, boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { githubInstallations } from "./github-installations";

export const repositoryStatusEnum = pgEnum("repository_status", [
  "active",
  "inactive",
  "archived",
]);

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
  installationId: uuid("installation_id")
    .references(() => githubInstallations.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch").default("main").notNull(),
  isPrivate: boolean("is_private").default(false).notNull(),
  language: text("language"),
  description: text("description"),
  status: repositoryStatusEnum("status").default("active").notNull(),
  cloneUrl: text("clone_url"),
  htmlUrl: text("html_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
