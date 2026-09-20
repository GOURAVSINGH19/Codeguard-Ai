import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ReviewAnalyticsService } from "@/services/ReviewAnalyticsService";

export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const days = parseInt(url.searchParams.get("days") || "30", 10);
    const weeks = parseInt(url.searchParams.get("weeks") || "12", 10);
    const topIssuesLimit = parseInt(url.searchParams.get("topIssuesLimit") || "10", 10);

    const analytics = new ReviewAnalyticsService();
    const data = await analytics.getAllTrends(userId, { days, weeks, topIssuesLimit });

    return NextResponse.json(data);
  } catch (error: any) {
    console.error("[GET /api/reviews/trends]", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch trends data" },
      { status: 500 }
    );
  }
}