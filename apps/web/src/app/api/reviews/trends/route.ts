import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ReviewAnalyticsService } from "@/services/ReviewAnalyticsService";
import { handleApiError, intParam, jsonError } from "@/lib/api";

export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const url = new URL(req.url);
    // Clamped so a crafted query can't request years of daily buckets.
    const days = intParam(url.searchParams.get("days"), 30, 1, 365);
    const weeks = intParam(url.searchParams.get("weeks"), 12, 1, 104);
    const topIssuesLimit = intParam(url.searchParams.get("topIssuesLimit"), 10, 1, 50);

    const data = await new ReviewAnalyticsService().getAllTrends(userId, { days, weeks, topIssuesLimit });
    return NextResponse.json(data);
  } catch (err) {
    return handleApiError(err, "GET /api/reviews/trends");
  }
}
