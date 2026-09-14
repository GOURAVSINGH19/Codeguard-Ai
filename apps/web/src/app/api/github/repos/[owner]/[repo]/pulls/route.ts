import { NextResponse } from "next/server";
import { GitHubService } from "@/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  try {
    const { owner, repo } = await params;
    if (!owner || !repo) {
      return NextResponse.json(
        { error: "owner and repo are required" },
        { status: 400 }
      );
    }

    const github = await GitHubService.fromCurrentUser();
    const pulls = await github.listOpenPRs(owner, repo);
    return NextResponse.json({ pulls });
  } catch (error: any) {
    console.error("[GET /api/github/repos/[owner]/[repo]/pulls]", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch pull requests" },
      { status: error.status || 500 }
    );
  }
}
