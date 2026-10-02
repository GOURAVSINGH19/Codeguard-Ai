import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { ReviewPersistenceService, UserService } from "@/services";
import { REVIEW_GROUPS, type ReviewGroup } from "@/services/ReviewPersistenceService";
import { handleApiError, intParam, jsonError } from "@/lib/api";

/**
 * GET /api/reviews — the user's reviews, newest first.
 *   ?page=1&pageSize=20   pagination
 *   ?group=attention|working|completed|failed   dashboard bucket
 *   ?q=text               title search
 */
export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const url = new URL(req.url);
    const page = intParam(url.searchParams.get("page"), 1, 1, 10_000);
    const pageSize = intParam(url.searchParams.get("pageSize"), 20, 1, 100);
    const groupParam = url.searchParams.get("group");
    if (groupParam && !REVIEW_GROUPS.includes(groupParam as ReviewGroup)) {
      return jsonError(400, `group must be one of: ${REVIEW_GROUPS.join(", ")}`);
    }
    const group = (groupParam as ReviewGroup | null) ?? undefined;
    const q = url.searchParams.get("q")?.trim().slice(0, 100) || undefined;

    await new UserService().syncCurrentUser();
    const { items, total } = await new ReviewPersistenceService().getUserReviews(userId, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      group,
      q,
    });
    return NextResponse.json({
      reviews: items,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: page * pageSize < total,
    });
  } catch (err) {
    return handleApiError(err, "GET /api/reviews");
  }
}
