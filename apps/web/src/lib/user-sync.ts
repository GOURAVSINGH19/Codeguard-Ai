import { currentUser } from "@clerk/nextjs/server";
import { db, users } from "@codeguard/db";
import { eq, or } from "drizzle-orm";

export async function syncUserWithDb() {
  try {
    const user = await currentUser();
    if (!user) return null;

    const githubAccount = user.externalAccounts.find(
      (acc) => acc.provider === "oauth_github"
    ) || user.externalAccounts[0];

    const clerkId = user.id;
    const githubId = githubAccount?.providerUserId || user.id;
    const githubLogin =
      githubAccount?.username ||
      user.username ||
      user.firstName ||
      `user_${user.id.slice(-6)}`;
    const githubEmail = user.emailAddresses[0]?.emailAddress || null;
    const avatarUrl = user.imageUrl;
    const name = user.firstName
      ? `${user.firstName} ${user.lastName || ""}`.trim()
      : githubLogin;

    // Check if user exists by githubId (existing DB column)
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.githubId, githubId))
      .limit(1);

    if (existingUser) {
      const [updatedUser] = await db
        .update(users)
        .set({
          githubLogin,
          githubEmail,
          avatarUrl,
          name,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser.id))
        .returning();
      return updatedUser;
    } else {
      const [newUser] = await db
        .insert(users)
        .values({
          githubId,
          githubLogin,
          githubEmail,
          avatarUrl,
          name,
        })
        .returning();
      return newUser;
    }
  } catch (error) {
    console.error("Failed to sync user with Neon DB:", error);
    return null;
  }
}
