import { bigint, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

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
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  status: installationStatusEnum("status").default("active").notNull(),
  permissions: jsonb("permissions"),
  events: jsonb("events"),
  webhookSecret: text("webhook_secret"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
