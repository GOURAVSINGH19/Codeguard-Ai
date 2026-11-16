import { RequestError } from "octokit";
import { db, githubInstallations, and, eq } from "@codeguard/db";
import { githubApp } from "@/server/github-app";
import { HttpError, requireUserId, withErrors } from "@/server/http";
import { setInstallationStatus } from "@/server/installation-sync";
import { toInstallationRow } from "@/server/serializers";

type Ctx = { params: Promise<{ id: string }> };

/** Load an installation by GitHub installation id, only if the signed-in user owns it. */
async function ownedInstallation(userId: string, idParam: string) {
  const installationId = Number(idParam);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new HttpError(400, "Invalid installation id");

  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(and(eq(githubInstallations.installationId, installationId), eq(githubInstallations.ownerUserId, userId)))
    .limit(1);
  // 404 (not 403) so we don't reveal which installation ids exist.
  if (!row) throw new HttpError(404, "Installation not found");
  return row;
}

/** GET /api/github/app/installations/:installationId */
export const GET = withErrors(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const row = await ownedInstallation(userId, (await params).id);
  return Response.json({ installation: toInstallationRow(row) });
});

/**
 * DELETE /api/github/app/installations/:installationId
 * Uninstall the App from that account on GitHub, then mark it deleted here.
 * (GitHub also sends an `installation.deleted` webhook; both paths are idempotent.)
 */
export const DELETE = withErrors(async (_req: Request, { params }: Ctx) => {
  const userId = await requireUserId();
  const row = await ownedInstallation(userId, (await params).id);

  try {
    await githubApp().octokit.request("DELETE /app/installations/{installation_id}", {
      installation_id: row.installationId,
    });
  } catch (err) {
    // Already gone on GitHub → still clean up our side.
    if (!(err instanceof RequestError && err.status === 404)) throw err;
  }

  await setInstallationStatus(row.installationId, "deleted");
  return Response.json({ ok: true });
});
