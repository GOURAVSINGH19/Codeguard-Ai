import { db, reviews, reviewFindings, and, eq, ne, gte, inArray, count, sql } from "@codeguard/db";
import { intParam, requireUserId, withErrors } from "@/server/http";
import { userRepoFullNames } from "@/server/review-access";

/**
 * GET /api/reviews/trends?days=30
 * The dashboard KPIs and charts (ReviewerDashboard.tsx → TrendsData):
 *   scoreTrend:        [{ date: "2026-11-16", avgScore: 7.4, count: 3 }]   (score on the UI's 0–10 scale)
 *   categoryBreakdown: [{ category: "security", severity: "high", count: 2 }]
 * Always scoped to repos the user can see.
 */
export const GET = withErrors(async (req: Request) => {
  const userId = await requireUserId();
  const days = intParam(new URL(req.url).searchParams.get("days"), 30, 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const names = await userRepoFullNames(userId);
  if (names.length === 0) return Response.json({ scoreTrend: [], categoryBreakdown: [] });

  const day = sql<string>`to_char(date_trunc('day', ${reviews.createdAt}), 'YYYY-MM-DD')`;
  const mine = and(inArray(reviews.repoFullName, names), gte(reviews.createdAt, since));

  const [trend, breakdown] = await Promise.all([
    db
      .select({
        date: day,
        avgScore: sql<number>`round(avg(${reviews.score}) / 10.0, 1)`.mapWith(Number),
        count: count(),
      })
      .from(reviews)
      .where(and(mine, eq(reviews.status, "completed")))
      .groupBy(day)
      .orderBy(day),
    db
      .select({ category: reviewFindings.category, severity: reviewFindings.severity, count: count() })
      .from(reviewFindings)
      .innerJoin(reviews, eq(reviews.id, reviewFindings.reviewId))
      .where(and(mine, ne(reviewFindings.status, "dismissed")))
      .groupBy(reviewFindings.category, reviewFindings.severity),
  ]);

  return Response.json({ scoreTrend: trend, categoryBreakdown: breakdown });
});
