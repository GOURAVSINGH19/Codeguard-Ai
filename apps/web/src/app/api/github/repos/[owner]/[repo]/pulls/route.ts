import { NextResponse } from "next/server";
import { getGitHubClient } from "@/lib/github";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  try {
    const { owner, repo } = await params;
    if (!owner || !repo) {
      return NextResponse.json({ error: "Owner and repo are required" }, { status: 400 });
    }

    const octokit = await getGitHubClient();
    const { data: pulls } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: 30,
    });

    const formattedPulls = pulls.map((pr) => ({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      authorLogin: pr.user?.login || "unknown",
      authorAvatar: pr.user?.avatar_url || null,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      htmlUrl: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    }));

    return NextResponse.json({ pulls: formattedPulls });
  } catch (error: any) {
    console.error("Error fetching open PRs:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch pull requests" },
      { status: error.status || 500 }
    );
  }
}
