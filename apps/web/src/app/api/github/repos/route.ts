import { NextResponse } from "next/server";
import { GitHubService } from "@/services";

export async function GET() {
  try {
    const github = await GitHubService.fromCurrentUser();
    const repos = await github.listRepos();
    return NextResponse.json({ repos });
  } catch (error: any) {
    console.error("[GET /api/github/repos]", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch GitHub repositories" },
      { status: error.status || 500 }
    );
  }
}
