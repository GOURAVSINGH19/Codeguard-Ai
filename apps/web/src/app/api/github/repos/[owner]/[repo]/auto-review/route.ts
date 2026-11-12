import { db, repositories, eq } from "@codeguard/db";
import { HttpError, requireUserId, withErrors } from "@/server/http";
import { requireUserRepo } from "@/server/repo-access";

type Ctx = { params: Promise<{ owner: string; repo: string }> };

/**
 * PATCH /api/github/repos/:owner/:repo/auto-review   body: { "enabled": true | false }
 * The per-repo switch on the Install page. The Day 2 router reads it before
 * turning a PR event into a review job.
 */
export const PATCH = withErrors(async (req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const { owner, repo: name } = await params;

  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") throw new HttpError(400, "Body must be { enabled: boolean }");

  const repo = await requireUserRepo(userId, owner, name);
  await db
    .update(repositories)
    .set({ autoReviewEnabled: body.enabled, updatedAt: new Date() })
    .where(eq(repositories.id, repo.id));

  return Response.json({ ok: true, autoReviewEnabled: body.enabled });
});
