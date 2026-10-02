import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubInstallations, pullRequests, repositories, reviews, and, desc, eq, inArray } from "@codeguard/db";
import { GitHubAppService } from "@/services/GitHubAppService";
import { GitHubService } from "@/services/GitHubService";
import { handleApiError, intParam, jsonError } from "@/lib/api";

/**
 * GET /api/github/app/repositories/:owner/:repo/pulls — open pull requests of
 * a repository the user's GitHub App installation was granted, each with its
 * latest CodeGuard review (if any).
 *
 * Read through the installation token, so it works without the user's own
 * GitHub OAuth token and only for repos picked during install.
 *
 *   ?page=1&perPage=30   pagination (GitHub's)
 */
export async function GET(req: Request, { params }: { params: Promise<{ owner: string; repo: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const { owner, repo } = await params;
    const url = new URL(req.url);
    const page = intParam(url.searchParams.get("page"), 1, 1, 1_000);
    const perPage = intParam(url.searchParams.get("perPage"), 30, 1, 100);

    const [row] = await db
      .select({
        id: repositories.id,
        fullName: repositories.fullName,
        owner: repositories.owner,
        name: repositories.name,
        private: repositories.isPrivate,
        htmlUrl: repositories.htmlUrl,
        autoReviewEnabled: repositories.autoReviewEnabled,
        installationId: githubInstallations.installationId,
      })
      .from(repositories)
      .innerJoin(githubInstallations, eq(repositories.installationId, githubInstallations.id))
      .where(
        and(
          eq(repositories.fullName, `${owner}/${repo}`),
          eq(repositories.status, "active"),
          eq(githubInstallations.userId, userId),
          eq(githubInstallations.status, "active")
        )
      )
      .limit(1);
    if (!row) return jsonError(404, "Repository not found or not granted to the GitHub App");

    const octokit = await GitHubAppService.fromEnv().createInstallationOctokit(Number(row.installationId));
    const pulls = await new GitHubService(octokit).listOpenPRs(row.owner, row.name, { page, perPage });

    // Latest review per PR number (newest first, first one wins).
    const latest = new Map<number, { id: string; status: string; score: number | null; headSha: string | null; createdAt: Date }>();
    if (pulls.length) {
      const found = await db
        .select({
          prNumber: pullRequests.prNumber,
          id: reviews.id,
          status: reviews.status,
          score: reviews.score,
          headSha: reviews.headSha,
          createdAt: reviews.createdAt,
        })
        .from(reviews)
        .innerJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
        .where(and(eq(pullRequests.repositoryId, row.id), inArray(pullRequests.prNumber, pulls.map((p) => p.number))))
        .orderBy(desc(reviews.createdAt));
      for (const { prNumber, ...r } of found) if (!latest.has(prNumber)) latest.set(prNumber, r);
    }

    return NextResponse.json({
      repo: { fullName: row.fullName, owner: row.owner, name: row.name, private: row.private, htmlUrl: row.htmlUrl ?? `https://github.com/${row.fullName}`, autoReviewEnabled: row.autoReviewEnabled },
      pulls: pulls.map((p) => {
        const r = latest.get(p.number);
        return {
          ...p,
          review: r
            ? { id: r.id, status: r.status, score: r.score, createdAt: r.createdAt, outdated: !!r.headSha && r.headSha !== p.headSha }
            : null,
        };
      }),
      page,
      perPage,
      hasMore: pulls.length === perPage,
    });
  } catch (err) {
    return handleApiError(err, "GET /api/github/app/repositories/[owner]/[repo]/pulls");
  }
}
