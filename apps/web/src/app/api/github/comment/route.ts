import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { annotatePatch } from "@codeguard/review-engine";
import { GitHubService, ReviewPersistenceService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

const BodySchema = z.object({ reviewId: z.string().uuid() });

/**
 * POST /api/github/comment — publish one of YOUR stored PR reviews to GitHub.
 *
 * The content comes from the database, not the request body, so the endpoint
 * can't be used to post arbitrary text under the CodeGuard banner. Issues on
 * changed lines become inline comments; the rest go in the summary.
 */
export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "reviewId is required");

    const persistence = new ReviewPersistenceService();
    const review = await persistence.getReviewById(parsed.data.reviewId, userId);
    if (!review || !review.pullRequest) return jsonError(404, "Review not found");
    if (review.status !== "completed" || review.score == null) return jsonError(409, "The review has not finished yet");

    const { owner, repo, number } = review.pullRequest;
    const github = await GitHubService.fromCurrentUser();
    const pr = await github.getPRDetail(owner, repo, number);
    const commentable = new Map(pr.patches.map((f) => [f.filename, f.patch ? annotatePatch(f.patch).commentableLines : new Set<number>()]));

    // Inline comments only make sense on the commit that was reviewed.
    const sameCommit = review.headSha === pr.headSha;
    const result = await github.postReview({
      owner,
      repo,
      pullNumber: number,
      commitId: review.headSha ?? undefined,
      score: review.score,
      summary: review.summary ?? "",
      issues: review.issues.map((i) => ({
        severity: i.severity as "critical" | "high" | "medium" | "low",
        category: i.category as "security" | "bug" | "performance" | "maintainability" | "style",
        file: i.file,
        line: i.line,
        message: i.message,
        suggestion: i.suggestion,
      })),
      commentable: sameCommit ? commentable : new Map(),
      notes: sameCommit ? undefined : [`Reviewed commit ${review.headSha?.slice(0, 7)}; the PR has new commits since.`],
      footer: "CodeGuard AI",
    });

    await persistence.mergeMetadata(review.id, { github: { reviewId: result.id, url: result.htmlUrl, mode: result.mode, inlineCount: result.inlineCount } });

    return NextResponse.json({ success: true, githubReviewId: result.id, htmlUrl: result.htmlUrl, inlineCount: result.inlineCount });
  } catch (err) {
    return handleApiError(err, "POST /api/github/comment");
  }
}
