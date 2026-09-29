import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ReviewInputSchema } from "@codeguard/types";
import { ReviewService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

/**
 * POST /api/review — start a snippet review.
 * Returns 202 with the review id; poll GET /api/reviews/:id for the result.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const body = await req.json().catch(() => null);
    const parsed = ReviewInputSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "Invalid request payload", { details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }

    const started = await new ReviewService().startSnippetReview({ userId, ...parsed.data });
    return NextResponse.json(started, { status: 202 });
  } catch (err) {
    return handleApiError(err, "POST /api/review");
  }
}
