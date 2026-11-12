import { db, reviews, and, eq, inArray, desc } from "@codeguard/db";
import { installationOctokit } from "@/server/github-app";
import { intParam, requireUserId, withErrors } from "@/server/http";
import { requireUserRepo } from "@/server/repo-access";
import { toRepoJson } from "@/server/serializers";

type Ctx = { params: Promise<{ owner: string; repo: string }> };

const PER_PAGE = 20;

/**
 * GET /api/github/app/repositories/:owner/:repo/pulls?page=1
 *
 * Open PRs come live from GitHub (through the installation token); each is
 * joined with its latest review from our DB. A review is "outdated" when it
 * looked at an older commit than the PR's current head.
 *
 * Response: { repo, pulls: Pull[], hasMore } (see RepoPulls.tsx)
 */
export const GET = withErrors(async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { owner, repo: name } = await params;
  const repo = await requireUserRepo(userId, owner, name);
  const page = intParam(new URL(req.url).searchParams.get("page"), 1);

  const octokit = await installationOctokit(repo.installationId);
  const { data: prs } = await octokit.rest.pulls.list({
    owner: repo.owner,
    repo: repo.name,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: PER_PAGE,
    page,
  });

  // Latest review per PR number (rows come newest first; keep the first we see).
  const latest = new Map<number, typeof reviews.$inferSelect>();
  if (prs.length) {
    const rows = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.repoFullName, repo.fullName), inArray(reviews.prNumber, prs.map((p) => p.number))))
      .orderBy(desc(reviews.createdAt));
    for (const r of rows) if (!latest.has(r.prNumber)) latest.set(r.prNumber, r);
  }

  const pulls = prs.map((pr) => {
    const review = latest.get(pr.number);
    return {
      number: pr.number,
      title: pr.title,
      authorLogin: pr.user?.login ?? "ghost",
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      htmlUrl: pr.html_url,
      createdAt: pr.created_at,
      review: review
        ? {
            id: review.id,
            status: review.status,
            score: review.score,
            createdAt: review.createdAt.toISOString(),
            outdated: review.headSha !== pr.head.sha,
          }
        : null,
    };
  });

  return Response.json({ repo: toRepoJson(repo), pulls, hasMore: prs.length === PER_PAGE });
});
