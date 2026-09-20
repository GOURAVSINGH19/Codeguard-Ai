import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { UuidSchema } from "@codeguard/types";
import { ReviewPersistenceService } from "@/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: reviewId } = await params;
    const uuidCheck = UuidSchema.safeParse(reviewId);
    if (!uuidCheck.success) {
      return NextResponse.json(
        { error: "Invalid review ID format (must be a valid UUID)" },
        { status: 400 }
      );
    }

    const persistence = new ReviewPersistenceService();
    const review = await persistence.getReviewById(reviewId, userId);

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    return NextResponse.json({ review });
  } catch (error: any) {
    console.error("[GET /api/reviews/[id]]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
