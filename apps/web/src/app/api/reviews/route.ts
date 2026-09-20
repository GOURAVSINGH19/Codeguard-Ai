import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ReviewPersistenceService, UserService } from "@/services";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Sync Clerk user into DB on every authenticated list request
    await new UserService().syncCurrentUser();

    const persistence = new ReviewPersistenceService();
    const userReviews = await persistence.getUserReviews(userId);

    return NextResponse.json({ reviews: userReviews });
  } catch (error: any) {
    console.error("[GET /api/reviews]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
