import { db, githubInstallations, repositories, reviews, and, eq, inArray, ne } from "@codeguard/db";
import { HttpError } from "./http";

/**
 * Which reviews may this user see? Reviews of repos that belong to the user's
 * (not uninstalled) installations, including repos that were later removed,
 * so history doesn't vanish.
 */
export async function userRepoFullNames(userId: string): Promise<string[]> {
  const rows = await db
    .select({ fullName: repositories.fullName })
    .from(repositories)
    .innerJoin(githubInstallations, eq(githubInstallations.installationId, repositories.installationId))
    .where(and(eq(githubInstallations.ownerUserId, userId), ne(githubInstallations.status, "deleted")));
  return [...new Set(rows.map((r) => r.fullName))];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Load a review only if the user may see it. 404 otherwise (don't reveal which ids exist). */
export async function requireUserReview(userId: string, reviewId: string) {
  if (!UUID.test(reviewId)) throw new HttpError(404, "Review not found");
  const names = await userRepoFullNames(userId);
  if (names.length === 0) throw new HttpError(404, "Review not found");

  const [review] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, reviewId), inArray(reviews.repoFullName, names)))
    .limit(1);
  if (!review) throw new HttpError(404, "Review not found");
  return review;
}
