import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, repositories, inArray } from "@codeguard/db";
import { GitHubService } from "@/services";
import { handleApiError, intParam, jsonError } from "@/lib/api";

/**
 * GET /api/github/repos — the user's GitHub repositories, enriched with
 * CodeGuard state (app installed? auto-review on?) from the database.
 * Paginated with ?page=1&perPage=50 (GitHub's own page size cap is 100).
 */
export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const url = new URL(req.url);
    const page = intParam(url.searchParams.get("page"), 1, 1, 1_000);
    const perPage = intParam(url.searchParams.get("perPage"), 50, 1, 100);

    const github = await GitHubService.fromCurrentUser();
    const repos = await github.listRepos({ page, perPage });

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
      page,
      perPage,
      // GitHub gives no total here; a full page means there may be another.
      hasMore: repos.length === perPage,
    });
  } catch (err) {
    return handleApiError(err, "GET /api/github/repos");
  }
}
