import { db, reviews, reviewComments, repositories, pullRequests } from "@codeguard/db";
import { eq, and, desc, gte, sql, count, avg } from "drizzle-orm";

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

    const [scoreTrend, categoryBreakdown, velocity, topIssues] = await Promise.all([
      this.getScoreTrend(userId, days),
      this.getCategoryBreakdown(userId),
      this.getVelocity(userId, weeks),
      this.getTopIssues(userId, topIssuesLimit),
    ]);

    return {
      scoreTrend,
      categoryBreakdown,
      velocity,
      topIssues,
    };
  }
}