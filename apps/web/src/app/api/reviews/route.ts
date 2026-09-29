import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ReviewPersistenceService, UserService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    await new UserService().syncCurrentUser();
    const reviews = await new ReviewPersistenceService().getUserReviews(userId);
    return NextResponse.json({ reviews });
  } catch (err) {
    return handleApiError(err, "GET /api/reviews");
  }
}
