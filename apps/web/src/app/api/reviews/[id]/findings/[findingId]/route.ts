import { db, reviewFindings, and, eq } from "@codeguard/db";
import { HttpError, requireUserId, withErrors } from "@/server/http";
import { requireUserReview } from "@/server/review-access";

type Ctx = { params: Promise<{ id: string; findingId: string }> };

const STATUSES = ["open", "resolved", "dismissed"] as const;

/**
 * PATCH /api/reviews/:id/findings/:findingId   body: { "status": "open" | "resolved" | "dismissed" }
 * Dismissed findings stop counting toward "needs attention".
 * (After Day 3, a dismissal is also a signal for "learnings".)
 */
export const PATCH = withErrors(async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { id, findingId } = await params;
  const review = await requireUserReview(userId, id);

  const body = (await req.json().catch(() => null)) as { status?: unknown } | null;
  const status = STATUSES.find((s) => s === body?.status);
  if (!status) throw new HttpError(400, "Body must be { status: 'open' | 'resolved' | 'dismissed' }");

  const [finding] = await db
    .update(reviewFindings)
    .set({ status, updatedAt: new Date() })
    // Scoped to this review, so a finding id from someone else's review can't be changed.
    .where(and(eq(reviewFindings.id, findingId), eq(reviewFindings.reviewId, review.id)))
    .returning({ id: reviewFindings.id, status: reviewFindings.status });
  if (!finding) throw new HttpError(404, "Finding not found");

  return Response.json({ finding });
});
