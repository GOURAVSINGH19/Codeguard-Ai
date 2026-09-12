import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, reviews, reviewComments } from "@codeguard/db";
import { eq, desc } from "drizzle-orm";
import { syncUserWithDb } from "@/lib/user-sync";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Automatically sync signed in Clerk user to Neon Postgres DB
    await syncUserWithDb();

    const userReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.userId, userId))
      .orderBy(desc(reviews.createdAt))
      .limit(20);

    const reviewsWithIssues = await Promise.all(
      userReviews.map(async (rev) => {
        const comments = await db
          .select()
          .from(reviewComments)
          .where(eq(reviewComments.reviewId, rev.id));

        return {
          ...rev,
          issues: comments.map((c) => ({
            severity: c.severity,
            category: c.category,
            line: c.lineNumber ?? null,
            message: c.body || c.comment || "",
            suggestion: c.suggestion ?? null,
          })),
        };
      })
    );

    return NextResponse.json({ reviews: reviewsWithIssues });
  } catch (error: any) {
    console.error("Error fetching reviews:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
