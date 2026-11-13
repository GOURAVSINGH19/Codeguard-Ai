import { db, reviews, and, eq } from "@codeguard/db";
import { publish, prKey, TOPICS, ReviewRequested } from "@codeguard/kafka";
import { installationOctokit } from "@/server/github-app";
import { HttpError, requireUserId, withErrors } from "@/server/http";
import { requireUserRepo } from "@/server/repo-access";

/**
 * POST /api/github/review   body: { owner, repo, pullNumber }
 * Manual "Review" button. Returns 202 { id } right away; the browser then follows
 * GET /api/reviews/:id/events while a worker does the work.
 *
 * Same idempotency as webhooks: one row per (repo, PR, head commit). Clicking
 * twice, or clicking while a webhook review runs, returns the same review.
 */
export const POST = withErrors(async (req: Request) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => null)) as { owner?: unknown; repo?: unknown; pullNumber?: unknown } | null;
  const pullNumber = Number(body?.pullNumber);
  if (typeof body?.owner !== "string" || typeof body?.repo !== "string" || !Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new HttpError(400, "Body must be { owner, repo, pullNumber }");
  }

  const repo = await requireUserRepo(userId, body.owner, body.repo);
  const octokit = await installationOctokit(repo.installationId);
  const { data: pr } = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.name, pull_number: pullNumber });
  if (pr.state !== "open") throw new HttpError(400, "Only open pull requests can be reviewed");

  const key = { repoFullName: repo.fullName, prNumber: pullNumber, headSha: pr.head.sha };
  const [created] = await db
    .insert(reviews)
    .values({ ...key, installationId: repo.installationId, trigger: "manual", status: "pending", prTitle: pr.title })
    .onConflictDoNothing({ target: [reviews.repoFullName, reviews.prNumber, reviews.headSha] })
    .returning({ id: reviews.id, status: reviews.status });
  const review =
    created ??
    (
      await db
        .select({ id: reviews.id, status: reviews.status })
        .from(reviews)
        .where(and(eq(reviews.repoFullName, key.repoFullName), eq(reviews.prNumber, key.prNumber), eq(reviews.headSha, key.headSha)))
        .limit(1)
    )[0];

  // Already running or done for this exact commit: just point the browser at it.
  if (review.status === "in_progress" || review.status === "completed") {
    return Response.json({ id: review.id }, { status: 202 });
  }

  try {
    await publish(TOPICS.reviewRequested, prKey(repo.fullName, pullNumber), ReviewRequested, {
      type: "review.requested",
      installationId: repo.installationId,
      ...key,
      trigger: "manual",
      requestedBy: userId,
    });
  } catch (err) {
    console.error("[review] could not queue:", (err as Error).message);
    await db
      .update(reviews)
      .set({ status: "failed", error: "The review queue is unavailable. Try again in a minute.", updatedAt: new Date() })
      .where(eq(reviews.id, review.id));
    throw new HttpError(503, "The review queue is unavailable. Try again in a minute.");
  }

  return Response.json({ id: review.id }, { status: 202 });
});
