import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { db, githubInstallations, repositories, and, asc, count, eq, ilike, inArray } from "@codeguard/db";
import { GitHubAppService } from "@/services/GitHubAppService";
import { handleApiError, intParam, jsonError } from "@/lib/api";

/**
 * GET /api/github/app/repositories — repositories the user's GitHub App
 * installations can access (i.e. what was granted on GitHub), not every repo
 * the user can see.
 *
 *   ?page=1&pageSize=20       pagination
 *   ?q=text                   filter by full name
 *   ?filter=all|enabled       only repos with auto-review on
 *   ?sync=1                   refresh the list from GitHub first
 */
export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return jsonError(401, "Unauthorized");

    const url = new URL(req.url);
    const page = intParam(url.searchParams.get("page"), 1, 1, 1_000);
    const pageSize = intParam(url.searchParams.get("pageSize"), 20, 1, 100);
    const q = url.searchParams.get("q")?.trim().slice(0, 100) || undefined;
    const onlyEnabled = url.searchParams.get("filter") === "enabled";

    const installs = await db
      .select({ id: githubInstallations.id, installationId: githubInstallations.installationId, accountLogin: githubInstallations.accountLogin })
      .from(githubInstallations)
      .where(and(eq(githubInstallations.userId, userId), eq(githubInstallations.status, "active")));

    if (installs.length === 0) {
      return NextResponse.json({ repos: [], page, pageSize, total: 0, totalPages: 1, hasMore: false, counts: { all: 0, enabled: 0 } });
    }

    // Pull the current grant from GitHub so repos added/removed there show up
    // even if the installation_repositories webhook was missed.
    // Best-effort: on failure we still return what's stored.
    if (url.searchParams.get("sync") === "1") {
      await Promise.all(
        installs.map(async (i) => {
          try {
            await GitHubAppService.fromEnv().syncInstallationRepositories(Number(i.installationId));
          } catch (err) {
            console.warn(`[GET /api/github/app/repositories] sync failed for ${i.installationId}:`, (err as Error).message);
          }
        })
      );
    }

    const base = and(
      inArray(repositories.installationId, installs.map((i) => i.id)),
      eq(repositories.status, "active")
    );
    const where = and(
      base,
      q ? ilike(repositories.fullName, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
      onlyEnabled ? eq(repositories.autoReviewEnabled, true) : undefined
    );

    const [rows, [{ total }], [{ all }], [{ enabled }]] = await Promise.all([
      db
        .select()
        .from(repositories)
        .where(where)
        .orderBy(asc(repositories.fullName))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ total: count() }).from(repositories).where(where),
      db.select({ all: count() }).from(repositories).where(base),
      db.select({ enabled: count() }).from(repositories).where(and(base, eq(repositories.autoReviewEnabled, true))),
    ]);

    const loginByInstall = new Map(installs.map((i) => [i.id, i.accountLogin]));

    return NextResponse.json({
      repos: rows.map((r) => ({
        id: r.githubRepoId,
        fullName: r.fullName,
        owner: r.owner,
        name: r.name,
        private: r.isPrivate,
        language: r.language,
        description: r.description,
        htmlUrl: r.htmlUrl ?? `https://github.com/${r.fullName}`,
        autoReviewEnabled: r.autoReviewEnabled,
        account: r.installationId ? loginByInstall.get(r.installationId) ?? null : null,
      })),
      page,
      pageSize,
      total: Number(total),
      totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
      hasMore: page * pageSize < Number(total),
      counts: { all: Number(all), enabled: Number(enabled) },
    });
  } catch (err) {
    return handleApiError(err, "GET /api/github/app/repositories");
  }
}
