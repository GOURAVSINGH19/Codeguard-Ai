import { db, reviews, reviewComments } from "@codeguard/db";
import { eq, and, gte, sql, count, avg } from "drizzle-orm";

export interface UsageSummary {
  reviews: number;
  totalTokens: number;
  avgTokensPerReview: number;
  avgDurationMs: number;
}

export interface ScoreTrendPoint {
  date: string;
  avgScore: number;
  count: number;
}

export interface CategoryBreakdownPoint {
  category: string;
  severity: string;
  count: number;
}

export interface VelocityPoint {
  week: string;
  reviews: number;
}

export interface TopIssuePoint {
  message: string;
  count: number;
}

export interface TrendsData {
  scoreTrend: ScoreTrendPoint[];
  categoryBreakdown: CategoryBreakdownPoint[];
  velocity: VelocityPoint[];
  topIssues: TopIssuePoint[];
  usage: UsageSummary;
}

/**
 * ReviewAnalyticsService
 *
 * Provides aggregated analytics for review trends over time.
 * Used by the trends dashboard to display charts and metrics.
 */
export class ReviewAnalyticsService {
  /**
   * Get quality score trend over time.
   * Groups by day and calculates average score and review count.
   */
  async getScoreTrend(
    userId: string,
    days: number = 30
  ): Promise<ScoreTrendPoint[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const results = await db
      .select({
        date: sql<string>`DATE(${reviews.completedAt})`.as("date"),
        avgScore: avg(reviews.score).as("avgScore"),
        count: count().as("count"),
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.userId, userId),
          eq(reviews.status, "completed"),
          gte(reviews.completedAt, cutoffDate)
        )
      )
      .groupBy(sql`DATE(${reviews.completedAt})`)
      .orderBy(sql`DATE(${reviews.completedAt})`);

    return results.map((r) => ({
      date: r.date,
      avgScore: Number(r.avgScore || 0),
      count: Number(r.count || 0),
    }));
  }

  /**
   * Get issue breakdown by category and severity.
   */
  async getCategoryBreakdown(userId: string): Promise<CategoryBreakdownPoint[]> {
    const results = await db
      .select({
        category: reviewComments.category,
        severity: reviewComments.severity,
        count: count().as("count"),
      })
      .from(reviewComments)
      .innerJoin(reviews, eq(reviewComments.reviewId, reviews.id))
      .where(eq(reviews.userId, userId))
      .groupBy(reviewComments.category, reviewComments.severity)
      .orderBy(sql`count DESC`);

    return results.map((r) => ({
      category: r.category,
      severity: r.severity,
      count: Number(r.count || 0),
    }));
  }

  /**
   * Get review velocity (reviews per week).
   */
  async getVelocity(userId: string, weeks: number = 12): Promise<VelocityPoint[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - weeks * 7);

    const results = await db
      .select({
        week: sql<string>`DATE_TRUNC('week', ${reviews.completedAt})::date`.as("week"),
        count: count().as("count"),
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.userId, userId),
          eq(reviews.status, "completed"),
          gte(reviews.completedAt, cutoffDate)
        )
      )
      .groupBy(sql`DATE_TRUNC('week', ${reviews.completedAt})`)
      .orderBy(sql`DATE_TRUNC('week', ${reviews.completedAt})`);

    return results.map((r) => ({
      week: r.week,
      reviews: Number(r.count || 0),
    }));
  }

  /**
   * Get top recurring issues across all reviews.
   */
  async getTopIssues(userId: string, limit: number = 10): Promise<TopIssuePoint[]> {
    const results = await db
      .select({
        message: reviewComments.body,
        count: count().as("count"),
      })
      .from(reviewComments)
      .innerJoin(reviews, eq(reviewComments.reviewId, reviews.id))
      .where(eq(reviews.userId, userId))
      .groupBy(reviewComments.body)
      .orderBy(sql`count DESC`)
      .limit(limit);

    return results.map((r) => ({
      message: r.message || "",
      count: Number(r.count || 0),
    }));
  }

  /**
   * Get all trends data in one call.
   */
  async getAllTrends(
    userId: string,
    options?: { days?: number; weeks?: number; topIssuesLimit?: number }
  ): Promise<TrendsData> {
    const { days = 30, weeks = 12, topIssuesLimit = 10 } = options || {};

    const [scoreTrend, categoryBreakdown, velocity, topIssues, usage] = await Promise.all([
      this.getScoreTrend(userId, days),
      this.getCategoryBreakdown(userId),
      this.getVelocity(userId, weeks),
      this.getTopIssues(userId, topIssuesLimit),
      this.getUsage(userId, days),
    ]);

    return {
      scoreTrend,
      categoryBreakdown,
      velocity,
      topIssues,
      usage,
    };
  }

  /**
   * LLM usage for completed reviews in the period: tokens and latency, read
   * from `reviews.metadata` (written by the review engine).
   */
  async getUsage(userId: string, days: number = 30): Promise<UsageSummary> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [row] = await db
      .select({
        reviews: count(),
        totalTokens: sql<number>`coalesce(sum((${reviews.metadata}->'usage'->>'totalTokens')::bigint), 0)`,
        avgDurationMs: sql<number>`coalesce(avg((${reviews.metadata}->>'durationMs')::numeric), 0)`,
      })
      .from(reviews)
      .where(and(eq(reviews.userId, userId), eq(reviews.status, "completed"), gte(reviews.createdAt, since)));

    const n = Number(row?.reviews ?? 0);
    const tokens = Number(row?.totalTokens ?? 0);
    return {
      reviews: n,
      totalTokens: tokens,
      avgTokensPerReview: n > 0 ? Math.round(tokens / n) : 0,
      avgDurationMs: Math.round(Number(row?.avgDurationMs ?? 0)),
    };
  }
}