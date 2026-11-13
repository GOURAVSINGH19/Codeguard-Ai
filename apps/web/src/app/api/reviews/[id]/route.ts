import { db, reviewFindings, eq, asc } from "@codeguard/db";
import { requireUserId, withErrors } from "@/server/http";
import { requireUserReview } from "@/server/review-access";
import { toReviewDetail } from "@/server/serializers";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/reviews/:id → { review: ReviewDetail } (also the polling fallback for live progress) */
export const GET = withErrors(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const review = await requireUserReview(userId, (await params).id);
  const findings = await db
    .select()
    .from(reviewFindings)
    .where(eq(reviewFindings.reviewId, review.id))
    .orderBy(asc(reviewFindings.createdAt));
  return Response.json({ review: toReviewDetail(review, findings) });
});
