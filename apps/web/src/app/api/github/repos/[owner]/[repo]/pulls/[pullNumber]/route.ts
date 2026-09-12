import { NextResponse } from "next/server";
import { getGitHubClient } from "@/lib/github";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ owner: string; repo: string; pullNumber: string }> }
) {
  try {
    const { owner, repo, pullNumber } = await params;
    const prNum = parseInt(pullNumber, 10);

    if (!owner || !repo || isNaN(prNum)) {
      return NextResponse.json({ error: "Invalid PR parameters" }, { status: 400 });
    }

    const octokit = await getGitHubClient();

    // Fetch PR metadata
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNum,
    });

    // Fetch changed files in the PR
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNum,
      per_page: 50,
    });

    const formattedFiles = files.map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch || "",
    }));

    return NextResponse.json({
      pr: {
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
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        htmlUrl: pr.html_url,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        files: formattedFiles,
      },
    });
  } catch (error: any) {
    console.error("Error fetching PR details:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch PR diff and details" },
      { status: error.status || 500 }
    );
  }
}
