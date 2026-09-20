import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { AIReviewService, GitHubService, ReviewPersistenceService, UserService } from "@/services";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sync user to DB on every authenticated PR review
  await new UserService().syncCurrentUser();

  const body = await req.json();
  const { owner, repo, pullNumber } = body;
  const prNum = parseInt(pullNumber, 10);

  if (!owner || !repo || isNaN(prNum)) {
    return NextResponse.json(
      { error: "owner, repo, and pullNumber are required" },
      { status: 400 }
    );
  }

  const persistence = new ReviewPersistenceService();
  let pendingReviewId: string | null = null;

  try {
    // 1. Fetch PR details + diff from GitHub
    const github = await GitHubService.fromCurrentUser();
    const prDetail = await github.getPRDetail(owner, repo, prNum);

    // 2. Upsert repository + PR records, create pending review
    const repoRecord = await persistence.ensureRepository(prDetail);
    const prRecord = await persistence.ensurePullRequest(prDetail, repoRecord.id);
    const pendingReview = await persistence.createPendingPRReview(
      userId,
      prRecord.id,
      prDetail
    );
    pendingReviewId = pendingReview.id;

    // 3. Run AI review
    const aiService = AIReviewService.fromEnv();
    const reviewOutput = await aiService.reviewPRDiff(
      prDetail.diffContext,
      prDetail.title,
      prDetail.body
    );

    // 4. Persist completed review + issues
    const firstFilename = prDetail.files[0]?.filename ?? "PR diff";
    const completed = await persistence.completePRReview(
      pendingReview.id,
      reviewOutput,
      firstFilename
    );

    return NextResponse.json({
      id: completed.id,
      prNumber: prNum,
      title: prDetail.title,
      score: reviewOutput.score,
      summary: reviewOutput.summary,
      issues: reviewOutput.issues,
      changedFiles: prDetail.files,
      headSha: prDetail.headSha,
      createdAt: completed.createdAt,
    });
  } catch (error: any) {
    console.error("[POST /api/github/review]", error);

    // Best-effort: mark pending review as failed so status stays consistent
    if (pendingReviewId) {
      await persistence.failReview(pendingReviewId).catch(() => null);
    }

    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
