import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, reviews, reviewComments } from "@codeguard/db";
import { eq, and } from "drizzle-orm";
import { UuidSchema } from "@codeguard/types";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resolvedParams = await params;
    const reviewId = resolvedParams.id;

    const uuidValidation = UuidSchema.safeParse(reviewId);
    if (!uuidValidation.success) {
      return NextResponse.json(
        { error: "Invalid review ID format (must be a valid UUID)" },
        { status: 400 }
      );
    }

    const [review] = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), eq(reviews.userId, userId)))
      .limit(1);

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    const comments = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.reviewId, review.id));

    const issues = comments.map((c) => ({
      id: c.id,
      severity: c.severity,
      category: c.category,
      line: c.lineNumber ?? null,
      message: c.body || c.comment || "",
      suggestion: c.suggestion ?? null,
    }));

    return NextResponse.json({
      review: {
        ...review,
        issues,
      },
    });
  } catch (error: any) {
    console.error("Error fetching review detail:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
