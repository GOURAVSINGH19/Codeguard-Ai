import { currentUser } from "@clerk/nextjs/server";
import { db, users } from "@codeguard/db";
import { eq } from "drizzle-orm";

/**
 * UserService
 *
 * Owns all user identity logic:
 * - Syncing Clerk users into the Neon users table
 * - Future: user preferences, plan/tier lookups
 */
export class UserService {
  /**
   * Upsert the currently authenticated Clerk user into the DB.
   * Safe to call on every authenticated request — no-op if user is up to date.
   * Returns the DB user record, or null if not authenticated / on error.
   */
  async syncCurrentUser() {
    try {
      const user = await currentUser();
      if (!user) return null;

      const githubAccount =
        user.externalAccounts.find(
          (acc) => acc.provider === "oauth_github"
        ) ?? user.externalAccounts[0];

      const githubId = githubAccount?.providerUserId ?? user.id;
      const githubLogin =
        githubAccount?.username ??
        user.username ??
        user.firstName ??
        `user_${user.id.slice(-6)}`;
      const githubEmail = user.emailAddresses[0]?.emailAddress ?? null;
      const avatarUrl = user.imageUrl;
      const name = user.firstName
        ? `${user.firstName} ${user.lastName ?? ""}`.trim()
        : githubLogin;

      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.githubId, githubId))
        .limit(1);

      if (existingUser) {
        const [updated] = await db
          .update(users)
          .set({ githubLogin, githubEmail, avatarUrl, name, updatedAt: new Date() })
          .where(eq(users.id, existingUser.id))
          .returning();
        return updated;
      }

      const [created] = await db
        .insert(users)
        .values({ githubId, githubLogin, githubEmail, avatarUrl, name })
        .returning();

      return created;
    } catch (error) {
      console.error("[UserService] syncCurrentUser failed:", error);
      return null;
    }
  }
}
