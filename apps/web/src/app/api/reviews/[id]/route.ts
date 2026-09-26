import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { UuidSchema } from "@codeguard/types";
import { ReviewPersistenceService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

/** GET /api/reviews/:id — one of the caller's reviews (also used for polling). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const { id } = await params;
    if (!UuidSchema.safeParse(id).success) return jsonError(400, "Invalid review ID format (must be a valid UUID)");

    const review = await new ReviewPersistenceService().getReviewById(id, userId);
    if (!review) return jsonError(404, "Review not found");

    return NextResponse.json({ review }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handleApiError(err, "GET /api/reviews/[id]");
  }
}
