import { pgTable, uuid, text, bigint, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/** One row per GitHub App installation (a user or org that installed CodeGuard). */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // GitHub's id for the installation. UNIQUE: the install webhook and the
    // callback both upsert it, so they must land on the same row.
    installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
    // GitHub's numeric id of the user/org that installed it. Ownership checks
    // compare ids, never names (names can be renamed and reused).
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(), // "User" | "Organization"
    accountAvatarUrl: text("account_avatar_url"),
    // Clerk user id of whoever installed it (set by the verified callback).
    ownerUserId: text("owner_user_id"),
    status: text("status", { enum: ["active", "suspended", "deleted"] })
      .notNull()
      .default("active"),
    permissions: jsonb("permissions").$type<Record<string, string>>().notNull().default({}),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("github_installations_owner_idx").on(t.ownerUserId)],
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
