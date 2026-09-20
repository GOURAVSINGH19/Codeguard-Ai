import { NextResponse } from "next/server";
import { GitHubService } from "@/services";

export async function GET(
  _req: Request,
  {
    params,
  }: { params: Promise<{ owner: string; repo: string; pullNumber: string }> }
) {
  try {
    const { owner, repo, pullNumber } = await params;
    const prNum = parseInt(pullNumber, 10);

    if (!owner || !repo || isNaN(prNum)) {
      return NextResponse.json(
        { error: "Invalid PR parameters" },
        { status: 400 }
      );
    }

    const github = await GitHubService.fromCurrentUser();
    const prDetail = await github.getPRDetail(owner, repo, prNum);

    return NextResponse.json({ pr: prDetail });
  } catch (error: any) {
    console.error(
      "[GET /api/github/repos/[owner]/[repo]/pulls/[pullNumber]]",
      error
    );
    return NextResponse.json(
      { error: error.message || "Failed to fetch PR details" },
      { status: error.status || 500 }
    );
  }
}
