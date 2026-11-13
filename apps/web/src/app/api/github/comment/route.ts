import { db, reviews, reviewFindings, and, eq, ne } from "@codeguard/db";
import { getEnv } from "@codeguard/config";
import { commentableLines } from "@codeguard/review-engine/diff";
import { fetchDiffFiles, publishReview } from "@codeguard/review-engine/github";
import { installationOctokit } from "@/server/github-app";
import { HttpError, requireUserId, withErrors } from "@/server/http";
import { requireUserReview } from "@/server/review-access";

/**
 * POST /api/github/comment   body: { reviewId }
 * (Re)post a finished review to its pull request, e.g. after the first post
 * failed, or after dismissing noisy findings. Returns { htmlUrl }.
 */
export const POST = withErrors(async (req: Request) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => null)) as { reviewId?: unknown } | null;
  if (typeof body?.reviewId !== "string") throw new HttpError(400, "Body must be { reviewId }");

  const review = await requireUserReview(userId, body.reviewId);
  if (review.status !== "completed" || review.score === null) throw new HttpError(409, "The review hasn't finished yet");
  if (!review.installationId || !review.baseSha) throw new HttpError(409, "This review can't be posted to GitHub");

  const findings = await db
    .select()
    .from(reviewFindings)
    .where(and(eq(reviewFindings.reviewId, review.id), ne(reviewFindings.status, "dismissed")));

  const [owner, repo] = review.repoFullName.split("/");
  const octokit = await installationOctokit(review.installationId);
  // Recompute which lines GitHub accepts comments on, from the same diff the review used.
  const files = await fetchDiffFiles(octokit, owner, repo, review.reviewedFromSha ?? review.baseSha, review.headSha);
  const appUrl = getEnv().APP_URL;

  const { htmlUrl } = await publishReview(octokit, {
    owner,
    repo,
    prNumber: review.prNumber,
    headSha: review.headSha,
    score: review.score,
    summary: review.summary ?? "",
    findings,
    commentable: new Map(files.map((f) => [f.filename, commentableLines(f.patch)])),
    detailsUrl: appUrl ? `${appUrl.replace(/\/$/, "")}/reviews/${review.id}` : null,
  });

  await db.update(reviews).set({ githubReviewUrl: htmlUrl, error: null, updatedAt: new Date() }).where(eq(reviews.id, review.id));
  return Response.json({ htmlUrl });
});
