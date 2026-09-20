import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { GitHubService } from "@/services";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { owner, repo, pullNumber, score, summary, issues } = body;
    const prNum = parseInt(pullNumber, 10);

    if (!owner || !repo || isNaN(prNum)) {
      return NextResponse.json(
        { error: "owner, repo, and pullNumber are required" },
        { status: 400 }
      );
    }

    const github = await GitHubService.fromCurrentUser();
    const result = await github.postReviewComment(
      owner,
      repo,
      prNum,
      score,
      summary,
      issues ?? []
    );

    return NextResponse.json({
      success: true,
      githubReviewId: result.reviewId,
      htmlUrl: result.htmlUrl,
      message: "Successfully posted CodeGuard AI review to GitHub PR!",
    });
  } catch (error: any) {
    console.error("[POST /api/github/comment]", error);
    return NextResponse.json(
      { error: error.message || "Failed to post review comment to GitHub PR." },
      { status: error.status || 400 }
    );
  }
}
