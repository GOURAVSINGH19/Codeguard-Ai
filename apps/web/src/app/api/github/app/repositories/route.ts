import { db, repositories, and, eq, inArray, sql, count, asc } from "@codeguard/db";
import { intParam, requireUserId, withErrors } from "@/server/http";
import { activeInstallationIds } from "@/server/ownership";
import { syncInstallationRepositories } from "@/server/installation-sync";
import { toRepoJson } from "@/server/serializers";

/**
 * GET /api/github/app/repositories?page=1&pageSize=20&q=api&filter=all|enabled&sync=1
 *
 * Repos the user's active installations grant, read from OUR table (fast, no
 * GitHub call per page view). ?sync=1 refreshes the table from GitHub first;
 * the UI sends it on the first load and on "Sync from GitHub".
 *
 * Response: { repos, total, counts: { all, enabled }, hasMore }
 */
export const GET = withErrors(async (req: Request) => {
  const userId = await requireUserId();
  const params = new URL(req.url).searchParams;
  const page = intParam(params.get("page"), 1);
  const pageSize = intParam(params.get("pageSize"), 20, 100);
  const q = params.get("q")?.trim().toLowerCase() ?? "";
  const filter = params.get("filter") === "enabled" ? "enabled" : "all";

  const installationIds = await activeInstallationIds(userId);
  if (installationIds.length === 0) {
    return Response.json({ repos: [], total: 0, counts: { all: 0, enabled: 0 }, hasMore: false });
  }

  if (params.has("sync")) {
    // One failing installation shouldn't hide the others' repos.
    await Promise.allSettled(installationIds.map((id) => syncInstallationRepositories(id)));
  }

  const visible = and(inArray(repositories.installationId, installationIds), eq(repositories.active, true));
  const matching = and(
    visible,
    q ? sql`lower(${repositories.fullName}) like ${`%${q.replace(/[%_\\]/g, "\\$&")}%`}` : undefined,
  );
  const listed = and(matching, filter === "enabled" ? eq(repositories.autoReviewEnabled, true) : undefined);

  const [rows, [totals], [allCounts]] = await Promise.all([
    db
      .select()
      .from(repositories)
      .where(listed)
      .orderBy(asc(repositories.fullName))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() }).from(repositories).where(listed),
    // Tab counts ("All" / "Auto-review on") follow the search box but not the tab itself.
    db
      .select({
        all: count(),
        enabled: sql<number>`count(*) filter (where ${repositories.autoReviewEnabled})`.mapWith(Number),
      })
      .from(repositories)
      .where(matching),
  ]);

  return Response.json({
    repos: rows.map(toRepoJson),
    total: totals.n,
    counts: { all: allCounts.all, enabled: allCounts.enabled },
    hasMore: page * pageSize < totals.n,
  });
});
