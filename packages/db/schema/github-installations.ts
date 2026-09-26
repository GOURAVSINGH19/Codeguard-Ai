import { bigint, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const installationStatusEnum = pgEnum("installation_status", [
  "active",
  "suspended",
  "deleted",
]);

export const githubInstallations = pgTable("github_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
  githubAppId: bigint("github_app_id", { mode: "number" }).notNull(),
  accountId: bigint("account_id", { mode: "number" }).notNull(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(), // "User" | "Organization"
  accountAvatarUrl: text("account_avatar_url"),
  /**
   * Clerk user id of the person who installed the app (verified in the
   * install callback). Text, not a users.id FK: every route authenticates
   * with Clerk ids, and a uuid column could never hold one.
   */
  userId: text("user_id"),
  status: installationStatusEnum("status").default("active").notNull(),
  permissions: jsonb("permissions"),
  events: jsonb("events"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
