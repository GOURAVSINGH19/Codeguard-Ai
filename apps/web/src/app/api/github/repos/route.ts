import { NextResponse } from "next/server";
import { getGitHubClient } from "@/lib/github";

export async function GET() {
  try {
    const octokit = await getGitHubClient();
    const { data: repos } = await octokit.rest.repos.listForAuthenticatedUser({
      sort: "updated",
      per_page: 50,
    });

    const formattedRepos = repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      private: repo.private,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      language: repo.language,
      description: repo.description,
    }));

    return NextResponse.json({ repos: formattedRepos });
  } catch (error: any) {
    console.error("Error fetching GitHub repos:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch GitHub repositories" },
      { status: error.status || 500 }
    );
  }
}
