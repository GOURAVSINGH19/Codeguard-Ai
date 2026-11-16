import { db, reviews, reviewFindings, and, or, not, eq, ne, lt, inArray, ilike, exists, desc, count, sql, type SQL } from "@codeguard/db";
import { intParam, requireUserId, withErrors } from "@/server/http";
import { userRepoFullNames } from "@/server/review-access";
import { toReviewRow } from "@/server/serializers";

/**
 * "Needs attention": finished, but the score is low or a serious issue is still open.
 * Defined once in SQL so the dashboard groups and the counts agree.
 */
const needsAttention = and(
  eq(reviews.status, "completed"),
  or(
    lt(reviews.score, 70),
    exists(
      db
        .select({ one: sql`1` })
        .from(reviewFindings)
        .where(
          and(
            eq(reviewFindings.reviewId, reviews.id),
            eq(reviewFindings.status, "open"),
            inArray(reviewFindings.severity, ["critical", "high"]),
          ),
        ),
    ),
  ),
)!;

function groupFilter(group: string | null): SQL | undefined {
  switch (group) {
    case "working":
      return inArray(reviews.status, ["pending", "in_progress"]);
    case "failed":
      return eq(reviews.status, "failed");
    case "attention":
      return needsAttention;
    case "completed":
      return and(eq(reviews.status, "completed"), not(needsAttention));
    default:
      return undefined;
  }
}

/**
 * GET /api/reviews?page=1&pageSize=10&q=auth&group=attention|working|completed|failed
 * The user's reviews, newest first.
 * Response: { reviews: ReviewRow[], total, hasMore }
 */
export const GET = withErrors(async (req: Request) => {
  const userId = await requireUserId();
  const params = new URL(req.url).searchParams;
  const page = intParam(params.get("page"), 1);
  const pageSize = intParam(params.get("pageSize"), 15, 50);
  const q = params.get("q")?.trim();

  const names = await userRepoFullNames(userId);
  if (names.length === 0) return Response.json({ reviews: [], total: 0, hasMore: false });

  const search = q
    ? or(
        ilike(reviews.prTitle, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
        ilike(reviews.repoFullName, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
        /^#?\d+$/.test(q) ? eq(reviews.prNumber, Number(q.replace("#", ""))) : undefined,
      )
    : undefined;
  const where = and(inArray(reviews.repoFullName, names), groupFilter(params.get("group")), search);

  const [rows, [{ n: total }]] = await Promise.all([
    db
      .select()
      .from(reviews)
      .where(where)
      .orderBy(desc(reviews.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(reviews).where(where),
  ]);

  // Severities per review for the little badges (dismissed findings don't count).
  const findings = rows.length
    ? await db
        .select({ reviewId: reviewFindings.reviewId, severity: reviewFindings.severity, category: reviewFindings.category })
        .from(reviewFindings)
        .where(and(inArray(reviewFindings.reviewId, rows.map((r) => r.id)), ne(reviewFindings.status, "dismissed")))
    : [];

  return Response.json({
    reviews: rows.map((r) => toReviewRow(r, findings.filter((f) => f.reviewId === r.id))),
    total,
    hasMore: page * pageSize < total,
  });
});
