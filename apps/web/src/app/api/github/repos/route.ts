import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, repositories, inArray } from "@codeguard/db";
import { GitHubService } from "@/services";
import { handleApiError, jsonError } from "@/lib/api";

/**
 * GET /api/github/repos — the user's GitHub repositories, enriched with
 * CodeGuard state (app installed? auto-review on?) from the database.
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const github = await GitHubService.fromCurrentUser();
    const repos = await github.listRepos();

    const known = repos.length
      ? await db
          .select({ githubRepoId: repositories.githubRepoId, installationId: repositories.installationId, autoReviewEnabled: repositories.autoReviewEnabled })
          .from(repositories)
          .where(inArray(repositories.githubRepoId, repos.map((r) => r.id)))
      : [];
    const byId = new Map(known.map((k) => [Number(k.githubRepoId), k]));

    return NextResponse.json({
      repos: repos.map((r) => ({
        ...r,
        installationId: byId.get(r.id)?.installationId ?? null,
        autoReviewEnabled: byId.get(r.id)?.autoReviewEnabled ?? false,
      })),
    });
  } catch (err) {
    return handleApiError(err, "GET /api/github/repos");
  }
}
