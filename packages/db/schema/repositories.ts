import { pgTable, uuid, text, bigint, boolean, timestamp, index } from "drizzle-orm/pg-core";

/** Repositories an installation has granted CodeGuard access to. */
export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(), // "owner/name"
    private: boolean("private").notNull().default(false),
    // Display-only details for the UI; filled by the GitHub sync, null from webhook payloads.
    htmlUrl: text("html_url"),
    language: text("language"),
    description: text("description"),
    // Per-repo switch shown on the Install page.
    autoReviewEnabled: boolean("auto_review_enabled").notNull().default(true),
    // false when the repo is removed from the installation (installation_repositories webhook).
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("repositories_installation_idx").on(t.installationId),
    index("repositories_full_name_idx").on(t.fullName),
  ],
);

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
