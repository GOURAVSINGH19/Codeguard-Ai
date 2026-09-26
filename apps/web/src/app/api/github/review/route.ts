import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { PRReviewRequestSchema } from "@codeguard/types";
import { GitHubService, ReviewService, UserService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

/**
 * POST /api/github/review — start an AI review of a pull request.
 *
 * Returns 202 with the review id plus PR metadata for the UI. The review runs
 * after the response is sent; poll GET /api/reviews/:id. Requesting the same
 * commit twice returns the existing review instead of paying for a new one.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const parsed = PRReviewRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "owner, repo and pullNumber are required");
    const { owner, repo, pullNumber } = parsed.data;

    await new UserService().syncCurrentUser();

    const github = await GitHubService.fromCurrentUser();
    const pr = await github.getPRDetail(owner, repo, pullNumber);
    const started = await new ReviewService().startPRReview(userId, pr);

    return NextResponse.json(
      {
        ...started,
        prNumber: pr.number,
        title: pr.title,
        headSha: pr.headSha,
        changedFiles: pr.files,
      },
      { status: 202 }
    );
  } catch (err) {
    return handleApiError(err, "POST /api/github/review");
  }
}
