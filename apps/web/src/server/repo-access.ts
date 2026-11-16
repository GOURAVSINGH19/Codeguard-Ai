import { db, repositories, and, eq, inArray, sql } from "@codeguard/db";
import { HttpError } from "./http";
import { activeInstallationIds } from "./ownership";

/**
 * Find a repo by owner/name, but only if one of the user's ACTIVE installations
 * grants it. Every repo-scoped route goes through this, so a user can never
 * read or change a repo just by typing its name into the URL.
 */
export async function requireUserRepo(userId: string, owner: string, name: string) {
  const installationIds = await activeInstallationIds(userId);
  if (installationIds.length === 0) throw new HttpError(404, "Repository not found");

  const fullName = `${owner}/${name}`.toLowerCase(); // GitHub names are case-insensitive
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        sql`lower(${repositories.fullName}) = ${fullName}`,
        inArray(repositories.installationId, installationIds),
        eq(repositories.active, true),
      ),
    )
    .limit(1);

  if (!repo) throw new HttpError(404, "Repository not found");
  return repo;
}
